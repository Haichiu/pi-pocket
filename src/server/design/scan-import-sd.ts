/**
 * Style Dictionary sources and other token folders (stream T): token JSON files in several folders, in the classic format
 * (`{ "color": { "base": { "red": { "value": "#f00" } } } }`, with `type`, `comment`, `attributes`, and references
 * `{color.base.red.value}` or `{color.base.red}`) or in the DTCG format (`$value`, `$type`). The files are merged in source
 * order, a later file over an earlier one, as Style Dictionary does: the order of the config's `source` globs when there is
 * a config, else the path. A folder named for a brand or a theme (`brands/acme/`, `themes/dark/`, `dark.json`) holds a
 * mode: the same paths with other values. Untyped classic tokens get their type from their category (`color`, `size`,
 * `font`, `time`...) and their value.
 */
import { parseColor } from "./color.ts";
import { isObject, type Obj } from "./scan-import-convert.ts";
import {
    DARK,
    type Entry,
    LIGHT,
    LIMITS,
    Mode,
    changesBetween,
    flatten,
    hasWord,
    segment,
    tokensOf,
} from "./scan-import-eval.ts";

/** One token file that was read. */
export interface SdFile {
    file: string;
    root: Obj;
}

/** What a Style Dictionary config says about its token files: the `source` and `include` globs, in order. */
export interface SdConfig {
    /** The folder of the config: its globs are relative to it, or to the project's root. */
    dir: string;
    include: string[];
    source: string[];
}

// --- The config -----------------------------------------------------------------------------------------------------------

/** A glob as a regular expression: `**`, `*`, `?`, and `{a,b}`. A glob with a template (`${brand}`) is not one. */
export function globToRegExp(glob: string): RegExp | undefined {
    // A template is not a glob, and many `**` make a pattern that is slow on a long path.
    if (/\$\{|\{\{|<%/.test(glob) || glob.length > 200 || (glob.match(/\*\*/g)?.length ?? 0) > 3) {
        return undefined;
    }

    let out = "";

    for (let at = 0; at < glob.length; at++) {
        const char = glob[at]!;

        if (char === "*") {
            if (glob[at + 1] === "*") {
                at += glob[at + 2] === "/" ? 2 : 1;
                out += "(?:.*/)?";
            } else {
                out += "[^/]*";
            }
        } else if (char === "?") {
            out += "[^/]";
        } else if (char === "{") {
            const close = glob.indexOf("}", at);

            if (close === -1) {
                return undefined;
            }

            out += `(?:${glob
                .slice(at + 1, close)
                .split(",")
                .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&"))
                .join("|")})`;
            at = close;
        } else {
            out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
        }
    }

    try {
        return new RegExp(`^${out}$`);
    } catch {
        return undefined;
    }
}

/** The strings of a list in a config: `["tokens/**\/*.json", 'brands/a/*.json']`. */
const stringsIn = (text: string) =>
    [...text.matchAll(/["'`]([^"'`\n]{1,200})["'`]/g)].map((match) => match[1]!).slice(0, 40);

/**
 * A Style Dictionary config in JavaScript or JSON text: its `source` and `include` lists. A config is a file that has
 * `platforms` and `source`; a list that is not written out (built in code) is not read.
 */
export function sdConfigIn(dir: string, text: string): SdConfig | undefined {
    if (!/\bplatforms\b/.test(text) || !/["']?\bsource\b["']?\s*:\s*\[/.test(text)) {
        return undefined;
    }

    const list = (name: string) => {
        const match = new RegExp(`["']?\\b${name}\\b["']?\\s*:\\s*\\[([^\\]]*)\\]`).exec(text);

        return match === null ? [] : stringsIn(match[1]!);
    };

    const source = list("source");

    return source.length === 0 ? undefined : { dir, include: list("include"), source };
}

// --- The files ------------------------------------------------------------------------------------------------------------

/** The folders whose children are modes: `brands/acme/`, `themes/dark/`. */
const MODE_FOLDER = /^(?:brands?|themes?|modes?|skins?|variants?|schemes?)$/i;

/** The mode a file belongs to, from its path: the folder under `brands/`, or a file named for the mode (`dark.json`). */
function modeOfFile(file: string): string | undefined {
    const parts = file.replace(/\.[^./]+$/, "").split("/");
    const at = parts.findIndex((part, index) => index < parts.length - 1 && MODE_FOLDER.test(part));

    if (at !== -1) {
        return segment(parts[at + 1]!).toLowerCase() || undefined;
    }

    // `tokens-dark.json`, `colors.dark.json`, `dark.json`: a mode word in the file's name.
    return hasWord(parts.at(-1)!, DARK) ? "dark" : undefined;
}

/** The type of an untyped classic token, from its category and its value; undefined when the engine has no type for it. */
function inferType(path: string[], value: unknown, node: Obj): string | undefined {
    const attributes = isObject(node.attributes) ? node.attributes : {};
    const category = String(attributes.category ?? path[0] ?? "").toLowerCase();
    const kind = String(attributes.type ?? "").toLowerCase();
    const where = [category, kind, ...path.map((part) => part.toLowerCase())].join(" ");
    const has = (pattern: RegExp) => pattern.test(where);
    const text = typeof value === "string" ? value.trim() : undefined;

    if (typeof value === "object" && value !== null) {
        return Array.isArray(value) && value.every((each) => typeof each === "string")
            ? "fontFamily"
            : has(/shadow|elevation/)
              ? "shadow"
              : has(/font|type|text/)
                ? "typography"
                : undefined;
    }

    if (text !== undefined && text.startsWith("{")) {
        return undefined;
    }

    if (has(/\b(?:colou?rs?|clr)\b/) && text !== undefined && parseColor(text) !== undefined) {
        return "color";
    }

    if (text !== undefined && has(/shadow|elevation/) && /\d/.test(text)) {
        return "shadow";
    }

    if (text !== undefined && /^-?\d*\.?\d+(?:px|rem|em|%|pt|vw|vh)$/i.test(text)) {
        return "dimension";
    }

    if (text !== undefined && /^\d*\.?\d+(?:ms|s)$/i.test(text)) {
        return "duration";
    }

    if (
        text !== undefined &&
        /^(?:#|rgba?\(|hsla?\(|oklch\()/i.test(text) &&
        parseColor(text) !== undefined
    ) {
        return "color";
    }

    const numeric = typeof value === "number" || (text !== undefined && /^-?\d*\.?\d+$/.test(text));

    if (has(/\bweight\b|font-weight/) && numeric) {
        return "fontWeight";
    }

    if (has(/\b(?:family|families|typeface)\b/) && text !== undefined) {
        return "fontFamily";
    }

    if (
        has(/\b(?:opacity|alpha|z|zindex|z-index|line-height|lineheight|leading|ratio|scale)\b/) &&
        numeric
    ) {
        return "number";
    }

    if (has(/\b(?:time|duration|delay|transition)\b/) && numeric) {
        return "duration";
    }

    if (
        has(
            /\b(?:size|sizes|spacing|space|spaces|radius|radii|rounded|dimension|dimensions|width|height|gap|gutter|breakpoint|breakpoints|tracking|letter-spacing|border-width|stroke)\b/,
        ) &&
        numeric
    ) {
        return "dimension";
    }

    if (
        has(/\b(?:easing|ease|timing|curve)\b/) &&
        text !== undefined &&
        /cubic-bezier|ease|linear/i.test(text)
    ) {
        return "cubicBezier";
    }

    return undefined;
}

/** The entries of one file, flat, with the type of an untyped token worked out. */
function entriesOf(root: Obj, budget: { left: number }): Map<string, Entry> {
    const entries = new Map<string, Entry>();

    flatten(root, entries, budget);

    for (const entry of entries.values()) {
        if (entry.type === undefined) {
            const raw = entry.node.$value ?? entry.node.value;
            const type = inferType(entry.path, raw, entry.node);

            if (type !== undefined) {
                entry.type = type;
            }
        }
    }

    return entries;
}

/** The files in the order Style Dictionary reads them: `include`, then `source`, each glob's files in path order. */
export function orderByConfig(files: SdFile[], config: SdConfig): SdFile[] | undefined {
    const ordered: SdFile[] = [];
    const seen = new Set<string>();
    const relative = (file: string, dir: string) =>
        dir === "" ? file : file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : undefined;

    for (const glob of [...config.include, ...config.source]) {
        const pattern = globToRegExp(glob.replace(/^\.\//, ""));

        if (pattern === undefined) {
            continue;
        }

        // Globs are written from the folder where Style Dictionary runs: the config's, or the project's.
        for (const base of config.dir === "" ? [""] : [config.dir, ""]) {
            const matched = files
                .filter((item) => {
                    const rel = relative(item.file, base);

                    return rel !== undefined && pattern.test(rel) && !seen.has(item.file);
                })
                .sort((a, b) => a.file.localeCompare(b.file));

            if (matched.length > 0) {
                matched.forEach((item) => seen.add(item.file));
                ordered.push(...matched);

                break;
            }
        }
    }

    return ordered.length > 0 ? ordered : undefined;
}

/** The tokens of a token folder: the default mode, the dark mode, other modes, how many there are, and what happened. */
export function styleDictionaryTokens(
    files: SdFile[],
    config?: SdConfig,
): { default: Obj; dark: Obj; extra: Record<string, Obj>; count: number; notes: string[] } {
    const notes: string[] = [];
    const ordered =
        (config === undefined ? undefined : orderByConfig(files, config)) ??
        [...files].sort((a, b) => a.file.localeCompare(b.file));
    const budget = { left: LIMITS.tokens };
    const base: SdFile[] = [];
    const modes = new Map<string, SdFile[]>();

    for (const item of ordered) {
        const mode = modeOfFile(item.file);

        if (mode === undefined) {
            base.push(item);
        } else {
            modes.set(mode, [...(modes.get(mode) ?? []), item]);
        }
    }

    const read = (list: SdFile[]) => {
        const entries = new Map<string, Entry>();

        for (const item of list) {
            entriesOf(item.root, budget).forEach((entry, key) => entries.set(key, entry));
        }

        return new Mode(entries);
    };

    // The default mode: every file that is for no mode, and the first mode that is light or the default, or the first.
    const names = [...modes.keys()];
    const lightName = names.find(
        (name) =>
            !hasWord(name, DARK) &&
            (hasWord(name, LIGHT) || /^(?:default|base|main|standard)$/.test(name)),
    );
    // A project whose only files are for a dark mode has that mode as its default.
    const firstName =
        lightName ??
        names.find((name) => !hasWord(name, DARK)) ??
        (base.length === 0 ? names[0] : undefined);
    const defaultFiles = [
        ...base,
        ...(firstName === undefined ? [] : (modes.get(firstName) ?? [])),
    ];
    const first = tokensOf(read(defaultFiles));
    const result = {
        default: first.tree,
        dark: {} as Obj,
        extra: {} as Record<string, Obj>,
        count: first.flat.size,
        notes,
    };

    if (names.length > 0) {
        notes.push(
            `Token folders: the default mode is ${[...(base.length > 0 ? ["the shared files"] : []), ...(firstName === undefined ? [] : [firstName])].join(" + ") || "none"}; modes found: ${names.join(", ")}.`,
        );
    }

    for (const name of names.filter((each) => each !== firstName).slice(0, 4)) {
        const second = tokensOf(read([...base, ...modes.get(name)!]));
        const { tree, skipped } = changesBetween(first.flat, second.flat);

        if (skipped > 0) {
            notes.push(`${skipped} tokens that only ${name} has were left out.`);
        }

        if (hasWord(name, DARK)) {
            result.dark = tree;
        } else {
            result.extra[name] = tree;
        }
    }

    return result;
}
