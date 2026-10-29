import { NAMED_COLORS, parseColor, toHex } from "./color.ts";

export type Scope = "default" | "dark" | "light" | "other";

export interface Decl {
    prop: string;
    /** The value, without `!important` and `!default`, cut to `MAX_VALUE`. */
    value: string;
    /** The innermost selector, with `&` resolved against its parent. Empty at the top level and for an inline style. */
    selector: string;
    /** The at-rule preludes around it, outermost first (`@media (min-width: 768px)`, `@theme`). */
    at: string[];
    /** Whether the rule applies in dark mode and, for a custom property, whether it defines the dark values. */
    scope: Scope;
    theme: boolean;
    inline: boolean;
    line?: number;
}

const MAX_VALUE = 400;
const MAX_MAP = 8000;

// Comments hold notes and old code, not styles in use. An unclosed comment runs to the end of the text, so the match stays linear; a `/*` or `//` after a word, a quote, or (for `//`) `:` or `(` is a glob or an address.
const COMMENTS =
    /(?<![\w.*"'`/-])\/\*[\s\S]*?(?:\*\/|$)|<!--[\s\S]*?(?:-->|$)|(?<![:\w"'`(/\\])\/\/[^\n]*/g;

const DARK_WORD = String.raw`(?:dark|dark[-_]theme|dark[-_]mode|darkmode|dark[-_]scheme|theme[-_]{0,2}dark|mode[-_]{0,2}dark|scheme[-_]{0,2}dark|color[-_]scheme[-_]dark|is[-_]?dark|has[-_]?dark|ui[-_]dark|app[-_]dark|body[-_]dark|v-theme--dark|chakra-ui-dark|ant-dark|night|night[-_]mode|nightmode|theme[-_]night|dark[-_]?(?:theme|mode|scheme)(?:[-_]active|[-_]on|[-_]enabled)?)`;
const DARK_PART = String.raw`(?:\.${DARK_WORD}(?![\w-])|\[(?:data-[\w-]*)?(?:theme|mode|color-mode|color-scheme|colorscheme|appearance|scheme)\s*[~|^$*]?=\s*["']?(?:dark|night|slate|dark[-_]mode|darkmode)["']?\s*\])`;
const DARK_ANY = new RegExp(DARK_PART, "i");
const DARK_ROOT = new RegExp(
    String.raw`^(?:html|body|:root|\*|:host)?(?:${DARK_PART})+(?::root)?$`,
    "i",
);
const LIGHT_PART = String.raw`(?:\.(?:light|light[-_]theme|light[-_]mode|lightmode|theme[-_]{1,2}light|mode[-_]{1,2}light|scheme[-_]light|v-theme--light|chakra-ui-light|ant-light|day|day[-_]mode)(?![\w-])|\[(?:data-[\w-]*)?(?:theme|mode|color-mode|color-scheme|colorscheme|appearance|scheme)\s*[~|^$*]?=\s*["']?(?:light|day)["']?\s*\])`;
const LIGHT_ROOT = new RegExp(
    String.raw`^(?:html|body|:root|\*|:host)?(?:${LIGHT_PART})+(?::root)?$`,
    "i",
);
const DARK_DESC = new RegExp(
    String.raw`^(?:html|body|:root|\*|:host)?(?:${DARK_PART})+\s+(?:body|html|:root|\*|main|#root|#app|\.app|\.App)$`,
    "i",
);
const ROOT_ONLY =
    /^(?:html|body|:root|\*|:host|#root|#app|#__next|\.app|\.theme|main)(?:\[data-(?:bs-)?(?:theme|mode)\])*$|^\[data-(?:bs-)?(?:theme|mode|color-scheme)\]$/i;
const ROOT_ANY = /^(?:html|body|:root|\*|:host)(?:\s*:not\([^)]*\))?$/i;

export const isDarkSelector = (selector: string) => DARK_ANY.test(selector);

function partScope(part: string, dark: boolean, light = false): Scope {
    if (DARK_ROOT.test(part) || DARK_DESC.test(part)) {
        return "dark";
    }

    if (LIGHT_ROOT.test(part)) {
        return "light";
    }

    if (light) {
        // Inside `prefers-color-scheme: light`, the root selectors define the light values (a dark-first project's other mode).
        return ROOT_ANY.test(part) || ROOT_ONLY.test(part) || /^:root\b/i.test(part)
            ? "light"
            : "other";
    }

    if (dark) {
        // Inside `prefers-color-scheme: dark`, the root selectors define the dark values; `:root:not(.light)` too.
        return ROOT_ANY.test(part) || ROOT_ONLY.test(part) || /^:root\b/i.test(part)
            ? "dark"
            : "other";
    }

    return ROOT_ONLY.test(part) ||
        /^:root\b(?!.*[.[])/i.test(part) ||
        /^(?:html|body|:root)\s*:not\(/i.test(part)
        ? "default"
        : "other";
}

function varScope(selector: string, dark: boolean, light = false): Scope {
    const scopes = selector
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => partScope(part, dark, light));

    if (scopes.length === 0) {
        return dark ? "dark" : light ? "light" : "default";
    }

    if (scopes.includes("default")) {
        return "default";
    }

    for (const scope of ["dark", "light"] as const) {
        if (scopes.every((each) => each === scope)) {
            return scope;
        }
    }

    return scopes.includes("dark") ? "dark" : scopes.includes("light") ? "light" : "other";
}

function isDarkWords(name: string): boolean {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => word === "dark" || word === "night");
}

function isDarkInclude(prelude: string): boolean {
    const include = /^@include\s+([\w.-]+)\s*(?:\(([^)]*)\))?/i.exec(prelude);

    if (include !== null) {
        const name = include[1]!.replace(/^.*\./, "");

        return (
            isDarkWords(name) ||
            /(?:^|[\s,(:])['"]?(?:dark|night)['"]?(?:$|[\s,)])/i.test(include[2] ?? "")
        );
    }

    return /^@(?:else\s+)?if\b[^{]*(?:==|=)\s*['"]?(?:dark|night)['"]?\s*$/i.test(prelude);
}

const MAX_DECLS = 30_000;
const MAX_DEPTH = 24;

// A comment keeps its line breaks, so that a line counted after it is the file's line; one line of it is a space.
export const stripComments = (text: string) =>
    text.replace(COMMENTS, (comment) => comment.replace(/[^\n]+/g, "").replace(/^$/, " "));

export function parseStyles(source: string, firstLine: number | undefined = 1): Decl[] {
    const text = stripComments(source);
    const breaks: number[] = [];

    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        breaks.push(at);
    }

    let cursor = 0;

    const lineOf = (index: number) => {
        let low = 0;
        let high = breaks.length;

        while (low < high) {
            const middle = (low + high) >> 1;

            if (breaks[middle]! < index) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        return (firstLine ?? 1) + low;
    };

    // `@custom-media --dark (prefers-color-scheme: dark);` names a query: `@media (--dark)` is the dark mode's.
    const darkQueries = [
        ...text.matchAll(/@custom-media\s+(--[\w-]+)\s+[^;{}]*prefers-color-scheme\s*:\s*dark/gi),
    ].map((match) => match[1]!);
    const decls: Decl[] = [];
    const stack: { prelude: string; selector: string }[] = [];
    let buffer = "";
    let paren = 0;

    const chain = () => stack.map((block) => block.prelude);
    const selector = () =>
        stack.findLast((block) => !block.prelude.startsWith("@"))?.selector ?? "";

    const flush = () => {
        const statement = buffer.trim();

        buffer = "";

        if (statement === "" || decls.length >= MAX_DECLS) {
            return;
        }

        const match = /^(--[\w-]+|[$@]?[A-Za-z_][\w-]*|\*[A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/.exec(
            statement,
        );

        if (
            match === null ||
            /^@(?:media|supports|import|charset|font-face|keyframes|layer|container|include|mixin|use|forward|extend|return|if|else|each|for|while|function|apply|plugin|source|tailwind|custom-variant|variant|utility|theme|config|namespace|property|page|counter-style|font-feature-values|scope|starting-style)\b/.test(
                statement,
            )
        ) {
            return;
        }

        const prop = match[1]!;
        const value = match[2]!.replace(/\s*!(?:important|default|global)\s*$/i, "").trim();
        const at = chain().filter((part) => part.startsWith("@"));
        const dark = at.some(
            (part) =>
                /^@media\b[^{]*prefers-color-scheme\s*:\s*dark/i.test(part) ||
                (/^@media\b/i.test(part) &&
                    darkQueries.some((name) => new RegExp(`\\(\\s*${name}\\s*\\)`).test(part))) ||
                isDarkInclude(part),
        );
        const light = at.some((part) =>
            /^@media\b[^{]*prefers-color-scheme\s*:\s*light/i.test(part),
        );
        const here = selector();
        const theme = at.some((part) => /^@theme\b/i.test(part));

        decls.push({
            prop: prop.startsWith("--") || /^[$@]/.test(prop) ? prop : prop.toLowerCase(),
            // A Sass map (`$themes: (light: (…), dark: (…))`) is long: it is read whole.
            value: value.slice(
                0,
                prop.startsWith("$") && value.startsWith("(") ? MAX_MAP : MAX_VALUE,
            ),
            selector: here,
            at,
            theme,
            inline: false,
            // The statement starts as many line breaks before the cursor as it holds after its first character.
            ...(firstLine === undefined
                ? {}
                : { line: lineOf(cursor) - (buffer.trimStart().match(/\n/g)?.length ?? 0) }),
            scope:
                prop.startsWith("--") || prop.startsWith("$") || prop.startsWith("@")
                    ? theme
                        ? "default"
                        : varScope(here, dark, light)
                    : dark || isDarkSelector(here)
                      ? "dark"
                      : "default",
        });
    };

    for (let at = 0; at < text.length; at++) {
        const char = text[at]!;

        cursor = at;

        if (char === '"' || char === "'") {
            let end = at + 1;

            while (end < text.length && text[end] !== char && text[end] !== "\n") {
                end += text[end] === "\\" ? 2 : 1;
            }

            buffer += text.slice(at, end + 1);
            at = end;
        } else if (char === "#" && text[at + 1] === "{") {
            const end = text.indexOf("}", at);

            buffer += text.slice(at, end === -1 ? text.length : end + 1);
            at = end === -1 ? text.length : end;
        } else if (char === "(") {
            paren += 1;
            buffer += char;
        } else if (char === ")") {
            paren = Math.max(0, paren - 1);
            buffer += char;
        } else if (char === "{" && paren === 0) {
            if (stack.length >= MAX_DEPTH) {
                return decls;
            }

            // Svelte, Vue and CSS Modules wrap selectors: `:global(:root)`, `:global(.dark)`, `:deep(.x)`, `:local(.x)`.
            const prelude = buffer
                .trim()
                .replace(/\s+/g, " ")
                .replace(/:(?:global|local|deep)\(((?:[^()]|\([^()]*\))*)\)/g, "$1")
                .replace(/^:global\s+/, "");

            buffer = "";

            // `&` is the parent selector; without it a nested rule is a descendant. An at-rule keeps its parent's.
            const parent =
                stack.findLast((block) => !block.prelude.startsWith("@"))?.selector ?? "";
            let resolved: string;

            if (prelude.startsWith("@") || parent === "") {
                resolved = prelude.startsWith("@") ? parent : prelude;
            } else if (prelude.includes("&")) {
                resolved = prelude.replace(/&/g, parent);
            } else {
                resolved = `${parent} ${prelude}`;
            }

            stack.push({ prelude: prelude.slice(0, 300), selector: resolved.slice(0, 300) });
        } else if (char === "}" && paren === 0) {
            flush();
            stack.pop();
        } else if (char === ";" && paren === 0) {
            flush();
        } else {
            buffer += char;
        }

        if (buffer.length > (buffer.trimStart().startsWith("$") ? MAX_MAP * 2 : 4000)) {
            // A statement this long is not a declaration: drop it rather than grow without bound.
            buffer = buffer.slice(-2000);
        }
    }

    flush();

    return decls;
}

export function pageStyles(source: string): { blocks: string[]; inline: Decl[] } {
    const blocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(
        (match) => match[1]!,
    );
    const inline: Decl[] = [];
    let count = 0;

    for (const match of source.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        if (++count > 5000) {
            break;
        }

        for (const declaration of (match[1] ?? match[2] ?? "").split(";")) {
            const colon = declaration.indexOf(":");

            if (colon > 0) {
                const prop = declaration.slice(0, colon).trim().toLowerCase();

                if (/^(?:--[\w-]+|[a-z-]+)$/.test(prop)) {
                    inline.push({
                        prop,
                        value: declaration
                            .slice(colon + 1)
                            .trim()
                            .slice(0, MAX_VALUE),
                        selector: "",
                        at: [],
                        scope: "default",
                        theme: false,
                        inline: true,
                    });
                }
            }
        }
    }

    return { blocks, inline };
}

export const UNKNOWN = Symbol("unknown");

export type Literal =
    string | number | boolean | null | typeof UNKNOWN | Literal[] | { [key: string]: Literal };

export function readLiteral(text: string, start: number): Literal | undefined {
    let at = start;
    let nodes = 0;

    const skip = () => {
        while (at < text.length) {
            if (/\s/.test(text[at]!)) {
                at += 1;
            } else if (text.startsWith("//", at)) {
                const end = text.indexOf("\n", at);

                at = end === -1 ? text.length : end + 1;
            } else if (text.startsWith("/*", at)) {
                const end = text.indexOf("*/", at + 2);

                at = end === -1 ? text.length : end + 2;
            } else {
                break;
            }
        }
    };

    const string = (): string | undefined => {
        const quote = text[at];

        if (quote !== '"' && quote !== "'" && quote !== "`") {
            return undefined;
        }

        let out = "";
        // A template literal with `${…}` is a value we cannot know; it is still read to its end.
        let dynamic = false;
        let braces = 0;

        at += 1;

        while (at < text.length && (text[at] !== quote || braces > 0)) {
            const char = text[at]!;

            if (char === "\\") {
                out += out.length < 2000 ? (text[at + 1] ?? "") : "";
                at += 2;

                continue;
            }

            if (quote === "`" && char === "$" && text[at + 1] === "{") {
                dynamic = true;
                braces += 1;
                at += 2;

                continue;
            }

            if (braces > 0 && char === "}") {
                braces -= 1;
            } else if (braces > 0 && char === "{") {
                braces += 1;
            } else if (out.length < 2000 && braces === 0) {
                out += char;
            }

            at += 1;
        }

        at += 1;

        return dynamic ? undefined : out;
    };

    const skipValue = (): typeof UNKNOWN => {
        let depth = 0;

        while (at < text.length) {
            const char = text[at]!;

            if (char === '"' || char === "'" || char === "`") {
                string();

                continue;
            }

            if ("([{".includes(char)) {
                depth += 1;
            } else if (")]}".includes(char)) {
                if (depth === 0) {
                    break;
                }

                depth -= 1;
            } else if (char === "," && depth === 0) {
                break;
            }

            at += 1;
        }

        return UNKNOWN;
    };

    const value = (depth: number): Literal => {
        skip();

        if (++nodes > 20_000 || depth > 12 || at >= text.length) {
            return UNKNOWN;
        }

        const char = text[at]!;

        if (char === "{") {
            at += 1;

            const out: { [key: string]: Literal } = {};
            let last = -1;

            while (at < text.length) {
                skip();

                // A closing bracket of another kind (`{ a: 1 ) }`) is read by nothing: the object ends there.
                if (at === last) {
                    break;
                }

                last = at;

                if (text[at] === "}") {
                    at += 1;

                    break;
                }

                if (text[at] === ",") {
                    at += 1;

                    continue;
                }

                if (text.startsWith("...", at)) {
                    skipValue();

                    continue;
                }

                if (text[at] === "[") {
                    skipValue();

                    continue;
                }

                let key = string();

                if (key === undefined) {
                    const bare = /^[A-Za-z_$][\w$-]*|^-?\d+(?:\.\d+)?/.exec(
                        text.slice(at, at + 80),
                    );

                    if (bare === null) {
                        skipValue();

                        continue;
                    }

                    key = bare[0];
                    at += key.length;
                }

                skip();

                if (text[at] === ":") {
                    at += 1;

                    const child = value(depth + 1);

                    if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
                        out[key] = child;
                    }
                } else {
                    skipValue();
                }
            }

            return out;
        }

        if (char === "[") {
            at += 1;

            const out: Literal[] = [];
            let last = -1;

            while (at < text.length) {
                skip();

                if (at === last) {
                    break;
                }

                last = at;

                if (text[at] === "]") {
                    at += 1;

                    break;
                }

                if (text[at] === ",") {
                    at += 1;

                    continue;
                }

                out.push(value(depth + 1));

                if (out.length > 500) {
                    break;
                }
            }

            return out;
        }

        const before = at;
        const quoted = string();

        if (quoted === undefined && at > before) {
            return skipValue();
        }

        if (quoted !== undefined) {
            // `"a" + b` and the like are not literals.
            skip();

            return text[at] === "," || text[at] === "}" || text[at] === "]" || at >= text.length
                ? quoted
                : skipValue();
        }

        const number = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(at, at + 40));

        if (number !== null) {
            at += number[0].length;
            skip();

            return text[at] === "," || text[at] === "}" || text[at] === "]" || at >= text.length
                ? Number(number[0])
                : skipValue();
        }

        const word = /^(true|false|null)\b/.exec(text.slice(at, at + 6));

        if (word !== null) {
            at += word[0].length;

            return word[1] === "null" ? null : word[1] === "true";
        }

        return skipValue();
    };

    skip();

    if (text[at] !== "{" && text[at] !== "[") {
        return undefined;
    }

    return value(0);
}

/** A `#hex` that is a color, not an HTML entity, a link or id, or a selector. */
const HEX =
    /(?<![&\w])(?<!(?:href|src|id|for)\s*=\s*["']?)(?<!url\(\s*["']?)#[0-9a-fA-F]{3,8}\b(?![\w-])(?!\s*[{.:[>+~])(?![^;{}"'`<>$]{0,200}\{)/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^()]*\)/gi;
const NAME_WORDS = new RegExp(
    String.raw`(?<![\w$@#.-])(${[...NAMED_COLORS.keys()].join("|")})(?![\w-])`,
    "gi",
);

interface FoundColor {
    text: string;
    hex: string;
}

/** A name inside `url()`, a string, or a function argument is not a color. */
export function colorsIn(value: string, named = false): FoundColor[] {
    const found: FoundColor[] = [];

    const push = (text: string) => {
        const color = parseColor(text);

        if (color !== undefined && !(color.a === 0 && /^transparent$/i.test(text))) {
            found.push({ text: text.trim(), hex: toHex(color) });
        }
    };

    for (const match of value.matchAll(HEX)) {
        push(match[0]);
    }

    for (const match of value.matchAll(COLOR_FUNCTION)) {
        push(match[0]);
    }

    if (named) {
        const bare = value
            .replace(/url\([^)]*\)/gi, " ")
            .replace(/(["'])(?:\\.|(?!\1).)*\1/g, " ")
            .replace(/\b[\w-]+\(/g, "(");

        for (const match of bare.matchAll(NAME_WORDS)) {
            if (match[1]!.toLowerCase() !== "transparent") {
                push(match[1]!);
            }
        }
    }

    return found;
}

export function px(text: string): number | undefined {
    // `clamp(1rem, 0.9rem + 1vw, 1.5rem)` is a fluid size: its smallest value is the step.
    const clamp = /^clamp\(\s*([^,()]+),/i.exec(text.trim());
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt)?$/i.exec(
        (clamp === null ? text : clamp[1]!).trim(),
    );

    if (match === null) {
        return undefined;
    }

    const value = Number(match[1]);

    switch (match[2]?.toLowerCase()) {
        case "rem":
        case "em":
            return value * 16;
        case "pt":
            return (value * 4) / 3;
        case "px":
            return value;
        default:
            return value === 0 ? 0 : undefined;
    }
}

export function parts(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let current = "";

    for (const char of value) {
        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth = Math.max(0, depth - 1);
        }

        if (/\s/.test(char) && depth === 0) {
            if (current !== "") {
                out.push(current);
            }

            current = "";
        } else {
            current += char;
        }
    }

    if (current !== "") {
        out.push(current);
    }

    return out;
}

export function commaParts(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = "";
    let current = "";

    for (const char of value) {
        if (quote !== "") {
            if (char === quote) {
                quote = "";
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth = Math.max(0, depth - 1);
        } else if (char === "," && depth === 0) {
            out.push(current.trim());
            current = "";

            continue;
        }

        current += char;
    }

    if (current.trim() !== "") {
        out.push(current.trim());
    }

    return out;
}
