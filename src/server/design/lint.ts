/**
 * Design checks (docs/design/design-system.md, "Verification"): render a design in the private Chromium, walk its DOM
 * once, and compare what it uses with the design system's tokens (colors, fonts, sizes), then check contrast, tap
 * targets, overflow, images, headings, fonts, the viewport, `data-pid`s, and focus styles.
 *
 * Precision matters more than recall: a finding is reported only when the page's own values prove it. Equal values on
 * many elements are one finding with a count in its message. The page is untrusted: everything that comes back from
 * it is shape-checked and bounded before it is used.
 */
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";
import {
    colorDistance,
    contrastRatio,
    familyList,
    formatColor,
    isGenericFamily,
    type LengthKind,
    type Rgba,
    tokenSet,
    type TokenSet,
} from "./color.ts";
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
     * The system mode to compare with. Default: `dark` for a dark color scheme when the system has that mode, else the
     * system's default mode. A mode that is not the default also sets `data-theme` on the page's root, if it sets none.
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
    "heading-order",
    "missing-pid",
];
/** Two colors this close (see `colorDistance`) are the same. About 2 steps of 8 bits. */
const SAME_COLOR = 1.5;
/** A nearest token farther than this is no help as a suggestion. */
const FAR_COLOR = 20;
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

const rgbaOf = (value: unknown): Rgba | undefined =>
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

/** The mode of `system` that a check at `colorScheme` compares with. */
export function modeFor(
    system: DesignSystem,
    colorScheme: "light" | "dark",
    mode?: string,
): { mode: string; theme?: string } {
    if (mode !== undefined) {
        if (!system.modes.includes(mode)) {
            throw new Error(
                `The design system has no mode "${mode}". Modes: ${system.modes.join(", ")}.`,
            );
        }

        return mode === system.modes[0] ? { mode } : { mode, theme: mode };
    }

    if (colorScheme === "dark" && system.modes.includes("dark") && system.modes[0] !== "dark") {
        return { mode: "dark", theme: "dark" };
    }

    return { mode: system.modes[0] ?? "light" };
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

/** Names that say what a color token is for, by how the page uses a color. */
const ROLE_NAMES: Record<string, RegExp> = {
    text: /text|fg|foreground|content|ink/i,
    background: /bg|background|surface|fill|canvas/i,
    border: /border|line|divider|stroke|outline|ring/i,
    outline: /focus|ring|outline|border/i,
};

/**
 * The nearest color token to `color`: the closest, a role before a palette value when two are as near. With a `role`
 * (how the page uses the color), tokens named for another role are left out (a border is not a background), and one
 * named for this role counts as a little nearer.
 */
function nearestColor(set: TokenSet, color: Rgba, role?: string): Nearest | undefined {
    const own = role === undefined ? undefined : ROLE_NAMES[role];
    const others = Object.entries(ROLE_NAMES)
        .filter(([name]) => name !== role)
        .map(([, pattern]) => pattern);
    const pool =
        own === undefined
            ? set.colors
            : set.colors.filter(
                  (token) =>
                      own.test(token.name) || !others.some((pattern) => pattern.test(token.name)),
              );

    let best: Nearest | undefined;

    for (const token of pool) {
        if (token.rgba === undefined) {
            continue;
        }

        const distance =
            colorDistance(color, token.rgba) - (own !== undefined && own.test(token.name) ? 3 : 0);

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
}

/** The length tokens of a kind, with a pixel value. */
const lengthsOf = (set: TokenSet, kind: LengthKind) =>
    set.lengths.filter(
        (token): token is typeof token & { px: number } =>
            token.kind === kind && token.px !== undefined,
    );

/** A color token that reaches `needed` contrast on `back`, as near to `fg` as any. */
function nearestPassing(set: TokenSet, fg: Rgba, back: [number, number, number], needed: number) {
    let best: { token: TokenSet["colors"][number]; distance: number; ratio: number } | undefined;

    for (const token of set.colors) {
        if (token.rgba === undefined || token.rgba[3] < 0.99) {
            continue;
        }

        const ratio = contrastRatio(token.rgba, back);

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

            if (nearest !== undefined && nearest.distance < SAME_COLOR) {
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

            add(
                {
                    rule: "off-system-color",
                    level: "error",
                    ...elementOf(group.el),
                    value,
                    ...(near === undefined ? {} : { suggestion: tokenRef(near.token) }),
                    message:
                        `${value} is not a system color (${roles}).` +
                        (near === undefined
                            ? " No token is close: pick a role from the system."
                            : ` Use ${tokenRef(near.token)} (${formatColor(near.token.rgba!)}).`),
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

            if (family === "" || allowed.has(family)) {
                continue;
            }

            const list = clip(group.list);
            const token = suggestFont(tokens, list);

            add(
                {
                    rule: "off-system-font",
                    level: "error",
                    ...elementOf(group.el),
                    value: list,
                    ...(token === undefined ? {} : { suggestion: tokenRef(token) }),
                    message:
                        `Font ${list} is not a system font (${plural(num(group.count), "element")}).` +
                        (token === undefined ? "" : ` Use ${tokenRef(token)}.`),
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

            if (scale.some((token) => Math.abs(token.px - px) <= SAME_LENGTH)) {
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

            add(
                {
                    rule: "off-system-size",
                    level: "warning",
                    ...elementOf(group.el),
                    value: `${px}px`,
                    suggestion: tokenRef(nearest),
                    message: `${props === "" ? kind : props} ${px}px is not on ${names[kind]} (${plural(num(group.count), "use")}). Nearest: ${tokenRef(nearest)} (${nearest.px}px).`,
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
            group.ui && typeof group.ratio === "number" ? group.ratio : contrastRatio(fg, bg);
        const needed = group.ui || group.large ? 3 : 4.5;

        if (ratio >= needed) {
            continue;
        }

        const shown = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

        if (group.ui) {
            add(
                {
                    rule: "contrast",
                    level: "warning",
                    ...elementOf(group.el),
                    value: shown,
                    message: `The edge of a form field is ${shown} against what it sits on; WCAG 1.4.11 needs 3:1. Give the border a stronger color${more(num(group.count))}.`,
                },
                num(group.count),
            );

            continue;
        }

        const swatch = (color: number[]) => formatColor(color);
        const pass =
            tokens === undefined
                ? undefined
                : nearestPassing(tokens, [...fg, 1] as Rgba, bg, needed);

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
                            ? " Darken the text or lighten the background."
                            : " No system color passes on this background: change the background."
                        : ` Use ${tokenRef(pass.token)} (${swatch(pass.token.rgba!)}, ${pass.ratio.toFixed(2)}:1).`),
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
                        ? `A <${clip(group.tag, 20)}> target is ${width}×${height} px, under the 24×24 px minimum of WCAG 2.2, and other targets are too close${more(num(group.count))}. Add padding or space.`
                        : `A <${clip(group.tag, 20)}> target is ${width}×${height} px; 44×44 px is easier to hit on a phone${more(num(group.count))}.`,
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
                message: `An image has ${clip(group.why, 60)}${more(num(group.count))}. Describe it in alt, or use alt="" if it is decoration.`,
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
            message: `A heading jumps from level ${num(group.previous)} to ${num(group.level)}. Use level ${num(group.previous) + 1}, and style it with CSS.`,
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

    return out
        .sort(
            (a, b) =>
                (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1) ||
                RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
                b.weight - a.weight,
        )
        .map(({ weight: _weight, ...finding }) => finding);
}

/** A report for findings. */
export function reportOf(
    findings: CheckFinding[],
    view: { viewport: DesignViewport; colorScheme: "light" | "dark" },
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
    const colorScheme = view.colorScheme ?? "light";
    const tokens =
        system === undefined
            ? undefined
            : tokenSet(system, modeFor(system, colorScheme, view.mode).mode);
    const deck = await page.isDeck();
    const input: PageInput = {
        tokenColors: tokens?.colors.map((token) => token.css) ?? [],
        tokenLengths: tokens?.lengths.map((token) => ({ css: token.css, kind: token.kind })) ?? [],
        deck,
        touch: view.viewport.width < 768,
    };
    const raw = (await page.evaluateIsolated(`(${PAGE_SCRIPT})(${JSON.stringify(input)})`)) as
        RawPage | undefined;

    if (raw === undefined || raw === null || typeof raw !== "object") {
        throw new Error("The page check returned nothing.");
    }

    return reportOf(
        analyze(raw, tokens, { deck }),
        { viewport: view.viewport, colorScheme },
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
    const colorScheme = options.colorScheme ?? "light";
    const picked = system === undefined ? undefined : modeFor(system, colorScheme, options.mode);

    return withRender(bundle, host, signal, async (page) => {
        await page.load(viewport, { page: options.page });
        await page.applyView({ colorScheme, theme: picked?.theme, tweaks: options.tweaks });
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
            { viewport, colorScheme },
            reports.reduce((total, report) => total + report.summary.elements, 0),
            system === undefined,
        );
    });
}
