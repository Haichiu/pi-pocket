/** How well a variable's name fits a role (stream T): the words of a name, and a score for each role from them. */
import { type RoleName, w } from "./scan-color-base.ts";

/** The words of a variable name: camelCase split, lower case, noise words dropped. */
export function words(name: string): string[] {
    const all = name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        // `font-color-base` (Infima) is the text color, not a font.
        .replace(/font[-_]colou?r/gi, "text-color")
        // `red9`, `gray12`: a name and its step.
        .replace(/([a-z]{3,})(\d{1,3})(?![\d-])/gi, "$1-$2")
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
        "accent danger error warning success info brand destructive critical secondary tertiary link border outline divider bad good ok positive negative note notice caution warn pass fail",
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
                // `on-surface-variant` (Material 3) is the quieter text.
                (onBase && segs.includes("variant")) ||
                // `text-2`, `ink-3`: the second and third text colors are the quieter ones.
                (ink && segs.some((seg) => /^[2-4]$/.test(seg))) ||
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
                has(
                    segs,
                    w("muted subtle dim dimmed faint faded soft weak hint quiet caption meta"),
                ) ||
                (weakAt >= 0 && inkAt >= 0 && inkAt < weakAt);

            if (
                segs.includes("on") &&
                segs.includes("variant") &&
                has(segs, ["surface", "background", "bg"])
            ) {
                return 78;
            }

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
                : w("subtle faint faded dim quiet weak hint").includes(segs[0]!)
                  ? 62
                  : 0;
        }

        case "border": {
            const named = has(
                segs,
                w("border outline divider separator stroke line hairline rule rim edge"),
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
                    w(
                        "danger error destructive critical negative invalid alert err bad fail failed failure wrong fatal severe",
                    ),
                    ["red"],
                ],
                warning: [
                    ["warning", "warn", "caution", "attention", "alertness", "moderate"],
                    ["amber", "orange", "yellow"],
                ],
                success: [
                    [
                        "success",
                        "positive",
                        "valid",
                        "ok",
                        "confirm",
                        "safe",
                        "good",
                        "pass",
                        "passed",
                        "done",
                    ],
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
