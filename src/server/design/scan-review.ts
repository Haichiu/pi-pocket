import type { Category, Facts } from "./scan-facts.ts";
import type { Inferred } from "./scan-scales.ts";

const THIN = { values: 3, uses: 4 } as const;

const total = (map: Map<unknown, number | { count: number }>): number =>
    [...map.values()].reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : value.count),
        0,
    );

export function reviewScales(facts: Facts, explicit: Set<Category>, result: Inferred): string[] {
    const lines: string[] = [];
    const thin = (distinct: number, uses: number) => distinct < THIN.values || uses < THIN.uses;

    const guess = (category: Category, label: string, distinct: number, uses: number) => {
        if (!explicit.has(category) && distinct > 0 && thin(distinct, uses)) {
            lines.push(
                `${label} (guessed from use: ${distinct} value${distinct === 1 ? "" : "s"}, ${uses} use${uses === 1 ? "" : "s"})`,
            );
        }
    };

    guess("text", "type scale", result.typeScale.sizes.length, total(facts.sizes));
    guess("space", "spacing", result.spacing.steps.length, total(facts.spacing));
    guess("radius", "radii", result.radii.length, total(facts.radii));
    guess("shadow", "shadows", result.shadows, total(facts.shadows));
    guess("font", "fonts", Object.keys(result.fonts).length, total(facts.fonts));

    // Spacing values that fit no step of the scale are left out of it: a person decides what to do with them.
    if (result.spacing.off.length > 0) {
        lines.push(
            `spacing (${result.spacing.off.length} value${result.spacing.off.length === 1 ? "" : "s"} fit no step of the ${result.spacing.base ?? 4}px grid: ${result.spacing.off
                .slice(0, 6)
                .map((size) => `${size}px`)
                .join(", ")}${result.spacing.off.length > 6 ? ", …" : ""})`,
        );
    }

    return lines;
}
