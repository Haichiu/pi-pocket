/**
 * The names in `tailwind.css` (stream T): which variable of Tailwind v4's theme each token has, so that the file makes
 * utilities of the right kind and the utilities read well. The rules are in `tailwindName`; `tailwindNames` settles
 * two tokens that want one name. `names.md` in `dist/` lists the result.
 */
import type { ResolvedToken } from "./system-types.ts";
import type { CompileInput } from "./tokens-compile.ts";

export const norm = (segment: string) => segment.toLowerCase().replace(/[-_]/g, "");

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
/** Last words of a role that name nothing alone: they take the word of their group (`text.primary` is `--color-text`). */
const GENERIC_ROLES = [
    "default",
    "primary",
    "secondary",
    "tertiary",
    "base",
    "main",
    "normal",
    "regular",
    "standard",
];
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
 * color role drops the word that the utility repeats (`color.bg.surface` is `--color-surface`, so `bg-surface`) unless
 * what is left is a word that says nothing alone (`default`, `primary`, `base`): then the role takes the word of its
 * group (`color.border.default` is `--color-border`, `color.text.primary` is `--color-text`, `color.bg.base` is
 * `--color-bg`). A role of another group loses a trailing `default` (`color.accent.default` is `--color-accent`).
 * When two roles want one name the first keeps it and the other keeps its full name (`--color-text-secondary`).
 */
export function tailwindName(token: ResolvedToken): string | undefined {
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
                // `color.border.default` is `--color-border`: a name that is only `default` or `primary` says nothing
                // (`primary` is also the brand), so the role takes the word of its group.
                rest =
                    rest.length === 2 && GENERIC_ROLES.includes(norm(rest[1]!))
                        ? rest.slice(0, 1)
                        : rest.slice(1);
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
export const TAILWIND_NAMESPACES = [
    "color",
    "font",
    "font-weight",
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
export const namespaceOf = (name: string) =>
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
