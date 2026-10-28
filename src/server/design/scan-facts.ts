/**
 * What the design system scan finds in a project's files (stream T): custom properties and theme variables by scope,
 * how often each color, font, size, space, radius, shadow, duration, and easing is used, and which variables are
 * referenced. This module only counts and records; `scan-infer.ts` decides what it means.
 */
import {
    type Decl,
    type Literal,
    type Scope,
    UNKNOWN,
    colorsIn,
    commaParts,
    objectStyles,
    pageStyles,
    parseStyles,
    parts,
    px,
    readLiteral,
    stripComments,
    templateStyles,
} from "./scan-parse.ts";
import { importTokens, type Imported } from "./scan-import.ts";

/** What a value is for, which decides the group of its token. */
export type Category =
    | "color"
    | "font"
    | "text"
    | "space"
    | "radius"
    | "shadow"
    | "duration"
    | "ease"
    | "breakpoint"
    | "weight"
    | "leading"
    | "tracking"
    | "z"
    | "opacity"
    | "size";

/** A custom property or a stylesheet variable. */
export interface VarFact {
    /** Without `--`, `$`, or `@`; for a JavaScript theme, the path joined by `-`. */
    name: string;
    value: string;
    scope: Scope;
    kind: "css" | "theme" | "scss" | "less" | "js";
    file: string;
    /** The category that the place of the variable states (a Tailwind namespace, a theme key such as `borderRadius`). */
    hint?: Category;
    /** Source order: files by priority, then position. */
    order: number;
    /** The file's rank by priority (0 is read first). The lowest rank wins; in one file the later declaration wins. */
    rank: number;
}

/** How a color is used. */
export interface ColorFact {
    hex: string;
    /** The authored texts, by count. */
    forms: Map<string, number>;
    /** Literal uses in declarations, by kind of property. */
    bg: number;
    text: number;
    border: number;
    fill: number;
    shadow: number;
    other: number;
    /** As a background on the page's root (`body`, `html`, `:root`, `#app`). */
    root: number;
    /** As the text color of the root or of paragraphs. */
    body: number;
    /** When it was first seen: the earlier of two equal colors is the one the author wrote first. */
    order: number;
}

export interface FontFact {
    /** The family names, quotes removed, in order. */
    stack: string[];
    count: number;
    heading: number;
    body: number;
    code: number;
}

export interface SizeFact {
    count: number;
    body: number;
    heading: number;
    /** The authored texts, by count: `1rem`, `16px`. */
    forms: Map<string, number>;
}

export interface Facts {
    /** The rank of the file being read. */
    rank: number;
    files: string[];
    partial: boolean;
    tailwind: boolean;
    vars: VarFact[];
    colors: Map<string, ColorFact>;
    darkColors: Map<string, ColorFact>;
    varUse: Map<string, number>;
    classUse: Map<string, number>;
    fonts: Map<string, FontFact>;
    sizes: Map<number, SizeFact>;
    weights: Map<number, number>;
    leadings: Map<number, number>;
    tracking: Map<string, number>;
    spacing: Map<number, number>;
    radii: Map<string, { count: number; text: string }>;
    shadows: Map<string, number>;
    durations: Map<number, number>;
    easings: Map<string, number>;
    breakpoints: Map<number, number>;
    /** Spacing from Tailwind classes (`p-4` is 16px): used only when the project uses Tailwind. */
    classSpacing: Map<number, number>;
    /** Tailwind utility classes by size name: `text-sm` → `sm`, `rounded-lg` → `lg`, `font-bold` → `bold`. */
    classText: Map<string, number>;
    classRadius: Map<string, number>;
    classWeight: Map<string, number>;
    /** Scopes that set custom properties but are neither the root nor dark mode, by selector. */
    scoped: Map<string, number>;
    /** Tokens already written in a DTCG, Style Dictionary, or Tokens Studio file. */
    imported: Imported;
}

export function newFacts(): Facts {
    return {
        rank: 0,
        files: [],
        partial: false,
        tailwind: false,
        vars: [],
        colors: new Map(),
        darkColors: new Map(),
        varUse: new Map(),
        classUse: new Map(),
        fonts: new Map(),
        sizes: new Map(),
        weights: new Map(),
        leadings: new Map(),
        tracking: new Map(),
        spacing: new Map(),
        radii: new Map(),
        shadows: new Map(),
        durations: new Map(),
        easings: new Map(),
        breakpoints: new Map(),
        classSpacing: new Map(),
        classText: new Map(),
        classRadius: new Map(),
        classWeight: new Map(),
        scoped: new Map(),
        imported: { default: {}, dark: {}, count: 0, files: [] },
    };
}

const bump = <K>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

// --- Color uses ----------------------------------------------------------------------------------------------------

const COLOR_PROPERTY: [RegExp, "bg" | "text" | "border" | "fill" | "shadow"][] = [
    [
        /^(?:color|caret-color|text-decoration(?:-color)?|-webkit-text-fill-color|text-emphasis-color)$/,
        "text",
    ],
    [/^(?:background(?:-color|-image)?|accent-color|scrollbar-color)$/, "bg"],
    [
        /^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|column-rule(?:-color)?|border-image)$/,
        "border",
    ],
    [/^(?:fill|stroke|stop-color|flood-color)$/, "fill"],
    [/^(?:box-shadow|text-shadow|filter|drop-shadow)$/, "shadow"],
];

/** Selectors of the page's root: `body`, `html`, `:root`, `#app`, `#root`, `main`. */
const ROOTISH =
    /^(?:html|body|:root|#root|#app|#__next|main|\.app|\.App|#app-root)(?:[.#:[][^\s,>+~]*)?$/;
const rootish = (selector: string) =>
    selector !== "" &&
    selector
        .split(",")
        .map((part) => part.trim())
        .every((part) => ROOTISH.test(part));
const HEADING =
    /(?:^|[\s,>+~])(?:h[1-6]|\.h[1-6]|\.(?:title|heading|headline|display)[\w-]*)(?![\w-])/i;
const BODY = /(?:^|[\s,>+~])(?:body|html|p|:root|\.text|\.body|main)(?![\w-])/i;
const CODE = /(?:^|[\s,>+~])(?:code|pre|kbd|samp|\.mono|\.code)(?![\w-])/i;

function colorFact(map: Map<string, ColorFact>, hex: string, text: string): ColorFact {
    let fact = map.get(hex);

    if (fact === undefined) {
        fact = {
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
            order: map.size,
        };
        map.set(hex, fact);
    }

    bump(fact.forms, text.replace(/\s+/g, " ").slice(0, 80));

    return fact;
}

/** Records the colors in a declaration's value as uses. */
function useColors(facts: Facts, decl: Decl, dark: boolean): void {
    const known = COLOR_PROPERTY.find(([pattern]) => pattern.test(decl.prop))?.[1];
    // Any other property may still hold a literal color (`filter: drop-shadow(… #000)`); a color name counts only where
    // the property takes a color.
    const kind = known ?? "other";

    const map = dark ? facts.darkColors : facts.colors;
    // A color name counts only where the property takes a color and the value is short (not a font stack or a URL).
    const found = colorsIn(
        decl.value,
        known !== undefined && (kind !== "shadow" || !/^none$/i.test(decl.value)),
    );

    for (const color of found) {
        const fact = colorFact(map, color.hex, color.text);

        fact[kind] += 1;

        if (kind === "bg" && rootish(decl.selector)) {
            fact.root += 1;
        }

        if (kind === "text" && (rootish(decl.selector) || BODY.test(decl.selector))) {
            fact.body += 1;
        }
    }
}

// --- Other uses ----------------------------------------------------------------------------------------------------

const GENERIC = new Set([
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
    "math",
    "emoji",
    "fangsong",
]);

/** The family names of a `font-family` value, quotes removed; undefined for `inherit` or a `var()`. */
export function stackOf(value: string): string[] | undefined {
    if (/^(?:inherit|initial|unset|revert)$/i.test(value.trim()) || /^var\(/i.test(value.trim())) {
        return undefined;
    }

    const names = commaParts(value)
        .map((part) => part.replace(/^["']|["']$/g, "").trim())
        .filter((name) => name !== "" && !/var\(|\$\{/.test(name))
        .slice(0, 12);

    return names.length === 0 ? undefined : names;
}

const stackKey = (stack: string[]) => stack.map((name) => name.toLowerCase()).join(",");

function useFont(facts: Facts, stack: string[], decl: Decl): void {
    const key = stackKey(stack);
    const fact = facts.fonts.get(key) ?? { stack, count: 0, heading: 0, body: 0, code: 0 };

    fact.count += 1;

    if (HEADING.test(decl.selector)) {
        fact.heading += 1;
    }

    if (BODY.test(decl.selector) || rootish(decl.selector)) {
        fact.body += 1;
    }

    if (
        CODE.test(decl.selector) ||
        stack.some((name) => /mono|code|courier|consolas|menlo|monaco/i.test(name)) ||
        stack.includes("monospace")
    ) {
        fact.code += 1;
    }

    facts.fonts.set(key, fact);
}

function useSize(facts: Facts, text: string, decl: Decl): void {
    const size = px(text);

    if (size === undefined || size < 8 || size > 160) {
        return;
    }

    const rounded = Math.round(size * 100) / 100;
    const fact = facts.sizes.get(rounded) ?? { count: 0, body: 0, heading: 0, forms: new Map() };

    fact.count += 1;
    bump(fact.forms, text.trim());

    if (HEADING.test(decl.selector)) {
        fact.heading += 1;
    }

    if (BODY.test(decl.selector) || rootish(decl.selector)) {
        fact.body += 1;
    }

    facts.sizes.set(rounded, fact);
}

const SPACING_PROPS =
    /^(?:padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap|grid-gap|grid-row-gap|grid-column-gap)$/;

function useSpacing(facts: Facts, value: string): void {
    for (const part of parts(value)) {
        const size = px(part);

        if (size !== undefined && size >= 1 && size <= 256) {
            bump(facts.spacing, Math.round(size * 4) / 4);
        }
    }
}

const FULL_RADIUS =
    /^(?:50%|100%|9999?px|99999?px|999rem|9999rem|100vmax|calc\(infinity \* 1px\))$/i;

function useRadius(facts: Facts, value: string): void {
    for (const part of value.split("/").flatMap((half) => parts(half))) {
        const text = part.trim();
        const full = FULL_RADIUS.test(text);
        const size = full ? undefined : px(text);

        if (full || (size !== undefined && size > 0 && size <= 200)) {
            const key = full ? "full" : `${Math.round(size! * 100) / 100}`;
            const fact = facts.radii.get(key) ?? { count: 0, text };

            fact.count += 1;
            facts.radii.set(key, fact);
        }
    }
}

const EASING =
    /\b(?:ease-in-out|ease-in|ease-out|ease|linear)\b|cubic-bezier\(\s*[\d.\s,-]+\)|steps\([^)]*\)/gi;

function useMotion(facts: Facts, decl: Decl): void {
    const { prop, value } = decl;

    if (
        prop === "transition" ||
        prop === "animation" ||
        prop === "transition-duration" ||
        prop === "animation-duration"
    ) {
        const clean = value.replace(/cubic-bezier\([^)]*\)|steps\([^)]*\)|var\([^)]*\)/gi, " ");

        // In a shorthand the first time is the duration; the second is a delay.
        for (const layer of commaParts(clean)) {
            const first = /(?<![\w.-])(\d*\.?\d+)(ms|s)\b/.exec(layer);

            if (first !== null) {
                const ms = Math.round(Number(first[1]) * (first[2] === "s" ? 1000 : 1));

                if (ms >= 30 && ms <= 5000) {
                    bump(facts.durations, ms);
                }
            }
        }
    }

    if (
        prop === "transition" ||
        prop === "animation" ||
        prop === "transition-timing-function" ||
        prop === "animation-timing-function"
    ) {
        for (const match of value.matchAll(EASING)) {
            bump(facts.easings, match[0].toLowerCase().replace(/\s+/g, " "));
        }
    }
}

/** Counts a declaration (not a custom property) in all the tallies. */
function ingest(facts: Facts, decl: Decl): void {
    const dark = decl.scope === "dark";

    useColors(facts, decl, dark);

    if (dark) {
        return;
    }

    switch (decl.prop) {
        case "font-family": {
            const stack = stackOf(decl.value);

            if (stack !== undefined) {
                useFont(facts, stack, decl);
            }

            return;
        }

        case "font": {
            const match =
                /^(?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|\d{3})\s+)*(?<size>[\d.]+(?:px|rem|em|pt))(?:\/(?<line>[\d.]+(?:px|rem|em)?))?\s+(?<family>.+)$/i.exec(
                    decl.value,
                );

            if (match?.groups !== undefined) {
                const stack = stackOf(match.groups.family!);

                useSize(facts, match.groups.size!, decl);

                if (stack !== undefined) {
                    useFont(facts, stack, decl);
                }

                const weight = /(?:^|\s)(\d{3})\s/.exec(decl.value)?.[1];
                const line = Number(match.groups.line);

                if (weight !== undefined) {
                    bump(facts.weights, Number(weight));
                }

                if (Number.isFinite(line) && line >= 1 && line <= 3) {
                    bump(facts.leadings, Math.round(line * 1000) / 1000);
                }
            }

            return;
        }

        case "font-size":
            useSize(facts, decl.value, decl);

            return;

        case "font-weight": {
            const weight = /^\d{3}$/.test(decl.value.trim())
                ? Number(decl.value)
                : ({ normal: 400, bold: 700 } as Record<string, number>)[
                      decl.value.trim().toLowerCase()
                  ];

            if (weight !== undefined) {
                bump(facts.weights, weight);
            }

            return;
        }

        case "line-height": {
            const value = Number(decl.value.trim());

            if (Number.isFinite(value) && value >= 1 && value <= 3) {
                bump(facts.leadings, Math.round(value * 1000) / 1000);
            }

            return;
        }

        case "letter-spacing": {
            const text = decl.value.trim();

            if (/^-?\d*\.?\d+(?:em|px|rem)$/.test(text) && Number.parseFloat(text) !== 0) {
                bump(facts.tracking, text);
            }

            return;
        }

        case "border-radius":
        case "border-top-left-radius":
        case "border-top-right-radius":
        case "border-bottom-left-radius":
        case "border-bottom-right-radius":
            useRadius(facts, decl.value);

            return;
        case "box-shadow":
            if (
                !/^(?:none|inherit|initial|unset)$/i.test(decl.value) &&
                !/var\(/.test(decl.value)
            ) {
                bump(facts.shadows, decl.value.replace(/\s+/g, " ").trim());
            }

            return;

        default:
            if (SPACING_PROPS.test(decl.prop)) {
                useSpacing(facts, decl.value);
            } else {
                useMotion(facts, decl);
            }
    }
}

// --- Variables -----------------------------------------------------------------------------------------------------

/** The category that a Tailwind v4 namespace states: `--color-brand` is a color, `--radius-lg` a radius. */
export function namespaceOf(name: string): { category: Category; rest: string } | undefined {
    const table: [RegExp, Category][] = [
        [/^color-/, "color"],
        [/^font-weight-/, "weight"],
        [/^font-/, "font"],
        [/^text-(?!.*--)/, "text"],
        [/^spacing-/, "space"],
        [/^radius-/, "radius"],
        [/^shadow-|^inset-shadow-|^drop-shadow-/, "shadow"],
        [/^ease-/, "ease"],
        [/^breakpoint-/, "breakpoint"],
        [/^leading-/, "leading"],
        [/^tracking-/, "tracking"],
        [/^blur-/, "size"],
        [/^container-/, "size"],
    ];

    for (const [pattern, category] of table) {
        if (pattern.test(name)) {
            return { category, rest: name.replace(pattern, "") };
        }
    }

    return undefined;
}

function addVar(facts: Facts, fact: Omit<VarFact, "order" | "rank">): void {
    facts.vars.push({ ...fact, order: facts.vars.length, rank: facts.rank });
}

/** The keys of a JavaScript theme, and what each holds. */
const THEME_KEYS: Record<string, Category> = {
    colors: "color",
    color: "color",
    colours: "color",
    palette: "color",
    fontFamily: "font",
    fontFamilies: "font",
    fonts: "font",
    fontSize: "text",
    fontSizes: "text",
    fontWeight: "weight",
    fontWeights: "weight",
    lineHeight: "leading",
    lineHeights: "leading",
    letterSpacing: "tracking",
    spacing: "space",
    space: "space",
    spacings: "space",
    borderRadius: "radius",
    radii: "radius",
    radius: "radius",
    rounded: "radius",
    boxShadow: "shadow",
    shadows: "shadow",
    shadow: "shadow",
    elevation: "shadow",
    screens: "breakpoint",
    breakpoints: "breakpoint",
    transitionDuration: "duration",
    durations: "duration",
    transitionTimingFunction: "ease",
    easings: "ease",
    easing: "ease",
    zIndex: "z",
};

/** A leaf of a theme object: the path of keys, and its text. */
function leaves(
    literal: Literal,
    path: string[],
    out: { path: string[]; value: string }[],
    category: Category,
): void {
    if (out.length > 600 || path.length > 6) {
        return;
    }

    if (typeof literal === "string") {
        out.push({ path, value: literal });
    } else if (typeof literal === "number") {
        out.push({ path, value: String(literal) });
    } else if (Array.isArray(literal)) {
        const strings = literal.filter((item): item is string => typeof item === "string");

        // A font stack is a list of names; a Tailwind font size is [size, { lineHeight }].
        if (strings.length > 0) {
            out.push({
                path,
                value:
                    category === "font"
                        ? strings
                              .map((name) =>
                                  /^[\w-]+$/.test(name) || GENERIC.has(name) ? name : `"${name}"`,
                              )
                              .join(", ")
                        : strings[0]!,
            });
        } else if (typeof literal[0] === "number") {
            out.push({ path, value: String(literal[0]) });
        }
    } else if (typeof literal === "object" && literal !== null) {
        for (const [key, child] of Object.entries(literal)) {
            leaves(
                child,
                key === "DEFAULT" || key === "default" ? path : [...path, key],
                out,
                category,
            );
        }
    }
}

/** Reads theme objects from a JavaScript or TypeScript file: `colors: { … }`, `const palette = { … }`. */
function themeVars(facts: Facts, file: string, text: string): void {
    const keys = Object.keys(THEME_KEYS).join("|");
    const heads = new RegExp(
        String.raw`(?<![\w$.])(${keys})\s*:\s*(?=[{[])|(?<![\w$.])(?:const|let|var)\s+(${keys})\s*(?::[^=\n]{1,80})?=\s*(?=[{[])`,
        "g",
    );
    let seen = 0;

    for (const match of text.matchAll(heads)) {
        if (++seen > 60) {
            break;
        }

        const key = match[1] ?? match[2]!;
        const category = THEME_KEYS[key]!;
        const literal = readLiteral(text, match.index + match[0].length);

        if (literal === undefined || literal === UNKNOWN) {
            continue;
        }

        const found: { path: string[]; value: string }[] = [];

        leaves(literal, [], found, category);

        for (const leaf of found) {
            if (leaf.path.length === 0 && category !== "font") {
                continue;
            }

            addVar(facts, {
                name: leaf.path.join("-") || key,
                value: leaf.value.slice(0, 400),
                scope: "default",
                kind: "js",
                file,
                hint: category,
            });
        }
    }
}

// --- Whole files ---------------------------------------------------------------------------------------------------

const CLASS_USE =
    /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|from|to|via|divide|decoration|accent|caret|placeholder|shadow)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g;
const TEXT_CLASS = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;
const ROUNDED_CLASS = /(?<![\w-])rounded(?:-(none|xs|sm|md|lg|xl|2xl|3xl|full))?(?![\w-])/g;
const WEIGHT_CLASS =
    /(?<![\w-])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])/g;
const SPACING_CLASS =
    /(?<![\w-])(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w-])/g;

/** The theme-like file names: a JavaScript file with these may hold a design theme. */
const THEMEISH =
    /(?:^|\/)(?:tailwind\.config|[^/]*(?:theme|tokens?|colors?|palette|design|variables|styles?|constants?|config)[^/]*)\.(?:[cm]?[jt]s|tsx?)$|\/(?:theme|themes|tokens|styles|design|constants)\/[^/]+\.[cm]?[jt]sx?$/i;

function ingestStyles(facts: Facts, file: string, decls: Decl[]): void {
    for (const decl of decls) {
        if (decl.prop.startsWith("--")) {
            const name = decl.prop.slice(2);

            if (decl.scope === "other") {
                bump(facts.scoped, decl.selector.slice(0, 80));

                continue;
            }

            addVar(facts, {
                name,
                value: decl.value,
                scope: decl.scope,
                kind: decl.theme ? "theme" : "css",
                file,
            });

            continue;
        }

        if (decl.prop.startsWith("$") && /^\(.*\)$/s.test(decl.value)) {
            // An SCSS map: `$spacers: (1: 0.25rem, 2: 0.5rem)` is one variable for each entry.
            for (const entry of commaParts(decl.value.slice(1, -1)).slice(0, 80)) {
                const colon = entry.indexOf(":");
                const key = entry
                    .slice(0, colon)
                    .trim()
                    .replace(/^["']|["']$/g, "");
                const value = entry.slice(colon + 1).trim();

                if (
                    colon > 0 &&
                    /^[\w-]{1,40}$/.test(key) &&
                    value !== "" &&
                    !value.startsWith("(")
                ) {
                    addVar(facts, {
                        name: `${decl.prop.slice(1)}-${key}`,
                        value: value.slice(0, 400),
                        scope: decl.scope,
                        kind: "scss",
                        file,
                    });
                }
            }

            continue;
        }

        if (decl.prop.startsWith("$") || decl.prop.startsWith("@")) {
            addVar(facts, {
                name: decl.prop.slice(1),
                value: decl.value,
                scope: decl.scope,
                kind: decl.prop.startsWith("$") ? "scss" : "less",
                file,
            });

            continue;
        }

        ingest(facts, decl);

        for (const at of decl.at) {
            breakpointsIn(facts, at);
        }
    }
}

function breakpointsIn(facts: Facts, query: string): void {
    for (const match of query.matchAll(
        /\(\s*(?:min-width\s*:\s*(\d*\.?\d+)(px|em|rem)|width\s*>=?\s*(\d*\.?\d+)(px|em|rem))/gi,
    )) {
        const size = px(`${match[1] ?? match[3]}${(match[2] ?? match[4])!}`);

        if (size !== undefined && size >= 320 && size <= 3000) {
            bump(facts.breakpoints, Math.round(size));
        }
    }
}

/** Reads one file's text into the facts. `extension` is the lower-case ending with its dot. */
export function ingestFile(facts: Facts, rel: string, extension: string, raw: string): void {
    const text = stripComments(raw);

    // `$x` and `@x` are uses of a stylesheet variable.
    if (extension === ".scss" || extension === ".sass" || extension === ".less") {
        for (const match of text.matchAll(/[$@]([A-Za-z_][\w-]*)(?!\s*:)/g)) {
            bump(facts.varUse, match[1]!);
        }
    }

    // `var(--x)` is a use of a variable, wherever it is written.
    for (const match of text.matchAll(/var\(\s*--([\w-]+)/g)) {
        bump(facts.varUse, match[1]!);
    }

    if (
        /@import\s+["']tailwindcss|@tailwind\s+base|@theme\b|tailwind\.config/.test(text) ||
        /(?:^|\/)tailwind\.config\./.test(rel)
    ) {
        facts.tailwind = true;
    }

    if (extension === ".json") {
        importTokens(facts.imported, rel, raw);

        return;
    }

    const isStyle = /^\.(?:css|scss|sass|less|pcss|postcss)$/.test(extension);
    const isPage = /^\.(?:html|htm|vue|svelte|astro|mdx|php|erb|hbs|njk)$/.test(extension);
    const isScript = /^\.(?:[cm]?[jt]s|[jt]sx)$/.test(extension);

    if (isStyle) {
        ingestStyles(facts, rel, parseStyles(raw));
    } else if (isPage) {
        const { blocks, inline } = pageStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block));
        }

        ingestStyles(facts, rel, inline);
    } else if (isScript) {
        const blocks = templateStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block));
        }

        ingestStyles(facts, rel, objectStyles(raw));

        if (THEMEISH.test(rel)) {
            themeVars(facts, rel, raw);
        }
    }

    if (isPage || isScript) {
        let seen = 0;

        for (const match of text.matchAll(CLASS_USE)) {
            if (++seen > 8000) {
                break;
            }

            bump(facts.classUse, match[1]!);
        }

        seen = 0;

        for (const match of text.matchAll(SPACING_CLASS)) {
            if (++seen > 8000) {
                break;
            }

            // Tailwind's step is a multiple of 0.25rem (4px).
            bump(facts.classSpacing, Number(match[1]) * 4);
        }

        for (const [pattern, map] of [
            [TEXT_CLASS, facts.classText],
            [ROUNDED_CLASS, facts.classRadius],
            [WEIGHT_CLASS, facts.classWeight],
        ] as const) {
            seen = 0;

            for (const match of text.matchAll(pattern)) {
                if (++seen > 8000) {
                    break;
                }

                bump(map, match[1] ?? "default");
            }
        }
    }
}
