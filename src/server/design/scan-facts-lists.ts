/** Themes written as lists and by mode (stream T): daisyUI theme lists, Mantine shades, Chakra `semanticTokens`, and objects named for a mode. */
import { NAMED_COLORS } from "./color.ts";
import { colorsIn, type Literal, readLiteral, type Scope } from "./scan-parse.ts";
import { addVar, type Category, type Facts, GENERIC } from "./scan-facts.ts";

/** The keys of a JavaScript theme, and what each holds. */
export const THEME_KEYS: Record<string, Category> = {
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
export function leaves(
    literal: Literal,
    path: string[],
    out: { path: string[]; value: string }[],
    category: Category,
    // The nodes still to visit: an object that the reader shares can make a tree of millions of them.
    budget = { left: 20_000 },
): void {
    if (out.length > 600 || path.length > 6 || --budget.left < 0) {
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
        // Panda and Chakra v3 write a token as `{ value: "#f9fafb" }` (and may add `description` and `type`).
        const only = Object.keys(literal).every((key) =>
            ["value", "description", "type", "deprecated", "extensions"].includes(key),
        );

        if (only && literal.value !== undefined && typeof literal.value !== "object") {
            leaves(literal.value, path, out, category, budget);

            return;
        }

        if (only && Array.isArray(literal.value)) {
            leaves(literal.value, path, out, category, budget);

            return;
        }

        for (const [key, child] of Object.entries(literal)) {
            leaves(
                child,
                key === "DEFAULT" || key === "default" ? path : [...path, key],
                out,
                category,
                budget,
            );
        }
    }
}

/** The mode that a name stands for (`darkTheme`, `theme_light`, `NIGHT`): dark, light, or none. */
export function modeOf(name: string): Scope | undefined {
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

/**
 * A list of themes, each an object with one key (daisyUI: `themes: [{ mytheme: { primary: "#570df8", … } }, { dark: … }]`):
 * a theme named for a mode is that mode; the first other one is the default.
 */
export function themeList(
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
export function modeBlocks(
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
        node = node.DEFAULT ?? node.default ?? node.value;
    }

    // A token written `{ value: "#fff" }` (Panda, Chakra v3), also as the DEFAULT of a group.
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
        node = node.value;
    }

    // A color keyword that the palette does not name (`white`, `transparent`) is the color.
    if (node === undefined && path.length === 1 && NAMED_COLORS.has(path[0]!.toLowerCase())) {
        return path[0]!.toLowerCase();
    }

    return typeof node === "string" ? node : undefined;
}

/** The conditions that a Panda or Chakra config defines: `conditions: { extend: { dark: ".dark &", night: "[data-theme=night] &" } }`. */
function conditionsIn(text: string, env: ReadonlyMap<string, Literal>): Map<string, string> {
    const out = new Map<string, string>();

    for (const match of [...text.matchAll(/(?<![\w$.])conditions\s*:\s*(?=\{)/g)].slice(0, 3)) {
        const literal = readLiteral(text, match.index + match[0].length, env);

        if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
            continue;
        }

        const entries = {
            ...literal,
            ...(typeof literal.extend === "object" &&
            literal.extend !== null &&
            !Array.isArray(literal.extend)
                ? literal.extend
                : {}),
        };

        for (const [name, selector] of Object.entries(entries).slice(0, 80)) {
            if (typeof selector === "string") {
                out.set(name.replace(/^_/, ""), selector);
            }
        }
    }

    return out;
}

/** What a condition key stands for: the base value, the dark or the light mode, or nothing (a state such as `_hover`). */
function conditionScope(
    key: string,
    conditions: ReadonlyMap<string, string>,
): Scope | "base" | undefined {
    const name = key.replace(/^_/, "");

    if (["base", "default", "DEFAULT"].includes(name)) {
        return "base";
    }

    const named = modeOf(name);

    if (named !== undefined) {
        return named;
    }

    // A condition the config names for itself: `night: "[data-theme=night] &"`, `contrast: "@media (prefers-contrast: more)"`.
    const selector = conditions.get(name);

    return selector === undefined
        ? undefined
        : (modeOf(selector.replace(/[^\w]+/g, " ")) ?? undefined);
}

/**
 * Semantic tokens with a value for each condition, in the forms of Chakra and Panda: `semanticTokens.colors`, a name
 * with `{ value: { base: "{colors.gray.50}", _dark: "{colors.gray.950}" } }` (v3, Panda), `{ default: "gray.50",
 * _dark: "gray.900" }` (v2), a plain `value: "{colors.green.600}"`, `DEFAULT` inside a group, conditions nested in a
 * condition, and conditions the config defines (`_night`). A color is written as itself or as a reference into the palette.
 * Each is a variable with a value for each mode.
 */
export function semanticTokens(
    facts: Facts,
    file: string,
    text: string,
    env: ReadonlyMap<string, Literal>,
    tree: Record<string, Literal>,
    scopeAt: (index: number) => Scope,
): void {
    const conditions = conditionsIn(text, env);

    // `semanticTokens: { … }`, `semanticTokens: defineSemanticTokens({ … })`, `semanticTokens: tokens`, or just `semanticTokens`.
    const heads = [
        ...text.matchAll(
            /(?<![\w$.])semanticTokens\s*(?::\s*(?:[A-Za-z_$][\w$.]*\s*\(\s*)?(?=\{)|:\s*(?=[A-Za-z_$])|(?=\s*[,}]))/g,
        ),
    ];

    for (const match of heads.slice(0, 4)) {
        const at = match.index + match[0].length;
        const named = /^[A-Za-z_$][\w$]*/.exec(text.slice(at, at + 80))?.[0];
        const literal =
            text[at] === "{"
                ? readLiteral(text, at, env)
                : env.get(match[0].includes(":") ? (named ?? "") : "semanticTokens");
        const colors =
            typeof literal === "object" && literal !== null && !Array.isArray(literal)
                ? literal.colors
                : undefined;

        if (typeof colors !== "object" || colors === null || Array.isArray(colors)) {
            continue;
        }

        const base = scopeAt(match.index);
        let count = 0;

        const add = (path: string[], ref: Literal | undefined, scope: Scope) => {
            const value = typeof ref === "string" ? paletteColor(ref, tree, env) : undefined;

            if (value !== undefined && path.length > 0) {
                addVar(facts, {
                    name: path.join("-"),
                    value,
                    scope,
                    kind: "js",
                    file,
                    hint: "color",
                });
            }
        };

        /** The text of a value that may be a condition's own object (`_dark: { base: "{colors.red.400}", _hover: … }`). */
        const plain = (node: Literal | undefined): Literal | undefined => {
            if (typeof node !== "object" || node === null || Array.isArray(node)) {
                return node;
            }

            for (const key of ["base", "default", "DEFAULT", "_light", "light", "value"]) {
                if (node[key] !== undefined) {
                    return plain(node[key]);
                }
            }

            return undefined;
        };

        /** A token's values by condition. `modes` is the object of conditions, or a string. */
        const conditional = (path: string[], modes: Literal): void => {
            if (typeof modes === "string") {
                add(path, modes, base);

                return;
            }

            if (typeof modes !== "object" || modes === null || Array.isArray(modes)) {
                return;
            }

            const entries = Object.entries(modes)
                .map(([key, value]) => ({ key, scope: conditionScope(key, conditions), value }))
                .filter(
                    (entry): entry is { key: string; scope: Scope | "base"; value: Literal } =>
                        entry.scope !== undefined,
                );
            const hasBase = entries.some((entry) => entry.scope === "base");

            // The operating system's dark first, so that the explicit dark condition is the later one.
            entries.sort((a, b) => Number(/^_?os/i.test(b.key)) - Number(/^_?os/i.test(a.key)));

            for (const entry of entries) {
                const scope: Scope =
                    entry.scope === "base"
                        ? base
                        : entry.scope === "light" && !hasBase
                          ? base
                          : entry.scope;

                add(path, plain(entry.value), scope);
            }
        };

        const walk = (node: Literal, path: string[]): void => {
            if (++count > 300 || path.length > 5) {
                return;
            }

            if (typeof node === "string") {
                add(path, node, base);

                return;
            }

            if (typeof node !== "object" || node === null || Array.isArray(node)) {
                return;
            }

            // A token of v3 and Panda: `{ value: … }`, the value a string or an object of conditions.
            if (node.value !== undefined && path.length > 0) {
                conditional(path, node.value);

                return;
            }

            // A token of v2: the conditions are the keys (`default`, `_dark`).
            const keys = Object.keys(node);

            if (
                path.length > 0 &&
                keys.length > 0 &&
                keys.every((key) => conditionScope(key, conditions) !== undefined) &&
                !Object.values(node).some(
                    (child) =>
                        typeof child === "object" &&
                        child !== null &&
                        !Array.isArray(child) &&
                        "value" in child,
                )
            ) {
                conditional(path, node);

                return;
            }

            for (const [key, child] of Object.entries(node)) {
                walk(
                    child,
                    key === "DEFAULT" || key === "default" ? path : [...path, ...key.split(".")],
                );
            }
        };

        walk(colors as Literal, []);
    }
}

// --- Whole files ---------------------------------------------------------------------------------------------------
