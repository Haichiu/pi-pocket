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
import { type SdConfig, sdConfigsIn } from "./scan-import-sd-config.ts";
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

// --- The config -----------------------------------------------------------------------------------------------------------

/** A glob's matcher: `**`, `*`, `?`, and `{a,b}`. A glob with a template (`${brand}`) is not one. */
export function globToRegExp(glob: string): { test: (path: string) => boolean } | undefined {
    // A template is not a glob, and many `**` make a pattern that is slow on a long path.
    if (/\$\{|\{\{|<%/.test(glob) || glob.length > 200 || (glob.match(/\*\*/g)?.length ?? 0) > 3) {
        return undefined;
    }

    // Braces become one glob for each choice (a bounded number), so that each glob is a plain sequence.
    let globs = [glob];

    while (globs.some((each) => each.includes("{"))) {
        const out: string[] = [];

        for (const each of globs) {
            const open = each.indexOf("{");
            const close = each.indexOf("}", open);
            const inner = each.slice(open + 1, close);

            if (open === -1) {
                out.push(each);
            } else if (close === -1 || inner.includes("{")) {
                return undefined;
            } else {
                out.push(
                    ...inner
                        .split(",")
                        .map((part) => each.slice(0, open) + part + each.slice(close + 1)),
                );
            }
        }

        if (out.length > 64) {
            return undefined;
        }

        globs = out;
    }

    // Each glob is a list of steps, matched by keeping the set of steps reached (no backtracking): the time grows with
    // the path's length times the glob's. "deep" is `**/` (any folders, or none), "deep-body" the folders it takes.
    const programs = globs.map((each) => {
        const steps: string[] = [];

        for (let at = 0; at < each.length; at++) {
            if (each[at] === "*" && each[at + 1] === "*") {
                at += each[at + 2] === "/" ? 2 : 1;
                steps.push("deep", "deep-body");
            } else {
                steps.push(each[at] === "*" ? "star" : each[at] === "?" ? "one" : `=${each[at]}`);
            }
        }

        return steps;
    });

    const run = (steps: string[], path: string) => {
        let now = new Uint8Array(steps.length + 1);
        let next = new Uint8Array(steps.length + 1);

        // The steps reached without a character: past a `*`, past `**/`, or into its folders.
        const close = (set: Uint8Array) => {
            for (let at = 0; at < steps.length; at++) {
                if (set[at] === 1 && steps[at] === "star") {
                    set[at + 1] = 1;
                } else if (set[at] === 1 && steps[at] === "deep") {
                    set[at + 1] = 1;
                    set[at + 2] = 1;
                }
            }
        };

        now[0] = 1;
        close(now);

        for (let index = 0; index < path.length; index++) {
            const char = path[index]!;

            next.fill(0);

            for (let at = 0; at < steps.length; at++) {
                const step = steps[at]!;

                if (now[at] === 0) {
                    continue;
                }

                if (step === `=${char}` || (step === "one" && char !== "/")) {
                    next[at + 1] = 1;
                } else if (step === "star" && char !== "/") {
                    next[at] = 1;
                } else if (step === "deep-body") {
                    next[at] = 1;

                    if (char === "/") {
                        next[at + 1] = 1;
                    }
                }
            }

            close(next);
            [now, next] = [next, now];
        }

        return now[steps.length] === 1;
    };

    return { test: (path) => programs.some((steps) => run(steps, path)) };
}

/** The first Style Dictionary config in a config's text, or undefined (`sdConfigsIn` has all of them). */
export const sdConfigIn = (dir: string, text: string): SdConfig | undefined =>
    sdConfigsIn(dir, "", text)[0];

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
    // A number, a size, or a time is short: a long text is not tested as one (the tests take the square of its length).
    const short = text !== undefined && text.length <= 200;

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

    if (short && /^-?\d*\.?\d+(?:px|rem|em|%|pt|vw|vh)$/i.test(text!)) {
        return "dimension";
    }

    if (short && /^\d*\.?\d+(?:ms|s)$/i.test(text!)) {
        return "duration";
    }

    if (
        text !== undefined &&
        /^(?:#|rgba?\(|hsla?\(|oklch\()/i.test(text) &&
        parseColor(text) !== undefined
    ) {
        return "color";
    }

    const numeric = typeof value === "number" || (short && /^-?\d*\.?\d+$/.test(text!));

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

/** The config that builds the default mode: one that names no mode, else the light one, else the first. */
function baseOf(configs: SdConfig[]): SdConfig | undefined {
    return (
        configs.find((config) => config.mode === undefined) ??
        configs.find((config) => config.mode !== undefined && hasWord(config.mode, LIGHT)) ??
        configs[0]
    );
}

/**
 * The files that a mode config reads: the base config's files under it, then its own (`include` and `source`), each in
 * the config's order. A file of another mode's folder is left out.
 */
function filesOfMode(files: SdFile[], config: SdConfig, base: SdFile[]): SdFile[] {
    const own = orderByConfig(files, config) ?? [];
    const have = new Set(own.map((item) => item.file));

    const fits = (item: SdFile) => {
        const mode = modeOfFile(item.file);

        return (
            mode === undefined ||
            mode === config.mode ||
            (hasWord(mode, DARK) && hasWord(config.mode ?? "", DARK))
        );
    };

    return [...base.filter((item) => !have.has(item.file)), ...own].filter(fits);
}

/** The tokens of a token folder: the default mode, the dark mode, other modes, how many there are, and what happened. */
export function styleDictionaryTokens(
    files: SdFile[],
    configs: SdConfig[] = [],
): { default: Obj; dark: Obj; extra: Record<string, Obj>; count: number; notes: string[] } {
    const notes: string[] = [];
    const baseConfig = baseOf(configs);
    const ordered =
        (baseConfig === undefined ? undefined : orderByConfig(files, baseConfig)) ??
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

    const addMode = (name: string, list: SdFile[]) => {
        const second = tokensOf(read(list));
        const { tree, skipped } = changesBetween(first.flat, second.flat);

        if (skipped > 0) {
            notes.push(`${skipped} tokens that only ${name} has were left out.`);
        }

        if (hasWord(name, DARK)) {
            result.dark = tree;
        } else {
            result.extra[name] = tree;
        }
    };

    for (const name of names.filter((each) => each !== firstName).slice(0, 4)) {
        addMode(name, [...base, ...modes.get(name)!]);
    }

    // A config for a mode (`config.dark.json`): the base config's files, with its own `source` over them.
    const done = new Set([firstName, ...names]);
    const fromConfigs = configs
        .filter(
            (config) =>
                config !== baseConfig && config.mode !== undefined && !done.has(config.mode),
        )
        .slice(0, 4);

    for (const config of fromConfigs) {
        done.add(config.mode);
        addMode(config.mode!, filesOfMode(files, config, ordered));
    }

    if (fromConfigs.length > 0) {
        notes.push(
            `Style Dictionary configs for modes: ${fromConfigs.map((config) => config.mode).join(", ")} (each one's source over the base config's).`,
        );
    }

    return result;
}
