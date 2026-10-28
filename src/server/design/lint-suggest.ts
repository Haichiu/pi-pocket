/**
 * Which token a check suggests for a color (`lint.ts`): what a token is for (from its name), how a page uses a color,
 * and the rules that make a suggestion one that a person can follow.
 *
 * 1. A token that is the same color, to the last digit, wins. Among those: a token of the role that the use has (text for
 *    text, a ground for a background, a border for a border), then a semantic token with no role (an accent), then a palette
 *    step, then a token of another role, and a component's own token last.
 * 2. A color that no token equals gets the nearest token of the use's role, or a roleless token (never a component's token,
 *    which belongs to one component), that stays in its hue family: a neutral gets a neutral, a chromatic color gets a color
 *    within a limit of hue. A token of another role is the last resort, in the same hue family, and the message says so.
 * 3. A color that fails a contrast gets a passing token by the same rules; if none of its hue passes, a token of the text
 *    (or border) role, and the message says that the hue changes.
 */
import { colorDistance, type RgbaTuple, toOklab, type TokenSet } from "./lint-color.ts";

/** Two colors this close (see `colorDistance`) are the same: a little over 2 steps of 8 bits. */
export const SAME_COLOR = 1;
/** A nearest token farther than this is no help as a suggestion. */
export const FAR_COLOR = 20;

/** The same color to the last digit: the same 8-bit channels and (within a rounding) the same alpha. */
export const sameBytes = (a: readonly number[], b: readonly number[]) =>
    Math.round(a[0]!) === Math.round(b[0]!) &&
    Math.round(a[1]!) === Math.round(b[1]!) &&
    Math.round(a[2]!) === Math.round(b[2]!) &&
    Math.abs((a[3] ?? 1) - (b[3] ?? 1)) <= 0.005;
/** Chroma (OKLCH) under which a color is a neutral, and the most chroma that a token may have to stand in for one. */
const NEUTRAL = 0.04;
const NEUTRAL_TOKEN = 0.07;
/** The most that the hue (degrees, OKLCH) may differ for a chromatic color. */
const HUE_LIMIT = 25;

export type Token = TokenSet["colors"][number];
export type Nearest = { token: Token; distance: number; exact: boolean };

/** What a color token is for, by the words of its path: a border, text on a ground, or a ground. None for a palette step. */
export type ColorRole = "text" | "background" | "border";

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

/** How a page uses a color (`useColor` in the page script) as a token role. */
export const USE_ROLE: Record<string, ColorRole> = {
    text: "text",
    background: "background",
    border: "border",
    outline: "border",
};

/** The CSS property that a use of a color sets, for the edit that a message names. */
export const USE_PROPERTY: Record<string, string> = {
    text: "color",
    background: "background-color",
    border: "border-color",
    outline: "outline-color",
};

/** The properties that can hold a color of each use, longhands and the shorthands that carry one (`fix.properties`). */
export const USE_PROPERTIES: Record<string, string[]> = {
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

/** Chroma and hue (degrees) of a color in OKLCH. */
function lch(color: readonly number[]): { c: number; h: number } {
    const [, a, b] = toOklab(color[0]!, color[1]!, color[2]!);

    return { c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * The hue of the system's own neutrals: the most common hue (in 30 degree bins) among its tokens with a little chroma, as a
 * grey with a tint is (Tokyo Night's blue-greys). A neutral color may take a tinted token only of that hue, so that a grey
 * border does not become a teal one.
 */
const neutralHues = new WeakMap<TokenSet, number | undefined>();

function neutralHue(set: TokenSet): number | undefined {
    if (!neutralHues.has(set)) {
        const bins = new Map<number, number>();

        for (const token of set.colors) {
            if (token.rgba === undefined) {
                continue;
            }

            const { c, h } = lch(token.rgba);

            if (c >= 0.01 && c <= NEUTRAL_TOKEN) {
                bins.set(Math.floor(h / 30), (bins.get(Math.floor(h / 30)) ?? 0) + 1);
            }
        }

        const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];

        neutralHues.set(set, top === undefined ? undefined : top[0] * 30 + 15);
    }

    return neutralHues.get(set);
}

/** Whether a token stays in the color's hue family: a neutral for a neutral, a near hue for a chromatic color. */
export function sameFamily(
    color: readonly number[],
    token: readonly number[],
    neutral?: number,
): boolean {
    const wanted = lch(color);
    const given = lch(token);

    if (wanted.c < NEUTRAL) {
        return (
            given.c <= 0.015 ||
            (given.c <= NEUTRAL_TOKEN && (neutral === undefined || hueGap(given.h, neutral) <= 25))
        );
    }

    // A chromatic color keeps its hue and a good part of its chroma: a tinted grey is not a blue.
    return (
        given.c >= Math.max(NEUTRAL / 2, wanted.c * 0.4) && hueGap(wanted.h, given.h) <= HUE_LIMIT
    );
}

/**
 * How well a token's kind fits a use, lower is better: a token of the role (0), a semantic token with no role (1), a palette
 * step (2), a token of another role (3), a component's own token (4: it is for that component's elements only).
 */
function rank(token: Token, role: ColorRole | undefined): number {
    const own = colorRoleOf(token.name);

    if (token.tier === "component") {
        return 4;
    }

    if (role !== undefined && own === role) {
        return 0;
    }

    if (own === undefined) {
        return token.tier === "semantic" ? 1 : 2;
    }

    return role === undefined ? 1 : 3;
}

/** Among tokens of one rank: a token whose path names the role itself (text, bg, border) before one that only implies it (on-fill). */
function strength(token: Token, role: ColorRole | undefined): number {
    const words = token.name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/);
    const named = {
        text: ["text"],
        background: ["bg", "background", "surface"],
        border: ["border"],
    }[role ?? "text"];

    return words.some((word) => named.includes(word)) ? 0 : 1;
}

/** The tokens that have a color of their own (not a reference left open). */
const colored = (set: TokenSet) => set.colors.filter((token) => token.rgba !== undefined);

/**
 * The token that a color equals to the last digit, by `rank` (a role token, an accent, a palette step, a token of another
 * role, a component's). `worst` is the highest rank that may answer (3 by default: a token of another role is still the
 * same color).
 */
export function exactColorToken(
    set: TokenSet,
    color: RgbaTuple,
    use: string | undefined,
    worst = 4,
): Token | undefined {
    const role = use === undefined ? undefined : USE_ROLE[use];

    return colored(set)
        .filter((token) => sameBytes(color, token.rgba!) && rank(token, role) <= worst)
        .sort(
            (a, b) =>
                rank(a, role) - rank(b, role) ||
                strength(a, role) - strength(b, role) ||
                a.name.localeCompare(b.name),
        )[0];
}

/**
 * The token to suggest for `color`, as a use (text, background, border, outline) sets it. An exact match first; else the
 * nearest token that fits the use and stays in the hue family; else a token of another role in the family, nearly the same
 * color. Never a component's token unless it is the same color. `undefined` when no token is close and in family.
 */
export function nearestColor(set: TokenSet, color: RgbaTuple, use?: string): Nearest | undefined {
    const role = use === undefined ? undefined : USE_ROLE[use];
    // The same color in a token that fits the use (a role token, an accent, a palette step) wins at once.
    const exact = exactColorToken(set, color, use, 2);

    if (exact !== undefined) {
        return { token: exact, distance: 0, exact: true };
    }

    const pick = (tokens: Token[]): Nearest | undefined => {
        let best: Nearest | undefined;

        for (const token of tokens) {
            const distance = colorDistance(color, token.rgba!);

            if (distance > FAR_COLOR || !sameFamily(color, token.rgba!, neutralHue(set))) {
                continue;
            }

            // A role token wins over a nearer one that is only a palette step, unless that one is much nearer.
            const adjusted = distance + rank(token, role) * 4;

            if (best === undefined || adjusted < best.distance) {
                best = { token, distance: adjusted, exact: false };
            }
        }

        return best && { ...best, distance: colorDistance(color, best.token.rgba!) };
    };

    const fits = colored(set).filter((token) => {
        const level = rank(token, role);

        return level <= 2;
    });
    const found = pick(fits);

    if (found !== undefined) {
        return found;
    }

    // Nothing that fits is close: the same color in a token of another role (or a component's), or a nearby token of
    // another role in the family. The message says that its role differs.
    const other = exactColorToken(set, color, use);

    if (other !== undefined) {
        return { token: other, distance: 0, exact: true };
    }

    return pick(colored(set).filter((token) => rank(token, role) === 3));
}

/**
 * How a token differs from the color that it replaces, in words: `slightly darker`, `lighter`, `much different in hue`.
 * Said when a suggestion changes the value, so that the edit is not a surprise.
 */
export function difference(color: RgbaTuple, token: RgbaTuple): string {
    const [l1] = toOklab(color[0], color[1], color[2]);
    const [l2] = toOklab(token[0], token[1], token[2]);
    const distance = colorDistance(color, token);
    const degree = distance < 3 ? "slightly " : distance < 8 ? "" : "much ";
    const lightness = l2 - l1;

    return Math.abs(lightness) > 0.01
        ? `${degree}${lightness < 0 ? "darker" : "lighter"}`
        : `${degree}different in hue, at the same lightness`;
}

/** WCAG contrast, passed in so that this file stays about tokens. */
export type Contrast = (a: readonly number[], b: readonly number[]) => number;

/**
 * A token that reaches `needed` contrast on `back`, for a use: by the rules of `nearestColor` (role, hue family, no
 * component's token). When none in the color's hue family passes, the nearest token of the use's role that passes, with
 * `sameHue` false so that the message can say that the hue changes.
 */
export function nearestPassing(
    set: TokenSet,
    fg: RgbaTuple,
    back: [number, number, number],
    needed: number,
    contrast: Contrast,
    use = "text",
): { token: Token; distance: number; ratio: number; sameHue: boolean } | undefined {
    const role = USE_ROLE[use];
    const passing = colored(set).filter(
        (token) =>
            token.rgba![3] >= 0.99 &&
            token.tier !== "component" &&
            contrast(token.rgba!, back) >= needed,
    );

    const best = (tokens: Token[], family: boolean) => {
        let found: { token: Token; distance: number; ratio: number; sameHue: boolean } | undefined;

        for (const token of tokens) {
            if (family && !sameFamily(fg, token.rgba!, neutralHue(set))) {
                continue;
            }

            const distance = colorDistance(fg, token.rgba!) + rank(token, role) * 4;

            if (found === undefined || distance < found.distance) {
                found = { token, distance, ratio: contrast(token.rgba!, back), sameHue: family };
            }
        }

        return found;
    };

    return (
        best(
            passing.filter((token) => rank(token, role) <= 2),
            true,
        ) ??
        best(
            passing.filter((token) => colorRoleOf(token.name) === role),
            false,
        )
    );
}
