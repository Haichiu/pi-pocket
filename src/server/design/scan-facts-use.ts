import { colorsIn, commaParts, type Decl, isDarkSelector, parts, px } from "./scan-parse.ts";
import { nameScore, words } from "./scan-colors.ts";
import { addVar, bump, type ColorFact, emptyKinds, type Facts, type Kinds } from "./scan-facts.ts";
import { sassMapVars } from "./scan-facts-sass.ts";
import { noteChannels } from "./scan-channels.ts";

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

export function ingest(facts: Facts, decl: Decl): void {
    noteChannels(facts, decl.value);

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
                    ) ||
                    /(?<![\w.-])(?:map[.-]get|(?!(?:calc|var|rgba?|hsla?|oklch|oklab|lab|lch|hwb|color|color-mix|clamp|min|max|minmax|repeat|url|attr|env|translate\w*|rotate\w*|scale\w*|linear-gradient|radial-gradient|conic-gradient|cubic-bezier|steps|counter|format|local|image-set|fit-content|blur|drop-shadow|brightness|contrast|saturate|sepia|invert|grayscale|opacity|hue-rotate)\()[a-z][\w-]*\(\s*-?[\d.$'"])/i.test(
                        decl.value,
                    )) &&
                !/\$\{/.test(decl.value))) &&
        facts.deferred.length < 1500
    ) {
        facts.deferred.push({
            prop: decl.prop,
            value: decl.value,
            selector: decl.selector,
            scope: decl.scope,
            ...(facts.file === undefined ? {} : { file: facts.file }),
            ...(decl.line === undefined ? {} : { line: decl.line }),
        });

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

export function lightDark(value: string): [string, string] | undefined {
    let light = "";
    let dark = "";
    let at = 0;
    let found = false;

    while (at < value.length) {
        const open = value.indexOf("light-dark(", at);

        if (open === -1 || (open > 0 && /[\w-]/.test(value[open - 1]!))) {
            const rest = open === -1 ? value.slice(at) : value.slice(at, open + 11);

            light += rest;
            dark += rest;
            at = open === -1 ? value.length : open + 11;

            continue;
        }

        light += value.slice(at, open);
        dark += value.slice(at, open);

        const parts = [];
        let depth = 0;
        let start = open + 11;
        let end = -1;

        for (let index = start; index < value.length; index++) {
            const char = value[index]!;

            if (char === "(") {
                depth += 1;
            } else if (char === ")") {
                if (depth === 0) {
                    end = index;

                    break;
                }

                depth -= 1;
            } else if (char === "," && depth === 0) {
                parts.push(value.slice(start, index));
                start = index + 1;
            }
        }

        if (end === -1) {
            return undefined;
        }

        parts.push(value.slice(start, end));

        if (parts.length !== 2) {
            return undefined;
        }

        light += parts[0]!.trim();
        dark += parts[1]!.trim();
        at = end + 1;
        found = true;
    }

    return found ? [light, dark] : undefined;
}

export function ingestStyles(facts: Facts, file: string, all: Decl[]): void {
    const mode = facts.fileMode;
    const decls =
        mode === undefined
            ? all
            : all.map((decl) =>
                  decl.scope === "default" && !decl.inline ? { ...decl, scope: mode } : decl,
              );

    const expanded = decls.flatMap((decl): Decl[] => {
        const pair = decl.value.includes("light-dark(") ? lightDark(decl.value) : undefined;

        if (pair === undefined || decl.scope === "other") {
            return [decl];
        }

        return decl.scope === "dark"
            ? [{ ...decl, value: pair[1] }]
            : [
                  { ...decl, value: pair[0] },
                  { ...decl, value: pair[1], scope: "dark" },
              ];
    });

    for (const decl of expanded) {
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

        const merged = /^map-merge\(\s*[$\w.-]+\s*,\s*(\(.*\))\s*\)$/s.exec(decl.value);
        const mapText = merged === null ? decl.value : merged[1]!;

        if (decl.prop.startsWith("$") && /^\(.*\)$/s.test(mapText)) {
            sassMapVars(facts, file, decl.prop.slice(1), mapText, decl.scope, decl.line);

            continue;
        }

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
