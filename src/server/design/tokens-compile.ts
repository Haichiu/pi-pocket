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

export type CompileInput = Pick<
    DesignSystem,
    "name" | "description" | "modes" | "schemes" | "tokens" | "components"
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

/** The declarations of a token in a mode: its variable, and the variables of a typography token's members. */
function declarations(token: ResolvedToken, mode: string): Decl[] {
    const value = token.modes[mode]!;
    const decls: Decl[] = [[token.cssVar, value.css]];

    for (const [property, css] of Object.entries(value.parts ?? {})) {
        decls.push([`${token.cssVar}-${property}`, css]);
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

/** The Tailwind v4 variable for a token (`--color-*`, `--font-*`, `--text-*`, `--spacing-*`, ...), if a namespace fits. */
function tailwindName(token: ResolvedToken): string | undefined {
    if (token.tailwind !== undefined) {
        return token.tailwind;
    }

    const path = token.path;
    const first = norm(path[0]!);
    const join = (prefix: string, rest: readonly string[]) => `--${prefix}-${rest.join("-")}`;

    switch (token.type) {
        case "color":
            return join("color", stripLead(path, ["color", "colors", "colour", "clr"]));
        case "fontFamily":
            return join(
                "font",
                stripLead(path, ["font", "fonts", "family", "families", "fontfamily", "typeface"]),
            );
        case "fontWeight":
            return join(
                "font-weight",
                stripLead(path, ["font", "weight", "weights", "fontweight"]),
            );
        case "cubicBezier":
            return join(
                "ease",
                stripLead(path, ["motion", "ease", "easing", "easings", "timing", "transition"]),
            );
        case "shadow":
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
            return ["leading", "lineheight", "lineheights"].includes(first)
                ? join(
                      "leading",
                      stripLead(path, ["leading", "lineheight", "lineheights", "line", "height"]),
                  )
                : undefined;
        case "dimension":
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
                (first === "font" && norm(path[1] ?? "") === "size")
            ) {
                return join(
                    "text",
                    stripLead(path, [
                        "text",
                        "font",
                        "size",
                        "sizes",
                        "fontsize",
                        "fontsizes",
                        "fs",
                        "typesize",
                    ]),
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

            if (["tracking", "letterspacing"].includes(first)) {
                return join("tracking", stripLead(path, ["tracking", "letterspacing"]));
            }

            return first === "blur" ? join("blur", stripLead(path, ["blur"])) : undefined;
        default:
            return undefined;
    }
}

/** The Tailwind file's declarations for a token in a mode: Tailwind's name carries the value, ours points at it. */
function tailwindDecls(token: ResolvedToken, mode: string, taken: Map<string, string>): Decl[] {
    const value = token.modes[mode]!;
    const name = taken.get(token.name);

    if (token.type === "typography") {
        const decls = declarations(token, mode);

        if (name !== undefined) {
            const parts = value.parts ?? {};

            decls.push([name, `var(${token.cssVar}-font-size)`]);

            for (const [property, suffix] of [
                ["line-height", "line-height"],
                ["font-weight", "font-weight"],
                ["letter-spacing", "letter-spacing"],
            ] as const) {
                if (parts[property] !== undefined) {
                    decls.push([`${name}--${suffix}`, `var(${token.cssVar}-${property})`]);
                }
            }
        }

        return decls;
    }

    if (name === undefined || name === token.cssVar) {
        return declarations(token, mode);
    }

    return [
        [name, value.css],
        [token.cssVar, `var(${name})`],
    ];
}

function tailwindCss(system: CompileInput): string {
    // One Tailwind name for one token: the first token keeps it, and no name another token already has as its own.
    const taken = new Map<string, string>();
    const owners = new Set<string>();
    const own = new Set(system.tokens.map((token) => token.cssVar));

    for (const token of system.tokens) {
        const name = tailwindName(token);

        if (name !== undefined && !owners.has(name) && (name === token.cssVar || !own.has(name))) {
            owners.add(name);
            taken.set(token.name, name);
        }
    }

    const base = system.modes[0]!;
    const parts = blocks(system, (token, mode) => tailwindDecls(token, mode, taken), true);
    const dark = system.modes.find((mode) => system.schemes[mode] === "dark" && mode !== base);
    const out = [
        header(system, "tailwind.css", [
            "For Tailwind CSS v4. Import it after Tailwind, in your main stylesheet:",
            '    @import "tailwindcss";',
            '    @import "./tailwind.css";',
            "Tokens in a Tailwind namespace (--color-*, --font-*, --text-*, --spacing-*, --radius-*, --shadow-*, --ease-*) make",
            "utilities such as bg-bg-surface or rounded-md. Every token keeps its own variable too, so var(--space-4) works.",
        ]),
        "",
        `:root,\n[data-theme="${base}"] {`,
        `    color-scheme: ${schemeOf(system, base)};`,
        "}",
        "",
        ...(dark === undefined
            ? []
            : [
                  `@custom-variant dark (&:where([data-theme="${dark}"], [data-theme="${dark}"] *));`,
                  "",
              ]),
        `/* ${comment(base)} values. Other modes override them below. */`,
        "@theme static {",
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

function resolvedJson(system: CompileInput): string {
    const tokens: Record<string, unknown> = {};

    for (const token of system.tokens) {
        const entry: Record<string, unknown> = {
            type: token.type,
            tier: token.tier,
            cssVar: token.cssVar,
        };

        for (const key of ["description", "deprecated", "tailwind", "contrast"] as const) {
            if (token[key] !== undefined) {
                entry[key] = token[key];
            }
        }

        entry.values = token.modes;
        Object.defineProperty(tokens, token.name, {
            value: entry,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    return `${JSON.stringify(
        {
            name: system.name,
            ...(system.description === undefined ? {} : { description: system.description }),
            modes: system.modes,
            defaultMode: system.modes[0],
            schemes: system.schemes,
            tokens,
        },
        null,
        2,
    )}\n`;
}

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

/** Compiles a system into the four files of `.pi/design/dist/`. */
export function compileDesignSystem(system: CompileInput): CompiledFiles {
    return {
        css: tokensCss(system),
        tailwind: tailwindCss(system),
        json: resolvedJson(system),
        components: componentsCss(system),
    };
}
