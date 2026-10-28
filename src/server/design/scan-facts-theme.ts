/** Theme objects in JavaScript and TypeScript (stream T): Tailwind config, Chakra, Mantine, Stitches, vanilla-extract, and the like, read by their keys. */
import { type Literal, readLiteral, type Scope, UNKNOWN } from "./scan-parse.ts";
import { addVar, bump, type Category, type Facts } from "./scan-facts.ts";
import {
    leaves,
    modeBlocks,
    modeOf,
    semanticTokens,
    THEME_KEYS,
    themeList,
} from "./scan-facts-lists.ts";

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

/** Reads theme objects from a JavaScript or TypeScript file: `colors: { … }`, `const palette = { … }`. */
export function themeVars(facts: Facts, file: string, text: string): void {
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
