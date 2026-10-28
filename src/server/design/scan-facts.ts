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
    indentedToBraces,
    isDarkSelector,
    objectStyles,
    pageStyles,
    parseStyles,
    parts,
    px,
    readLiteral,
    stripComments,
    templateStyles,
} from "./scan-parse.ts";
import { nameScore, words } from "./scan-colors.ts";
import { importTokens, type Imported } from "./scan-import.ts";

/** A list of words from one string. */
const w = (text: string) => text.split(" ");

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
    /** The line of the file where the variable is set, when known. */
    line?: number;
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
    /** As a background on a card, panel, modal, or the like. */
    surface: number;
    /** When it was first seen: the earlier of two equal colors is the one the author wrote first. */
    order: number;
    /** Where it was first seen, as `file:line`. */
    at?: string;
}

/** How a color is used, by kind of property (the counts of a `ColorFact`). */
export type Kinds = Pick<
    ColorFact,
    "bg" | "text" | "border" | "fill" | "shadow" | "other" | "root" | "body" | "surface"
>;

export const emptyKinds = (): Kinds => ({
    bg: 0,
    text: 0,
    border: 0,
    fill: 0,
    shadow: 0,
    other: 0,
    root: 0,
    body: 0,
    surface: 0,
});

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
    /** The project has a WordPress `theme.json`: its variables are named `--wp--preset--…`. */
    wordpress?: boolean;
    /** The Sass mixins that hold the dark mode (`@include dark { … }`), from every file. */
    darkMixins: Set<string>;
    /** The file being read, relative to the scanned folder. */
    file?: string;
    /** The mode that the file being read is named for (`dark.less`), when it is one. */
    fileMode?: Scope;
    /** Declarations that compute a size from custom properties (`calc(var(--gap) * 2)`): the scan resolves them later. */
    deferred: { prop: string; value: string; selector: string }[];
    /** 3 or 4: which defaults the utility classes mean. */
    tailwindVersion: 3 | 4;
    /** How the project uses Tailwind's default colors by class (`bg-slate-200`, `text-white`), by color name. */
    classColors: Map<string, Kinds>;
    vars: VarFact[];
    colors: Map<string, ColorFact>;
    darkColors: Map<string, ColorFact>;
    varUse: Map<string, number>;
    /** How each custom property is used as a color: `background: var(--ink)` is a background use of `--ink`. */
    varKinds: Map<string, Kinds>;
    /** What each length variable is used for: spacing, type size, radius, or the size of a box. */
    varLayout: Map<string, { space: number; text: number; radius: number; box: number }>;
    classUse: Map<string, number>;
    /** The classes on the page's `<body>` and `<html>`: their rules style the whole page. */
    rootClasses: Set<string>;
    /** How often each class name is used in markup (`class="a b"`). */
    classCount: Map<string, number>;
    /** The colors that a rule with one class sets (`.text-gray-900 { color: … }`), by class, in each mode. */
    classRules: Map<string, { kind: "bg" | "text" | "border"; light?: string; dark?: string }>;
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
        deferred: [],
        tailwindVersion: 3,
        classColors: new Map(),
        vars: [],
        colors: new Map(),
        darkColors: new Map(),
        varUse: new Map(),
        varKinds: new Map(),
        varLayout: new Map(),
        classUse: new Map(),
        rootClasses: new Set(),
        darkMixins: new Set(),
        classCount: new Map(),
        classRules: new Map(),
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
    /^(?:html|body|:root|#root|#app|#__next|main|\.app|\.App|#app-root|\.(?:page|wrapper|layout|site|shell|root|app-shell|page-wrapper|site-wrapper|app-wrapper|container|screen|safeArea|safe-area)|#(?:page|wrapper|main|site|layout))(?:[.#:[][^\s,>+~]*)?$/;
const rootish = (selector: string) =>
    selector !== "" &&
    selector
        .split(",")
        .map((part) => part.trim())
        .every((part) => ROOTISH.test(part));
const SURFACE_SELECTOR =
    /(?:^|[\s,>+~.#:_-])(?:card|panel|surface|modal|dialog|popover|tile|well|sheet|drawer|dropdown|menu|tooltip|toast|box|pop)[\w-]*/i;
const HEADING =
    /(?:^|[\s,>+~])(?:h[1-6]|\.h[1-6]|\.(?:title|heading|headline|display)[\w-]*)(?![\w-])/i;
const BODY = /(?:^|[\s,>+~])(?:body|html|p|:root|\.text|\.body|main)(?![\w-])/i;
const CODE = /(?:^|[\s,>+~])(?:code|pre|kbd|samp|\.mono|\.code)(?![\w-])/i;

export function colorFact(
    map: Map<string, ColorFact>,
    hex: string,
    text: string,
    at?: string,
): ColorFact {
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
            surface: 0,
            order: map.size,
            ...(at === undefined ? {} : { at }),
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

    const count = (fact: Kinds) => {
        fact[kind] += 1;

        if (kind === "bg" && rootish(decl.selector)) {
            fact.root += 1;
        }

        if (kind === "bg" && SURFACE_SELECTOR.test(decl.selector)) {
            fact.surface += 1;
        }

        if (kind === "text" && (rootish(decl.selector) || BODY.test(decl.selector))) {
            fact.body += 1;
        }
    };

    for (const color of found) {
        count(
            colorFact(
                map,
                color.hex,
                color.text,
                facts.file === undefined || decl.line === undefined
                    ? undefined
                    : `${facts.file}:${decl.line}`,
            ),
        );
    }

    // A rule with one class (`.text-gray-900 { color: #111827 }`, `.dark .text-gray-900 { color: #f9fafb }`) is that
    // class's color in its mode: used as often as markup uses the class, and paired with its other mode.
    const single = /^(?:[^\s,]*\s+)?\.([\w-]+)$/.exec(decl.selector.trim());

    if (
        single !== null &&
        found.length === 1 &&
        (kind === "bg" || kind === "text" || kind === "border") &&
        facts.classRules.size < 600 &&
        (decl.selector.trim() === `.${single[1]}` || (dark && isDarkSelector(decl.selector)))
    ) {
        const rule = facts.classRules.get(`${single[1]}|${kind}`) ?? { kind };

        rule[dark ? "dark" : "light"] = found[0]!.hex;
        facts.classRules.set(`${single[1]}|${kind}`, rule);
    }

    // A color that comes by a variable is a use of that variable (and of the color it holds, once the scan knows it).
    if (known !== undefined && !dark) {
        for (const match of decl.value.matchAll(/var\(\s*--([\w-]+)/g)) {
            const kinds = facts.varKinds.get(match[1]!) ?? emptyKinds();

            count(kinds);
            facts.varKinds.set(match[1]!, kinds);
        }
    }
}

// --- Other uses ----------------------------------------------------------------------------------------------------

const GENERIC = new Set(
    w(
        "serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong",
    ),
);

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

const FULL_RADIUS = /^(?:9{3,}px|9{3,}rem|100vmax|calc\(infinity \* 1px\))$/i;

function useRadius(facts: Facts, value: string): void {
    for (const part of value.split("/").flatMap((half) => parts(half))) {
        const text = part.trim();

        // A percentage makes a circle of a square; it is not a size.
        if (text.endsWith("%")) {
            continue;
        }

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

const SASS_PROPS =
    /^(?:padding|margin|gap|row-gap|column-gap|border-radius|font-size|box-shadow|border|border-(?:top|right|bottom|left)|outline|color|background|background-color|border-color)(?:-[a-z-]+)?$/;
const SCALE_PROPS =
    /^(?:padding|margin|gap|row-gap|column-gap|border-radius|font-size)(?:-[a-z-]+)?$/;

/** Counts a declaration (not a custom property) in all the tallies. */
export function ingest(facts: Facts, decl: Decl): void {
    // A length variable shows what it is for by the property that takes it: `padding: var(--size-4)` is spacing.
    if (decl.value.includes("var(")) {
        const group = SPACING_PROPS.test(decl.prop)
            ? "space"
            : decl.prop === "font-size"
              ? "text"
              : /^border(?:-\w+)*-radius$/.test(decl.prop)
                ? "radius"
                : /^(?:width|height|min-width|min-height|max-width|max-height|inline-size|block-size|flex-basis)$/.test(
                        decl.prop,
                    )
                  ? "box"
                  : undefined;

        if (group !== undefined) {
            for (const match of decl.value.matchAll(/var\(\s*--([\w-]+)/g)) {
                const layout = facts.varLayout.get(match[1]!) ?? {
                    space: 0,
                    text: 0,
                    radius: 0,
                    box: 0,
                };

                layout[group] += 1;
                facts.varLayout.set(match[1]!, layout);
            }
        }
    }

    // A size computed from custom properties (or from Sass variables: `$unit * 2`, `rgba($black, .2)`) is resolved once
    // the scan knows the variables.
    if (
        ((SCALE_PROPS.test(decl.prop) && /calc\(/.test(decl.value) && /var\(/.test(decl.value)) ||
            (SASS_PROPS.test(decl.prop) &&
                (/(?<![\w$@-])[$@][A-Za-z_]/.test(decl.value) ||
                    /(?<![\w-])(?:tint-color|shade-color|shift-color|darken|lighten|desaturate|fade-in|fade-out|transparentize|opacify|adjust-hue|mix)\(/.test(
                        decl.value,
                    )) &&
                !/\$\{/.test(decl.value))) &&
        facts.deferred.length < 1500
    ) {
        facts.deferred.push({ prop: decl.prop, value: decl.value, selector: decl.selector });

        return;
    }

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
    // A file that is the other mode's (`dark.less`, `themes/night/colors.css`) sets that mode's values.
    const scope =
        fact.scope === "default" && facts.fileMode !== undefined ? facts.fileMode : fact.scope;

    facts.vars.push({ ...fact, scope, order: facts.vars.length, rank: facts.rank });
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
    // A typography block: `h1: { fontSize: "2.5rem" }` (read by `typographyVars`, not as a scale).
    typography: "text",
    // Mantine: `headings: { fontFamily, sizes: { h1: { fontSize } } }` and a monospace family.
    headings: "text",
    fontFamilyMonospace: "font",
    // Mantine's `other: { bodyLight: "#fff", bodyDark: "#1a1b1e" }`: only the values that are colors are read.
    other: "color",
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

        // A palette as a list of shades (Mantine, Chakra): `brand: ["#eff5ff", …, "#2c4478"]` is `brand-0` to `brand-9`.
        if (
            category === "color" &&
            strings.length >= 5 &&
            strings.every((value) => /^\s*(?:#[0-9a-f]{3,8}|(?:rgb|hsl|oklch)a?\()/i.test(value))
        ) {
            strings.forEach((value, at) => out.push({ path: [...path, String(at)], value }));
        } else if (category === "shadow") {
            // A list of shadows (Material's elevations) is one token each; `none` is no shadow.
            strings.forEach((value, at) => {
                if (value.trim() !== "none") {
                    out.push({ path: [...path, String(at)], value });
                }
            });
        } else if (strings.length > 0) {
            // A font stack is a list of names; a Tailwind font size is [size, { lineHeight }].
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

/**
 * A typography block of a theme (Material UI, Theme UI): the base `fontFamily` and `fontSize`, and each variant
 * (`h1: { fontSize: "2.5rem", fontFamily: … }`) as a size.
 */
function typographyVars(facts: Facts, file: string, scope: Scope, block: Literal): void {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
        return;
    }

    const add = (name: string, hint: Category, value: unknown) => {
        const text =
            typeof value === "number" ? (hint === "text" ? `${value}px` : String(value)) : value;

        if (typeof text === "string" && text !== "") {
            addVar(facts, { name, value: text.slice(0, 400), scope, kind: "js", file, hint });
        }
    };

    const variants = { ...(block as Record<string, Literal>) };
    const sizes = variants.sizes;

    // Mantine: `headings: { sizes: { h1: { fontSize: "2.25rem" } } }`.
    if (typeof sizes === "object" && sizes !== null && !Array.isArray(sizes)) {
        delete variants.sizes;
        Object.assign(variants, sizes);
    }

    for (const [key, child] of Object.entries(variants)) {
        if (key === "fontFamily") {
            add("base", "font", child);
        } else if (key === "fontSize") {
            add("base", "text", child);
        } else if (typeof child === "object" && child !== null && !Array.isArray(child)) {
            const variant = child as Record<string, Literal>;

            add(key, "text", variant.fontSize);

            if (typeof variant.fontFamily === "string") {
                add(key, "font", variant.fontFamily);
            }
        }
    }
}

/** The line of the first `needle` at or after `from`, when the text has one. */
function lineFrom(text: string, needle: string, from: number): number | undefined {
    const at = needle === "" ? -1 : text.indexOf(needle, from);

    return at === -1 ? undefined : 1 + (text.slice(0, at).match(/\n/g)?.length ?? 0);
}

/** The index after the brace that closes the one at `open`, skipping strings; undefined when it does not close in reach. */
function braceEnd(text: string, open: number): number | undefined {
    let depth = 0;
    let quote = "";

    for (let at = open; at < Math.min(text.length, open + 60_000); at++) {
        const char = text[at]!;

        if (quote !== "") {
            if (char === "\\") {
                at += 1;
            } else if (char === quote) {
                quote = "";
            } else if (char === "\n" && quote !== "`") {
                quote = "";
            }
        } else if (char === '"' || char === "'" || char === "`") {
            quote = char;
        } else if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;

            if (depth === 0) {
                return at + 1;
            }
        }
    }

    return undefined;
}

/** The mode that a name stands for (`darkTheme`, `theme_light`, `NIGHT`): dark, light, or none. */
function modeOf(name: string): Scope | undefined {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/);

    // `mydark`, `appdark`: a mode word at the end of a name is a mode too (a theme called `mytheme`/`mydark` in daisyUI).
    const last = words.at(-1) ?? "";

    if (
        words.some((word) => word === "dark" || word === "night" || word === "dim") ||
        /^[a-z]{2,}(?:dark|night)$/.test(last)
    ) {
        return "dark";
    }

    return words.some((word) => word === "light" || word === "day") || /^[a-z]{2,}light$/.test(last)
        ? "light"
        : undefined;
}

/** Reads theme objects from a JavaScript or TypeScript file: `colors: { … }`, `const palette = { … }`. */
function themeVars(facts: Facts, file: string, text: string): void {
    const keys = Object.keys(THEME_KEYS).join("|");
    const heads = new RegExp(
        String.raw`(?<![\w$.])(${keys})\s*:\s*(?=[{[])|(?<![\w$.])(?:const|let|var)\s+(${keys})\s*(?::[^=\n]{1,80})?=\s*(?=[{[])|(?<![\w$.])(fontFamily|fontFamilyMonospace|fontSize|borderRadius)\s*:\s*(?=["'])`,
        "g",
    );
    // The objects the file declares by name (`const brand = { 50: "#e3f0ff" }`), for `colors: { brand }`.
    const env = new Map<string, Literal>();

    for (const match of text.matchAll(
        /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,80})?=\s*(?=[{[])/g,
    )) {
        if (env.size >= 40) {
            break;
        }

        const literal = readLiteral(text, match.index + match[0].length);

        if (typeof literal === "object" && literal !== null) {
            env.set(match[1]!, literal);
        }
    }

    // The objects a key sits in: a declaration (`const darkTheme = {…}`), or a key (`dark: {…}`, `light: {…}`). A name
    // with a mode word in it ("dark", "night", "light", "day") holds that mode's values; the nearest such object around
    // the key decides.
    const owners = [
        ...text.matchAll(
            /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?<![\w$.])([A-Za-z_$][\w$]*)\s*:\s*(?=\{)/g,
        ),
    ]
        .filter((owner) => modeOf(owner[1] ?? owner[2]!) !== undefined)
        .slice(0, 200)
        .flatMap((owner) => {
            const name = owner[1] ?? owner[2]!;
            const from = owner.index + owner[0].length;
            const open = owner[2] === undefined ? text.indexOf("{", from) : from;

            // A declaration owns the first object after its `=` (or the call that wraps it), unless a statement ends first.
            if (
                open === -1 ||
                (owner[2] === undefined &&
                    (open - from > 160 || text.slice(from, open).includes(";")))
            ) {
                return [];
            }

            const end = braceEnd(text, open);

            return end === undefined ? [] : [{ at: owner.index, end, name, mode: modeOf(name) }];
        });
    const scopeAt = (index: number): Scope =>
        owners
            .filter((owner) => owner.at < index && index < owner.end && owner.mode !== undefined)
            .at(-1)?.mode ?? "default";
    let seen = 0;

    // A base unit written as a number: `spacing: 8`, `shape: { borderRadius: 4 }` (Material UI, Chakra).
    for (const match of text.matchAll(
        /(?<![\w$.])(spacing|borderRadius)\s*:\s*(\d+(?:\.\d+)?)(?![\w.%])(?=\s*[,}\n])/g,
    )) {
        if (++seen > 60) {
            break;
        }

        addVar(facts, {
            name: match[1]!,
            value: `${match[2]}px`,
            scope: scopeAt(match.index),
            kind: "js",
            file,
            hint: match[1] === "spacing" ? "space" : "radius",
        });
    }

    const paletteTree: Record<string, Literal> = {};
    const references: { name: string; target: string; hint: Category }[] = [];

    for (const match of text.matchAll(heads)) {
        if (++seen > 60) {
            break;
        }

        const key = match[1] ?? match[2] ?? match[3]!;
        const category = THEME_KEYS[key]!;
        // A scalar (`fontFamily: "Inter, sans-serif"`, `fontSize: "15px"`) or an object or list.
        const scalar =
            match[3] === undefined
                ? undefined
                : /^(["'])((?:\\.|(?!\1)[^\\\n]){1,300})\1/.exec(
                      text.slice(
                          match.index + match[0].length,
                          match.index + match[0].length + 320,
                      ),
                  );
        const literal =
            match[3] === undefined
                ? readLiteral(text, match.index + match[0].length, env)
                : scalar === null || scalar === undefined
                  ? undefined
                  : scalar[2]!;

        if (literal === undefined || literal === UNKNOWN) {
            continue;
        }

        const scope = scopeAt(match.index);

        if (key === "typography" || key === "headings") {
            typographyVars(facts, file, scope, literal);

            continue;
        }

        // A list of numbers (`space: [0, 4, 8, 16]`, `fontSizes: [12, 14, 16]`) is used like a scale: counted, not named.
        if (
            Array.isArray(literal) &&
            literal.length >= 2 &&
            literal.every((item) => typeof item === "number")
        ) {
            for (const size of literal as number[]) {
                if (scope !== "dark" && category === "space" && size > 0) {
                    bump(facts.spacing, size, 2);
                } else if (scope !== "dark" && category === "text" && size >= 8 && size <= 160) {
                    const fact = facts.sizes.get(size) ?? {
                        count: 0,
                        body: 0,
                        heading: 0,
                        forms: new Map(),
                    };

                    fact.count += 2;
                    bump(fact.forms, `${size}px`);
                    facts.sizes.set(size, fact);
                }
            }

            continue;
        }

        if (category === "color" && typeof literal === "object" && !Array.isArray(literal)) {
            Object.assign(paletteTree, literal);
        }

        const emit = (part: Literal, at: Scope) => {
            const found: { path: string[]; value: string }[] = [];

            leaves(part, [], found, category);

            // Tokens that name other tokens of the group: Stitches `"$gray1"`, `"$colors$gray1"`, `"{colors.gray.1}"`.
            const byName = new Map(found.map((leaf) => [leaf.path.join("-"), leaf.value]));

            const resolve = (value: string): string | undefined => {
                let current = value;

                for (let hop = 0; hop < 4 && /^\{[\w.$-]+\}$|^\$[\w$.-]+$/.test(current); hop++) {
                    const name = current.replace(/^\{|\}$/g, "").replace(/^\$/, "");
                    const full = name.split(/[$.]/).filter((part) => part !== "");
                    const next =
                        byName.get(full.join("-")) ??
                        byName.get(full.slice(1).join("-")) ??
                        byName.get(full.at(-1) ?? "");

                    if (next === undefined) {
                        return undefined;
                    }

                    current = next;
                }

                return /^\{|^\$/.test(current) ? undefined : current;
            };

            for (const leaf of found) {
                // A scalar under the theme key itself (`fontSize: "15px"`) is the base value, when it is a length.
                if (
                    leaf.path.length === 0 &&
                    category !== "font" &&
                    !/^\s*\d*\.?\d+(?:px|rem|em)\s*$/.test(leaf.value)
                ) {
                    continue;
                }

                const value = resolve(leaf.value);

                if (value === undefined) {
                    continue;
                }

                // Remember which token a reference named, so the other mode's value of that token can follow it.
                if (value !== leaf.value && at === "default") {
                    const target = leaf.value
                        .replace(/^\{|\}$/g, "")
                        .split(/[$.]/)
                        .filter((part) => part !== "")
                        .at(-1);

                    if (target !== undefined) {
                        references.push({
                            name: leaf.path.join("-") || key,
                            target,
                            hint: category,
                        });
                    }
                }

                leaf.value = value;

                const line = lineFrom(text, leaf.value, match.index);

                addVar(facts, {
                    name: leaf.path.join("-") || key,
                    value: leaf.value.slice(0, 400),
                    scope: at,
                    kind: "js",
                    file,
                    hint: category,
                    ...(line === undefined ? {} : { line }),
                });
            }
        };

        // `colors: { light: { … }, dark: { … } }`: a block for each mode holds that mode's values.
        const blocks =
            typeof literal === "object" && literal !== null && !Array.isArray(literal)
                ? Object.entries(literal).filter(
                      ([name, child]) =>
                          modeOf(name) !== undefined &&
                          typeof child === "object" &&
                          child !== null &&
                          !Array.isArray(child),
                  )
                : [];

        if (blocks.length > 0 && category !== "text") {
            for (const [name, child] of blocks) {
                emit(child, modeOf(name)!);
            }

            emit(
                Object.fromEntries(
                    Object.entries(literal as Record<string, Literal>).filter(
                        ([name]) => !blocks.some(([block]) => block === name),
                    ),
                ),
                scope,
            );
        } else {
            emit(literal, scope);
        }
    }

    // `bg: "$gray1"` in the base theme, and a dark theme that sets `gray1`: the dark `bg` is the dark `gray1`.
    for (const { name, target, hint } of references) {
        const other = facts.vars.findLast(
            (fact) =>
                fact.file === file &&
                fact.name === target &&
                fact.hint === hint &&
                fact.scope !== "default",
        );

        if (other !== undefined) {
            addVar(facts, { name, value: other.value, scope: other.scope, kind: "js", file, hint });
        }
    }

    modeBlocks(facts, file, text, env, scopeAt);
    themeList(facts, file, text, env);

    semanticTokens(facts, file, text, env, paletteTree, scopeAt);
}

/**
 * A list of themes, each an object with one key (daisyUI: `themes: [{ mytheme: { primary: "#570df8", … } }, { dark: … }]`):
 * a theme named for a mode is that mode; the first other one is the default.
 */
function themeList(
    facts: Facts,
    file: string,
    text: string,
    env: ReadonlyMap<string, Literal>,
): void {
    let defaults = 0;

    for (const match of [...text.matchAll(/(?<![\w$.])themes\s*:\s*(?=\[)/g)].slice(0, 2)) {
        const list = readLiteral(text, match.index + match[0].length, env);

        if (!Array.isArray(list)) {
            continue;
        }

        for (const item of list.slice(0, 12)) {
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
                continue;
            }

            for (const [name, theme] of Object.entries(item).slice(0, 4)) {
                const mode = modeOf(name);

                if (typeof theme !== "object" || theme === null || Array.isArray(theme)) {
                    continue;
                }

                const found: { path: string[]; value: string }[] = [];

                leaves(theme, [], found, "color");

                const colors = found.filter((leaf) =>
                    /^\s*(?:#[0-9a-f]{3,8}|(?:rgb|hsl|oklch)a?\()/i.test(leaf.value),
                );

                if (colors.length < 4 || (mode === undefined && ++defaults > 1)) {
                    continue;
                }

                for (const leaf of colors) {
                    addVar(facts, {
                        name: leaf.path.join("-"),
                        value: leaf.value.slice(0, 400),
                        scope: mode ?? "default",
                        kind: "js",
                        file,
                        hint: "color",
                    });
                }
            }
        }
    }
}

/**
 * A block named for a mode whose keys are colors (`dark: { canvas: "#101114", ink: "#f2f3f5" }`), where the theme has no
 * `colors` key around them: the project's variables for that mode.
 */
function modeBlocks(
    facts: Facts,
    file: string,
    text: string,
    env: ReadonlyMap<string, Literal>,
    scopeAt: (index: number) => Scope,
): void {
    const keys = new Set(Object.keys(THEME_KEYS));
    let count = 0;

    for (const match of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*:\s*(?=\{)/g)) {
        const mode = modeOf(match[1]!);

        if (mode === undefined || ++count > 12) {
            continue;
        }

        const literal = readLiteral(text, match.index + match[0].length, env);

        if (
            typeof literal !== "object" ||
            literal === null ||
            Array.isArray(literal) ||
            Object.keys(literal).some((key) => keys.has(key))
        ) {
            continue;
        }

        // The block's own mode, unless it sits in another mode's object.
        const scope =
            scopeAt(match.index + match[0].length) !== "default"
                ? scopeAt(match.index + match[0].length)
                : mode;
        const found: { path: string[]; value: string }[] = [];

        leaves(literal, [], found, "color");

        const colors = found.filter(
            (leaf) =>
                leaf.path.length > 0 &&
                colorsIn(leaf.value, false).length === 1 &&
                /^\s*(?:#|rgb|hsl|oklch)/i.test(leaf.value),
        );

        if (colors.length < 3) {
            continue;
        }

        for (const leaf of colors) {
            addVar(facts, {
                name: leaf.path.join("-"),
                value: leaf.value.slice(0, 400),
                scope,
                kind: "js",
                file,
                hint: "color",
            });
        }
    }
}

/** A color that a semantic token names: the color itself, or a path into the palette (`gray.50`, `colors.brand.500`). */
function paletteColor(
    ref: string,
    tree: Record<string, Literal>,
    env: ReadonlyMap<string, Literal>,
): string | undefined {
    const text = ref.trim().replace(/^\{|\}$/g, "");

    if (/^#[0-9a-f]{3,8}$|^(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch)\(/i.test(text)) {
        return text;
    }

    const path = text.split(".").filter((part) => part !== "");

    if (path[0] === "colors") {
        path.shift();
    }

    let node: Literal | undefined = tree;

    // A name the palette does not have may be an object the file declares (`const gray = { … }`).
    if (path[0] !== undefined && tree[path[0]] === undefined && env.has(path[0])) {
        node = env.get(path.shift()!);
    }

    for (const part of path) {
        node =
            typeof node === "object" && node !== null && !Array.isArray(node)
                ? node[part]
                : undefined;
    }

    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
        node = node.DEFAULT ?? node.default;
    }

    return typeof node === "string" ? node : undefined;
}

/**
 * Chakra's `semanticTokens.colors`: a name with a value for each mode (`{ default: "gray.50", _dark: "gray.900" }`),
 * written as a color or as a path into the palette. Each is a variable with two values.
 */
function semanticTokens(
    facts: Facts,
    file: string,
    text: string,
    env: ReadonlyMap<string, Literal>,
    tree: Record<string, Literal>,
    scopeAt: (index: number) => Scope,
): void {
    for (const match of [...text.matchAll(/(?<![\w$.])semanticTokens\s*:\s*(?=\{)/g)].slice(0, 4)) {
        const literal = readLiteral(text, match.index + match[0].length, env);
        const colors =
            typeof literal === "object" && literal !== null && !Array.isArray(literal)
                ? literal.colors
                : undefined;

        if (typeof colors !== "object" || colors === null || Array.isArray(colors)) {
            continue;
        }

        const base = scopeAt(match.index);
        let count = 0;

        const walk = (node: Literal, path: string[]): void => {
            if (++count > 200 || path.length > 4) {
                return;
            }

            if (typeof node === "string") {
                const value = paletteColor(node, tree, env);

                if (value !== undefined && path.length > 0) {
                    addVar(facts, {
                        name: path.join("-"),
                        value,
                        scope: base,
                        kind: "js",
                        file,
                        hint: "color",
                    });
                }

                return;
            }

            if (typeof node !== "object" || node === null || Array.isArray(node)) {
                return;
            }

            const modes = Object.keys(node).filter((key) =>
                /^(?:default|_light|_dark|_?light|_?dark)$/.test(key),
            );

            if (modes.length > 0 && path.length > 0) {
                for (const key of modes) {
                    const value =
                        typeof node[key] === "string"
                            ? paletteColor(node[key], tree, env)
                            : undefined;

                    if (value !== undefined) {
                        const scope: Scope = /dark/.test(key)
                            ? "dark"
                            : /light/.test(key)
                              ? "light"
                              : base;

                        addVar(facts, {
                            name: path.join("-"),
                            value,
                            scope,
                            kind: "js",
                            file,
                            hint: "color",
                        });
                    }
                }

                return;
            }

            for (const [key, child] of Object.entries(node)) {
                walk(child, [...path, ...key.split(".")]);
            }
        };

        walk(colors as Literal, []);
    }
}

// --- Whole files ---------------------------------------------------------------------------------------------------

const CLASS_USE =
    /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|from|to|via|divide|decoration|accent|caret|placeholder|shadow)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g;
const DEFAULT_COLOR_CLASS =
    /(?<![\w-])(bg|text|border|ring|outline|fill|stroke|divide|from|to|via|decoration|accent|caret|placeholder)-((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d+)?(?![\w-])/g;
const CLASS_KIND: Record<string, "bg" | "text" | "border" | "fill"> = {
    bg: "bg",
    from: "bg",
    to: "bg",
    via: "bg",
    text: "text",
    placeholder: "text",
    decoration: "text",
    caret: "text",
    accent: "text",
    border: "border",
    ring: "border",
    outline: "border",
    divide: "border",
    fill: "fill",
    stroke: "fill",
};
const TEXT_CLASS = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;
const ROUNDED_CLASS = /(?<![\w-])rounded(?:-(none|xs|sm|md|lg|xl|2xl|3xl|full))?(?![\w-])/g;
const WEIGHT_CLASS =
    /(?<![\w-])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])/g;
const SPACING_CLASS =
    /(?<![\w-])(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w-])/g;

/** The theme-like file names: a JavaScript file with these may hold a design theme. */
// A script that writes styles: styled-components, Emotion, Stitches, makeStyles, a style prop or an `sx` prop.
const STYLED =
    /\bstyled\s*[.(]|\bcss\s*`|createGlobalStyle|keyframes\s*`|makeStyles|createUseStyles|\bsx\s*=|style\s*=\s*\{|\bcva\s*\(|\bglobalStyle\b|StyleSheet\.create|\bstyle\s*:\s*\{|\bstyles\s*:\s*\[?\s*`/;

// A script that holds a theme whatever its name: `colors: {` / `palette: {` / `themes: {` with a few color values.
const THEME_CONTENT =
    /\b(?:colors|colours|palette|themes?)\s*:\s*\{[^]{0,2500}?#[0-9a-fA-F]{3,8}\b[^]{0,1500}?#[0-9a-fA-F]{3,8}\b/;

const THEMEISH =
    /(?:^|\/)(?:tailwind\.config|[^/]*(?:theme|tokens?|colors?|palette|design|variables|styles?|constants?|config)[^/]*)\.(?:[cm]?[jt]s|tsx?)$|\/(?:theme|themes|tokens|styles|design|constants)\/[^/]+\.[cm]?[jt]sx?$/i;

/** `--wp--preset--color--primary` is `--color-primary`; `--wp--custom--radius--pill` is `--custom-radius-pill`; `var:preset|color|primary` too. */
function wordpressNames(text: string): string {
    return text
        .replace(/--wp--preset--([\w-]+?)--([\w-]+)/g, "--$1-$2")
        .replace(
            /--wp--custom--([\w-]+)/g,
            (_, rest: string) => `--custom-${rest.replace(/--/g, "-")}`,
        )
        .replace(/var:preset\|([\w-]+)\|([\w-]+)/g, "var(--$1-$2)")
        .replace(
            /var:custom\|([\w|-]+)/g,
            (_, rest: string) => `var(--custom-${rest.replace(/\|/g, "-")})`,
        );
}

const WP_CSS: Record<string, string> = {
    background: "background-color",
    text: "color",
};

/** A WordPress `styles` object as CSS rules, so that the scan reads how the theme uses its presets. */
function wordpressCss(styles: unknown): string {
    const isObj = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
    const text = (value: unknown) =>
        typeof value === "string" || typeof value === "number"
            ? wordpressNames(String(value))
            : undefined;
    let rules = 0;

    const declarations = (node: Record<string, unknown>): string => {
        const out: string[] = [];

        const put = (property: string, value: unknown) => {
            const found = text(value);

            if (found !== undefined && found !== "") {
                out.push(`${property}: ${found};`);
            }
        };

        if (isObj(node.color)) {
            for (const [key, property] of Object.entries(WP_CSS)) {
                put(property, node.color[key]);
            }
        }

        if (isObj(node.typography)) {
            put("font-family", node.typography.fontFamily);
            put("font-size", node.typography.fontSize);
            put("line-height", node.typography.lineHeight);
            put("font-weight", node.typography.fontWeight);
        }

        if (isObj(node.border)) {
            put("border-color", node.border.color);
            put("border-radius", node.border.radius);
            put("border-width", node.border.width);
        }

        if (isObj(node.spacing)) {
            for (const key of ["padding", "margin"]) {
                const value = node.spacing[key];

                if (isObj(value)) {
                    for (const side of ["top", "right", "bottom", "left"]) {
                        put(`${key}-${side}`, value[side]);
                    }
                } else {
                    put(key, value);
                }
            }

            put("gap", node.spacing.blockGap);
        }

        put("box-shadow", node.shadow);

        return out.join(" ");
    };

    const rule = (selector: string, node: unknown): string => {
        if (!isObj(node) || ++rules > 120) {
            return "";
        }

        const own = declarations(node);
        const nested: string[] = [];

        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith(":")) {
                nested.push(rule(`${selector}${key}`, child));
            }
        }

        return `${own === "" ? "" : `${selector} { ${own} }`} ${nested.join(" ")}`;
    };

    if (!isObj(styles)) {
        return "";
    }

    const out = [rule("body", styles)];
    const elements: Record<string, string> = {
        link: "a",
        button: ".wp-element-button, .wp-block-button__link",
        heading: "h1, h2, h3, h4, h5, h6",
        caption: "figcaption",
        cite: "cite",
    };

    if (isObj(styles.elements)) {
        for (const [key, node] of Object.entries(styles.elements)) {
            out.push(
                rule(
                    elements[key] ??
                        (/^h[1-6]$/.test(key) ? key : `.wp-element-${key.replace(/[^\w-]/g, "")}`),
                    node,
                ),
            );
        }
    }

    if (isObj(styles.blocks)) {
        for (const [key, node] of Object.entries(styles.blocks)) {
            out.push(rule(`.wp-block-${key.replace(/^core\//, "").replace(/[^\w-]/g, "-")}`, node));
        }
    }

    return out.join("\n");
}

/**
 * A WordPress block theme's `theme.json` (and its style variations in `styles/`): the palette, font sizes, font
 * families, spacing sizes, shadows, and `settings.custom` become variables; `styles` becomes the rules that use them.
 * A variation named for dark (`styles/dark.json`) holds the dark values. Returns whether the file was one.
 */
function wordpressTheme(facts: Facts, file: string, source: string): boolean {
    if (
        !/\bsettings\b/.test(source) ||
        !/\b(?:palette|fontSizes|spacingSizes|presets|fontFamilies|custom)\b/.test(source)
    ) {
        return false;
    }

    let root: unknown;

    try {
        root = JSON.parse(source);
    } catch {
        return false;
    }

    const isObj = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
    const settings = isObj(root) ? root.settings : undefined;

    if (
        !isObj(root) ||
        !isObj(settings) ||
        (!/wp\.org|theme\.json/i.test(`${root.$schema ?? ""} ${file}`) && !isObj(settings.color))
    ) {
        return false;
    }

    facts.wordpress = true;

    const title = typeof root.title === "string" ? modeOf(root.title) : undefined;
    const scope: Scope =
        facts.fileMode ?? (title === "dark" || title === "light" ? title : "default");

    const add = (name: string, value: unknown, hint: Category) => {
        if (typeof value === "string" || typeof value === "number") {
            addVar(facts, {
                name,
                value: String(value).slice(0, 400),
                scope,
                kind: "css",
                file,
                hint,
            });
        }
    };

    const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? value.filter(isObj).slice(0, 80) : [];
    const key = (value: unknown) => String(value ?? "").replace(/[^\w-]/g, "-");

    if (isObj(settings.color)) {
        for (const item of list(settings.color.palette)) {
            add(`color-${key(item.slug)}`, item.color, "color");
        }
    }

    if (isObj(settings.typography)) {
        for (const item of list(settings.typography.fontSizes)) {
            add(`font-size-${key(item.slug)}`, item.size, "text");
        }

        for (const item of list(settings.typography.fontFamilies)) {
            add(`font-family-${key(item.slug)}`, item.fontFamily, "font");
        }
    }

    if (isObj(settings.spacing)) {
        for (const item of list(settings.spacing.spacingSizes)) {
            add(`spacing-${key(item.slug)}`, item.size, "space");
        }
    }

    if (isObj(settings.shadow)) {
        for (const item of list(settings.shadow.presets)) {
            add(`shadow-${key(item.slug)}`, item.shadow, "shadow");
        }
    }

    // `settings.custom`: nested groups, named by their path (`--custom-radius-pill`).
    const custom = (node: unknown, path: string[]) => {
        if (path.length > 4) {
            return;
        }

        if (isObj(node)) {
            for (const [name, child] of Object.entries(node).slice(0, 60)) {
                custom(child, [...path, name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()]);
            }
        } else if (typeof node === "string" || typeof node === "number") {
            const name = path.join("-");
            const hint: Category | undefined =
                path[0] === "color"
                    ? "color"
                    : path[0] === "radius"
                      ? "radius"
                      : path[0] === "spacing"
                        ? "space"
                        : path[0] === "shadow"
                          ? "shadow"
                          : undefined;

            if (hint !== undefined) {
                add(`custom-${name}`, node, hint);
            }
        }
    };

    custom(settings.custom, []);

    const css = wordpressCss(root.styles);

    if (css !== "") {
        ingestStyles(facts, file, parseStyles(css));
    }

    return true;
}

/** One entry of a Sass map: its key, and its value as text, or as entries when the value is a map. */
interface MapEntry {
    key: string;
    value: string;
    map?: MapEntry[];
}

/** Reads a Sass map `(a: 1, b: (c: 2))`; undefined when the text is not one. */
function sassMap(text: string, depth = 0): MapEntry[] | undefined {
    const inner = text.trim();

    if (depth > 3 || !inner.startsWith("(") || !inner.endsWith(")")) {
        return undefined;
    }

    const entries: MapEntry[] = [];

    // A value with commas of its own (a shadow with two layers) continues the entry before it.
    const parts: string[] = [];

    for (const part of commaParts(inner.slice(1, -1))) {
        if (parts.length > 0 && !/^["']?[\w-]{1,40}["']?\s*:/.test(part)) {
            parts[parts.length - 1] += `, ${part}`;
        } else {
            parts.push(part);
        }
    }

    for (const part of parts.slice(0, 120)) {
        const colon = part.indexOf(":");
        const key = part
            .slice(0, colon)
            .trim()
            .replace(/^["']|["']$/g, "");
        const value = part.slice(colon + 1).trim();

        if (colon <= 0 || !/^[\w-]{1,40}$/.test(key) || value === "") {
            continue;
        }

        const map = sassMap(value, depth + 1);

        entries.push(map === undefined ? { key, value } : { key, value, map });
    }

    return entries;
}

/**
 * A Sass map is one variable for each entry: `$spacers: (1: 0.25rem, 2: 0.5rem)` is `spacers-1` and `spacers-2`. A map
 * of modes (`$themes: (light: (bg: #fff), dark: (bg: #000))`) holds the variables of each mode; a map of names that
 * each hold modes (`primary: (light: #fff, dark: #000)`) holds one variable with two values.
 */
function sassMapVars(
    facts: Facts,
    file: string,
    name: string,
    text: string,
    scope: Scope,
    line?: number,
): void {
    const entries = sassMap(text);

    if (entries === undefined) {
        return;
    }

    const modeKey = (key: string): Scope | undefined =>
        /^(?:default|base|root|standard)$/i.test(key) ? "default" : modeOf(key);
    const add = (variable: string, value: string, at: Scope) =>
        addVar(facts, {
            name: variable,
            value: value.slice(0, 400),
            scope: at,
            kind: "scss",
            file,
            ...(line === undefined ? {} : { line }),
        });
    const modes = entries.filter(
        (entry) => entry.map !== undefined && modeKey(entry.key) !== undefined,
    );

    if (modes.length > 0 && modes.length * 2 >= entries.length) {
        for (const entry of modes) {
            for (const inner of entry.map!) {
                if (inner.map === undefined) {
                    add(inner.key, inner.value, modeKey(entry.key)!);
                }
            }
        }

        return;
    }

    for (const entry of entries) {
        if (entry.map === undefined) {
            add(`${name}-${entry.key}`, entry.value, scope);
        } else if (entry.map.some((inner) => modeKey(inner.key) !== undefined)) {
            for (const inner of entry.map) {
                const at = modeKey(inner.key);

                if (at !== undefined && inner.map === undefined) {
                    add(`${name}-${entry.key}`, inner.value, at);
                }
            }
        }
    }
}

function ingestStyles(facts: Facts, file: string, all: Decl[]): void {
    const mode = facts.fileMode;
    const decls =
        mode === undefined
            ? all
            : all.map((decl) =>
                  decl.scope === "default" && !decl.inline ? { ...decl, scope: mode } : decl,
              );

    for (const decl of decls) {
        if (decl.prop.startsWith("--")) {
            const name = decl.prop.slice(2);

            if (decl.scope === "other") {
                bump(facts.scoped, decl.selector.slice(0, 80));

                // The surface is often set on the card itself (`.card { --bs-card-bg: #fff }`): a component variable that
                // is named for a card or a panel is the surface, in the mode its selector names.
                if (
                    nameScore("surface", words(name)) >= 60 &&
                    colorsIn(decl.value).length === 1 &&
                    /^\s*(?:#|rgb|hsl|oklch)/i.test(decl.value)
                ) {
                    addVar(facts, {
                        name,
                        value: decl.value,
                        scope: isDarkSelector(decl.selector) ? "dark" : "default",
                        kind: "css",
                        file,
                    });
                }

                continue;
            }

            addVar(facts, {
                name,
                value: decl.value,
                scope: decl.scope,
                kind: decl.theme ? "theme" : "css",
                file,
                ...(decl.line === undefined ? {} : { line: decl.line }),
            });

            continue;
        }

        // `map-merge($theme-colors, ("brand": #6f42c1))` adds the entries of its last map.
        const merged = /^map-merge\(\s*[$\w.-]+\s*,\s*(\(.*\))\s*\)$/s.exec(decl.value);
        const mapText = merged === null ? decl.value : merged[1]!;

        if (decl.prop.startsWith("$") && /^\(.*\)$/s.test(mapText)) {
            sassMapVars(facts, file, decl.prop.slice(1), mapText, decl.scope, decl.line);

            continue;
        }

        // `$surface: if($theme == dark, #1a1c21, #ffffff)`: a value for each mode.
        const choice =
            /^if\(\s*\$[\w-]+\s*==\s*['"]?(dark|night|light|day)['"]?\s*,([\s\S]*)\)$/i.exec(
                decl.value,
            );
        const branches = choice === null ? [] : commaParts(choice[2]!);

        if (decl.prop.startsWith("$") && choice !== null && branches.length === 2) {
            const dark = /^(?:dark|night)$/i.test(choice[1]!);

            for (const [value, scope] of [
                [branches[0]!, dark ? "dark" : "light"],
                [branches[1]!, dark ? "light" : "dark"],
            ] as const) {
                addVar(facts, {
                    name: decl.prop.slice(1),
                    value: value.trim(),
                    scope,
                    kind: "scss",
                    file,
                    ...(decl.line === undefined ? {} : { line: decl.line }),
                });
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
                ...(decl.line === undefined ? {} : { line: decl.line }),
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

/** The line of the file where a block of it starts, or undefined when the block is not a part of the file as it is. */
function lineOfBlock(raw: string, block: string): number | undefined {
    const at = raw.indexOf(block);

    return at === -1 ? undefined : 1 + (raw.slice(0, at).match(/\n/g)?.length ?? 0);
}

/** Reads one file's text into the facts. `extension` is the lower-case ending with its dot. */
export function ingestFile(facts: Facts, rel: string, extension: string, raw: string): void {
    const text = stripComments(raw);
    const parts = rel.split("/");
    // `dark.less`, `theme.dark.css`, `variables-night.scss`, `themes/dark/colors.css`.
    const named = modeOf(parts.at(-1)!.replace(/\.[^.]+$/, ""));
    const mode = named ?? (parts.length > 1 ? modeOf(parts.at(-2)!) : undefined);

    facts.fileMode = mode === "dark" || mode === "light" ? mode : undefined;
    facts.file = rel;

    // WordPress names its variables `--wp--preset--color--primary`; the scan reads them as `--color-primary`.
    if (facts.wordpress) {
        raw = wordpressNames(raw);
    }

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

    if (/@import\s+["']tailwindcss|@theme\b/.test(text)) {
        facts.tailwindVersion = 4;
    }

    if (extension === ".json") {
        if (!wordpressTheme(facts, rel, raw)) {
            importTokens(facts.imported, rel, raw);
        }

        return;
    }

    const isStyle = /^\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(extension);
    const isPage = /^\.(?:html|htm|vue|svelte|astro|mdx|php|erb|hbs|njk)$/.test(extension);
    const isScript = /^\.(?:[cm]?[jt]s|[jt]sx)$/.test(extension);

    if (isStyle) {
        // Indented Sass and Stylus have no braces: they are turned into some first.
        const source = /^\.(?:sass|styl|stylus)$/.test(extension) ? indentedToBraces(raw) : raw;

        ingestStyles(facts, rel, parseStyles(source, 1, facts.darkMixins));
    } else if (isPage) {
        const { blocks, inline } = pageStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block, lineOfBlock(raw, block), facts.darkMixins));
        }

        ingestStyles(facts, rel, inline);
    } else if (
        isScript &&
        (THEMEISH.test(rel) ||
            THEME_CONTENT.test(raw) ||
            !/^\.(?:[cm]?[jt]s)$/.test(extension) ||
            STYLED.test(raw))
    ) {
        const blocks = templateStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block, lineOfBlock(raw, block), facts.darkMixins));
        }

        if (THEMEISH.test(rel) || THEME_CONTENT.test(raw)) {
            // A theme object holds values, not styles in use: `border: "#2d3640"` there is a token, not a border.
            themeVars(facts, rel, raw);
        } else {
            ingestStyles(facts, rel, objectStyles(raw));
        }
    }

    if (isPage || isScript) {
        let seen = 0;

        // Tailwind's default colors by class: `bg-slate-200`, `text-white`, `border-red-500/50`.
        for (const match of text.matchAll(DEFAULT_COLOR_CLASS)) {
            if (++seen > 8000) {
                break;
            }

            const kinds = facts.classColors.get(match[2]!) ?? emptyKinds();
            const kind = CLASS_KIND[match[1]!] ?? "other";

            kinds[kind] += 1;
            facts.classColors.set(match[2]!, kinds);
        }

        seen = 0;

        // Tailwind's arbitrary values: `bg-[#fff4d6]`, `text-[rgb(0,0,0)]`.
        for (const match of text.matchAll(
            /(?<![\w-])(bg|text|border|fill|stroke|ring|outline|from|to|via)-\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([^\])]*\))\]/g,
        )) {
            if (++seen > 2000) {
                break;
            }

            const kind =
                (
                    {
                        bg: "bg",
                        text: "text",
                        fill: "fill",
                        stroke: "fill",
                        from: "bg",
                        to: "bg",
                        via: "bg",
                    } as Record<string, "bg" | "text" | "fill" | "border">
                )[match[1]!] ?? "border";

            for (const color of colorsIn(match[2]!.replace(/_/g, " "))) {
                colorFact(facts.colors, color.hex, color.text)[kind] += 1;
            }
        }

        seen = 0;

        for (const match of text.matchAll(
            /<(?:body|html)\b[^>]*?\bclass(?:Name)?\s*=\s*["'`{]+([^"'`}]*)/gi,
        )) {
            for (const name of match[1]!.split(/\s+/).slice(0, 20)) {
                if (/^[\w-]{1,40}$/.test(name)) {
                    facts.rootClasses.add(name);
                }
            }
        }

        seen = 0;

        // Every class name used in markup, to weigh the rules that set a color by how often their class is used.
        for (const match of text.matchAll(
            /\bclass(?:Name)?\s*=\s*(?:["'`]|\{\s*["'`])([^"'`}]*)/g,
        )) {
            if (++seen > 4000) {
                break;
            }

            for (const name of match[1]!.split(/\s+/).slice(0, 40)) {
                if (/^[\w-]{1,40}$/.test(name)) {
                    bump(facts.classCount, name);
                }
            }
        }

        seen = 0;

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
