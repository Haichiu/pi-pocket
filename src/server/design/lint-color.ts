import { colorObjectCss, contrastRatio, toHex } from "./color.ts";
import type { DesignSystem, ModeValue, ResolvedToken } from "./system-types.ts";

export type RgbaTuple = [number, number, number, number];

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** sRGB (0 to 255) to OKLab, by Björn Ottosson's matrices. */
export function toOklab(red: number, green: number, blue: number): [number, number, number] {
    const linear = (channel: number) => {
        const value = channel / 255;

        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };

    const r = linear(red);
    const g = linear(green);
    const b = linear(blue);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

// The OKLab distance times 100: about 1 is the smallest step a person sees, 0.4 is one 8-bit step. The alpha difference in percent is added.
export function colorDistance(a: RgbaTuple, b: RgbaTuple): number {
    const [l1, a1, b1] = toOklab(a[0], a[1], a[2]);
    const [l2, a2, b2] = toOklab(b[0], b[1], b[2]);
    const lab = Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;

    return lab + Math.abs(a[3] - b[3]) * 100;
}

export function contrastOf(a: readonly number[], b: readonly number[]): number {
    const color = (value: readonly number[]) => ({
        r: value[0]! / 255,
        g: value[1]! / 255,
        b: value[2]! / 255,
        a: 1,
    });

    return contrastRatio(color(a), color(b));
}

export function formatColor(color: readonly number[]): string {
    const alpha = color[3] ?? 1;
    const channels = [color[0]!, color[1]!, color[2]!].map((value) =>
        Math.round(clamp(value, 0, 255)),
    );

    if (alpha >= 0.995) {
        return toHex({ r: channels[0]! / 255, g: channels[1]! / 255, b: channels[2]! / 255, a: 1 });
    }

    return `rgb(${channels.join(" ")} / ${Math.round(alpha * 100) / 100})`;
}

export function colorCss(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value.startsWith("{") || value.length > 200 ? undefined : value;
    }

    const css = colorObjectCss(value);

    if ("css" in css) {
        return css.css;
    }

    const hex = (value as { hex?: unknown } | null)?.hex;

    return typeof hex === "string" ? hex : undefined;
}

export function dimensionCss(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return `${value}px`;
    }

    if (typeof value === "string") {
        return /^[-+0-9.a-z%(), *\/]+$/i.test(value) && value.length <= 120 ? value : undefined;
    }

    if (typeof value === "object" && value !== null) {
        const { value: amount, unit } = value as { value?: unknown; unit?: unknown };

        if (typeof amount === "number" && Number.isFinite(amount) && typeof unit === "string") {
            return /^[a-z%]{1,5}$/i.test(unit) ? `${amount}${unit}` : undefined;
        }
    }

    return undefined;
}

export function familyList(value: string): string[] {
    const names: string[] = [];
    let current = "";
    let quote = "";

    for (const character of value) {
        if (quote !== "") {
            if (character === quote) {
                quote = "";
            } else {
                current += character;
            }
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === ",") {
            names.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    names.push(current);

    return names.map((name) => name.trim().toLowerCase()).filter((name) => name !== "");
}

const GENERIC_FAMILIES = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
]);

export function isGenericFamily(name: string): boolean {
    return GENERIC_FAMILIES.has(name);
}

export type LengthKind = "font-size" | "space" | "radius";

export interface TokenColor {
    name: string;
    cssVar: string;
    tier: ResolvedToken["tier"];
    css: string;
    rgba?: RgbaTuple;
}

export interface TokenFont {
    name: string;
    cssVar: string;
    families: string[];
}

export interface TokenLength {
    kind: LengthKind;
    name: string;
    cssVar: string;
    css: string;
    px?: number;
}

export interface TokenSet {
    mode: string;
    colors: TokenColor[];
    fonts: TokenFont[];
    lengths: TokenLength[];
}

const SPACE_GROUP = /^(space|spaces|spacing|gap|gaps|gutter|inset)$/i;
const RADIUS_GROUP = /^(radius|radii|rounded|corner|corners|round)$/i;
const FONT_GROUPS = /^(font|fonts|text|type|typography|fontsize|fontsizes|font-size|font-sizes)$/i;
const SIZE_NAME = /^(size|sizes|fontsize|font-size|fontsizes|font-sizes|fs)$/i;

export function lengthKind(path: string[]): LengthKind | undefined {
    const names = path.slice(0, -1).concat(path.at(-1) ?? "");

    if (names.some((name) => RADIUS_GROUP.test(name))) {
        return "radius";
    }

    if (names.some((name) => SPACE_GROUP.test(name))) {
        return "space";
    }

    if (
        names.some((name) => /^(fontsize|fontsizes|font-size|font-sizes|fs)$/i.test(name)) ||
        (names.some((name) => SIZE_NAME.test(name)) &&
            names.some((name) => FONT_GROUPS.test(name))) ||
        (path.length > 1 && /^(text|type)$/i.test(path[0]!) && !names.some(isNonSize))
    ) {
        return "font-size";
    }

    return undefined;
}

const isNonSize = (name: string) =>
    /^(weight|leading|line-?height|tracking|spacing|family)$/i.test(name);

const valueIn = (token: ResolvedToken, mode: string): ModeValue | undefined =>
    token.modes[mode] ?? Object.values(token.modes)[0];

function fontFamilies(value: unknown): string[] {
    if (typeof value === "string") {
        return familyList(value);
    }

    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === "string").map((item) => item.toLowerCase());
    }

    return [];
}

export function tokenSet(system: DesignSystem, mode: string): TokenSet {
    const set: TokenSet = { mode, colors: [], fonts: [], lengths: [] };
    const seen = new Set<string>();

    const addLength = (token: ResolvedToken, kind: LengthKind, value: unknown, suffix = "") => {
        const css = dimensionCss(value);

        if (css !== undefined && !seen.has(`${token.name}${suffix}`)) {
            seen.add(`${token.name}${suffix}`);
            set.lengths.push({ kind, name: token.name, cssVar: token.cssVar, css });
        }
    };

    for (const token of system.tokens) {
        const entry = valueIn(token, mode);

        if (entry === undefined) {
            continue;
        }

        if (token.type === "color") {
            const css = entry.css.startsWith("var(") ? colorCss(entry.value) : entry.css;

            if (css !== undefined) {
                set.colors.push({ name: token.name, cssVar: token.cssVar, tier: token.tier, css });
            }
        } else if (token.type === "fontFamily") {
            const families = fontFamilies(entry.value);

            if (families.length > 0) {
                set.fonts.push({ name: token.name, cssVar: token.cssVar, families });
            }
        } else if (token.type === "dimension" && token.tier !== "component") {
            const kind = lengthKind(token.path);

            if (kind !== undefined) {
                addLength(token, kind, entry.value);
            }
        } else if (token.type === "typography") {
            const fontSize = (entry.value as { fontSize?: unknown } | null)?.fontSize;

            if (fontSize !== undefined) {
                addLength(token, "font-size", fontSize, "#size");
            }
        }
    }

    return set;
}
