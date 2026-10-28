/**
 * Colors for the design system scan (stream T): merges near-identical colors, decides which color plays which role
 * (page background, surface, text, muted text, border, accent, danger, warning, success) from the names of the
 * project's variables first and from how the colors are used second, and names the palette by hue and lightness.
 */
import { type Rgba, contrastRatio, parseColor, toOklch } from "./color.ts";
import type { ColorFact, Kinds } from "./scan-facts.ts";

/** A list of words from one string. */
const w = (text: string) => text.split(" ");

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

const ROLES = Object.keys(ROLE_PATHS) as RoleName[];

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

    return fact;
}

// --- Names ----------------------------------------------------------------------------------------------------------

/** The words of a variable name: camelCase split, lower case, noise words dropped. */
export function words(name: string): string[] {
    const all = name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[-_.\s]+/);
    // The prefixes of well-known libraries are no part of what a color is for (`--bs-body-bg`, `--ifm-color-primary`).
    const found = all.filter(
        (word) =>
            word !== "" &&
            !w(
                "color colour clr c theme tw ui sys md ref palette colors var bs ifm sl mui ant chakra mantine pico vt wp preset custom",
            ).includes(word),
    );

    // `secondary-color` and `tertiary-color` name quiet text: the word `color` says it is a text color.
    return all.at(-1) === "color" &&
        found.some((word) => w("secondary tertiary muted subtle dim faint quiet").includes(word)) &&
        !found.includes("bg") &&
        !found.includes("background") &&
        !found.includes("border")
        ? ["text", ...found]
        : found;
}

const STATE = new Set(
    w("hover active focus pressed disabled selected checked visited ring placeholder"),
);
const SURFACEISH = new Set(
    w(
        "surface card panel elevated raised container popover modal dialog sheet input button btn header footer nav navbar sidebar menu tooltip toast overlay code table row layer tile well component",
    ),
);
const OTHER_ROLE = new Set(
    w(
        "accent danger error warning success info brand destructive critical secondary tertiary link border outline divider",
    ),
);
/** A name made only of the role's own words, and short: `border`, `border-default`; not `divider-light-1`. */
const subset = (segs: string[], allowed: string[]) =>
    segs.length <= 2 && segs.every((seg) => allowed.includes(seg) || /^\d{1,3}$/.test(seg));
const has = (segs: string[], list: readonly string[]) => segs.some((seg) => list.includes(seg));

const VARIANT = w(
    "bg background subtle soft light lighter muted tint container border outline hover active focus pressed disabled faint",
);
const INK = ["foreground", "fg", "text", "on", "contrast", "inverse", "inverted", "content"];

/** How well a variable's name fits a role, 0 (not at all) to about 100. */
export function nameScore(role: RoleName, segs: string[]): number {
    if (
        segs.length === 0 ||
        segs.some((seg) =>
            w(
                "rgb hsl channels channel alpha opacity radius width shadow size font gradient",
            ).includes(seg),
        )
    ) {
        return 0;
    }

    const state = has(
        segs,
        [...STATE].filter((word) => word !== "placeholder"),
    );

    switch (role) {
        case "background": {
            // `body` alone is the body text in many systems (`--body`); `body-bg` is the page.
            const strong =
                (segs.includes("body") && has(segs, ["bg", "background"])) ||
                has(segs, ["bg", "background", "page", "canvas", "window", "root"]);
            const base = segs.includes("base") && segs.some((seg) => /^\d/.test(seg));

            if (state || has(segs, [...SURFACEISH, ...OTHER_ROLE]) || (!strong && !base)) {
                return 0;
            }

            // `bg-primary` is the page in many systems and the brand in others: the caller checks the color.
            return (
                (strong ? 70 : 55) +
                (subset(
                    segs,
                    w(
                        "bg background page canvas body base main app root default window primary 1 0",
                    ),
                )
                    ? 25
                    : 0)
            );
        }

        case "surface": {
            const named = has(
                segs,
                w(
                    "surface card panel elevated raised container popover layer sheet tile well paper component",
                ),
            );
            const layered =
                has(segs, ["bg", "background"]) &&
                has(segs, w("secondary alt subtle muted elevated raised tertiary soft mute"));
            const base = segs.includes("base") && segs.some((seg) => /^[2-9]\d{2}$/.test(seg));

            if (
                state ||
                has(segs, [
                    ...INK,
                    ...w(
                        "accent danger error warning success info brand link border outline divider",
                    ),
                ]) ||
                (!named && !layered && !base)
            ) {
                return 0;
            }

            return (
                (named ? 70 : layered ? 62 : 50) +
                (subset(
                    segs,
                    w(
                        "surface card panel bg background default elevated raised container secondary alt subtle muted popover",
                    ),
                )
                    ? 25
                    : 0)
            );
        }

        case "text": {
            const ink = has(segs, ["text", "fg", "foreground", "ink", "content", "copy"]);
            const onBase = segs.includes("on") && has(segs, ["surface", "background", "bg"]);
            const body =
                has(segs, ["body", "font"]) && segs.length <= 2 && !has(segs, ["bg", "background"]);

            if (
                state ||
                has(
                    segs,
                    w(
                        "muted secondary subtle dim dimmed faint tertiary disabled inverse inverted link heading quiet soft weak hint",
                    ),
                ) ||
                (has(
                    segs,
                    w(
                        "accent primary danger error warning success info brand destructive card popover sidebar",
                    ),
                ) &&
                    !subset(segs, ["text", "primary", "fg", "foreground", "default"])) ||
                (!ink && !onBase && !body)
            ) {
                return 0;
            }

            return (
                (ink ? 70 : onBase ? 62 : 42) +
                (subset(
                    segs,
                    w("text fg foreground primary default base main body ink content 1 0"),
                )
                    ? 25
                    : 0)
            );
        }

        case "muted": {
            const ink = has(segs, ["text", "fg", "foreground", "content", "ink"]);
            // `secondary` and `tertiary` also name a brand's second color, whose pair is `secondary-foreground`: they
            // are quiet text only when the text word comes first (`text-secondary`, `fg-tertiary`).
            const inkAt = segs.findIndex((seg) =>
                ["text", "fg", "foreground", "content", "ink"].includes(seg),
            );
            const weakAt = segs.findIndex((seg) => ["secondary", "tertiary"].includes(seg));
            const quiet =
                has(segs, w("muted subtle dim dimmed faint soft weak hint quiet caption meta")) ||
                (weakAt >= 0 && inkAt >= 0 && inkAt < weakAt);

            if (
                (state && !segs.includes("placeholder")) ||
                has(
                    segs,
                    w("bg background card surface border accent danger error warning success"),
                )
            ) {
                return 0;
            }

            if (quiet && ink) {
                return 80;
            }

            if (segs.includes("placeholder")) {
                return 50;
            }

            // Two (`text-2`, `fg-3`).
            if (ink && segs.some((seg) => /^[2-4]$/.test(seg))) {
                return 70;
            }

            // A name that is only the word is the quiet text; `muted` alone is often a tint of the background (shadcn).
            if (segs.length !== 1) {
                return 0;
            }

            return segs[0] === "muted"
                ? 45
                : w("subtle faint dim quiet weak hint").includes(segs[0]!)
                  ? 62
                  : 0;
        }

        case "border": {
            const named = has(
                segs,
                w("border outline divider separator stroke line hairline rule"),
            );

            if (
                !named ||
                state ||
                has(
                    segs,
                    w(
                        "radius width style focus accent primary danger error success warning bg background",
                    ),
                )
            ) {
                return 0;
            }

            return (
                70 +
                (subset(
                    segs,
                    w("border default base subtle muted light divider separator line color"),
                )
                    ? 25
                    : 0)
            );
        }

        case "accent": {
            const weights: Record<string, number> = {
                primary: 50,
                brand: 50,
                accent: 45,
                highlight: 30,
                key: 20,
                link: 25,
                cta: 25,
                action: 25,
                interactive: 25,
                main: 20,
                theme: 12,
            };
            const best = Math.max(0, ...segs.map((seg) => weights[seg] ?? 0));

            if (best === 0 || state || has(segs, INK) || has(segs, ["info"])) {
                return 0;
            }

            const variant = has(segs, VARIANT);
            // A step of a palette (`brand-500`) is the last choice, after a role name (`primary`); of the steps, the middle.
            const step = segs.some((seg) => /^\d{2,3}$/.test(seg));
            const middle = step
                ? segs.includes("500")
                    ? -9
                    : segs.includes("600")
                      ? -12
                      : -15
                : 0;

            return (
                best +
                30 +
                middle -
                (variant ? 40 : 0) +
                (subset(segs, w("accent primary brand default main 500 600 base link key"))
                    ? 10
                    : 0)
            );
        }

        case "danger":
        case "warning":

        case "success": {
            const table = {
                danger: [
                    w("danger error destructive critical negative invalid alert err"),
                    ["red"],
                ],
                warning: [
                    ["warning", "warn", "caution", "attention"],
                    ["amber", "orange", "yellow"],
                ],
                success: [
                    ["success", "positive", "valid", "ok", "confirm", "safe"],
                    ["green", "emerald"],
                ],
            } as const;
            const [named, hue] = table[role];

            if (state || has(segs, INK)) {
                return 0;
            }

            const base = has(segs, named) ? 70 : has(segs, hue) ? 48 : 0;

            if (base === 0) {
                return 0;
            }

            return (
                base -
                (has(segs, VARIANT) ? 28 : 0) +
                (subset(segs, [...named, ...hue, "default", "base", "main"]) ? 25 : 0)
            );
        }
    }
}

// --- Roles ----------------------------------------------------------------------------------------------------------

/** What decides a role's color. */
export interface RoleChoice {
    role: RoleName;
    hex: string;
    /** `name` when a variable's name chose it; `use` when how the color is used did. */
    basis: "name" | "use";
    /** The variable (or the usage) that chose it, for the report. */
    source: string;
    score: number;
}

export interface VarColor {
    name: string;
    hex: string;
    uses: number;
    /** How the variable is used as a color: as a background, as text, as a border. */
    kinds?: Kinds;
}

const hueOk = (role: RoleName, color: ColorEntry): boolean => {
    if (color.c < 0.06) {
        return false;
    }

    switch (role) {
        case "danger":
            return color.h >= 345 || color.h < 45;
        case "warning":
            return color.h >= 35 && color.h < 115;
        case "success":
            return color.h >= 105 && color.h < 185;
        default:
            return true;
    }
};

/**
 * Chooses a color for each role. Variable names come first (a variable called `--bg-surface` is the surface), the way
 * the colors are used second. `colors` are all the project's colors; `named` are those that variables hold.
 */
export function chooseRoles(
    colors: Map<string, ColorEntry>,
    named: VarColor[],
): Partial<Record<RoleName, RoleChoice>> {
    const chosen: Partial<Record<RoleName, RoleChoice>> = {};
    const entries = [...colors.values()];
    const byUse = (list: ColorEntry[], pick: (entry: ColorEntry) => number) =>
        [...list].sort(
            (a, b) => pick(b) - pick(a) || b.uses - a.uses || a.hex.localeCompare(b.hex),
        );

    const set = (
        role: RoleName,
        color: string,
        basis: "name" | "use",
        source: string,
        score: number,
    ) => {
        chosen[role] = { role, hex: color, basis, source, score };
    };

    const entry = (hex: string) => colors.get(hex);

    // 1. Names: the best fitting variable for each role, the page background first (the others are judged against it).
    const pickNamed = (
        role: RoleName,
        bg: ColorEntry | undefined,
    ): { variable: VarColor; score: number } | undefined => {
        let best: { variable: VarColor; score: number } | undefined;
        const scored: { variable: VarColor; score: number }[] = [];

        for (const variable of named) {
            const color = entry(variable.hex);
            const segs = words(variable.name);

            if (
                color === undefined ||
                Object.values(chosen).some(
                    (each) =>
                        each.hex === variable.hex &&
                        each.basis === "name" &&
                        each.source === variable.name,
                )
            ) {
                continue;
            }

            let score = nameScore(role, segs);

            if (score === 0) {
                continue;
            }

            // Sanity from the color itself.
            if (
                (role === "danger" || role === "warning" || role === "success") &&
                !hueOk(role, color)
            ) {
                score -= 45;
            }

            if (role === "accent") {
                // A color is the brand when it has a hue; a gray one (shadcn's hover surface) is not. How vivid it is only
                // breaks a tie: a muted brand `primary` still beats a vivid `accent-1`.
                score += color.c >= 0.03 ? 20 + Math.min(10, color.c * 40) : -10;

                // The role's own word beats a synonym, among colors that have a hue.
                if (
                    segs.includes("accent") &&
                    !segs.includes("primary") &&
                    !segs.includes("brand") &&
                    color.c >= 0.03
                ) {
                    score += 10;
                }

                // `accent-1`, `accent-2`: one of a set, not the role.
                if (segs.some((seg) => /^\d$/.test(seg))) {
                    score -= 15;
                }

                // A long name that only holds a role word (`tooltipExternalLinkColor`) is not the brand.
                const strangers = segs.filter(
                    (seg) =>
                        !/^\d+$/.test(seg) &&
                        !w(
                            "accent primary brand link highlight cta action interactive main theme key default base 500 600 text dark light hover active focus pressed",
                        ).includes(seg),
                );

                score -= Math.min(24, strangers.length * 8);
            }

            // How the variable is really used beats what it is called: a "text" color that paints the page is the page.
            const kinds = variable.kinds;

            if (kinds !== undefined) {
                const fill = kinds.bg;
                const ink = kinds.text;

                if ((role === "text" || role === "muted") && fill >= 2 && fill > ink * 2) {
                    score -= 45;
                } else if (
                    (role === "background" || role === "surface") &&
                    ink >= 2 &&
                    ink > fill * 2
                ) {
                    score -= 40;
                } else if (role === "border" && fill >= 3 && fill > kinds.border * 3) {
                    score -= 30;
                }
            }

            if (role === "background" && color.c > 0.1) {
                score -= 50;
            }

            if ((role === "text" || role === "muted") && bg !== undefined) {
                const ratio = contrastRatio(color.rgba, bg.rgba);

                score += ratio >= 4.5 ? 8 : ratio >= 3 ? 0 : -45;
            }

            // The most referenced variable wins a tie.
            score += Math.min(8, Math.log2(1 + variable.uses));

            scored.push({ variable, score });

            if (best === undefined || score > best.score) {
                best = { variable, score };
            }
        }

        // A surface that is the page's own color is no surface (`--surface-1` is the page, `--surface-2` the card): when
        // another surface has a different color, that one is the role.
        if (
            role === "surface" &&
            best !== undefined &&
            bg !== undefined &&
            best.variable.hex === bg.hex
        ) {
            const other = scored
                .filter((each) => each.variable.hex !== bg.hex && each.score >= 60)
                .sort((a, b) => b.score - a.score)[0];

            if (other !== undefined) {
                best = other;
            }
        }

        return best !== undefined && best.score >= 60 ? best : undefined;
    };

    const bgChoice = pickNamed("background", undefined);

    if (bgChoice !== undefined) {
        set("background", bgChoice.variable.hex, "name", bgChoice.variable.name, bgChoice.score);
    }

    // The page the text sits on: the named background, else the neutral color most used on the page's root. The text
    // and the quiet text are judged against it (a near-black `--ink` on a near-black page is not the text).
    const bg =
        chosen.background === undefined
            ? [...colors.values()]
                  .filter(
                      (color) =>
                          color.c < 0.06 && color.rgba.a > 0.9 && (color.fact?.root ?? 0) > 0,
                  )
                  .sort((a, b) => (b.fact?.root ?? 0) - (a.fact?.root ?? 0))[0]
            : entry(chosen.background.hex);

    // A name that fits two roles (`--muted`) goes to the role where the color makes sense.
    for (const role of ROLES.filter((each) => each !== "background")) {
        const found = pickNamed(role, bg);

        if (found !== undefined) {
            set(role, found.variable.hex, "name", found.variable.name, found.score);
        }
    }

    // `--muted` alone: text if it reads on the page, a surface if not.
    if (chosen.muted === undefined || chosen.surface === undefined) {
        const lone = named.find(
            (variable) =>
                variable.name.toLowerCase() === "muted" ||
                variable.name.toLowerCase() === "color-muted",
        );
        const color = lone === undefined ? undefined : entry(lone.hex);

        if (lone !== undefined && color !== undefined && bg !== undefined) {
            const text = contrastRatio(color.rgba, bg.rgba) >= 3 && distance(color, bg) > 0.2;

            if (text && chosen.muted === undefined) {
                set("muted", lone.hex, "name", lone.name, 62);
            } else if (
                !text &&
                chosen.surface === undefined &&
                lone.hex !== chosen.background?.hex
            ) {
                set("surface", lone.hex, "name", lone.name, 62);
            }
        }
    }

    // 2. Use: what the names did not settle.
    const neutral = entries.filter((color) => color.c < 0.06 && color.rgba.a > 0.9);
    const pageSource = (hex: string) => `used on the page ${hex}`;

    if (chosen.background === undefined) {
        const top =
            byUse(
                neutral.filter((color) => (color.fact?.root ?? 0) > 0),
                (color) => color.fact?.root ?? 0,
            )[0] ??
            byUse(
                neutral.filter((color) => (color.fact?.bg ?? 0) > 0),
                (color) => color.fact?.bg ?? 0,
            )[0];

        if (top !== undefined) {
            set("background", top.hex, "use", pageSource(top.hex), 40);
        }
    }

    const page = chosen.background === undefined ? undefined : entry(chosen.background.hex);
    const used = (hex: string) => Object.values(chosen).some((each) => each.hex === hex);

    if (chosen.surface === undefined && page !== undefined) {
        const top = byUse(
            neutral.filter(
                (color) =>
                    !used(color.hex) &&
                    (color.fact?.bg ?? 0) > 0 &&
                    distance(color, page) > 0.012 &&
                    distance(color, page) < 0.3,
            ),
            // A background on a card or a panel counts three times.
            (color) => (color.fact?.surface ?? 0) * 3 + (color.fact?.bg ?? 0),
        )[0];

        if (top !== undefined) {
            set("surface", top.hex, "use", "most used background of cards and panels", 35);
        }
    }

    if (chosen.text === undefined) {
        const candidates = entries.filter(
            (color) =>
                !used(color.hex) &&
                color.rgba.a > 0.9 &&
                color.c < 0.1 &&
                (color.fact?.text ?? 0) > 0 &&
                (page === undefined || contrastRatio(color.rgba, page.rgba) >= 4.5),
        );
        const top = byUse(
            candidates,
            (color) => (color.fact?.body ?? 0) * 3 + (color.fact?.text ?? 0),
        )[0];

        if (top !== undefined) {
            set("text", top.hex, "use", "most used text color", 40);
        }
    }

    const ink = chosen.text === undefined ? undefined : entry(chosen.text.hex);

    if (chosen.muted === undefined && ink !== undefined && page !== undefined) {
        const top = byUse(
            entries.filter((color) => {
                const ratio = contrastRatio(color.rgba, page.rgba);

                return (
                    !used(color.hex) &&
                    color.rgba.a > 0.9 &&
                    color.c < 0.1 &&
                    (color.fact?.text ?? 0) > 0 &&
                    ratio >= 3 &&
                    ratio < contrastRatio(ink.rgba, page.rgba) - 0.5
                );
            }),
            // A quiet text is a gray: a tinted color (a light link color) is a weaker candidate than a gray.
            // A quiet text is also clearly softer than the body text.
            (color) =>
                (color.fact?.text ?? 0) *
                (color.c < 0.05 ? 1 : 0.3) *
                (contrastRatio(color.rgba, page.rgba) <= contrastRatio(ink.rgba, page.rgba) * 0.7
                    ? 1
                    : 0.5),
        )[0];

        if (top !== undefined) {
            set("muted", top.hex, "use", "second most used text color", 35);
        }
    }

    if (chosen.border === undefined) {
        const top =
            byUse(
                neutral.filter((color) => !used(color.hex) && (color.fact?.border ?? 0) > 0),
                (color) => color.fact?.border ?? 0,
            )[0] ??
            byUse(
                entries.filter(
                    (color) => !used(color.hex) && color.c < 0.08 && (color.fact?.border ?? 0) > 0,
                ),
                (color) => color.fact?.border ?? 0,
            )[0];

        if (top !== undefined) {
            set("border", top.hex, "use", "most used border color", 35);
        }
    }

    const chroma = entries.filter((color) => color.c >= 0.07 && color.rgba.a > 0.9);

    if (chosen.accent === undefined) {
        const top = byUse(
            chroma.filter((color) => !used(color.hex)),
            (color) =>
                (color.fact?.bg ?? 0) * 1.4 +
                (color.fact?.text ?? 0) +
                (color.fact?.border ?? 0) +
                (color.fact?.fill ?? 0) +
                color.c * 5,
        )[0];

        if (top !== undefined) {
            set("accent", top.hex, "use", "most used chromatic color", 35);
        }
    }

    // The hue each status color sits nearest to (Oklch degrees): a red close to 27° is an error, not an orange.
    const centers = { danger: 27, warning: 70, success: 148 } as const;
    const accentColor = chosen.accent === undefined ? undefined : entry(chosen.accent.hex);

    for (const role of ["danger", "warning", "success"] as const) {
        if (chosen[role] === undefined) {
            const closeness = (color: ColorEntry) => {
                const gap = Math.abs(((color.h - centers[role] + 540) % 360) - 180);

                return 1 - Math.min(1, gap / 40);
            };

            const top = byUse(
                chroma.filter(
                    (color) =>
                        !used(color.hex) &&
                        hueOk(role, color) &&
                        color.c >= 0.1 &&
                        color.uses >= 1 &&
                        // A shade of the accent (near it, or of the same hue) is not a status color.
                        (accentColor === undefined ||
                            (distance(color, accentColor) > 0.06 &&
                                !(
                                    accentColor.c >= 0.07 &&
                                    Math.abs(((color.h - accentColor.h + 540) % 360) - 180) < 8
                                ))),
                ),
                (color) => Math.log2(1 + color.uses) * 2 + closeness(color) * 3,
            )[0];

            if (top !== undefined) {
                set(role, top.hex, "use", `used ${top.uses}× with the hue of ${role}`, 30);
            }
        }
    }

    return chosen;
}

// --- Palette names ----------------------------------------------------------------------------------------------------

/** The hue family of a color: `gray` when it has almost no chroma. */
export function family(color: { c: number; h: number }): string {
    if (color.c < 0.045) {
        return "gray";
    }

    const h = color.h;

    if (h >= 335 || h < 10) {
        return "pink";
    }

    const table: [number, string][] = [
        [40, "red"],
        [70, "orange"],
        [105, "yellow"],
        [135, "lime"],
        [170, "green"],
        [200, "teal"],
        [225, "cyan"],
        [270, "blue"],
        [295, "indigo"],
        [335, "purple"],
    ];

    return table.find(([limit]) => h < limit)![1];
}

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** The lightness step (50 lightest, 950 darkest) of a color, on the scale of Tailwind's palette. */
export function step(l: number): number {
    const limits: [number, number][] = [
        [0.976, 50],
        [0.9475, 100],
        [0.9, 200],
        [0.79, 300],
        [0.629, 400],
        [0.4985, 500],
        [0.41, 600],
        [0.3255, 700],
        [0.244, 800],
        [0.17, 900],
    ];

    return limits.find(([limit]) => l > limit)?.[1] ?? 950;
}

/**
 * Names primitives by family and step. `taken` is every path in use (joined by "."); a color whose name is taken moves
 * to the nearest free step. A translucent color keeps its alpha in the name.
 */
export function paletteName(color: ColorEntry, taken: Set<string>): string[] {
    // Pure white and pure black are not a step of anything.
    if (color.hex === "#ffffff" && !taken.has("color.white")) {
        return ["color", "white"];
    }

    if (color.hex === "#000000" && !taken.has("color.black")) {
        return ["color", "black"];
    }

    const fam = family(color);
    const alpha = color.rgba.a < 0.995 ? `-a${Math.round(color.rgba.a * 100)}` : "";
    const base = STEPS.indexOf(step(color.l) as (typeof STEPS)[number]);

    // The nearest free step, no farther than the next one: a color two steps off is a different color, so it takes a
    // suffix (`400-2`) instead of a wrong step.
    for (let offset = 0; offset <= 1; offset++) {
        for (const at of offset === 0 ? [base] : [base - offset, base + offset]) {
            if (at >= 0 && at < STEPS.length) {
                const path = ["color", fam, `${STEPS[at]}${alpha}`];

                if (!taken.has(path.join("."))) {
                    return path;
                }
            }
        }
    }

    let n = 2;

    while (taken.has(`color.${fam}.${STEPS[base]}${alpha}-${n}`)) {
        n += 1;
    }

    return ["color", fam, `${STEPS[base]}${alpha}-${n}`];
}
