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
import {
    colorRoleOf,
    difference,
    FAR_COLOR,
    nearestColor,
    nearestPassing as passing,
    SAME_COLOR,
    USE_PROPERTIES,
    USE_PROPERTY,
    USE_ROLE,
} from "./lint-suggest.ts";
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
import type { CheckFinding, CheckReport, CheckRule, DesignSystem } from "./system-types.ts";

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
    /**
     * Ids of findings that a person accepted on purpose (`CheckFinding.id`, stable between runs). They are reported apart,
     * in `accepted`, and are not errors or warnings. An id that no finding has any more is ignored.
     */
    accepted?: string[];
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
    "form-label",
    "accessible-name",
    "missing-lang",
    "input-zoom",
    "missing-main",
    "heading-order",
    "missing-pid",
];

/** Motion longer than this, in milliseconds, or an animation that repeats forever, needs a reduced-motion rule. */
export const MOTION_MS = 500;

export { colorRoleOf };

/** WCAG contrast for the suggestions of `lint-suggest.ts`. */
const nearestPassing = (
    set: TokenSet,
    fg: RgbaTuple,
    back: [number, number, number],
    needed: number,
    use?: string,
) => passing(set, fg, back, needed, contrastOf, use);
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
 * scheme (`system.schemes`); without a name, the mode that `tokens.css` shows at that scheme.
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

    // The mode that `tokens.css` shows at this scheme without a data-theme: the default mode in its own scheme, else the
    // mode of its media query (named for the scheme, else the first of that scheme), as `preferred` in tokens-compile.ts.
    const base = system.modes[0] ?? "light";
    const other =
        (system.schemes?.[base] ?? "light") === colorScheme
            ? undefined
            : (system.modes.find((each) => each !== base && each === colorScheme) ??
              system.modes.find(
                  (each) => each !== base && (system.schemes?.[each] ?? "light") === colorScheme,
              ));

    if (other !== undefined) {
        return { mode: other, scheme: colorScheme, theme: other, named: false };
    }

    return { mode: base, scheme: colorScheme, named: false };
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

/** The length tokens of a kind, with a pixel value. */
const lengthsOf = (set: TokenSet, kind: LengthKind) =>
    set.lengths.filter(
        (token): token is typeof token & { px: number } =>
            token.kind === kind && token.px !== undefined,
    );

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
    context: { deck?: boolean; phone?: boolean } = {},
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

            // On the system: some token is this color, within a rounding.
            const onSystem = tokens.colors.some(
                (token) => token.rgba !== undefined && colorDistance(rgba, token.rgba) < SAME_COLOR,
            );

            if (onSystem && group.literal !== true) {
                continue;
            }

            const [main] = Object.entries(group.roles ?? {}).sort((a, b) => num(b[1]) - num(a[1]));

            const roles = Object.entries(group.roles ?? {})
                .filter(([, count]) => Number.isFinite(count))
                .map(([role, count]) => `${role} on ${plural(count, "element")}`)
                .join(", ");
            const better = nearestColor(tokens, rgba, main?.[0]);
            const near =
                better !== undefined && (better.exact || better.distance <= FAR_COLOR)
                    ? better
                    : undefined;
            const value = formatColor(rgba);
            const wanted = USE_ROLE[main?.[0] ?? ""];
            const given = near === undefined ? undefined : colorRoleOf(near.token.name);
            const property = USE_PROPERTY[main?.[0] ?? ""] ?? "color";
            // Said as "the same color" only when it is: a token that differs is the closest one, and the message says how.
            const edit =
                near === undefined
                    ? ""
                    : near.exact
                      ? ` Set \`${property}: ${tokenRef(near.token)}\` (${formatColor(near.token.rgba!)}, the same color).`
                      : ` Set \`${property}: ${tokenRef(near.token)}\` (${formatColor(near.token.rgba!)}) instead of ${value}.`;
            const change =
                near === undefined || near.exact
                    ? ""
                    : ` The closest token is ${formatColor(near.token.rgba!)}, which is ${difference(rgba, near.token.rgba!)}.`;
            const roleNote =
                wanted !== undefined && given !== undefined && given !== wanted
                    ? ` It is a ${given} token, and the system has no ${wanted} token this close.`
                    : "";

            // A fix replaces the literal in place, so the token must fit the use: a text token is not a background's.
            const exact =
                onSystem &&
                group.literal === true &&
                near?.exact &&
                near.token.tier !== "component" &&
                (given === undefined || given === wanted)
                    ? near.token
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
                          (near === undefined ? "" : `${edit}${change}${roleNote}`)
                        : `${value} is not a system color (${roles}).` +
                          (near === undefined
                              ? " No token is close: pick a role from the system."
                              : `${edit}${change}${roleNote}`),
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
                    : nearestPassing(
                          tokens,
                          [...fg, 1] as RgbaTuple,
                          bg,
                          3,
                          part === "icon" ? "text" : "border",
                      );
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
                        : ` Set \`color: ${tokenRef(pass.token)}\` (${swatch(pass.token.rgba!)}, ${pass.ratio.toFixed(2)}:1) instead of ${swatch(fg)}.${
                              pass.sameHue
                                  ? ""
                                  : ` No system color of its hue reaches ${needed}:1 here, so this one changes the hue.`
                          }`),
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

    // Page semantics.
    const semantics = raw.semantics;

    if (semantics !== undefined && semantics.lang === false) {
        add({
            rule: "missing-lang",
            level: "error",
            ...elementOf(semantics.html),
            message:
                'The page has no lang attribute on <html>, so a screen reader has to guess its language (WCAG 3.1.1). Set `<html lang="en">`, with the page\'s own language.',
        });
    }

    if (semantics !== undefined && semantics.main === false && context.deck !== true) {
        add({
            rule: "missing-main",
            level: "warning",
            ...elementOf(semantics.body),
            message:
                "The page has no main landmark, so a screen reader cannot jump to its content. Wrap the page's content in `<main>`.",
        });
    }

    for (const group of raw.labels ?? []) {
        add(
            {
                rule: "form-label",
                level: "error",
                ...elementOf(group.el),
                value: clip(group.kind, 40),
                message: `A <${clip(group.kind, 40)}> has no label (no label, aria-label, aria-labelledby, or title; a placeholder is not a label: it goes away when a person types, and not every screen reader reads it)${more(num(group.count))}. Add a \`<label for="id">\` (or wrap the field in a \`<label>\`), or add \`aria-label="what it is"\`.`,
            },
            num(group.count),
        );
    }

    for (const group of raw.names ?? []) {
        add(
            {
                rule: "accessible-name",
                level: "error",
                ...elementOf(group.el),
                value: clip(group.kind, 40),
                message: `A <${clip(group.kind, 40)}> has no accessible name (no text, aria-label, aria-labelledby, title, image alt, or SVG title)${more(num(group.count))}. Add \`aria-label="what it does"\`.`,
            },
            num(group.count),
        );
    }

    if (context.phone === true) {
        const sizes =
            tokens === undefined
                ? []
                : lengthsOf(tokens, "font-size").filter((token) => token.px >= 16);
        const step = sizes.sort((a, b) => a.px - b.px)[0];

        for (const group of raw.zoom ?? []) {
            add(
                {
                    rule: "input-zoom",
                    level: "warning",
                    ...elementOf(group.el),
                    value: `${num(group.px)}px`,
                    ...(step === undefined ? {} : { suggestion: tokenRef(step) }),
                    message: `A <${clip(group.kind, 40)}> has font-size ${num(group.px)}px: iOS Safari zooms the page in when a field under 16px gets the focus${more(num(group.count))}. ${
                        step === undefined
                            ? "Set `font-size: 16px`."
                            : `Set \`font-size: ${tokenRef(step)}\` (${step.px}px).`
                    }`,
                },
                num(group.count),
            );
        }
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
        .map(({ weight: _weight, ...finding }) => finding)
        .reduce(groupFindings, [] as CheckFinding[])
        .map((finding) => {
            const id = findingId(finding);
            const again = (seen.get(id) ?? 0) + 1;

            seen.set(id, again);

            return { id: again === 1 ? id : `${id}-${again}`, ...finding };
        });
}

/** A message without its counts, so that two findings of one defect on different elements compare equal. */
const plain = (message: string) =>
    message.replace(/\d+ (more )?(elements?|uses?)/g, "N").replace(/ ?\(and N\)/g, "");

/** The key that findings of one defect share, kept apart from the message (which grows a list of the other elements). */
const groupKeys = new WeakMap<CheckFinding, string>();

/**
 * Findings of one rule with the same value, suggestion, and message (apart from its counts) are one defect on several
 * elements, as two titles in the same wrong font: they become one finding that lists its elements (a pin for each). A
 * finding with no element (a page-level one) is left alone.
 */
export function groupFindings(list: CheckFinding[], next: CheckFinding): CheckFinding[] {
    const element = (finding: CheckFinding) => ({
        selector: finding.selector,
        ...(finding.pid === undefined ? {} : { pid: finding.pid }),
        ...(finding.rect === undefined ? {} : { rect: finding.rect }),
    });

    const key = (finding: CheckFinding) => {
        if (!groupKeys.has(finding)) {
            groupKeys.set(
                finding,
                [
                    finding.rule,
                    finding.level,
                    finding.value ?? "",
                    finding.suggestion ?? "",
                    plain(finding.message),
                ].join("\0"),
            );
        }

        return groupKeys.get(finding)!;
    };

    const same =
        next.selector === ""
            ? undefined
            : list.find((each) => each.selector !== "" && key(each) === key(next));

    if (same === undefined) {
        return [...list, next];
    }

    const elements = same.elements ?? [element(same)];

    if (elements.length < 12) {
        elements.push(element(next));
    }

    same.elements = elements;
    same.message = same.message.replace(/ The same in \d+ more places?: .*$/, "");
    same.message += ` The same in ${plural(elements.length - 1, "more place")}: ${elements
        .slice(1, 4)
        .map((each) => each.pid ?? each.selector)
        .join(", ")}${elements.length > 4 ? ", …" : ""}.`;

    return list;
}

/**
 * A finding's id: the rule, and a hash of where it is (the `data-pid`, else the selector) and what it is about (the
 * value). The same problem on the same element has the same id in every run, so a pin can follow it; fixing the value
 * ends it, and a new value is a new id. The color scheme, the viewport, and the wording do not change it.
 */
export function findingId(
    finding: Pick<CheckFinding, "rule" | "pid" | "selector" | "value" | "elements">,
): string {
    const one = (item: { pid?: string; selector: string }) =>
        item.pid !== undefined && item.pid !== "" ? `pid:${item.pid}` : `sel:${item.selector}`;
    // One defect on several elements: the scope is all of them (sorted), so that its id does not depend on their order.
    const scope =
        finding.elements === undefined ? one(finding) : finding.elements.map(one).sort().join("+");
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

    const by = Math.round(Math.abs(step.px - px) * 100) / 100;
    const change =
        by < 0.01 ? "" : ` The closest step is ${by}px ${step.px < px ? "smaller" : "larger"}.`;

    return `Set ${set} to ${tokenRef(step)}, ${step.px}px, instead of ${px}px.${change}`;
}

/** A report for findings. */
export function reportOf(
    findings: CheckFinding[],
    view: { viewport: DesignViewport; colorScheme: "light" | "dark"; mode?: string },
    elements: number,
    withoutSystem: boolean,
    notJudged?: { count: number; elements: string[] },
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
            ...(notJudged === undefined || notJudged.count <= 0
                ? {}
                : {
                      notJudged: {
                          contrast: { count: notJudged.count, elements: notJudged.elements },
                      },
                  }),
        },
        withoutSystem,
    };
}

/**
 * Move the findings that a person accepted (by id) out of `findings`: they are reported in `accepted`, and the counts
 * leave them out. A report with nothing accepted is returned as it is.
 */
export function acceptFindings(
    report: CheckReport,
    ids: readonly string[] | undefined,
): CheckReport {
    const wanted = new Set(ids ?? []);
    const accepted = report.findings.filter(
        (finding) => finding.id !== undefined && wanted.has(finding.id),
    );

    if (accepted.length === 0) {
        return report;
    }

    const rest = report.findings.filter((finding) => !accepted.includes(finding));
    const byRule: CheckReport["summary"]["byRule"] = {};

    for (const finding of rest) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    }

    return {
        ...report,
        findings: rest,
        accepted,
        summary: {
            ...report.summary,
            errors: rest.filter((finding) => finding.level === "error").length,
            warnings: rest.filter((finding) => finding.level === "warning").length,
            byRule,
            accepted: accepted.length,
        },
    };
}

/** The sentence of a report that says what was left unjudged, or nothing when everything was judged. */
export function notJudgedText(report: CheckReport): string | undefined {
    const left = report.summary.notJudged?.contrast;

    return left === undefined || left.count <= 0
        ? undefined
        : `Contrast not judged on ${plural(left.count, "element")} (what is behind the text is not certain: a gradient, an image, an overlay, a filter, or a faded parent)${left.elements.length > 0 ? `: ${left.elements.join(", ")}${left.count > left.elements.length ? ", …" : ""}` : ""}.`;
}

/** What was not judged, over several reports (slides): the most, with the elements of each, up to 8. */
export function mergeNotJudged(
    reports: CheckReport[],
): { count: number; elements: string[] } | undefined {
    const all = reports
        .map((report) => report.summary.notJudged?.contrast)
        .filter((each) => each !== undefined);

    return all.length === 0
        ? undefined
        : {
              count: Math.max(...all.map((each) => each.count)),
              elements: [...new Set(all.flatMap((each) => each.elements))].slice(0, 8),
          };
}

/**
 * The mode to check the loaded page against: the one asked for, else the `data-theme` the page's root really has when
 * that is a mode of the system, else `picked`.
 */
export async function renderedMode(
    page: DesignPage,
    system: DesignSystem | undefined,
    asked: string | undefined,
    picked: string | undefined,
): Promise<string | undefined> {
    if (asked !== undefined) {
        return picked;
    }

    const theme = await page.evaluateIsolated(
        "document.documentElement.getAttribute('data-theme')",
    );

    return typeof theme === "string" && system?.modes.includes(theme) ? theme : picked;
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
        analyze(raw, tokens, { deck, phone: view.viewport.width < 600 }),
        { viewport: view.viewport, colorScheme, mode: picked?.mode },
        num(raw.elements),
        system === undefined,
        raw.notJudged === undefined
            ? undefined
            : {
                  count: num(raw.notJudged.count),
                  elements: (Array.isArray(raw.notJudged.elements) ? raw.notJudged.elements : [])
                      .slice(0, 8)
                      .map((each) => clip(each, 500)),
              },
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
        const mode = await renderedMode(page, system, options.mode, picked?.mode);
        const view = { viewport, colorScheme, mode };

        if (!(await page.isDeck())) {
            return acceptFindings(await checkPage(page, system, view), options.accepted);
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

        return acceptFindings(
            reportOf(
                findings,
                { viewport, colorScheme, mode },
                reports.reduce((total, report) => total + report.summary.elements, 0),
                system === undefined,
                mergeNotJudged(reports),
            ),
            options.accepted,
        );
    });
}
