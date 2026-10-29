import { colorsIn, commaParts, parts, px } from "./scan-parse.ts";
import type { RoleName } from "./scan-colors.ts";
import type { Category, Facts, SizeFact } from "./scan-facts.ts";

type Obj = Record<string, unknown>;

export interface Draft {
    tokens: Obj;
    modes: Record<string, Obj>;
}

interface RoleInfo {
    token: string;
    value: string;
    dark?: string;
    basis: "name" | "use";
    source: string;
    /** How sure the scan is: a name that says the role is high; a guess from how colors are used is low. */
    confidence: "high" | "medium" | "low";
    /** Where the choice comes from, as `file:line`, when the scan knows. */
    at?: string;
}

export interface Inferred {
    draft: Draft;
    roles: Partial<Record<RoleName, RoleInfo>>;
    palette: Record<string, number>;
    typeScale: { base?: string; sizes: string[]; ratio?: number };
    fonts: Record<string, string>;
    spacing: { base?: number; steps: number[]; off: number[] };
    radii: string[];
    shadows: number;
    motion: { durations: string[]; easings: string[] };
    breakpoints: string[];
    hasDark: boolean;
    modes: { default: string; alt: string };
    notes: string[];
    imported: number;
    dropped: string[];
    sources: string[];
    review: string[];
}

const BEZIER: Record<string, number[]> = {
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
    linear: [0, 0, 1, 1],
};

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

const WEIGHT_NAMES: Record<number, string> = {
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

const SIZE_BELOW = ["sm", "xs", "2xs"];
const SIZE_ABOVE = ["lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];

export const rounded = (value: number) => Math.round(value * 100) / 100;
export const topBy = <T>(list: T[], key: (item: T) => number, limit: number) =>
    [...list].sort((a, b) => key(b) - key(a)).slice(0, limit);

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

    const kindOf = (stack: string[]) =>
        stack.some((name) => /mono|code|courier|consolas|menlo|monaco/i.test(name)) ||
        stack.includes("monospace")
            ? "mono"
            : stack.includes("serif") && !stack.includes("sans-serif")
              ? "serif"
              : "sans";

    for (const entry of named) {
        result.fonts[entry.path.join(".")] = (entry.node.$value as string[]).join(", ");
    }

    if (explicit.has("font")) {
        const covered = new Set(
            named.map((entry) => (entry.node.$value as string[])[0]?.toLowerCase()),
        );

        for (const fact of [...stacks].sort((a, b) => b.count - a.count).slice(0, 8)) {
            const first = fact.stack[0]?.toLowerCase();
            const kind = kindOf(fact.stack);

            if (
                first !== undefined &&
                kind === "mono" &&
                !covered.has(first) &&
                !named.some((entry) => kindOf(entry.node.$value as string[]) === "mono") &&
                !book.has(["font", kind])
            ) {
                book.add(["font", kind], { $value: fact.stack, $type: "fontFamily" });
                result.fonts[`font.${kind}`] = fact.stack.join(", ");
                covered.add(first);
            }
        }

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

    if (facts.tailwind && facts.classText.size >= 1 && (explicit.has("text") || sizes.length < 3)) {
        for (const [name] of topBy([...facts.classText], ([, count]) => count, 9)) {
            if (TAILWIND_TEXT[name] !== undefined && !book.has(["text", name])) {
                book.add(["text", name], { $value: TAILWIND_TEXT[name], $type: "dimension" });
                explicit.add("text");
            }
        }
    }

    // Sizes a pixel apart are one size (11px and 12px): the one used more stands for both.
    const merged: [number, SizeFact][] = [];

    for (const [size, fact] of [...sizes].sort(
        (a, b) => b[1].count + b[1].body * 2 - (a[1].count + a[1].body * 2) || a[0] - b[0],
    )) {
        const near = merged.find(([other]) => Math.abs(other - size) <= 1);

        if (near === undefined) {
            merged.push([size, { ...fact, forms: new Map(fact.forms) }]);
        } else {
            near[1].count += fact.count;
            near[1].body += fact.body;
            near[1].heading += fact.heading;
        }
    }

    if (explicit.has("text")) {
        const named = [...book.tokens.values()]
            .filter((entry) => entry.path[0] === "text")
            .map((entry) => px(String(entry.node.$value)) ?? -99);

        for (const [size, fact] of topBy(merged, ([, each]) => each.count + each.body * 2, 8)) {
            const path = ["text", String(rounded(size)).replace(".", "-")];

            if (named.every((value) => Math.abs(value - size) > 1) && !book.has(path)) {
                const form = [...fact.forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${size}px`;

                book.add(path, {
                    $value: /^-?[\d.]+(?:px|rem)$/.test(form) ? form : `${rounded(size)}px`,
                    $type: "dimension",
                });
            }
        }

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

    let kept = topBy(merged, ([, fact]) => fact.count + fact.body * 2 + fact.heading, 10).sort(
        (a, b) => a[0] - b[0],
    );

    const bodyAt = (list: typeof kept) => {
        const withBody = list.filter(([, fact]) => fact.body > 0);

        return withBody.length > 0
            ? list.indexOf(topBy(withBody, ([, fact]) => fact.body, 1)[0]!)
            : list.indexOf(topBy(list, ([size]) => -Math.abs(size - 16), 1)[0]!);
    };

    let base = bodyAt(kept);

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
    const named = () =>
        [...book.tokens.values()]
            .filter((entry) => entry.path[0] === "space")
            .map((entry) => px(String(entry.node.$value)))
            .filter((value): value is number => value !== undefined && value > 0);
    const counts = new Map(facts.spacing);

    // Tailwind classes are steps of 4px; they count only for a project that uses Tailwind.
    if (facts.tailwind) {
        for (const [size, count] of facts.classSpacing) {
            counts.set(size, (counts.get(size) ?? 0) + count);
        }
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

    if (total === 0) {
        const steps = [...new Set(named())].sort((a, b) => a - b);

        result.spacing = { base: steps[0], steps, off: [] };

        return;
    }

    const share = (unit: number) =>
        [...counts]
            .filter(([size]) => size % unit === 0)
            .reduce((sum, [, count]) => sum + count, 0) / total;
    const base = share(8) >= 0.85 ? 8 : share(4) >= 0.75 ? 4 : share(2) >= 0.75 ? 2 : 4;

    // Values a pixel apart are one value (15px and 16px; 4px and 5px): the one used more stands for both. Below 4px
    // every pixel counts.
    const clusters: [number, number][] = [];

    for (const [size, count] of [...counts]
        .filter(([size]) => size >= 1 && size <= 192)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
        const near = clusters.find(
            ([other]) => Math.abs(other - size) <= 1 && Math.min(other, size) >= 4,
        );

        if (near === undefined) {
            clusters.push([size, count]);
        } else {
            near[1] += count;
        }
    }

    // A value used once that is off the grid (6px, 10px in a 4px grid) or under 4px (a hairline) is a one-off, not a step.
    const kept = topBy(
        clusters.filter(
            ([size, count]) =>
                size >= 2 &&
                (count >= 2 || (size >= 4 && size % Math.min(base, 4) === 0)) &&
                (size >= 4 || count >= 3),
        ),
        ([, count]) => count,
        12,
    ).sort((a, b) => a[0] - b[0]);
    const own = explicit.has("space") ? named() : [];
    const fresh = kept.filter(([size]) =>
        own.every((value) => Math.abs(value - size) > 1 || size < 4),
    );

    for (const [size] of fresh) {
        const path = ["space", String(rounded(size / 4)).replace(".", "-")];

        if (!book.has(path)) {
            book.add(path, { $value: `${rounded(size)}px`, $type: "dimension" });
        }
    }

    const steps = [...new Set(named().map((value) => rounded(value)))].sort((a, b) => a - b);

    result.spacing = {
        base: explicit.has("space") ? steps[0] : base,
        steps,
        off: steps.filter((size) => size % 4 !== 0).slice(0, 6),
    };
}

export function radiusScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
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

    const has = (key: string) =>
        [...book.tokens.values()].some(
            (entry) =>
                entry.path[0] === "radius" &&
                (key === "full"
                    ? (px(String(entry.node.$value)) ?? 0) >= 100
                    : Math.abs((px(String(entry.node.$value)) ?? -99) - Number(key)) <= 1),
        );

    if (explicit.has("radius")) {
        const extra: [string, { count: number; text: string }][] = [];

        for (const [key, fact] of [...facts.radii]
            .filter(([each]) => !has(each) && (each === "full" || Number(each) >= 2))
            .sort((a, b) => b[1].count - a[1].count)) {
            const near = extra.find(
                ([other]) =>
                    other !== "full" &&
                    key !== "full" &&
                    Math.abs(Number(other) - Number(key)) <= 1,
            );

            if (near === undefined) {
                extra.push([key, { ...fact }]);
            } else {
                near[1].count += fact.count;
            }
        }

        const taken = new Set(
            [...book.tokens.values()]
                .filter((entry) => entry.path[0] === "radius")
                .map((entry) => entry.path[1]),
        );

        for (const [key, fact] of extra.slice(0, 6)) {
            const name = key === "full" ? "full" : key.replace(".", "-");

            if (!taken.has(name)) {
                book.add(["radius", name], {
                    $value:
                        key === "full"
                            ? /^[\d.]+(?:px|rem|em)$/.test(fact.text)
                                ? fact.text
                                : "9999px"
                            : /^[\d.]+(?:px|rem|em)$/.test(fact.text)
                              ? fact.text
                              : `${key}px`,
                    $type: "dimension",
                });
            }
        }

        result.radii = [...book.tokens.values()]
            .filter((entry) => entry.path[0] === "radius")
            .sort((a, b) => (px(String(a.node.$value)) ?? 0) - (px(String(b.node.$value)) ?? 0))
            .map((entry) => `${entry.path[1]} ${String(entry.node.$value)}`);

        return;
    }

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
        const text = facts.radii.get("full")!.text;
        const value = /^[\d.]+(?:px|rem|em)$/.test(text) ? text : "9999px";

        book.add(["radius", "full"], { $value: value, $type: "dimension" });
        result.radii.push(`full ${value}`);
    }
}

function sameShadow(a: unknown, b: unknown): boolean {
    const layers = (value: unknown) => (Array.isArray(value) ? value : [value]) as Obj[];
    const first = layers(a);
    const second = layers(b);
    const length = (value: unknown) => px(String(value ?? "0")) ?? 0;

    const alpha = (value: unknown) => {
        const color = typeof value === "string" ? colorsIn(value)[0] : undefined;

        return color === undefined ? undefined : color.hex;
    };

    return (
        first.length === second.length &&
        first.every((layer, at) => {
            const other = second[at]!;

            return (
                (layer.inset === true) === (other.inset === true) &&
                Math.abs(length(layer.offsetX) - length(other.offsetX)) <= 1 &&
                Math.abs(length(layer.offsetY) - length(other.offsetY)) <= 1 &&
                Math.abs(length(layer.blur) - length(other.blur)) <= 2 &&
                Math.abs(length(layer.spread) - length(other.spread)) <= 1 &&
                alpha(layer.color) === alpha(other.color)
            );
        })
    );
}

export function shadowScale(facts: Facts, book: Book, result: Inferred): void {
    const clusters: { text: string; value: unknown; count: number }[] = [];

    for (const [text, count] of [...facts.shadows].sort((a, b) => b[1] - a[1])) {
        const value = shadowValue(text);

        if (typeof value === "string") {
            continue;
        }

        const near = clusters.find((other) => sameShadow(other.value, value));

        if (near === undefined) {
            clusters.push({ text, value, count });
        } else {
            near.count += count;
        }
    }

    // A ring or an inset line is not a step of elevation: it gets a name of its own.
    const rings: typeof clusters = [];
    const lifts: typeof clusters = [];

    const own = [...book.tokens.values()]
        .filter((entry) => entry.path[0] === "shadow")
        .map((entry) => entry.node.$value);

    for (const cluster of topBy(
        clusters.filter((each) => !own.some((value) => sameShadow(value, each.value))),
        (each) => each.count,
        8,
    )) {
        const layers = (Array.isArray(cluster.value) ? cluster.value : [cluster.value]) as Obj[];
        const inset = layers.every((layer) => layer.inset === true);
        const ring = layers.every(
            (layer) =>
                (px(String(layer.blur ?? "0")) ?? 0) === 0 &&
                (px(String(layer.offsetY ?? "0")) ?? 0) === 0,
        );

        (inset || ring ? rings : lifts).push(cluster);
    }

    lifts.sort((a, b) => elevation(a.value) - elevation(b.value));

    const ladder = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
    const names: Record<number, string[]> = {
        1: ["md"],
        2: ["sm", "lg"],
        3: ["sm", "md", "lg"],
        4: ["sm", "md", "lg", "xl"],
    };

    const free = (name: string) => !book.has(["shadow", name]);

    lifts.forEach((entry, at) => {
        const wanted = (names[lifts.length] ?? ladder)[at]!;
        // A name the project already gave to another shadow is not taken: the next free step of the ladder is.
        const name = free(wanted) ? wanted : (ladder.find(free) ?? `extra-${at + 1}`);

        book.add(["shadow", name], { $value: entry.value, $type: "shadow" });
    });

    const seen = new Map<string, number>();

    for (const entry of rings) {
        const layers = (Array.isArray(entry.value) ? entry.value : [entry.value]) as Obj[];
        const kind = layers.every((layer) => layer.inset === true) ? "inset" : "ring";
        const count = (seen.get(kind) ?? 0) + 1;

        seen.set(kind, count);

        const name = count === 1 ? kind : `${kind}-${count}`;

        if (free(name)) {
            book.add(["shadow", name], { $value: entry.value, $type: "shadow" });
        }
    }

    result.shadows = [...book.tokens.values()].filter((entry) => entry.path[0] === "shadow").length;
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
