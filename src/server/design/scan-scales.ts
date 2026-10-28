/**
 * The scales of the design system scan (stream T): the type scale, fonts, weights, line heights, spacing, radii, shadows,
 * motion, and breakpoints that a project does not name in variables, read from how it uses them. Each function adds
 * tokens to the `Book` and notes to the result; none runs when the project already names that kind of token.
 */
import { colorsIn, commaParts, parts, px } from "./scan-parse.ts";
import type { RoleName } from "./scan-colors.ts";
import type { Category, Facts } from "./scan-facts.ts";

type Obj = Record<string, unknown>;

export interface Draft {
    tokens: Obj;
    modes: Record<string, Obj>;
}

/** One role as the report shows it. */
export interface RoleInfo {
    token: string;
    value: string;
    dark?: string;
    basis: "name" | "use";
    source: string;
}

/** The scan's conclusions, for the report and for the tests. */
export interface Inferred {
    draft: Draft;
    roles: Partial<Record<RoleName, RoleInfo>>;
    /** Palette families and their sizes. */
    palette: Record<string, number>;
    typeScale: { base?: string; sizes: string[]; ratio?: number };
    fonts: Record<string, string>;
    spacing: { base?: number; steps: number[]; off: number[] };
    radii: string[];
    shadows: number;
    motion: { durations: string[]; easings: string[] };
    breakpoints: string[];
    /** Whether the project has a second mode (a dark mode in most; a light one in a dark-first project). */
    hasDark: boolean;
    /** The names of the modes: the default, and the other one when there is one. */
    modes: { default: string; alt: string };
    /** What the scan could not decide, or left out. */
    notes: string[];
    /** How many tokens came from a token file instead of a guess. */
    imported: number;
    /** Tokens the engine refused, dropped from the draft. */
    dropped: string[];
}

export const BEZIER: Record<string, number[]> = {
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
    linear: [0, 0, 1, 1],
};

/** An easing as a DTCG cubicBezier value (an array of four numbers), or undefined. */
export function bezier(text: string): number[] | undefined {
    const keyword = BEZIER[text.trim().toLowerCase()];

    if (keyword !== undefined) {
        return keyword;
    }

    const match =
        /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i.exec(
            text.trim(),
        );

    if (match === null) {
        return undefined;
    }

    const numbers = match.slice(1, 5).map(Number);

    return numbers.every(Number.isFinite) &&
        numbers[0]! >= 0 &&
        numbers[0]! <= 1 &&
        numbers[2]! >= 0 &&
        numbers[2]! <= 1
        ? numbers
        : undefined;
}

/** A CSS shadow as DTCG layers; the text itself when it cannot be taken apart. */
export function shadowValue(text: string): unknown {
    const layers: Obj[] = [];

    for (const layer of commaParts(text)) {
        const found = colorsIn(layer, true);
        const color = found[0];
        const rest = layer.replace(color?.text ?? "", " ");
        const lengths = parts(rest)
            .filter((part) => part !== "inset")
            .map((part) => px(part));

        if (
            color === undefined ||
            lengths.length < 2 ||
            lengths.length > 4 ||
            lengths.some((length) => length === undefined)
        ) {
            return text;
        }

        const dimension = (value: number | undefined) =>
            `${Math.round((value ?? 0) * 100) / 100}px`;

        layers.push({
            color: color.text.replace(/\s+/g, " "),
            offsetX: dimension(lengths[0]),
            offsetY: dimension(lengths[1]),
            blur: dimension(lengths[2]),
            ...(lengths[3] === undefined ? {} : { spread: dimension(lengths[3]) }),
            ...(/\binset\b/.test(layer) ? { inset: true } : {}),
        });
    }

    return layers.length === 1 ? layers[0] : layers;
}

/** A shadow's size, for ordering: blur and offset of its largest layer. */
export function elevation(value: unknown): number {
    const layers = Array.isArray(value)
        ? (value as Obj[])
        : typeof value === "object" && value !== null
          ? [value as Obj]
          : [];

    return Math.max(
        0,
        ...layers.map(
            (layer) =>
                (px(String(layer.blur ?? "0")) ?? 0) +
                Math.abs(px(String(layer.offsetY ?? "0")) ?? 0),
        ),
    );
}

/** Tokens being gathered: by path, with a version for the dark mode. */
export class Book {
    tokens = new Map<string, { path: string[]; node: Obj }>();
    dark = new Map<string, { path: string[]; node: Obj }>();

    has(path: string[]) {
        return this.tokens.has(path.join("."));
    }

    add(path: string[], node: Obj) {
        this.tokens.set(path.join("."), { path, node });
    }

    addDark(path: string[], node: Obj) {
        this.dark.set(path.join("."), { path, node });
    }

    taken() {
        return new Set(this.tokens.keys());
    }
}

export const WEIGHT_NAMES: Record<number, string> = {
    100: "thin",
    200: "extralight",
    300: "light",
    400: "regular",
    500: "medium",
    600: "semibold",
    700: "bold",
    800: "extrabold",
    900: "black",
};
/** Tailwind's own sizes, for the utility classes (`text-sm`, `rounded-lg`) that a project uses without defining them. */
const TAILWIND_TEXT: Record<string, string> = {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
    "5xl": "3rem",
    "6xl": "3.75rem",
    "7xl": "4.5rem",
    "8xl": "6rem",
    "9xl": "8rem",
};
const TAILWIND_RADIUS: Record<string, string> = {
    xs: "0.125rem",
    sm: "0.25rem",
    md: "0.375rem",
    lg: "0.5rem",
    xl: "0.75rem",
    "2xl": "1rem",
    "3xl": "1.5rem",
    full: "9999px",
};
const TAILWIND_WEIGHT: Record<string, [string, number]> = {
    thin: ["thin", 100],
    extralight: ["extralight", 200],
    light: ["light", 300],
    normal: ["regular", 400],
    medium: ["medium", 500],
    semibold: ["semibold", 600],
    bold: ["bold", 700],
    extrabold: ["extrabold", 800],
    black: ["black", 900],
};

export const SIZE_BELOW = ["sm", "xs", "2xs"];
export const SIZE_ABOVE = ["lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];

export const rounded = (value: number) => Math.round(value * 100) / 100;
export const topBy = <T>(list: T[], key: (item: T) => number, limit: number) =>
    [...list].sort((a, b) => key(b) - key(a)).slice(0, limit);

// --- Scales --------------------------------------------------------------------------------------------------------

export function fontScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    const stacks = [...facts.fonts.values()];
    const named = [...book.tokens.values()].filter(
        (entry) =>
            entry.path[0] === "font" &&
            !entry.path[1]!.startsWith("heading") &&
            !entry.path[1]!.startsWith("body"),
    );

    for (const entry of named) {
        result.fonts[entry.path.join(".")] = (entry.node.$value as string[]).join(", ");
    }

    if (explicit.has("font")) {
        const sans = named.find((entry) => /sans|body|base|text/.test(entry.path[1]!)) ?? named[0];
        const heading = named.find((entry) => /heading|display|title/.test(entry.path[1]!));

        if (sans !== undefined && !book.has(["font", "body"])) {
            book.add(["font", "body"], { $value: `{${sans.path.join(".")}}`, $type: "fontFamily" });
        }

        if (heading !== undefined && !book.has(["font", "heading"])) {
            book.add(["font", "heading"], {
                $value: `{${heading.path.join(".")}}`,
                $type: "fontFamily",
            });
        }

        return;
    }

    if (stacks.length === 0) {
        return;
    }

    const kindOf = (stack: string[]) =>
        stack.some((name) => /mono|code|courier|consolas|menlo|monaco/i.test(name)) ||
        stack.includes("monospace")
            ? "mono"
            : stack.includes("serif") && !stack.includes("sans-serif")
              ? "serif"
              : "sans";
    const ranked = [...stacks].sort((a, b) => b.count - a.count);
    const used = new Map<string, FontPick>();

    interface FontPick {
        path: string[];
        stack: string[];
    }

    const add = (kind: string, stack: string[]) => {
        const path = ["font", kind];

        if (book.has(path)) {
            return undefined;
        }

        // A system stack with no named family still gets a role.
        book.add(path, { $value: stack, $type: "fontFamily" });
        used.set(kind, { path, stack });
        result.fonts[path.join(".")] = stack.join(", ");

        return path;
    };

    const body = [...ranked]
        .filter((fact) => kindOf(fact.stack) !== "mono")
        .sort((a, b) => b.body * 3 + b.count - (a.body * 3 + a.count))[0];
    const bodyKind = body === undefined ? undefined : kindOf(body.stack);
    const bodyPath = body === undefined ? undefined : add(bodyKind!, body.stack);
    const mono = [...ranked]
        .filter((fact) => kindOf(fact.stack) === "mono")
        .sort((a, b) => b.code + b.count - (a.code + a.count))[0];

    if (mono !== undefined) {
        add("mono", mono.stack);
    }

    const heading = [...ranked]
        .filter((fact) => fact !== body && fact.heading > 0 && kindOf(fact.stack) !== "mono")
        .sort((a, b) => b.heading - a.heading)[0];
    let headingPath: string[] | undefined;

    if (heading !== undefined) {
        const kind = kindOf(heading.stack);

        headingPath = add(book.has(["font", kind]) ? "display" : kind, heading.stack);
    }

    const other = ranked.find(
        (fact) =>
            fact !== body &&
            fact !== mono &&
            fact !== heading &&
            kindOf(fact.stack) === "serif" &&
            !book.has(["font", "serif"]),
    );

    if (other !== undefined) {
        add("serif", other.stack);
    }

    if (bodyPath !== undefined) {
        book.add(["font", "body"], { $value: `{${bodyPath.join(".")}}`, $type: "fontFamily" });
        book.add(["font", "heading"], {
            $value: `{${(headingPath ?? bodyPath).join(".")}}`,
            $type: "fontFamily",
        });
    }
}

export function sizeScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    const sizes = [...facts.sizes].filter(([size]) => size >= 9 && size <= 96);

    // Tailwind's own sizes, named as Tailwind names them: the ones a project uses and does not define itself.
    if (facts.tailwind && facts.classText.size >= 2 && (explicit.has("text") || sizes.length < 3)) {
        for (const [name] of topBy([...facts.classText], ([, count]) => count, 9)) {
            if (TAILWIND_TEXT[name] !== undefined && !book.has(["text", name])) {
                book.add(["text", name], { $value: TAILWIND_TEXT[name], $type: "dimension" });
                explicit.add("text");
            }
        }
    }

    if (explicit.has("text")) {
        result.typeScale = {
            sizes: [...book.tokens.values()]
                .filter((entry) => entry.path[0] === "text")
                .sort((a, b) => (px(String(a.node.$value)) ?? 0) - (px(String(b.node.$value)) ?? 0))
                .map((entry) => `${entry.path[1]} ${String(entry.node.$value)}`),
        };

        return;
    }

    if (sizes.length === 0) {
        return;
    }

    // The sizes used most, in order of size.
    let kept = topBy(sizes, ([, fact]) => fact.count + fact.body * 2 + fact.heading, 10).sort(
        (a, b) => a[0] - b[0],
    );

    const bodyAt = (list: typeof kept) => {
        const withBody = list.filter(([, fact]) => fact.body > 0);

        return withBody.length > 0
            ? list.indexOf(topBy(withBody, ([, fact]) => fact.body, 1)[0]!)
            : list.indexOf(topBy(list, ([size]) => -Math.abs(size - 16), 1)[0]!);
    };

    let base = bodyAt(kept);

    // Only as many sizes as there are names: drop the least used at the ends.
    while (base > SIZE_BELOW.length || kept.length - base - 1 > SIZE_ABOVE.length) {
        const first = kept[0]!;
        const last = kept.at(-1)!;

        kept =
            base > SIZE_BELOW.length &&
            (kept.length - base - 1 <= SIZE_ABOVE.length || first[1].count <= last[1].count)
                ? kept.slice(1)
                : kept.slice(0, -1);
        base = bodyAt(kept);
    }

    const names = kept.map((_, at) =>
        at === base ? "base" : at < base ? SIZE_BELOW[base - at - 1]! : SIZE_ABOVE[at - base - 1]!,
    );

    kept.forEach(([size, fact], at) => {
        const form = [...fact.forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${size}px`;

        book.add(["text", names[at]!], {
            $value: /^-?[\d.]+(?:px|rem)$/.test(form) ? form : `${rounded(size)}px`,
            $type: "dimension",
        });
    });

    const above = kept.slice(base).map(([size]) => size);
    const ratios = above.slice(1).map((size, at) => size / above[at]!);

    result.typeScale = {
        base: `${rounded(kept[base]![0])}px`,
        sizes: kept.map(([size], at) => `${names[at]} ${rounded(size)}px`),
        ...(ratios.length > 0
            ? {
                  ratio: rounded(
                      Math.exp(
                          ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length,
                      ),
                  ),
              }
            : {}),
    };
}

export function detailScales(facts: Facts, book: Book, explicit: Set<Category>): void {
    if (!explicit.has("weight")) {
        const counts = new Map(facts.weights);

        if (facts.tailwind) {
            for (const [name, count] of facts.classWeight) {
                const weight = TAILWIND_WEIGHT[name]?.[1];

                if (weight !== undefined) {
                    counts.set(weight, (counts.get(weight) ?? 0) + count);
                }
            }
        }

        const used = topBy([...counts], ([, count]) => count, 5).sort((a, b) => a[0] - b[0]);

        if (used.length >= 2) {
            for (const [weight] of used) {
                const name = WEIGHT_NAMES[weight];

                if (name !== undefined) {
                    book.add(["weight", name], { $value: weight, $type: "fontWeight" });
                }
            }
        }
    }

    if (!explicit.has("leading")) {
        const used = topBy([...facts.leadings], ([, count]) => count, 3).sort(
            (a, b) => a[0] - b[0],
        );
        const names =
            used.length === 1
                ? ["normal"]
                : used.length === 2
                  ? ["tight", "normal"]
                  : ["tight", "normal", "relaxed"];

        used.forEach(([value], at) =>
            book.add(["leading", names[at]!], { $value: value, $type: "number" }),
        );
    }

    if (!explicit.has("tracking")) {
        const used = [...facts.tracking].sort((a, b) => b[1] - a[1]);
        const tight = used.find(([text]) => text.startsWith("-"));
        const wide = used.find(([text]) => !text.startsWith("-"));

        if (tight !== undefined) {
            book.add(["tracking", "tight"], { $value: tight[0], $type: "dimension" });
        }

        if (wide !== undefined) {
            book.add(["tracking", "wide"], { $value: wide[0], $type: "dimension" });
        }
    }
}

export function spacingScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    if (explicit.has("space")) {
        const steps = [...book.tokens.values()]
            .filter((entry) => entry.path[0] === "space")
            .map((entry) => px(String(entry.node.$value)))
            .filter((value): value is number => value !== undefined)
            .sort((a, b) => a - b);

        result.spacing = {
            base: steps.length > 0 ? steps.find((value) => value > 0) : undefined,
            steps: [...new Set(steps.filter((step) => step > 0))],
            off: [],
        };

        return;
    }

    const counts = new Map(facts.spacing);

    // Tailwind classes are steps of 4px; they count only for a project that uses Tailwind.
    if (facts.tailwind) {
        for (const [size, count] of facts.classSpacing) {
            counts.set(size, (counts.get(size) ?? 0) + count);
        }
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

    if (total === 0) {
        return;
    }

    const share = (unit: number) =>
        [...counts]
            .filter(([size]) => size % unit === 0)
            .reduce((sum, [, count]) => sum + count, 0) / total;
    const base = share(8) >= 0.85 ? 8 : share(4) >= 0.75 ? 4 : share(2) >= 0.75 ? 2 : 4;
    // A scale on a 4px grid keeps the multiples of 4 (and 2px); a project without a grid keeps what is even.
    const unit = share(4) >= 0.5 ? 4 : 2;
    const grid = [...counts].filter(
        ([size]) => (size % unit === 0 || size === 2) && size >= 2 && size <= 192,
    );
    const kept = topBy(grid, ([, count]) => count, 12).sort((a, b) => a[0] - b[0]);
    const off = [...counts]
        .filter(([size]) => !grid.some(([each]) => each === size) && size >= 1 && size <= 64)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);

    for (const [size] of kept) {
        // Named in steps of 4px, as Tailwind does: 16px is `space.4`, 2px is `space.0-5`.
        const step = size / 4;
        const name = Number.isInteger(step)
            ? String(step)
            : step * 2 === Math.round(step * 2)
              ? `${Math.floor(step)}-5`
              : undefined;

        if (name !== undefined) {
            book.add(["space", name], { $value: `${size}px`, $type: "dimension" });
        }
    }

    result.spacing = { base, steps: kept.map(([size]) => size), off: off.map(([size]) => size) };
}

export function radiusScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    // Tailwind's `rounded-lg` and the like: the names a project uses and does not define itself.
    if (
        facts.tailwind &&
        facts.classRadius.size > 0 &&
        (explicit.has("radius") || facts.radii.size === 0)
    ) {
        for (const [name] of topBy([...facts.classRadius], ([, count]) => count, 6)) {
            const value = TAILWIND_RADIUS[name];

            if (value !== undefined && !book.has(["radius", name])) {
                book.add(["radius", name], { $value: value, $type: "dimension" });
                explicit.add("radius");
            }
        }
    }

    if (explicit.has("radius")) {
        result.radii = [...book.tokens.values()]
            .filter((entry) => entry.path[0] === "radius")
            .sort((a, b) => (px(String(a.node.$value)) ?? 0) - (px(String(b.node.$value)) ?? 0))
            .map((entry) => `${entry.path[1]} ${String(entry.node.$value)}`);

        return;
    }

    // Radii a pixel apart are one radius (6px and 7px): the more used one stands for both.
    const clusters: [string, { count: number; text: string }][] = [];

    for (const [key, fact] of [...facts.radii]
        .filter(([each]) => each !== "full")
        .sort((a, b) => b[1].count - a[1].count)) {
        const near = clusters.find(([other]) => Math.abs(Number(other) - Number(key)) <= 1);

        if (near === undefined) {
            clusters.push([key, { ...fact }]);
        } else {
            near[1].count += fact.count;
        }
    }

    const kept = topBy(clusters, ([, fact]) => fact.count, 5).sort(
        (a, b) => Number(a[0]) - Number(b[0]),
    );
    const ladders: Record<number, string[]> = {
        1: ["md"],
        2: ["sm", "lg"],
        3: ["sm", "md", "lg"],
        4: ["sm", "md", "lg", "xl"],
        5: ["xs", "sm", "md", "lg", "xl"],
    };

    kept.forEach(([key, fact], at) => {
        const form = /^-?[\d.]+(?:px|rem|em)$/.test(fact.text) ? fact.text : `${key}px`;

        book.add(["radius", ladders[kept.length]![at]!], { $value: form, $type: "dimension" });
        result.radii.push(`${ladders[kept.length]![at]} ${form}`);
    });

    if (facts.radii.has("full")) {
        book.add(["radius", "full"], { $value: "9999px", $type: "dimension" });
        result.radii.push("full 9999px");
    }
}

export function shadowScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    if (explicit.has("shadow")) {
        result.shadows = [...book.tokens.values()].filter(
            (entry) => entry.path[0] === "shadow",
        ).length;

        return;
    }

    const used = topBy([...facts.shadows], ([, count]) => count, 5)
        .map(([text]) => ({ text, value: shadowValue(text) }))
        .filter((entry) => typeof entry.value !== "string")
        .sort((a, b) => elevation(a.value) - elevation(b.value));
    const ladders: Record<number, string[]> = {
        1: ["md"],
        2: ["sm", "lg"],
        3: ["sm", "md", "lg"],
        4: ["sm", "md", "lg", "xl"],
        5: ["xs", "sm", "md", "lg", "xl"],
    };

    used.forEach((entry, at) =>
        book.add(["shadow", ladders[used.length]![at]!], { $value: entry.value, $type: "shadow" }),
    );
    result.shadows = used.length;
}

export function motionScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    if (!explicit.has("duration")) {
        const used = topBy([...facts.durations], ([, count]) => count, 4).sort(
            (a, b) => a[0] - b[0],
        );
        const ladders: Record<number, string[]> = {
            1: ["base"],
            2: ["fast", "slow"],
            3: ["fast", "base", "slow"],
            4: ["instant", "fast", "base", "slow"],
        };

        used.forEach(([ms], at) => {
            book.add(["duration", ladders[used.length]![at]!], {
                $value: `${ms}ms`,
                $type: "duration",
            });
            result.motion.durations.push(`${ladders[used.length]![at]} ${ms}ms`);
        });
    }

    if (!explicit.has("ease")) {
        const NAMES: Record<string, string> = {
            ease: "standard",
            "ease-in": "in",
            "ease-out": "out",
            "ease-in-out": "in-out",
            linear: "linear",
        };
        const used = topBy([...facts.easings], ([, count]) => count, 4);
        let custom = 0;

        for (const [text] of used) {
            const value = bezier(text);

            if (value === undefined) {
                continue;
            }

            const key = JSON.stringify(value);
            const known = Object.entries(BEZIER).find(([, each]) => JSON.stringify(each) === key);
            const name =
                NAMES[text] ??
                (value[0] === 0.4 && value[1] === 0 && value[2] === 0.2 && value[3] === 1
                    ? "standard"
                    : known === undefined
                      ? `custom-${++custom}`
                      : NAMES[known[0]]!);

            if (!book.has(["ease", name])) {
                book.add(["ease", name], { $value: value, $type: "cubicBezier" });
                result.motion.easings.push(`${name} ${text}`);
            }
        }
    }
}

export function breakpointScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    if (explicit.has("breakpoint")) {
        return;
    }

    // 1100px and 1101px are one breakpoint: the more used stands for both.
    const clusters: [number, number][] = [];

    for (const [size, count] of [...facts.breakpoints].sort((a, b) => b[1] - a[1])) {
        const near = clusters.find(([other]) => Math.abs(other - size) <= Math.max(2, size * 0.02));

        if (near === undefined) {
            clusters.push([size, count]);
        } else {
            near[1] += count;
        }
    }

    const used = topBy(clusters, ([, count]) => count, 5).sort((a, b) => a[0] - b[0]);
    const names = ["sm", "md", "lg", "xl", "2xl"];

    used.forEach(([size], at) => {
        book.add(["breakpoint", names[at]!], { $value: `${size}px`, $type: "dimension" });
        result.breakpoints.push(`${names[at]} ${size}px`);
    });
}
