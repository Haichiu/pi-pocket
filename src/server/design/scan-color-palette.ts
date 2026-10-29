import { type ColorEntry } from "./scan-color-base.ts";

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

// A taken name moves to the nearest free step; a translucent color keeps its alpha in the name.
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
