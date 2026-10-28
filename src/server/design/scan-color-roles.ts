/** The color roles of the scan (stream T): a color for each role, from the names of the project's variables first and from how the colors are used second. */
import { contrastRatio } from "./color.ts";
import { type Kinds } from "./scan-facts.ts";
import { type ColorEntry, distance, type RoleName, ROLES, w } from "./scan-color-base.ts";
import { nameScore, words } from "./scan-color-names.ts";

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
    /** The platform whose naming this variable follows, when that says more than the name does. */
    platform?: "wordpress";
}

/**
 * The words of a variable's name. WordPress block themes call the page `base` and the text `contrast` (Twenty Twenty-Four
 * and after), which no other system reads that way.
 */
const wordsOf = (variable: VarColor): string[] => {
    const all = words(variable.name);

    if (variable.platform === "wordpress" && all.length === 1) {
        return all[0] === "base" ? ["bg"] : all[0] === "contrast" ? ["text"] : all;
    }

    return all;
};

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
    /** The hue of a status color that the other mode names (`--success` in the dark scope), to find its pair here. */
    hints: Partial<Record<"danger" | "warning" | "success", number>> = {},
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
            const segs = wordsOf(variable);

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

            // A color called `warn` that is red is the error color (Angular Material's `warn` palette).
            if (role === "danger" && score === 0 && color.c >= 0.1 && hueOk("danger", color)) {
                const asWarning = nameScore("warning", segs);

                score = asWarning > 0 ? asWarning - 15 : 0;
            }

            if (score === 0) {
                continue;
            }

            // Of a palette's steps, the middle one is the color (`warn-500`).
            if (
                (role === "danger" || role === "warning" || role === "success") &&
                segs.some((seg) => /^\d{3}$/.test(seg))
            ) {
                score += segs.includes("500") ? 8 : segs.includes("600") ? 5 : 0;
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

                // A quiet text a little under 3:1 (a gray on a gray page) is still quiet text; far under is not text.
                score += ratio >= 4.5 ? 8 : ratio >= 3 ? 0 : ratio >= 2.5 ? -18 : -45;
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
            (color) => (color.fact?.body ?? 0) * 6 + (color.fact?.text ?? 0),
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

    // A status color that the other mode names has its pair in this mode: the used color of the same hue, before the
    // most used chromatic color is taken for the accent.
    for (const role of ["danger", "warning", "success"] as const) {
        const hue = hints[role];

        if (hue === undefined || chosen[role] !== undefined) {
            continue;
        }

        const pair = byUse(
            chroma.filter(
                (color) =>
                    !used(color.hex) &&
                    color.c >= 0.1 &&
                    color.uses >= 1 &&
                    Math.abs(((color.h - hue + 540) % 360) - 180) <= 30,
            ),
            (color) => color.uses,
        )[0];

        if (pair !== undefined) {
            set(role, pair.hex, "use", `used ${pair.uses}× with the hue of the dark ${role}`, 32);
        }
    }

    if (chosen.accent === undefined) {
        const statusSingles = new Set(
            chroma
                .filter(
                    (color) =>
                        !used(color.hex) &&
                        color.uses <= 1 &&
                        color.names.length === 0 &&
                        color.c >= 0.1,
                )
                .flatMap((color) =>
                    (["danger", "warning", "success"] as const).filter((role) =>
                        hueOk(role, color),
                    ),
                ),
        ).size;
        const top = byUse(
            // Reds, oranges, and greens that are each used once (all of the statuses at once) are more likely the
            // statuses than the brand.
            chroma.filter(
                (color) =>
                    !used(color.hex) &&
                    // A color that a variable names for a status or a notice (`--invalid`, `--note`) is not the brand.
                    !color.names.some(
                        (each) =>
                            (["danger", "warning", "success"] as const).some(
                                (role) => nameScore(role, words(each.name)) >= 48,
                            ) ||
                            words(each.name).some((word) =>
                                ["info", "note", "notice"].includes(word),
                            ),
                    ) &&
                    !(
                        statusSingles >= 2 &&
                        color.uses <= 1 &&
                        color.names.length === 0 &&
                        color.c >= 0.1 &&
                        (["danger", "warning", "success"] as const).some((role) =>
                            hueOk(role, color),
                        )
                    ),
            ),
            (color) =>
                (color.fact?.bg ?? 0) * 1.4 +
                (color.fact?.text ?? 0) +
                (color.fact?.border ?? 0) +
                (color.fact?.fill ?? 0) +
                // A color a variable names is a token of the design; a literal in a gradient is a decoration.
                (color.names.length > 0 ? 2 : 0) +
                color.c * 5,
        )[0];

        if (top !== undefined) {
            set("accent", top.hex, "use", "most used chromatic color", 35);
        }
    }

    // The hue each status color sits nearest to (Oklch degrees): a red close to 27° is an error, not an orange.
    const centers = { danger: 27, warning: 70, success: 148 } as const;
    const accentColor = chosen.accent === undefined ? undefined : entry(chosen.accent.hex);
    // A color named for the accent's variable and a suffix (`--glow-deep`, `--brandHover`) is a step of the accent.
    const variantOfAccent = (color: ColorEntry) =>
        (accentColor?.names ?? []).some((stem) =>
            color.names.some(
                (each) =>
                    each.name !== stem.name &&
                    each.name.startsWith(stem.name) &&
                    /^[-_A-Z0-9]/.test(each.name.slice(stem.name.length)),
            ),
        );

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
                        // Used, or named by a variable (`--stop` is defined, and no rule needs to use it).
                        (color.uses >= 1 || color.names.length > 0) &&
                        !variantOfAccent(color) &&
                        // A shade of the accent (near it, or of the same hue) is not a status color; a color that has a
                        // name of its own (`--go` beside `--glow`) is its own.
                        (accentColor === undefined ||
                            (distance(color, accentColor) > 0.06 &&
                                !(
                                    accentColor.c >= 0.07 &&
                                    color.names.length === 0 &&
                                    Math.abs(((color.h - accentColor.h + 540) % 360) - 180) < 8
                                ))),
                ),
                // A color a variable names is the design's; a literal used once may be a decoration.
                (color) =>
                    Math.log2(1 + color.uses) * 2 +
                    closeness(color) * 3 +
                    (color.names.length > 0 ? 3 : 0),
            )[0];

            if (top !== undefined) {
                set(
                    role,
                    top.hex,
                    "use",
                    top.uses === 0
                        ? `named ${top.names[0]!.name}, with the hue of ${role}`
                        : `used ${top.uses}× with the hue of ${role}`,
                    30,
                );
            }
        }
    }

    return chosen;
}

// --- Palette names ----------------------------------------------------------------------------------------------------
