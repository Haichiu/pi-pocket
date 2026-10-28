/**
 * Compiles a design system into the files of `.pi/design/dist/` (stream T): `tokens.css`, a Tailwind v4 `tailwind.css`,
 * `tokens.resolved.json`, and `components.css`. A pure function of the resolved tokens, so the same system always
 * gives the same bytes.
 *
 * `tokens.css` has the default mode on `:root`, each other mode in `[data-theme="<mode>"]`, and a media query for the
 * operating system's light or dark preference. A mode block repeats every token whose value differs from the default,
 * the tokens that only refer to a changed one included: a custom property that holds `var(--x)` is computed where it
 * is declared, so a nested `[data-theme]` scope must declare it again to see the new `--x`.
 */
import type { CompiledFiles, DesignSystem, ResolvedToken, TokenTier } from "./system-types.ts";
import { compactJson, dtcgJson, studioJson } from "./tokens-dtcg.ts";

export type CompileInput = Pick<
    DesignSystem,
    | "name"
    | "description"
    | "modes"
    | "schemes"
    | "tokens"
    | "components"
    | "tailwindReset"
    | "dtcgFormat"
>;

type Decl = [property: string, value: string];

const comment = (text: string, max = 90) => {
    const line = text.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const TIERS: { tier: TokenTier; title: string }[] = [
    { tier: "primitive", title: "Primitives" },
    { tier: "semantic", title: "Semantic roles" },
    { tier: "component", title: "Component tokens" },
];

/**
 * A primitive (or a step of a scale, `space.4`) is a raw value, so the stylesheet holds the value (`--space-4: 16px`),
 * also when a person wrote it as a reference to another primitive (`{dim.16}`): DevTools then shows `16px`, not
 * `var(--dim-16)`. A role or a component token that refers to a token keeps its `var()`: the reference is what a
 * person wrote, and what a mode changes.
 */
function literalPrimitives(system: CompileInput): CompileInput {
    const byName = new Map(system.tokens.map((token) => [token.name, token]));
    const composite = new Set(["typography", "shadow", "border", "transition", "gradient"]);
    const tokens = system.tokens.map((token) => {
        // A primitive, or a step of a scale (`space.4`, `neutral.500`): both are raw values, whatever the file calls them.
        const raw =
            token.tier === "primitive" ||
            (token.tier !== "component" && /^\d/.test(token.path.at(-1)!));

        if (!raw || composite.has(token.type)) {
            return token;
        }

        let changed = false;
        const modes: ResolvedToken["modes"] = {};

        for (const [mode, value] of Object.entries(token.modes)) {
            const target = value.alias === undefined ? undefined : byName.get(value.alias);

            if (
                target?.tier === "primitive" &&
                value.literal !== undefined &&
                value.literal !== value.css
            ) {
                modes[mode] = { ...value, css: value.literal };
                changed = true;
            } else {
                modes[mode] = value;
            }
        }

        return changed ? { ...token, modes } : token;
    });

    return { ...system, tokens };
}

/** The declarations of a token in a mode: its variable, and the variables of a typography token's members. */
function declarations(token: ResolvedToken, mode: string): Decl[] {
    const value = token.modes[mode]!;
    const decls: Decl[] = [[token.cssVar, value.css]];

    // Only a type style is used by its members (`font-size: var(--type-body-font-size)`); a shadow's are for editors.
    if (token.type === "typography") {
        for (const [property, css] of Object.entries(value.parts ?? {})) {
            decls.push([`${token.cssVar}-${property}`, css]);
        }
    }

    return decls;
}

/** Whether a token's value in `mode` differs from the default's, or its CSS does. */
function differs(token: ResolvedToken, mode: string, base: string): boolean {
    const a = token.modes[mode]!;
    const b = token.modes[base]!;

    return (
        a.css !== b.css ||
        JSON.stringify(a.value) !== JSON.stringify(b.value) ||
        JSON.stringify(a.parts) !== JSON.stringify(b.parts)
    );
}

/** The tokens in tier order (primitives, semantic roles, components), each tier in file order. */
function inTiers(tokens: readonly ResolvedToken[]): { title: string; tokens: ResolvedToken[] }[] {
    return TIERS.map(({ tier, title }) => ({
        title,
        tokens: tokens.filter((token) => token.tier === tier),
    })).filter((section) => section.tokens.length > 0);
}

/** Writes declarations with a comment where the group changes, and a token's description after it. */
function body(
    sections: { title: string; tokens: ResolvedToken[] }[],
    decl: (token: ResolvedToken) => Decl[],
    notes: boolean,
): string[] {
    const lines: string[] = [];

    for (const section of sections) {
        if (lines.length > 0) {
            lines.push("");
        }

        lines.push(`    /* === ${section.title} === */`);

        let group: string | undefined;

        for (const token of section.tokens) {
            const label = token.path.slice(0, -1).join(".") || token.path[0]!;

            if (label !== group) {
                group = label;
                lines.push("", `    /* ${comment(label, 60)} */`);
            }

            const decls = decl(token);

            decls.forEach(([property, value], at) => {
                let note = "";

                if (notes && at === 0) {
                    if (token.deprecated !== undefined) {
                        note = ` /* deprecated${typeof token.deprecated === "string" ? `: ${comment(token.deprecated, 60)}` : ""} */`;
                    } else if (token.description !== undefined) {
                        note = ` /* ${comment(token.description, 70)} */`;
                    }
                }

                lines.push(`    ${property}: ${value};${note}`);
            });
        }
    }

    return lines;
}

/** The `color-scheme` value of a mode. */
const schemeOf = (system: CompileInput, mode: string) => system.schemes[mode] ?? "light";

/** The mode that the operating system's other preference selects, and the preference's name. */
function preferred(system: CompileInput): { mode: string; scheme: "light" | "dark" } | undefined {
    const base = system.modes[0]!;
    const other = schemeOf(system, base) === "dark" ? "light" : "dark";
    const mode =
        system.modes.find((each) => each !== base && each === other) ??
        system.modes.find((each) => each !== base && schemeOf(system, each) === other);

    return mode === undefined ? undefined : { mode, scheme: other };
}

/** The declaration lines of each block of a stylesheet: the default mode, the other modes, and the media query. */
interface Blocks {
    base: string[];
    others: { mode: string; lines: string[] }[];
    media?: { scheme: "light" | "dark"; lines: string[] };
}

function blocks(
    system: CompileInput,
    decl: (token: ResolvedToken, mode: string) => Decl[],
    notes: boolean,
): Blocks {
    const base = system.modes[0]!;
    // The tokens of a mode that differ from the default, in tiers.
    const changed = (mode: string) =>
        inTiers(system.tokens.filter((token) => differs(token, mode, base)));
    const alternate = preferred(system);

    return {
        base: body(inTiers(system.tokens), (token) => decl(token, base), notes),
        others: system.modes.slice(1).map((mode) => ({
            mode,
            lines: body(changed(mode), (token) => decl(token, mode), false),
        })),
        ...(alternate === undefined
            ? {}
            : {
                  media: {
                      scheme: alternate.scheme,
                      lines: body(
                          changed(alternate.mode),
                          (token) => decl(token, alternate.mode),
                          false,
                      ),
                  },
              }),
    };
}

function header(system: CompileInput, file: string, lines: string[]): string {
    return [
        "/*",
        ` * ${comment(system.name, 60)}: ${file} (generated)`,
        " * Generated by Pi Pocket from .pi/design/. Do not edit by hand: change the tokens, then compile again.",
        ...lines.map((line) => ` * ${line}`),
        " */",
    ].join("\n");
}

function tokensCss(system: CompileInput): string {
    const base = system.modes[0]!;
    const modes = system.modes
        .map((mode, at) => (at === 0 ? `${mode} (default)` : mode))
        .join(", ");
    const parts = blocks(system, (token, mode) => declarations(token, mode), true);
    const out = [
        header(system, "tokens.css", [
            `Modes: ${comment(modes)}.`,
            'Use it:  <link rel="stylesheet" href="ds/tokens.css">  then  color: var(--color-text-primary);',
            system.modes.length > 1
                ? `Switch a mode with <html data-theme="${system.modes[1]}">.${parts.media === undefined ? "" : ` Without data-theme, the system's ${parts.media.scheme} setting applies.`}`
                : "One mode only: add tokens.<mode>.json for a dark or brand mode.",
        ]),
        "",
        `:root,\n[data-theme="${base}"] {`,
        `    color-scheme: ${schemeOf(system, base)};`,
        "",
        ...parts.base,
        "}",
    ];

    for (const { mode, lines } of parts.others) {
        out.push(
            "",
            `/* Mode: ${comment(mode)}. Repeats each token that differs from ${comment(base)}. */`,
            `[data-theme="${mode}"] {`,
            `    color-scheme: ${schemeOf(system, mode)};`,
            "",
            ...lines,
            "}",
        );
    }

    if (parts.media !== undefined) {
        out.push(
            "",
            `/* Follow the operating system's ${parts.media.scheme} setting until a data-theme is set. */`,
            `@media (prefers-color-scheme: ${parts.media.scheme}) {`,
            "    :root:not([data-theme]) {",
            `        color-scheme: ${parts.media.scheme};`,
            "",
            ...parts.media.lines.map((line) => (line === "" ? line : `    ${line}`)),
            "    }",
            "}",
        );
    }

    return `${out.join("\n")}\n`;
}

// --- Tailwind v4 ----------------------------------------------------------------------------------------------------

const norm = (segment: string) => segment.toLowerCase().replace(/[-_]/g, "");

/** `path` without its leading words in `drop` (at least one segment stays). */
function stripLead(path: readonly string[], drop: readonly string[]): string[] {
    let at = 0;

    while (at < path.length - 1 && drop.includes(norm(path[at]!))) {
        at += 1;
    }

    return path.slice(at);
}

/** Words that name the group of a type scale: `font.leading.tight`, `type.size.lg`, `typography.tracking.wide`. */
const TYPE_GROUPS = ["font", "fonts", "type", "typography", "text"];
/** The Tailwind namespace of the second word of such a path. */
const TYPE_SUB: Record<string, string> = {
    leading: "leading",
    lineheight: "leading",
    lineheights: "leading",
    tracking: "tracking",
    letterspacing: "tracking",
    weight: "font-weight",
    weights: "font-weight",
    fontweight: "font-weight",
    size: "text",
    sizes: "text",
    fontsize: "text",
    family: "font",
    families: "font",
    fontfamily: "font",
    typeface: "font",
};
/** The first words of a color path that name the utility, not the role: `bg-surface`, `text-primary`, `border-default`. */
const UTILITY_WORDS = [
    "bg",
    "background",
    "text",
    "fg",
    "foreground",
    "border",
    "outline",
    "ring",
    "fill",
    "stroke",
];

/**
 * The Tailwind v4 variable for a token, if a namespace fits: `--color-*`, `--font-*` (families), `--text-*`,
 * `--font-weight-*`, `--tracking-*`, `--leading-*`, `--breakpoint-*`, `--container-*`, `--spacing-*`, `--radius-*`,
 * `--shadow-*`, `--inset-shadow-*`, `--drop-shadow-*`, `--blur-*`, `--perspective-*`, `--aspect-*`, `--ease-*`. A
 * color role drops the word that the utility repeats (`color.bg.surface` is `--color-surface`, so `bg-surface`), and a
 * trailing `default` (`color.accent.default` is `--color-accent`), unless that leaves nothing.
 */
function tailwindName(token: ResolvedToken): string | undefined {
    if (token.tailwind !== undefined) {
        return token.tailwind;
    }

    const path = token.path;
    const first = norm(path[0]!);
    const sub = TYPE_GROUPS.includes(first) ? TYPE_SUB[norm(path[1] ?? "")] : undefined;
    const join = (prefix: string, rest: readonly string[]) => `--${prefix}-${rest.join("-")}`;
    // The path without the words of the group and its sub-group (`font.leading.tight` is `tight`).
    const tail = (drop: readonly string[]) =>
        stripLead(path, [...TYPE_GROUPS, ...Object.keys(TYPE_SUB), ...drop]);

    switch (token.type) {
        case "color": {
            let rest = stripLead(path, ["color", "colors", "colour", "clr"]);

            if (rest.length > 1 && UTILITY_WORDS.includes(norm(rest[0]!))) {
                rest = rest.slice(1);
            } else if (rest.length > 1 && norm(rest.at(-1)!) === "default") {
                rest = rest.slice(0, -1);
            }

            return join("color", rest);
        }

        case "fontFamily":
            return join("font", tail(["typeface"]));
        case "fontWeight":
            return join("font-weight", tail(["weight", "weights", "fontweight"]));
        case "cubicBezier":
            return join(
                "ease",
                stripLead(path, ["motion", "ease", "easing", "easings", "timing", "transition"]),
            );
        case "shadow":
            if (["inset", "insetshadow"].includes(first)) {
                return join(
                    "inset-shadow",
                    stripLead(path, ["inset", "insetshadow", "shadow", "shadows"]),
                );
            }

            if (["dropshadow", "drop"].includes(first)) {
                return join(
                    "drop-shadow",
                    stripLead(path, ["dropshadow", "drop", "shadow", "shadows"]),
                );
            }

            return join(
                "shadow",
                stripLead(path, ["shadow", "shadows", "elevation", "elevations", "boxshadow"]),
            );
        case "typography":
            return join(
                "text",
                stripLead(path, ["text", "type", "typography", "font", "fonts", "style", "styles"]),
            );
        case "number":
            if (sub === "leading" || ["leading", "lineheight", "lineheights"].includes(first)) {
                return join(
                    "leading",
                    tail(["leading", "lineheight", "lineheights", "line", "height"]),
                );
            }

            return ["aspect", "aspects", "ratio", "ratios"].includes(first)
                ? join("aspect", stripLead(path, ["aspect", "aspects", "ratio", "ratios"]))
                : undefined;
        case "dimension":
            if (sub === "tracking" || ["tracking", "letterspacing"].includes(first)) {
                return join("tracking", tail(["tracking", "letterspacing"]));
            }

            if (sub === "leading") {
                return join("leading", tail(["leading", "lineheight", "lineheights"]));
            }

            if (["space", "spacing", "spaces", "gap", "gutter"].includes(first)) {
                return join(
                    "spacing",
                    stripLead(path, ["space", "spacing", "spaces", "gap", "gutter"]),
                );
            }

            if (
                ["radius", "radii", "rounded", "corner", "corners", "borderradius"].includes(first)
            ) {
                return join(
                    "radius",
                    stripLead(path, [
                        "radius",
                        "radii",
                        "rounded",
                        "corner",
                        "corners",
                        "borderradius",
                    ]),
                );
            }

            if (
                ["text", "fontsize", "fontsizes", "fs", "typesize"].includes(first) ||
                sub === "text"
            ) {
                return join(
                    "text",
                    tail(["size", "sizes", "fontsize", "fontsizes", "fs", "typesize"]),
                );
            }

            if (["breakpoint", "breakpoints", "screen", "screens", "bp"].includes(first)) {
                return join(
                    "breakpoint",
                    stripLead(path, ["breakpoint", "breakpoints", "screen", "screens", "bp"]),
                );
            }

            if (["container", "containers"].includes(first)) {
                return join("container", stripLead(path, ["container", "containers"]));
            }

            if (["perspective", "perspectives"].includes(first)) {
                return join("perspective", stripLead(path, ["perspective", "perspectives"]));
            }

            return first === "blur" ? join("blur", stripLead(path, ["blur"])) : undefined;
        default:
            return undefined;
    }
}

/** The namespaces of Tailwind v4's theme: a variable that starts with one makes utilities, so it must be of that kind. */
const TAILWIND_NAMESPACES = [
    "color",
    "font",
    "text",
    "tracking",
    "leading",
    "breakpoint",
    "container",
    "spacing",
    "radius",
    "shadow",
    "inset-shadow",
    "drop-shadow",
    "blur",
    "perspective",
    "aspect",
    "ease",
    "animate",
];

/** The namespace that Tailwind reads a variable in (the longest that fits: `font-weight` before `font`). */
const namespaceOf = (name: string) =>
    [...TAILWIND_NAMESPACES]
        .sort((a, b) => b.length - a.length)
        .find((namespace) => name.startsWith(`--${namespace}-`));

/** Whether a variable would be read by Tailwind as a member of one of its theme namespaces. */
const inNamespace = (name: string) => namespaceOf(name) !== undefined;

/** The scales that a dimension token can belong to, by the name of its group. */
export type Scale = "text" | "space" | "radius" | "breakpoint" | "container" | "tracking" | "blur";

/**
 * Which scale a dimension token is part of, read from its path: `text.*`, `font.size.*` (font sizes), `space.*`,
 * `spacing.*`, `gap.*` (spacing), `radius.*`, `radii.*`, `rounded.*` (corners), `breakpoint.*`, `screen.*`
 * (breakpoints), `container.*`, `tracking.*`, `blur.*`. Other dimensions (`size.*`, `dim.*`, `border.width.*`) belong to
 * no scale. The Tailwind file and the checks share this one rule.
 */
export function scaleOf(token: ResolvedToken): Scale | undefined {
    if (token.type !== "dimension") {
        return undefined;
    }

    const prefix = /^--(text|spacing|radius|breakpoint|container|tracking|blur)-/.exec(
        tailwindName({ ...token, tailwind: undefined }) ?? "",
    )?.[1];

    return prefix === undefined ? undefined : (({ spacing: "space" }[prefix] ?? prefix) as Scale);
}

/**
 * The one variable each token has in `tailwind.css`: its Tailwind v4 namespace name (`--spacing-4`, `--text-sm`,
 * `--color-bg-surface`) when one fits and no earlier token has it, else its own (`--button-padding-x`).
 */
export function tailwindNames(system: CompileInput): Map<string, string> {
    const names = new Map<string, string>();
    const claimed = new Set<string>();
    const wanted = system.tokens.map((token) => ({ token, name: tailwindName(token) }));

    // A token with no namespace keeps its own name; nobody else may take it. A name that starts with a namespace of
    // Tailwind's (`--font-leading-tight`) would make utilities of the wrong kind (`font-leading-tight`), so it gets
    // `--ds-` in front.
    for (const { token, name } of wanted) {
        if (name === undefined) {
            const own = inNamespace(token.cssVar) ? `--ds-${token.cssVar.slice(2)}` : token.cssVar;

            names.set(token.name, own);
            claimed.add(own);
        }
    }

    // A token whose own variable already is its Tailwind name keeps it.
    for (const { token, name } of wanted) {
        if (name !== undefined && name === token.cssVar && !claimed.has(name)) {
            names.set(token.name, name);
            claimed.add(name);
        }
    }

    // The first token in file order has a namespace name; a later one with the same name keeps its own.
    for (const { token, name } of wanted) {
        if (name === undefined || names.has(token.name)) {
            continue;
        }

        if (!claimed.has(name)) {
            names.set(token.name, name);
            claimed.add(name);
        } else {
            // Its own variable, when that is not in a namespace of another kind (--font-leading-tight for a leading).
            const base =
                !inNamespace(token.cssVar) || namespaceOf(token.cssVar) === namespaceOf(name)
                    ? token.cssVar
                    : name;
            let own = base;

            for (let at = 2; claimed.has(own); at++) {
                own = `${base}-${at}`;
            }

            names.set(token.name, own);
            claimed.add(own);
        }
    }

    return names;
}

function tailwindCss(system: CompileInput): string {
    const names = tailwindNames(system);
    const rename = new Map(system.tokens.map((token) => [token.cssVar, names.get(token.name)!]));
    // A reference points at the variable that the token has in this file.
    const swap = (css: string) =>
        css.replace(/var\((--[\w-]+)/g, (all, name: string) =>
            rename.has(name) ? `var(${rename.get(name)}` : all,
        );

    const decls = (token: ResolvedToken, mode: string): Decl[] => {
        const value = token.modes[mode]!;
        const name = names.get(token.name)!;

        if (token.type !== "typography") {
            return [[name, swap(value.css)]];
        }

        const parts = value.parts ?? {};

        // A type style is Tailwind's `--text-*`: the size, with `--line-height`, `--font-weight`, and `--letter-spacing`.
        if (name.startsWith("--text-") && parts["font-size"] !== undefined) {
            const out: Decl[] = [[name, swap(parts["font-size"])]];

            for (const property of ["line-height", "font-weight", "letter-spacing"] as const) {
                if (parts[property] !== undefined) {
                    out.push([`${name}--${property}`, swap(parts[property])]);
                }
            }

            return out;
        }

        return [
            [name, swap(value.css)],
            ...Object.entries(parts).map(([property, css]): Decl => [
                `${name}-${property}`,
                swap(css),
            ]),
        ];
    };

    const base = system.modes[0]!;
    const parts = blocks(system, decls, true);
    const dark = system.modes.find((mode) => system.schemes[mode] === "dark" && mode !== base);
    const reset = (system.tailwindReset ?? []).map((namespace) =>
        namespace === "all" ? "--*: initial;" : `--${namespace}-*: initial;`,
    );
    const out = [
        header(system, "tailwind.css", [
            "For Tailwind CSS v4. Import it after Tailwind, in your main stylesheet:",
            '    @import "tailwindcss";',
            '    @import "./tailwind.css";',
            "Each token has one variable here, in a namespace of Tailwind's theme when one fits: --color-*, --font-* (families),",
            "--text-*, --font-weight-*, --tracking-*, --leading-*, --breakpoint-*, --container-*, --spacing-*, --radius-*,",
            "--shadow-*, --inset-shadow-*, --drop-shadow-*, --blur-*, --perspective-*, --aspect-*, --ease-*. A token with no",
            "namespace keeps its own name (--button-height); one whose name would be read as a namespace of the wrong kind",
            "(--font-leading-tight) gets --ds- in front.",
            "Utilities read well because a role drops the word that the utility repeats: color.bg.surface is --color-surface",
            "(bg-surface), color.text.primary is --color-primary (text-primary), color.border.default is --color-default",
            "(border-default), and a trailing default goes (color.accent.default is --color-accent). When two roles would",
            "have one name, the first keeps it and the other keeps its full name (--color-text-muted).",
            "tokens.css has every token under its own name (--color-bg-surface, --space-4); link it too for var(--space-4)",
            "and the components.",
            'To clear Tailwind\'s default palette (bg-red-500 and the rest), set "tailwindReset": ["color"] in tokens.json\'s',
            '$extensions["com.pi-pocket"].',
        ]),
        "",
        `:root,\n[data-theme="${base}"] {`,
        `    color-scheme: ${schemeOf(system, base)};`,
        "}",
        "",
        ...(dark === undefined
            ? []
            : [
                  "/* dark: matches [data-theme] when it is set, and the system's dark setting when no data-theme is. */",
                  "@custom-variant dark {",
                  `    &:where([data-theme="${dark}"], [data-theme="${dark}"] *) {`,
                  "        @slot;",
                  "    }",
                  "",
                  "    @media (prefers-color-scheme: dark) {",
                  "        &:where(:not([data-theme]):not([data-theme] *)) {",
                  "            @slot;",
                  "        }",
                  "    }",
                  "}",
                  "",
              ]),
        `/* ${comment(base)} values. Other modes override them below. */`,
        "@theme static {",
        ...reset.map((line) => `    ${line}`),
        ...(reset.length > 0 ? [""] : []),
        ...parts.base,
        "}",
    ];

    for (const { mode, lines } of parts.others) {
        out.push(
            "",
            `/* Mode: ${comment(mode)} */`,
            `[data-theme="${mode}"] {`,
            `    color-scheme: ${schemeOf(system, mode)};`,
            "",
            ...lines,
            "}",
        );
    }

    if (parts.media !== undefined) {
        out.push(
            "",
            `@media (prefers-color-scheme: ${parts.media.scheme}) {`,
            "    :root:not([data-theme]) {",
            `        color-scheme: ${parts.media.scheme};`,
            "",
            ...parts.media.lines.map((line) => (line === "" ? line : `    ${line}`)),
            "    }",
            "}",
        );
    }

    return `${out.join("\n")}\n`;
}

// --- Resolved JSON and component CSS ------------------------------------------------------------------------------------

function componentsCss(system: CompileInput): string {
    const head = header(system, "components.css", [
        'Use it:  <link rel="stylesheet" href="ds/components.css">  then use the markup of a component specimen.',
    ]);

    if (system.components.length === 0) {
        return `${head}\n\n/* No components yet. */\n`;
    }

    const blocks = system.components.map(
        (component) =>
            `/* ${comment(component.name, 60)} (components/${component.slug}.html) */\n${component.css}`,
    );

    return `${head}\n\n${blocks.join("\n\n")}\n`;
}

/** Compiles a system into the files of `.pi/design/dist/`: four, a DTCG file for each mode, and one for Tokens Studio. */
export function compileDesignSystem(input: CompileInput): CompiledFiles {
    const system = literalPrimitives(input);

    return {
        css: tokensCss(system),
        tailwind: tailwindCss(system),
        json: compactJson(system),
        components: componentsCss(system),
        modes: Object.fromEntries(system.modes.map((mode) => [mode, dtcgJson(system, mode)])),
        studio: studioJson(system),
    };
}
