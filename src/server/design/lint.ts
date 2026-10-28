/**
 * Design checks (docs/design/design-system.md, "Verification"): render a design in the private Chromium, walk its DOM
 * once, and compare what it uses with the design system's tokens (colors, fonts, sizes), then check contrast, tap
 * targets, overflow, images, headings, fonts, the viewport, `data-pid`s, and focus styles.
 *
 * Precision matters more than recall: a finding is reported only when the page's own values prove it. Equal values on
 * many elements are one finding with a count in its message. The page is untrusted: everything that comes back from
 * it is shape-checked and bounded before it is used.
 */
import { createHash } from "node:crypto";
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";
import {
    colorDistance,
    contrastOf,
    familyList,
    formatColor,
    isGenericFamily,
    type LengthKind,
    type RgbaTuple,
    tokenSet,
    type TokenSet,
} from "./lint-color.ts";
import { PAGE_SCRIPT, type PageInput, type RawElement, type RawPage } from "./lint-page.ts";
import {
    type DesignAction,
    type DesignPage,
    type DesignViewport,
    type TweakValues,
    type ViewportName,
    viewportOf,
    withRender,
} from "./render.ts";
import type {
    CheckFinding,
    CheckReport,
    CheckRule,
    DesignSystem,
    ResolvedToken,
} from "./system-types.ts";

/** What `checkDesign` takes besides the bundle and the system. */
export interface CheckOptions {
    /** A preset or a size. Default: desktop. */
    viewport?: ViewportName | DesignViewport;
    /** Default: light. */
    colorScheme?: "light" | "dark";
    /**
     * A mode of the system (`system.modes`: `high-contrast`, a brand). The page gets `data-theme="<mode>"` on its root
     * element, is drawn in the mode's color scheme (`system.schemes`; `colorScheme` is the fallback), and is compared
     * with that mode's tokens. The name is checked against the system, and a system is needed. Left out: `dark` for a
     * dark color scheme when the system has that mode (the root gets `data-theme` only if the page sets none), else
     * the system's default mode.
     */
    mode?: string;
    tweaks?: TweakValues;
    /** Another HTML page of the bundle (`about.html`). */
    page?: string;
    /** Steps before the checks, in order. */
    actions?: DesignAction[];
    /** For a deck: the slide to check (from 1, default 1), or `all` (up to 40 slides). */
    slide?: number | "all";
}

/** The order that findings sort in, after errors before warnings. */
const RULE_ORDER: CheckRule[] = [
    "contrast",
    "overflow",
    "off-system-color",
    "off-system-font",
    "off-system-size",
    "tap-target",
    "font-fallback",
    "image-alt",
    "missing-viewport",
    "focus-visible",
    "reduced-motion",
    "heading-order",
    "missing-pid",
];

/** Motion longer than this, in milliseconds, or an animation that repeats forever, needs a reduced-motion rule. */
export const MOTION_MS = 500;
/** Two colors this close (see `colorDistance`) are the same: a little over 2 steps of 8 bits. */
const SAME_COLOR = 1;
/** A nearest token farther than this is no help as a suggestion. */
const FAR_COLOR = 20;
/** A color this close to a token is the token's color to the last digit (a fix may replace it). */
const EXACT_COLOR = 0.3;
/** Lengths this close, in pixels, are the same. */
const SAME_LENGTH = 0.5;
const MAX_TEXT = 300;

const clip = (value: unknown, length = MAX_TEXT): string =>
    typeof value === "string" ? value.slice(0, length) : "";
const num = (value: unknown, fallback = 0): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const more = (count: number) => (count > 1 ? ` (and ${plural(count - 1, "more element")})` : "");

/** An element reference from the page, cleaned. */
function elementOf(raw: RawElement | undefined): {
    selector: string;
    pid?: string;
    rect?: CheckFinding["rect"];
} {
    const rect = raw?.rect;

    return {
        selector: clip(raw?.selector, 500),
        ...(typeof raw?.pid === "string" && raw.pid !== "" ? { pid: clip(raw.pid, 200) } : {}),
        ...(rect === undefined
            ? {}
            : {
                  rect: {
                      x: num(rect.x),
                      y: num(rect.y),
                      width: num(rect.width),
                      height: num(rect.height),
                  },
              }),
    };
}

const rgbaOf = (value: unknown): RgbaTuple | undefined =>
    Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(item))
        ? [value[0], value[1], value[2], value[3]]
        : undefined;
const rgbOf = (value: unknown): [number, number, number] | undefined =>
    Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)
        ? [value[0], value[1], value[2]]
        : undefined;

/** The tier of a token as a tie-break: a role beats a raw palette value. */
const TIER_RANK: Record<ResolvedToken["tier"], number> = {
    semantic: 0,
    component: 1,
    primitive: 2,
};

/** The view of a system's mode: which mode, which color scheme to draw, and the `data-theme` to set. */
export interface ModeView {
    mode: string;
    scheme: "light" | "dark";
    /** The value of `data-theme` on the root, when the check sets one. */
    theme?: string;
    /** True when the mode was asked for by name: the attribute then replaces the page's own. */
    named: boolean;
}

/**
 * The mode of `system` that a check at `colorScheme` compares with. A named mode is validated and draws in its own
 * scheme (`system.schemes`); without a name, a dark scheme takes the `dark` mode when the system has one.
 */
export function modeFor(
    system: DesignSystem,
    colorScheme: "light" | "dark",
    mode?: string,
): ModeView {
    if (mode !== undefined) {
        if (!system.modes.includes(mode)) {
            throw new Error(
                `The design system has no mode "${mode}". Modes: ${system.modes.join(", ")}.`,
            );
        }

        return { mode, scheme: system.schemes?.[mode] ?? colorScheme, theme: mode, named: true };
    }

    if (colorScheme === "dark" && system.modes.includes("dark") && system.modes[0] !== "dark") {
        return { mode: "dark", scheme: "dark", theme: "dark", named: false };
    }

    return { mode: system.modes[0] ?? "light", scheme: colorScheme, named: false };
}

/** What the page script resolved for the system's tokens, put back into the token set. */
function resolveTokens(set: TokenSet, raw: RawPage): void {
    set.colors.forEach((token, index) => {
        token.rgba = rgbaOf(raw.resolvedColors?.[index]);
    });
    set.lengths.forEach((token, index) => {
        const value = raw.resolvedLengths?.[index];

        token.px = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    });
}

type Nearest = { token: TokenSet["colors"][number]; distance: number };

/** What a color token is for, by the words of its path: a border, text on a ground, or a ground. None for a palette step. */
type ColorRole = "text" | "background" | "border";

const ROLE_WORDS: [ColorRole, RegExp][] = [
    ["border", /^(border|borders|line|lines|divider|dividers|stroke|outline|ring|rule|separator)$/],
    ["text", /^(text|fg|foreground|content|ink|on|label|copy)$/],
    ["background", /^(bg|background|surface|fill|canvas|base|ground|wash|soft|scrim|overlay)$/],
];

/** The role a token's name gives it (the first of border, text, background whose words it holds), if any. */
export function colorRoleOf(name: string): ColorRole | undefined {
    const words = name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/);

    return ROLE_WORDS.find(([, pattern]) => words.some((word) => pattern.test(word)))?.[0];
}

/** The CSS property that a use of a color sets, for the edit that a message names. */
const USE_PROPERTY: Record<string, string> = {
    text: "color",
    background: "background-color",
    border: "border-color",
    outline: "outline-color",
};

/** The properties that can hold a color of each use, longhands and the shorthands that carry one (`fix.properties`). */
const USE_PROPERTIES: Record<string, string[]> = {
    text: ["color", "-webkit-text-fill-color"],
    background: ["background-color", "background"],
    border: [
        "border-color",
        "border",
        "border-top",
        "border-right",
        "border-bottom",
        "border-left",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
    ],
    outline: ["outline-color", "outline"],
};

/** The properties that can hold a length of each group (`props` of a size group), with their sides and shorthands. */
const LENGTH_PROPERTIES: Record<string, string[]> = {
    padding: ["padding", "padding-top", "padding-right", "padding-bottom", "padding-left"],
    margin: ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left"],
    gap: ["gap", "row-gap", "column-gap", "grid-gap"],
    "font-size": ["font-size", "font"],
    "border-radius": [
        "border-radius",
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-right-radius",
        "border-bottom-left-radius",
    ],
};

/** The tokens that a color equals to the last digit, the one for the use first (a role token, then a palette step). */
function exactColorToken(set: TokenSet, color: RgbaTuple, use: string | undefined) {
    const role = use === undefined ? undefined : USE_ROLE[use];
    const same = set.colors.filter(
        (token) => token.rgba !== undefined && colorDistance(color, token.rgba) <= EXACT_COLOR,
    );

    return [...same].sort(
        (a, b) =>
            Number(colorRoleOf(b.name) === role) - Number(colorRoleOf(a.name) === role) ||
            TIER_RANK[a.tier] - TIER_RANK[b.tier],
    )[0];
}

/** How a page uses a color (`useColor` in the page script) as a token role. */
const USE_ROLE: Record<string, ColorRole> = {
    text: "text",
    background: "background",
    border: "border",
    outline: "border",
};

/**
 * The nearest color token to `color`: the closest, a role before a palette value when two are as near. With a `use`
 * (text, background, border, outline), the tokens of that role come first (a color used as a background gets a
 * background token, not a text token); a palette or accent token with no role can stand in; a token of another role is
 * the last resort.
 */
function nearestColor(set: TokenSet, color: RgbaTuple, use?: string): Nearest | undefined {
    const role = use === undefined ? undefined : USE_ROLE[use];

    const nearest = (tokens: TokenSet["colors"], bonus: ColorRole | undefined) => {
        let best: Nearest | undefined;

        for (const token of tokens) {
            if (token.rgba === undefined) {
                continue;
            }

            const distance =
                colorDistance(color, token.rgba) -
                (bonus !== undefined && colorRoleOf(token.name) === bonus ? 3 : 0);

            if (
                best === undefined ||
                distance < best.distance - 0.5 ||
                (distance < best.distance + 0.5 &&
                    TIER_RANK[token.tier] < TIER_RANK[best.token.tier] &&
                    distance < SAME_COLOR)
            ) {
                best = { token, distance };
            }
        }

        return best;
    };

    if (role === undefined) {
        return nearest(set.colors, undefined);
    }

    const matching = nearest(
        set.colors.filter((token) => colorRoleOf(token.name) === role),
        undefined,
    );
    const usable = nearest(
        set.colors.filter((token) => {
            const own = colorRoleOf(token.name);

            return own === undefined || own === role;
        }),
        role,
    );
    const best =
        matching !== undefined && matching.distance <= (usable?.distance ?? Infinity) + 6
            ? matching
            : usable;

    if (best !== undefined && best.distance <= FAR_COLOR) {
        return best;
    }

    // No token of the role is close: any token that is close at all (the message says that its role differs).
    return nearest(set.colors, undefined);
}

/** The length tokens of a kind, with a pixel value. */
const lengthsOf = (set: TokenSet, kind: LengthKind) =>
    set.lengths.filter(
        (token): token is typeof token & { px: number } =>
            token.kind === kind && token.px !== undefined,
    );

/** A color token that reaches `needed` contrast on `back`, as near to `fg` as any. */
function nearestPassing(
    set: TokenSet,
    fg: RgbaTuple,
    back: [number, number, number],
    needed: number,
) {
    let best: { token: TokenSet["colors"][number]; distance: number; ratio: number } | undefined;

    for (const token of set.colors) {
        if (token.rgba === undefined || token.rgba[3] < 0.99) {
            continue;
        }

        const ratio = contrastOf(token.rgba, back);

        if (ratio < needed) {
            continue;
        }

        const distance = colorDistance(fg, token.rgba);

        if (best === undefined || distance < best.distance - 0.5) {
            best = { token, distance, ratio };
        }
    }

    return best;
}

const tokenRef = (token: { cssVar: string }) => `var(${token.cssVar})`;

/** The token to suggest for a font family list: one with the same generic fallback, else the first. */
function suggestFont(set: TokenSet, list: string) {
    const wanted = familyList(list).filter(isGenericFamily).at(-1);

    return (
        set.fonts.find((font) => wanted !== undefined && font.families.at(-1) === wanted) ??
        set.fonts.find((font) => /body|base|sans|text/i.test(font.name)) ??
        set.fonts[0]
    );
}

/**
 * The findings for what the page script returned. Pure: no browser. `tokens` is `undefined` without a system, and then
 * the off-system rules do not run.
 */
export function analyze(
    raw: RawPage,
    tokens: TokenSet | undefined,
    context: { deck?: boolean } = {},
): CheckFinding[] {
    const out: (CheckFinding & { weight: number })[] = [];
    const add = (finding: CheckFinding, weight = 1) => out.push({ ...finding, weight });

    if (tokens !== undefined) {
        resolveTokens(tokens, raw);
    }

    // Colors.
    if (tokens !== undefined && tokens.colors.some((token) => token.rgba !== undefined)) {
        for (const group of raw.colors ?? []) {
            const rgba = rgbaOf(group.rgba);

            if (rgba === undefined) {
                continue;
            }

            const nearest = nearestColor(tokens, rgba);

            const onSystem = nearest !== undefined && nearest.distance < SAME_COLOR;

            if (onSystem && group.literal !== true) {
                continue;
            }

            const [main] = Object.entries(group.roles ?? {}).sort((a, b) => num(b[1]) - num(a[1]));

            const roles = Object.entries(group.roles ?? {})
                .filter(([, count]) => Number.isFinite(count))
                .map(([role, count]) => `${role} on ${plural(count, "element")}`)
                .join(", ");
            const better = nearestColor(tokens, rgba, main?.[0]);
            const near = better !== undefined && better.distance <= FAR_COLOR ? better : undefined;
            const value = formatColor(rgba);
            const wanted = USE_ROLE[main?.[0] ?? ""];
            const given = near === undefined ? undefined : colorRoleOf(near.token.name);
            const property = USE_PROPERTY[main?.[0] ?? ""] ?? "color";
            const edit =
                near === undefined
                    ? ""
                    : ` Set \`${property}: ${tokenRef(near.token)}\` (${formatColor(near.token.rgba!)}) instead of ${value}.`;
            const roleNote =
                wanted !== undefined && given !== undefined && given !== wanted
                    ? ` It is a ${given} token, and the system has no ${wanted} token this close.`
                    : "";

            const exact =
                onSystem && group.literal === true
                    ? exactColorToken(tokens, rgba, main?.[0])
                    : undefined;

            add(
                {
                    rule: "off-system-color",
                    level: onSystem ? "warning" : "error",
                    ...elementOf(group.el),
                    value,
                    ...(near === undefined ? {} : { suggestion: tokenRef(near.token) }),
                    ...(exact === undefined
                        ? {}
                        : {
                              fix: {
                                  kind: "color" as const,
                                  properties: USE_PROPERTIES[main?.[0] ?? "text"] ?? ["color"],
                                  literal: value,
                                  token: exact.name,
                                  cssVar: exact.cssVar,
                                  mode: tokens.mode,
                              },
                          }),
                    message: onSystem
                        ? `${value} is written as a literal (${roles}), so it does not follow the system.` +
                          (near === undefined ? "" : `${edit}${roleNote}`)
                        : `${value} is not a system color (${roles}).` +
                          (near === undefined
                              ? " No token is close: pick a role from the system."
                              : `${edit}${roleNote}`),
                },
                num(group.count),
            );
        }
    }

    // Fonts.
    if (tokens !== undefined && tokens.fonts.length > 0) {
        const allowed = new Set(tokens.fonts.map((font) => font.families[0]));

        for (const group of raw.fonts ?? []) {
            const family = clip(group.family, 120);

            const onSystem = allowed.has(family);

            if (family === "" || (onSystem && group.literal !== true)) {
                continue;
            }

            const list = clip(group.list);
            const token = suggestFont(tokens, list);
            const names = familyList(list);
            const exact =
                onSystem && group.literal === true
                    ? tokens.fonts.find(
                          (font) =>
                              font.families.length === names.length &&
                              font.families.every((name, index) => name === names[index]),
                      )
                    : undefined;

            add(
                {
                    rule: "off-system-font",
                    level: onSystem ? "warning" : "error",
                    ...elementOf(group.el),
                    value: list,
                    ...(token === undefined ? {} : { suggestion: tokenRef(token) }),
                    ...(exact === undefined
                        ? {}
                        : {
                              fix: {
                                  kind: "font" as const,
                                  properties: ["font-family"],
                                  literal: list,
                                  token: exact.name,
                                  cssVar: exact.cssVar,
                                  mode: tokens.mode,
                              },
                          }),
                    message:
                        (onSystem
                            ? `Font ${list} is written as a literal (${plural(num(group.count), "element")}), so it does not follow the system.`
                            : `Font ${list} is not a system font (${plural(num(group.count), "element")}).`) +
                        (token === undefined
                            ? ""
                            : ` Set \`font-family: ${tokenRef(token)}\` instead of ${list}.`),
                },
                num(group.count),
            );
        }
    }

    // Sizes: font size, spacing, and radius, each on its own scale.
    if (tokens !== undefined) {
        const names: Record<string, string> = {
            "font-size": "the type scale",
            space: "the spacing scale",
            radius: "the radius scale",
        };

        for (const group of raw.sizes ?? []) {
            const kind = group.kind as LengthKind;
            const scale = names[kind] === undefined ? [] : lengthsOf(tokens, kind);
            const px = num(group.px, Number.NaN);

            if (scale.length === 0 || !Number.isFinite(px)) {
                continue;
            }

            const equal = scale.find((token) => Math.abs(token.px - px) <= SAME_LENGTH);

            if (equal !== undefined && group.literal !== true) {
                continue;
            }

            // Two equally near steps: the smaller one.
            const sorted = [...scale].sort(
                (a, b) => Math.abs(a.px - px) - Math.abs(b.px - px) || a.px - b.px,
            );
            const nearest = sorted[0]!;
            const props = (Array.isArray(group.props) ? group.props : [])
                .map((prop) => clip(prop, 30))
                .join(", ");
            const step = equal ?? nearest;
            const exact =
                group.literal === true
                    ? scale.find((token) => Math.abs(token.px - px) <= 0.01)
                    : undefined;
            const properties = (Array.isArray(group.props) ? group.props : []).flatMap(
                (prop) => LENGTH_PROPERTIES[String(prop)] ?? [],
            );

            add(
                {
                    rule: "off-system-size",
                    level: "warning",
                    ...elementOf(group.el),
                    value: `${px}px`,
                    suggestion: tokenRef(step),
                    ...(exact === undefined || properties.length === 0
                        ? {}
                        : {
                              fix: {
                                  kind: "length" as const,
                                  properties,
                                  literal: `${px}px`,
                                  token: exact.name,
                                  cssVar: exact.cssVar,
                                  mode: tokens.mode,
                              },
                          }),
                    message:
                        equal === undefined
                            ? `${props === "" ? kind : props} ${px}px is not on ${names[kind]} (${plural(num(group.count), "use")}). ${sizeEdit(group.props, kind, nearest, px)}`
                            : `${props === "" ? kind : props} ${px}px is written as a literal (${plural(num(group.count), "use")}), so it does not follow the system. ${sizeEdit(group.props, kind, equal, px)}`,
                },
                num(group.count),
            );
        }
    }

    // Contrast.
    for (const group of raw.contrast ?? []) {
        const fg = rgbOf(group.fg);
        const bg = rgbOf(group.bg);

        if (fg === undefined || bg === undefined) {
            continue;
        }

        const ratio =
            group.ui && typeof group.ratio === "number" ? group.ratio : contrastOf(fg, bg);
        const needed = group.ui || group.large ? 3 : 4.5;

        if (ratio >= needed) {
            continue;
        }

        const shown = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

        if (group.ui) {
            // A system that sets a field's border and fill owns that look: its contrast pairs are checked in the system.
            const edges = (group.edges ?? []).map(rgbaOf);

            if (
                tokens !== undefined &&
                edges.length > 0 &&
                edges.every((edge) => {
                    const near = edge === undefined ? undefined : nearestColor(tokens, edge);

                    return near !== undefined && near.distance < SAME_COLOR;
                })
            ) {
                continue;
            }

            const part = group.what === "focus" || group.what === "icon" ? group.what : "field";
            const tag = clip(group.tag, 20);
            const found =
                tokens === undefined
                    ? undefined
                    : nearestPassing(tokens, [...fg, 1] as RgbaTuple, bg, 3);
            const property = part === "focus" ? "outline-color" : "color";
            const edit =
                found === undefined
                    ? part === "field"
                        ? " Give the border a stronger color."
                        : ` Use ${part === "focus" ? "a ring" : "an icon"} color that reaches 3:1 on ${formatColor(bg)}.`
                    : ` Set \`${property}: ${tokenRef(found.token)}\` (${formatColor(found.token.rgba!)}, ${found.ratio.toFixed(2)}:1)${part === "icon" ? " on the icon (or its `fill`)" : ""} instead of ${formatColor(fg)}.`;
            const what =
                part === "focus"
                    ? `The focus ring of a <${tag}> is ${shown} against what is around it`
                    : part === "icon"
                      ? `The icon in a <${tag}> is ${shown} against what it sits on`
                      : `The edge of a form field is ${shown} against what it sits on`;

            add(
                {
                    rule: "contrast",
                    level: "warning",
                    ...elementOf(group.el),
                    value: shown,
                    ...(found === undefined ? {} : { suggestion: tokenRef(found.token) }),
                    message: `${what}; WCAG 1.4.11 needs 3:1${more(num(group.count))}.${edit}`,
                },
                num(group.count),
            );

            continue;
        }

        const swatch = (color: number[]) => formatColor(color);
        const pass =
            tokens === undefined
                ? undefined
                : nearestPassing(tokens, [...fg, 1] as RgbaTuple, bg, needed);

        add(
            {
                rule: "contrast",
                level: "error",
                ...elementOf(group.el),
                value: shown,
                ...(pass === undefined ? {} : { suggestion: tokenRef(pass.token) }),
                message:
                    `Text ${swatch(fg)} on ${swatch(bg)} is ${shown}; ${group.large ? "large text" : "text"} needs ${needed}:1${more(num(group.count))}.` +
                    (pass === undefined
                        ? tokens === undefined
                            ? " Darken the `color` or lighten the `background-color`."
                            : " No system color passes on this background: change its `background-color`."
                        : ` Set \`color: ${tokenRef(pass.token)}\` (${swatch(pass.token.rgba!)}, ${pass.ratio.toFixed(2)}:1) instead of ${swatch(fg)}.`),
            },
            num(group.count),
        );
    }

    // Tap targets.
    for (const group of raw.targets ?? []) {
        const width = num(group.width);
        const height = num(group.height);
        const level = group.level === "error" ? "error" : "warning";

        add(
            {
                rule: "tap-target",
                level,
                ...elementOf(group.el),
                value: `${width}×${height}px`,
                message:
                    level === "error"
                        ? `A <${clip(group.tag, 20)}> target is ${width}×${height} px, under the 24×24 px minimum of WCAG 2.2${more(num(group.count))}. Set \`min-width: 44px; min-height: 44px\` (or padding) on it.`
                        : `A <${clip(group.tag, 20)}> target is ${width}×${height} px; 44×44 px is easier to hit on a phone${more(num(group.count))}. Set \`min-width: 44px; min-height: 44px\` (or padding) on it.`,
            },
            num(group.count),
        );
    }

    // Overflow.
    if (raw.overflow !== undefined && context.deck !== true) {
        const { scrollWidth, clientWidth, clipped, offenders } = raw.overflow;

        add({
            rule: "overflow",
            level: clipped ? "warning" : "error",
            ...elementOf(raw.overflow.el),
            value: `${num(scrollWidth)}px in ${num(clientWidth)}px`,
            message: clipped
                ? `Content reaches ${num(scrollWidth)} px in a ${num(clientWidth)} px viewport and is cut off (${plural(num(offenders), "element")} end past the edge).`
                : `The page scrolls sideways: ${num(scrollWidth)} px wide in a ${num(clientWidth)} px viewport${raw.overflow.el === undefined ? "" : `, with the widest element ending past the edge (${plural(num(offenders), "element")} do)`}. Let it wrap, shrink, or scroll inside its own box.`,
        });
    }

    // Images, headings, fonts, the viewport.
    for (const group of raw.images ?? []) {
        add(
            {
                rule: "image-alt",
                level: "error",
                ...elementOf(group.el),
                message: `An image has ${clip(group.why, 60)}${more(num(group.count))}. Add \`alt="what it shows"\`, or \`alt=""\` if it is decoration.`,
            },
            num(group.count),
        );
    }

    for (const group of raw.headings ?? []) {
        add({
            rule: "heading-order",
            level: "warning",
            ...elementOf(group.el),
            value: `h${num(group.level)} after h${num(group.previous)}`,
            message: `A heading jumps from level ${num(group.previous)} to ${num(group.level)}. Change the tag to <h${num(group.previous) + 1}> and keep its look with CSS.`,
        });
    }

    for (const group of raw.fontFaces ?? []) {
        const family = clip(group.family, 120);

        add(
            {
                rule: "font-fallback",
                level: group.failed ? "error" : "warning",
                ...elementOf(group.el),
                value: family,
                message: `Font "${family}" is used but ${clip(group.why, 100)}, so the text falls back to another font${more(num(group.count))}. Load the font (an @font-face file in the bundle, or a public HTTPS stylesheet).`,
            },
            num(group.count),
        );
    }

    if (raw.hasViewportMeta === false && context.deck !== true) {
        add({
            rule: "missing-viewport",
            level: "error",
            selector: "",
            message:
                'The page has no viewport meta tag, so a phone shows it zoomed out. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        });
    }

    for (const group of raw.focus ?? []) {
        const tag = clip(group.tag, 20);

        add(
            {
                rule: "focus-visible",
                level: "warning",
                ...elementOf(group.el),
                message: `A <${tag}> shows no focus style: ${group.outlineNone ? "its outline is removed and nothing else changes" : "nothing changes"} when a keyboard focuses it${more(num(group.count))}. Add a :focus-visible rule, such as outline: 2px solid ${tokens?.colors.find((token) => /focus|ring/i.test(token.name)) === undefined ? "an accent color" : tokenRef(tokens.colors.find((token) => /focus|ring/i.test(token.name))!)}.`,
            },
            num(group.count),
        );
    }

    // Motion with no way to ask for less: one finding for the page.
    const motion = raw.motion;

    if (
        motion !== undefined &&
        num(motion.count) > 0 &&
        motion.override !== true &&
        motion.unreadable !== true
    ) {
        add({
            rule: "reduced-motion",
            level: "warning",
            ...elementOf(motion.el),
            value: `${num(motion.longest)}ms`,
            message:
                `${plural(num(motion.count), "element")} use a transition or an animation longer than ${MOTION_MS} ms, or one that repeats forever (the longest is ${num(motion.longest)} ms), and the page has no \`@media (prefers-reduced-motion: reduce)\` rule. ` +
                "Add \`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }\`.",
        });
    }

    // `data-pid`: one finding in all, naming the tags.
    const pids = (raw.pids ?? []).filter((group) => num(group.count) > 0);

    if (pids.length > 0) {
        const total = pids.reduce((sum, group) => sum + num(group.count), 0);
        const listed = pids
            .slice(0, 5)
            .map((group) => `${num(group.count)} <${clip(group.tag, 20)}>`);
        const tags = pids.length > 5 ? `${listed.join(", ")}, …` : listed.join(", ");

        add({
            rule: "missing-pid",
            level: "warning",
            ...elementOf(pids[0]!.el),
            message: `${plural(total, "element")} with no data-pid on it or a parent (${tags}). Add data-pid to the sections and controls people may comment on.`,
        });
    }

    const seen = new Map<string, number>();

    return out
        .sort(
            (a, b) =>
                (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1) ||
                RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
                b.weight - a.weight,
        )
        .map(({ weight: _weight, ...finding }) => {
            const id = findingId(finding);
            const again = (seen.get(id) ?? 0) + 1;

            seen.set(id, again);

            return { id: again === 1 ? id : `${id}-${again}`, ...finding };
        });
}

/**
 * A finding's id: the rule, and a hash of where it is (the `data-pid`, else the selector) and what it is about (the
 * value). The same problem on the same element has the same id in every run, so a pin can follow it; fixing the value
 * ends it, and a new value is a new id. The color scheme, the viewport, and the wording do not change it.
 */
export function findingId(
    finding: Pick<CheckFinding, "rule" | "pid" | "selector" | "value">,
): string {
    const scope =
        finding.pid !== undefined && finding.pid !== ""
            ? `pid:${finding.pid}`
            : `sel:${finding.selector}`;
    const hash = createHash("sha256")
        .update(`${finding.rule}\0${scope}\0${finding.value ?? ""}`)
        .digest("hex")
        .slice(0, 10);

    return `${finding.rule}-${hash}`;
}

/** The edit for a length: the property (or properties), the token by name, its value, and what it replaces. */
function sizeEdit(
    props: unknown,
    kind: string,
    step: { cssVar: string; px: number },
    px: number,
): string {
    const names = (Array.isArray(props) ? props : [])
        .map((prop) => clip(prop, 30))
        .filter((prop) => prop !== "");
    const list = names.length > 0 ? names : [kind === "font-size" ? "font-size" : kind];
    const set = list.map((prop) => `\`${prop}\``).join(" or ");

    return `Set ${set} to ${tokenRef(step)}, ${step.px}px, instead of ${px}px.`;
}

/** A report for findings. */
export function reportOf(
    findings: CheckFinding[],
    view: { viewport: DesignViewport; colorScheme: "light" | "dark"; mode?: string },
    elements: number,
    withoutSystem: boolean,
): CheckReport {
    const byRule: CheckReport["summary"]["byRule"] = {};

    for (const finding of findings) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    }

    return {
        viewport: view.viewport,
        colorScheme: view.colorScheme,
        ...(view.mode === undefined ? {} : { mode: view.mode }),
        findings,
        summary: {
            errors: findings.filter((finding) => finding.level === "error").length,
            warnings: findings.filter((finding) => finding.level === "warning").length,
            elements,
            byRule,
        },
        withoutSystem,
    };
}

/**
 * Check the page that is loaded in `page`, in the state it is in now (a color scheme, tweaks, a slide, actions already
 * applied). `mode` names the system mode to compare with.
 */
export async function checkPage(
    page: DesignPage,
    system: DesignSystem | undefined,
    view: { viewport: DesignViewport; colorScheme?: "light" | "dark"; mode?: string },
): Promise<CheckReport> {
    const picked =
        system === undefined ? undefined : modeFor(system, view.colorScheme ?? "light", view.mode);
    const colorScheme = picked?.scheme ?? view.colorScheme ?? "light";
    const tokens =
        system === undefined || picked === undefined ? undefined : tokenSet(system, picked.mode);
    const deck = await page.isDeck();
    const input: PageInput = {
        tokenColors: tokens?.colors.map((token) => token.css) ?? [],
        tokenLengths: tokens?.lengths.map((token) => ({ css: token.css, kind: token.kind })) ?? [],
        deck,
        literals: tokens !== undefined,
    };
    const raw = (await page.evaluateIsolated(`(${PAGE_SCRIPT})(${JSON.stringify(input)})`)) as
        RawPage | undefined;

    if (raw === undefined || raw === null || typeof raw !== "object") {
        throw new Error("The page check returned nothing.");
    }

    return reportOf(
        analyze(raw, tokens, { deck }),
        { viewport: view.viewport, colorScheme, mode: picked?.mode },
        num(raw.elements),
        system === undefined,
    );
}

/** Findings of several reports as one list, equal findings once. */
export function mergeFindings(reports: CheckReport[]): CheckFinding[] {
    const seen = new Set<string>();
    const merged: CheckFinding[] = [];

    for (const report of reports) {
        for (const finding of report.findings) {
            const key = [finding.rule, finding.level, finding.selector, finding.value ?? ""].join(
                "|",
            );

            if (!seen.has(key)) {
                seen.add(key);
                merged.push(finding);
            }
        }
    }

    return merged;
}

/**
 * Render a design and check it: the contract that the Design workspace's Check button and `design_preview` rely on.
 * Without a system, the off-system rules do not run and the report says so.
 */
export async function checkDesign(
    bundle: DesignBundle,
    system: DesignSystem | undefined,
    options: CheckOptions,
    host: PocketHost,
    signal?: AbortSignal,
): Promise<CheckReport> {
    const viewport = viewportOf(options.viewport ?? "desktop");

    if (options.mode !== undefined && system === undefined) {
        throw new Error("A mode needs a design system: this project has none.");
    }

    const picked =
        system === undefined
            ? undefined
            : modeFor(system, options.colorScheme ?? "light", options.mode);
    const colorScheme = picked?.scheme ?? options.colorScheme ?? "light";

    return withRender(bundle, host, signal, async (page) => {
        await page.load(viewport, { page: options.page });
        await page.applyView({
            colorScheme,
            theme: picked?.theme,
            forceTheme: picked?.named,
            tweaks: options.tweaks,
        });
        await page.act(options.actions ?? []);
        const view = { viewport, colorScheme, mode: picked?.mode };

        if (!(await page.isDeck())) {
            return checkPage(page, system, view);
        }

        const count = (await page.slides()).length;
        const slides =
            options.slide === "all"
                ? Array.from({ length: Math.min(count, 40) }, (_, index) => index + 1)
                : [options.slide ?? 1];
        const reports: CheckReport[] = [];

        for (const slide of slides) {
            await page.showSlide(slide, viewport);
            reports.push(await checkPage(page, system, view));
        }

        const findings = mergeFindings(reports);

        return reportOf(
            findings,
            { viewport, colorScheme, mode: picked?.mode },
            reports.reduce((total, report) => total + report.summary.elements, 0),
            system === undefined,
        );
    });
}
