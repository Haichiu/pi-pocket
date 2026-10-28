/** The colors of the scan (stream T): the roles a color can play, and the merging of near-identical colors into one entry that counts how each was used. */
import { parseColor, type Rgba, toOklch } from "./color.ts";
import { type ColorFact } from "./scan-facts.ts";

/** A list of words from one string. */
export const w = (text: string) => text.split(" ");

export type RoleName =
    | "background"
    | "surface"
    | "text"
    | "muted"
    | "border"
    | "accent"
    | "danger"
    | "warning"
    | "success";

export const ROLE_PATHS: Record<RoleName, string[]> = {
    background: ["color", "bg", "page"],
    surface: ["color", "bg", "surface"],
    text: ["color", "text", "primary"],
    muted: ["color", "text", "muted"],
    border: ["color", "border", "default"],
    accent: ["color", "accent", "default"],
    danger: ["color", "danger", "default"],
    warning: ["color", "warning", "default"],
    success: ["color", "success", "default"],
};

export const ROLES = Object.keys(ROLE_PATHS) as RoleName[];

/** A color of the project and what is known about it. */
export interface ColorEntry {
    hex: string;
    rgba: Rgba;
    l: number;
    c: number;
    h: number;
    /** The Oklab a and b, kept so that a distance costs no trigonometry. */
    la: number;
    lb: number;
    /** Literal uses in declarations, all kinds. */
    uses: number;
    /** Uses by kind and the page-root evidence (see `ColorFact`). */
    fact: ColorFact | undefined;
    /** Variable names that hold this value, with how often each is referenced. */
    names: { name: string; uses: number }[];
    /** The authored text that is used most. */
    text: string;
}

export const entryOf = (hex: string, text = hex): ColorEntry | undefined => {
    const rgba = parseColor(hex);

    if (rgba === undefined) {
        return undefined;
    }

    const { l, c, h } = toOklch(rgba);
    const rad = (h * Math.PI) / 180;

    return {
        hex,
        rgba,
        l,
        c,
        h,
        la: c * Math.cos(rad),
        lb: c * Math.sin(rad),
        uses: 0,
        fact: undefined,
        names: [],
        text,
    };
};

/**
 * Whether two colors are one color to a designer: a hair apart (about two levels of a channel), or the same gray a shade
 * apart (a lightness difference alone, up to about three levels: `#ddd` and `#e0e0e0`). Pure white and pure black are
 * decisions, not shades: only a level apart is the same.
 */
export function nearColors(a: ColorEntry, b: ColorEntry, threshold = 0.0065): boolean {
    if ([a.hex, b.hex].some((hex) => hex === "#ffffff" || hex === "#000000")) {
        return distance(a, b) < Math.min(threshold, 0.003);
    }

    const chroma = Math.hypot(a.la - b.la, a.lb - b.lb);

    return distance(a, b) < threshold || (chroma < 0.004 && Math.abs(a.l - b.l) < 0.0095);
}

/** The distance of two colors in Oklab (about 0.02 is just visible). */
export function distance(a: ColorEntry, b: ColorEntry): number {
    return Math.hypot(a.l - b.l, a.la - b.la, a.lb - b.lb);
}

export const totalUses = (fact: ColorFact | undefined) =>
    fact === undefined ? 0 : fact.bg + fact.text + fact.border + fact.fill + fact.other;

/**
 * Folds the literal color uses into the colors that variables define (the variables are the project's own names, so
 * they are never merged with each other), and merges what is left of near-identical uses (`#3b82f6`, `#3b83f6`).
 * Returns the colors by hex.
 */
/** Colors kept from uses, and from variables. */
const MAX_COLORS = 300;

export function mergeColors(
    defined: { hex: string; text: string }[],
    uses: Map<string, ColorFact>,
    threshold = 0.0065,
): Map<string, ColorEntry> {
    const out = new Map<string, ColorEntry>();

    for (const color of defined.slice(0, MAX_COLORS * 2)) {
        if (!out.has(color.hex)) {
            const entry = entryOf(color.hex, color.text);

            if (entry !== undefined) {
                out.set(color.hex, entry);
            }
        }
    }

    // The colors that are used most: a draft needs the palette, not every shade a file ever wrote.
    const rest = [...uses.values()]
        .sort(
            (a, b) =>
                totalUses(b) - totalUses(a) || a.order - b.order || a.hex.localeCompare(b.hex),
        )
        .slice(0, MAX_COLORS);
    const pool = [...out.values()];

    for (const fact of rest) {
        const entry = entryOf(
            fact.hex,
            [...fact.forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fact.hex,
        );

        if (entry === undefined) {
            continue;
        }

        // Near a defined color, or near a more used one, or its own color.
        const target =
            out.get(fact.hex) ??
            pool.find(
                (other) =>
                    Math.abs(other.rgba.a - entry.rgba.a) < 0.05 &&
                    nearColors(other, entry, threshold),
            );

        if (target !== undefined) {
            target.uses += totalUses(fact);
            target.fact = merge(target.fact, fact, target.hex);
        } else {
            entry.uses = totalUses(fact);
            entry.fact = merge(undefined, fact, entry.hex);
            pool.push(entry);
            out.set(entry.hex, entry);
        }
    }

    return out;
}

export function merge(into: ColorFact | undefined, more: ColorFact, hex: string): ColorFact {
    const fact: ColorFact = into ?? {
        hex,
        forms: new Map(),
        bg: 0,
        text: 0,
        border: 0,
        fill: 0,
        shadow: 0,
        other: 0,
        root: 0,
        body: 0,
        surface: 0,
        order: more.order,
    };

    for (const key of [
        "bg",
        "text",
        "border",
        "fill",
        "shadow",
        "other",
        "root",
        "body",
        "surface",
    ] as const) {
        fact[key] += more[key];
    }

    for (const [form, count] of more.forms) {
        fact.forms.set(form, (fact.forms.get(form) ?? 0) + count);
    }

    if (fact.at === undefined && more.at !== undefined) {
        fact.at = more.at;
    }

    return fact;
}

// --- Names ----------------------------------------------------------------------------------------------------------
