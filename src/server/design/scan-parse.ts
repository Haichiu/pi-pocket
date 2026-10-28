/**
 * Static parsing for the design system scan (stream T): a tolerant CSS, SCSS, and Less reader that lists declarations
 * with the selector and at-rules around them, a reader for JavaScript object literals (no code runs), and the small
 * extractors for colors, lengths, and times. Everything is linear in the input and bounded; none of it executes or
 * resolves a file.
 */
import { NAMED_COLORS, parseColor, toHex } from "./color.ts";

/** Which mode a rule belongs to: the default, the dark mode, an explicit light mode, or a scope that is none (a component). */
export type Scope = "default" | "dark" | "light" | "other";

/** One declaration, with where it sits. */
export interface Decl {
    /** The property: lower case for CSS, as written for a custom property (`--Brand`), `$name` or `@name` for a variable. */
    prop: string;
    /** The value, without `!important` and `!default`, cut to `MAX_VALUE`. */
    value: string;
    /** The innermost selector, with `&` resolved against its parent. Empty at the top level and for an inline style. */
    selector: string;
    /** The at-rule preludes around it, outermost first (`@media (min-width: 768px)`, `@theme`). */
    at: string[];
    /** Whether the rule applies in dark mode and, for a custom property, whether it defines the dark values. */
    scope: Scope;
    /** True inside `@theme` (Tailwind v4). */
    theme: boolean;
    /** True for a `style="…"` attribute or a JSX style object. */
    inline: boolean;
    /** The line of the file where the declaration starts (1 is the first), when known. */
    line?: number;
}

export const MAX_VALUE = 400;
/** The most text of a Sass map. */
export const MAX_MAP = 8000;

/**
 * Comments hold notes (`fixes #123`) and old code, not the styles in use. Each becomes a line break. An unclosed comment
 * runs to the end of the text, so the match stays linear. A `/*` or `//` after a word, a quote, or (for `//`) `:` or `(`
 * is part of a glob (`src/*.css`) or an address (`https://`), not a comment.
 */
export const COMMENTS =
    /(?<![\w.*"'`/-])\/\*[\s\S]*?(?:\*\/|$)|<!--[\s\S]*?(?:-->|$)|(?<![:\w"'`(/\\])\/\/[^\n]*/g;

const DARK_WORD = String.raw`(?:dark|dark[-_]theme|dark[-_]mode|darkmode|dark[-_]scheme|theme[-_]{0,2}dark|mode[-_]{0,2}dark|scheme[-_]{0,2}dark|color[-_]scheme[-_]dark|is[-_]?dark|has[-_]?dark|ui[-_]dark|app[-_]dark|body[-_]dark|v-theme--dark|chakra-ui-dark|ant-dark|night|night[-_]mode|nightmode|theme[-_]night|dark[-_]?(?:theme|mode|scheme)(?:[-_]active|[-_]on|[-_]enabled)?)`;
// A class or attribute that selects the dark theme: `.dark`, `[data-theme="dark"]`, `[data-mantine-color-scheme=dark]`...
const DARK_PART = String.raw`(?:\.${DARK_WORD}(?![\w-])|\[(?:data-[\w-]*)?(?:theme|mode|color-mode|color-scheme|colorscheme|appearance|scheme)\s*[~|^$*]?=\s*["']?(?:dark|night|slate|dark[-_]mode|darkmode)["']?\s*\])`;
const DARK_ANY = new RegExp(DARK_PART, "i");
// A root-like compound that ends in the dark class: `html.dark`, `:root[data-theme=dark]`, `body.dark`, `.dark`.
const DARK_ROOT = new RegExp(
    String.raw`^(?:html|body|:root|\*|:host)?(?:${DARK_PART})+(?::root)?$`,
    "i",
);
const LIGHT_PART = String.raw`(?:\.(?:light|light[-_]theme|light[-_]mode|lightmode|theme[-_]{1,2}light|mode[-_]{1,2}light|scheme[-_]light|v-theme--light|chakra-ui-light|ant-light|day|day[-_]mode)(?![\w-])|\[(?:data-[\w-]*)?(?:theme|mode|color-mode|color-scheme|colorscheme|appearance|scheme)\s*[~|^$*]?=\s*["']?(?:light|day)["']?\s*\])`;
// A root-like compound that ends in the light class: `:root[data-mode="light"]`, `html.light`, `.light`.
const LIGHT_ROOT = new RegExp(
    String.raw`^(?:html|body|:root|\*|:host)?(?:${LIGHT_PART})+(?::root)?$`,
    "i",
);
// A root-like element under the dark class: `[data-bs-theme=dark] body`, `.dark :root`.
const DARK_DESC = new RegExp(
    String.raw`^(?:html|body|:root|\*|:host)?(?:${DARK_PART})+\s+(?:body|html|:root|\*|main|#root|#app|\.app|\.App)$`,
    "i",
);
// What a custom property on the default scope is set on.
const ROOT_ONLY =
    /^(?:html|body|:root|\*|:host|#root|#app|#__next|\.app|\.theme|main)(?:\[data-(?:bs-)?(?:theme|mode)\])*$|^\[data-(?:bs-)?(?:theme|mode|color-scheme)\]$/i;
const ROOT_ANY = /^(?:html|body|:root|\*|:host)(?:\s*:not\([^)]*\))?$/i;

/** Whether a selector, anywhere in it, selects the dark theme. */
export const isDarkSelector = (selector: string) => DARK_ANY.test(selector);

/** The scope of one selector of the rule: dark, light (explicitly), the default, or none of them. */
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

/**
 * The scope of the rule for a custom property: which mode its values belong to. A rule for `:root, [data-theme=light]`
 * is the default; `.dark` is dark; `:root[data-mode="light"]` is light (the mode of a dark-first project).
 */
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

/** Whether a name is made of mode words for the dark mode (`dark`, `dark-mode`, `on-dark`, `theme-dark`, `night`). */
function isDarkWords(name: string): boolean {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => word === "dark" || word === "night");
}

/**
 * `@include dark { … }`, `@include dark-mode { … }`, `@include theme(dark) { … }`, `@include <a mixin that wraps the dark
 * mode> { … }`, and an `@if $theme == dark { … }` block hold the dark mode's rules.
 */
function isDarkInclude(prelude: string, darkMixins: ReadonlySet<string>): boolean {
    const include = /^@include\s+([\w.-]+)\s*(?:\(([^)]*)\))?/i.exec(prelude);

    if (include !== null) {
        const name = include[1]!.replace(/^.*\./, "");

        return (
            darkMixins.has(name) ||
            isDarkWords(name) ||
            /(?:^|[\s,(:])['"]?(?:dark|night)['"]?(?:$|[\s,)])/i.test(include[2] ?? "")
        );
    }

    return /^@(?:else\s+)?if\b[^{]*(?:==|=)\s*['"]?(?:dark|night)['"]?\s*$/i.test(prelude);
}

/**
 * The Sass mixins of a text that hold the dark mode: one that wraps its `@content` in the dark mode
 * (`@mixin dark { @media (prefers-color-scheme: dark) { @content } }`, `.theme-dark & { @content }`), or one called dark.
 * `@include dark { … }` is then the dark mode.
 */
export function darkMixinsIn(text: string): Set<string> {
    const darkMixins = new Set<string>();

    for (const match of text.matchAll(/@mixin\s+([\w-]+)\s*(?:\([^)]*\))?\s*\{/g)) {
        // The mixin's own text: up to the next mixin, and at most 600 characters.
        const body = text
            .slice(match.index + match[0].length, match.index + match[0].length + 600)
            .split("@mixin")[0]!;
        const wrapper = body.split("@content")[0]!;

        if (
            isDarkWords(match[1]!) ||
            (body.includes("@content") &&
                (/prefers-color-scheme\s*:\s*dark/i.test(wrapper) || isDarkSelector(wrapper)))
        ) {
            darkMixins.add(match[1]!);
        }
    }

    return darkMixins;
}

const MAX_DECLS = 30_000;
const MAX_DEPTH = 24;

/**
 * Indented Sass (`.sass`) and Stylus (`.styl`) as braces and semicolons, one output line for each input line (so a line
 * number stays the file's): a line with deeper lines under it opens a block, any other line is a declaration. `$x: 1` and
 * `x = 1` are variables; `=name` and `+name` are `@mixin` and `@include`; Stylus' `prop value` has no colon.
 */
export function indentedToBraces(source: string): string {
    const lines = source.split("\n").slice(0, 20_000);
    const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;
    const blank = (line: string) => line.trim() === "" || /^\s*\/\//.test(line);
    const stack: number[] = [];
    const out: string[] = [];

    for (const [at, line] of lines.entries()) {
        if (blank(line)) {
            out.push("");

            continue;
        }

        const indent = indentOf(line);
        let closing = "";

        while (stack.length > 0 && stack.at(-1)! >= indent) {
            stack.pop();
            closing += "} ";
        }

        const next = lines.slice(at + 1).find((each) => !blank(each));
        const opens = next !== undefined && indentOf(next) > indent;
        let text = line.trim().replace(/;\s*$/, "");

        if (opens) {
            text = text
                .replace(/^=\s*/, "@mixin ")
                .replace(/^\+\s*/, "@include ")
                .replace(/\s+\/\/.*$/, "");
            out.push(`${closing}${text} {`);
            stack.push(indent);

            continue;
        }

        text = text
            .replace(/\s+\/\/.*$/, "")
            .replace(/^=\s*/, "@mixin ")
            .replace(/^\+\s*/, "@include ");

        // `x = 1` (Stylus) is a variable; `:prop value` (indented Sass) and `prop value` (Stylus) are declarations.
        const variable = /^(\$?[\w-]+)\s*[?:]?=\s*(.+)$/.exec(text);
        const colonFirst = /^:([\w-]+)\s+(.+)$/.exec(text);
        const spaced = /^([a-z][a-z-]*)\s+([^:{}][^{}]*)$/.exec(text);

        if (variable !== null) {
            text = `${variable[1]!.startsWith("$") ? variable[1] : `$${variable[1]}`}: ${variable[2]}`;
        } else if (colonFirst !== null) {
            text = `${colonFirst[1]}: ${colonFirst[2]}`;
        } else if (
            spaced !== null &&
            !text.startsWith("@") &&
            !/^(?:if|else|for|return|unless)\b/.test(text)
        ) {
            text = `${spaced[1]}: ${spaced[2]}`;
        }

        out.push(`${closing}${text};`);
    }

    out[out.length - 1] = `${out.at(-1) ?? ""}${" }".repeat(stack.length)}`;

    return out.join("\n");
}

/** Strips comments, keeping line breaks. */
// A comment keeps its line breaks, so that a line counted after it is the file's line; one line of it is a space.
export const stripComments = (text: string) =>
    text.replace(COMMENTS, (comment) => comment.replace(/[^\n]+/g, "").replace(/^$/, " "));

/**
 * Reads CSS, SCSS, or Less into declarations. It tracks blocks, strings, parentheses (a `;` inside `url(data:…;base64)`
 * does not end a declaration), and SCSS `#{…}`. Variables (`$x: 1`, `@x: 1`) come back as declarations with that prop.
 * Statements that are not declarations (`@import "x";`) are skipped.
 */
export function parseStyles(
    source: string,
    firstLine: number | undefined = 1,
    known?: ReadonlySet<string>,
): Decl[] {
    const text = stripComments(source);
    // The line of an index: the number of line breaks before it.
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
    const darkMixins = new Set([...darkMixinsIn(text), ...(known ?? [])]);
    const decls: Decl[] = [];
    // One entry per open block: its prelude, and the selector it resolves to.
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

        // `prop: value`, `--prop: value`, `$var: value`, `@var: value` (Less). A selector or an at-rule is not one.
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
                isDarkInclude(part, darkMixins),
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
            // A string: copy it whole, so its braces and semicolons mean nothing.
            let end = at + 1;

            while (end < text.length && text[end] !== char && text[end] !== "\n") {
                end += text[end] === "\\" ? 2 : 1;
            }

            buffer += text.slice(at, end + 1);
            at = end;
        } else if (char === "#" && text[at + 1] === "{") {
            // SCSS interpolation `#{…}`.
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

/** The `<style>` blocks of a page, and the `style="…"` attributes as inline declarations. */
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

/** CSS-in-JS: the text of `css`, `styled.x`, `styled(X)`, `createGlobalStyle`, and `injectGlobal` template literals. */
export function templateStyles(source: string): string[] {
    const found: string[] = [];
    const head =
        /(?<![\w$.])(?:css|styled(?:\.[a-z][\w]*|\([^)\n]{1,60}\))(?:\.attrs\([^)\n]{0,200}\))?|createGlobalStyle|injectGlobal|keyframes|styles\s*:\s*\[?)\s*`/g;

    for (const match of source.matchAll(head)) {
        if (found.length >= 400) {
            break;
        }

        const start = match.index + match[0].length;
        let end = start;

        while (end < source.length && source[end] !== "`") {
            end += source[end] === "\\" ? 2 : 1;
        }

        // `${…}` holds code: a value we cannot know.
        const block = source
            .slice(start, Math.min(end, start + 20_000))
            .replace(/\$\{[^}]*\}/g, "var(--js)");

        if (block.trim() !== "") {
            found.push(block);
        }
    }

    return found;
}

/** The CSS properties that a JSX style object or a CSS-in-JS object may set, as camelCase. */
const STYLE_KEYS =
    /\b(color|background|backgroundColor|borderColor|border|borderTop|borderBottom|borderLeft|borderRight|outlineColor|outline|fill|stroke|fontFamily|fontSize|fontWeight|lineHeight|letterSpacing|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingHorizontal|paddingVertical|margin|marginTop|marginBottom|marginLeft|marginRight|marginHorizontal|marginVertical|gap|rowGap|columnGap|borderRadius|boxShadow|textShadow|transition|animation)\s*:\s*(?:(["'`])((?:\\.|(?!\2)[^\\\n]){1,200})\2|(-?\d+(?:\.\d+)?)(?![\w.]))/g;

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
// A bare number is pixels for these; for the rest it is unitless or not a length.
const PIXEL_KEYS = new Set([
    "fontSize",
    "padding",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "paddingHorizontal",
    "paddingVertical",
    "margin",
    "marginTop",
    "marginBottom",
    "marginLeft",
    "marginRight",
    "marginHorizontal",
    "marginVertical",
    "gap",
    "rowGap",
    "columnGap",
    "borderRadius",
    "letterSpacing",
]);

/** The key of the object that an index sits in (`card` for `card: { padding: 8 }`), looking back at most 2,000 characters. */
function enclosingKey(source: string, index: number): string | undefined {
    let depth = 0;

    for (let at = index - 1; at >= Math.max(0, index - 2000); at--) {
        const char = source[at];

        if (char === "}") {
            depth += 1;
        } else if (char === "{") {
            if (depth === 0) {
                return /([A-Za-z_$][\w$]*)\s*(?::|=)\s*(?:\w+\.create\(\s*)?$/.exec(
                    source.slice(Math.max(0, at - 80), at),
                )?.[1];
            }

            depth -= 1;
        }
    }

    return undefined;
}

/** Style objects in JavaScript: `{ backgroundColor: "#fff", padding: 8 }` as inline declarations. */
export function objectStyles(source: string): Decl[] {
    const decls: Decl[] = [];
    // Material UI's `sx` takes numbers as steps of the theme (`p: 2` is two spacings), not as pixels.
    const themed = /\bsx\s*=\s*\{/.test(source);

    for (const match of source.matchAll(STYLE_KEYS)) {
        if (decls.length >= 5000) {
            break;
        }

        const key = match[1]!;

        if (match[3] === undefined && themed && PIXEL_KEYS.has(key)) {
            continue;
        }

        const value = match[3] ?? (PIXEL_KEYS.has(key) ? `${match[4]!}px` : match[4]!);
        // The style's own name (`styles.container`, `card: {…}`) says what it paints.
        const owner = enclosingKey(source, match.index);

        decls.push({
            // React Native's `paddingHorizontal` is CSS's `padding-inline`.
            prop: kebab(key)
                .replace(/-horizontal$/, "-inline")
                .replace(/-vertical$/, "-block"),
            value: value.trim().slice(0, MAX_VALUE),
            selector: owner === undefined ? "" : `.${owner}`,
            at: [],
            scope: "default",
            theme: false,
            inline: true,
        });
    }

    // React Native shadows are four properties, not a `box-shadow`: `shadowOffset`, `shadowRadius`, `shadowOpacity`,
    // `shadowColor` of one object make one.
    for (const match of source.matchAll(/\bshadowRadius\s*:\s*(\d+(?:\.\d+)?)/g)) {
        if (decls.length >= 5000) {
            break;
        }

        const around = source.slice(Math.max(0, match.index - 300), match.index + 300);
        const height = /\bheight\s*:\s*(-?\d+(?:\.\d+)?)/.exec(around)?.[1] ?? "0";
        const width = /\bwidth\s*:\s*(-?\d+(?:\.\d+)?)/.exec(around)?.[1] ?? "0";
        const opacity = /\bshadowOpacity\s*:\s*(\d*\.?\d+)/.exec(around)?.[1] ?? "0.25";
        const color = /\bshadowColor\s*:\s*(["'])(#[0-9a-fA-F]{3,8}|[a-z]+)\1/.exec(around)?.[2];
        const rgb = color === undefined ? undefined : colorsIn(color, true)[0];

        if (rgb !== undefined) {
            const hex = rgb.hex.slice(1, 7);
            const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16);

            decls.push({
                prop: "box-shadow",
                value: `${width}px ${height}px ${match[1]}px rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${opacity})`,
                selector: "",
                at: [],
                scope: "default",
                theme: false,
                inline: true,
            });
        }
    }

    return decls;
}

// --- JavaScript object literals -------------------------------------------------------------------------------------

/** A value the literal reader could not read (a call, a variable, a spread). */
export const UNKNOWN = Symbol("unknown");

export type Literal =
    string | number | boolean | null | typeof UNKNOWN | Literal[] | { [key: string]: Literal };

/**
 * Reads one JavaScript object or array literal that starts at `start` (a `{` or `[`), without running anything. Keys may
 * be bare or quoted; values may be strings, numbers, nested literals, or something it cannot know (then `UNKNOWN`, and
 * it skips to the next comma). Bounded by depth and node count. Returns undefined if `start` is not a literal.
 */
export function readLiteral(
    text: string,
    start: number,
    env: ReadonlyMap<string, Literal> = new Map(),
): Literal | undefined {
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

    // Skips an expression we cannot read, to the next comma or closing bracket at its own level.
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

            while (at < text.length) {
                skip();

                if (text[at] === "}") {
                    at += 1;

                    break;
                }

                if (text[at] === ",") {
                    at += 1;

                    continue;
                }

                // `...shared` or `...shared.token`: the keys of an object that the file declares above.
                if (text.startsWith("...", at)) {
                    const named =
                        /^\.\.\.\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})\s*(?=[,}\n])/.exec(
                            text.slice(at, at + 120),
                        );
                    let spread: Literal | undefined;

                    if (named !== null) {
                        const parts = named[1]!.split(".");

                        spread = env.get(parts[0]!);

                        for (const part of parts.slice(1)) {
                            spread =
                                typeof spread === "object" &&
                                spread !== null &&
                                !Array.isArray(spread)
                                    ? spread[part]
                                    : undefined;
                        }
                    }

                    if (
                        named !== null &&
                        typeof spread === "object" &&
                        spread !== null &&
                        !Array.isArray(spread)
                    ) {
                        for (const [name, child] of Object.entries(spread)) {
                            if (name !== "__proto__" && name !== "constructor") {
                                out[name] = child;
                            }
                        }

                        at += named[0].length;

                        continue;
                    }

                    skipValue();

                    continue;
                }

                // A computed key: skip it.
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
                } else if ((text[at] === "," || text[at] === "}") && env.has(key)) {
                    // `{ brand, gray }`: the objects that the file declares above.
                    out[key] = env.get(key)!;
                } else {
                    // `{ shorthand }` or a method: not a value we can read.
                    skipValue();
                }
            }

            return out;
        }

        if (char === "[") {
            at += 1;

            const out: Literal[] = [];

            while (at < text.length) {
                skip();

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
            // A template with code in it: skip to the end of the value.
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

        // `key: brand`: an object that the file declares above.
        const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(at, at + 80));

        if (name !== null && env.has(name[0])) {
            const here = at;

            at += name[0].length;
            skip();

            if (text[at] === "," || text[at] === "}" || text[at] === "]") {
                return env.get(name[0])!;
            }

            at = here;
        }

        return skipValue();
    };

    skip();

    if (text[at] !== "{" && text[at] !== "[") {
        return undefined;
    }

    return value(0);
}

// --- Extractors -----------------------------------------------------------------------------------------------------

/**
 * A `#hex` that is a color, not an HTML entity (`&#123;`), a link or id (`href="#add"`, `url(#a)`), or a selector
 * (`#fab {`).
 */
const HEX =
    /(?<![&\w])(?<!(?:href|src|id|for)\s*=\s*["']?)(?<!url\(\s*["']?)#[0-9a-fA-F]{3,8}\b(?![\w-])(?!\s*[{.:[>+~])(?![^;{}"'`<>$]{0,200}\{)/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^()]*\)/gi;
const NAME_WORDS = new RegExp(
    String.raw`(?<![\w$@#.-])(${[...NAMED_COLORS.keys()].join("|")})(?![\w-])`,
    "gi",
);

export interface FoundColor {
    /** The color as written, trimmed (`#FFF`, `rgb(0 0 0 / .5)`). */
    text: string;
    /** `#rrggbb` or `#rrggbbaa`, the key for counting. */
    hex: string;
}

/**
 * The colors in a value: hex, functions, and (when `named`) color names used as a value. A name inside `url()`, a
 * string, or a function argument is not one.
 */
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
        // Remove what is not a plain value before looking for words.
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

/** A length in pixels, with its authored text: `1.5rem` is 24px at a 16px root. */
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

/** The whitespace-separated parts of a value, keeping what is inside parentheses together. */
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

/** The comma-separated parts of a value, at the top level (not inside parentheses or quotes). */
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
