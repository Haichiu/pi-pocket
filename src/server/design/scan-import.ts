/**
 * Imports tokens that a project already keeps in a token file (stream T): W3C DTCG (`$value`), Style Dictionary
 * (`value`), and Tokens Studio (`value` and `type`, with `sizing`, `fontFamilies`, `boxShadow`...). The scan uses them
 * as they are: a project that has tokens does not need them guessed from its CSS.
 */
import { convert, isObject, type Obj } from "./scan-import-convert.ts";
import { looksLikeSets, studioTokens, type StudioSource } from "./scan-import-studio.ts";

/** A token file that was read: its path, what it parsed to, and whether its name says it holds tokens. */
interface Pending {
    file: string;
    root: unknown;
    named: boolean;
}

/** Tokens found in token files: the default mode, the dark mode, and how many there are. */
export interface Imported {
    default: Obj;
    dark: Obj;
    /** Other modes that a Tokens Studio file has (`high-contrast`), by name: the tokens that each changes. */
    extra: Record<string, Obj>;
    count: number;
    files: string[];
    /** A Tokens Studio file was read (it has `$themes` or `$metadata`): it is a token source, however few tokens it holds. */
    studio: boolean;
    /** Token files read and not yet sorted into modes (`finishImports` does that, once, when every file has been read). */
    pending: Pending[];
    /** What the Tokens Studio files said that the scan did not take (a theme that was not read). */
    notes: string[];
    done: boolean;
}

/** A file that may hold tokens: by its name, so `package.json` and `tsconfig.json` are never read as tokens. */
export const TOKEN_FILE =
    /(?:^|\/)(?:[^/]*tokens?[^/]*|theme[^/]*)\.json$|(?:^|\/)(?:design-)?tokens\/[^/]+\.json$|(?:^|\/)\$(?:themes|metadata)\.json$/i;

const MAX_FILES = 300;
/** `$themes.json` and `$metadata.json`, the two files that Tokens Studio writes beside its sets. */
const STUDIO_MARK = /(?:^|\/)\$(?:themes|metadata)\.json$/;
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

/** Whether a JSON root is one Tokens Studio file: it has `$themes` or `$metadata`, or sets named for light and dark. */
function isStudioFile(root: unknown): root is Obj {
    if (!isObject(root)) {
        return false;
    }

    if (Array.isArray(root.$themes) || isObject(root.$metadata)) {
        return true;
    }

    const keys = Object.keys(root).filter((key) => !key.startsWith("$"));

    return keys.length >= 2 && looksLikeSets(keys) && keys.every((key) => isObject(root[key]));
}

/** Reads a token file. It is kept until every file has been read: `finishImports` sorts the files into modes. */
export function importTokens(into: Imported, file: string, source: string): void {
    if (into.pending.length >= MAX_FILES || source.length > 2_000_000) {
        return;
    }

    let root: unknown;

    try {
        root = JSON.parse(source);
    } catch {
        return;
    }

    if (isObject(root) || (Array.isArray(root) && STUDIO_MARK.test(file))) {
        into.pending.push({ file, root, named: TOKEN_FILE.test(file) });
    }
}

/** One file of tokens, as one set: the default mode, or the dark mode when the file's name says dark. */
function singleFile(into: Imported, file: string, root: Obj): void {
    const target = /(?:^|[^a-z])dark(?:[^a-z]|$)/i.test(file.split("/").at(-1) ?? "")
        ? into.dark
        : into.default;
    let added = 0;

    const visit = (node: Obj, out: Obj, inherited: string | undefined, depth: number) => {
        const type =
            typeof node.$type === "string"
                ? node.$type
                : typeof node.type === "string" && !("value" in node) && !("$value" in node)
                  ? node.type
                  : inherited;

        for (const [key, child] of Object.entries(node)) {
            if (
                key.startsWith("$") ||
                key === "__proto__" ||
                key === "constructor" ||
                key === "prototype" ||
                !isObject(child) ||
                depth > 12 ||
                !/^[\w-]{1,64}$/.test(key)
            ) {
                continue;
            }

            if ("$value" in child || "value" in child) {
                const token = convert(child, type);

                if (token !== undefined && added < 5000) {
                    out[key] = token;
                    added += 1;
                }
            } else {
                const group: Obj = {};

                visit(child, group, type, depth + 1);

                if (Object.keys(group).length > 0) {
                    out[key] = group;
                }
            }
        }
    };

    visit(root, target, undefined, 0);

    if (added > 0) {
        into.count += added;
        into.files.push(file);
    }
}

/** A group of the default tree that a later source adds to (a path that is there stays as it is). */
function addTo(target: Obj, source: Obj): void {
    for (const [key, value] of Object.entries(source)) {
        const have = target[key];

        if (!(key in target)) {
            target[key] = value;
        } else if (
            isObject(have) &&
            isObject(value) &&
            !("$value" in have) &&
            !("$value" in value)
        ) {
            addTo(have, value);
        }
    }
}

/** Adds what a Tokens Studio source holds to the imported tokens. */
function addStudio(into: Imported, source: StudioSource, files: string[]): void {
    const found = studioTokens(source);

    if (found.count === 0) {
        return;
    }

    into.studio = true;
    addTo(into.default, found.default);
    addTo(into.dark, found.dark);

    for (const [mode, tree] of Object.entries(found.extra)) {
        into.extra[mode] ??= {};
        addTo(into.extra[mode]!, tree);
    }

    into.count += found.count;
    into.files.push(...files);
    into.notes.push(...found.notes);
}

/**
 * Sorts the token files that were read into modes, once every file is in. A Tokens Studio file (token sets as top-level
 * keys, with `$themes` or `$metadata`), or a folder of them (`$themes.json`, `$metadata.json`, and a file for each
 * set), is read set by set, and the modes come from its themes. Any other token file is one set, as it was written.
 */
export function finishImports(into: Imported): void {
    if (into.done) {
        return;
    }

    into.done = true;

    const pending = into.pending;
    const taken = new Set<Pending>();
    const marks = new Map<string, { themes?: unknown[]; order?: string[] }>();

    for (const item of pending) {
        if (!STUDIO_MARK.test(item.file)) {
            continue;
        }

        const mark = marks.get(dirOf(item.file)) ?? {};

        if (item.file.endsWith("$themes.json") && Array.isArray(item.root)) {
            mark.themes = item.root;
        } else if (item.file.endsWith("$metadata.json") && isObject(item.root)) {
            mark.order = Array.isArray(item.root.tokenSetOrder)
                ? item.root.tokenSetOrder.filter((name): name is string => typeof name === "string")
                : [];
        }

        marks.set(dirOf(item.file), mark);
        taken.add(item);
    }

    // A folder of Tokens Studio files: each other file under it is a set, named by its path without `.json`.
    for (const [dir, mark] of marks) {
        const sets = new Map<string, Obj>();
        const files: string[] = [];

        for (const item of pending) {
            if (
                taken.has(item) ||
                !isObject(item.root) ||
                !item.file.endsWith(".json") ||
                !(dir === "" || item.file.startsWith(`${dir}/`))
            ) {
                continue;
            }

            const name = (dir === "" ? item.file : item.file.slice(dir.length + 1)).replace(
                /\.json$/,
                "",
            );

            sets.set(name, item.root);
            files.push(item.file);
            taken.add(item);
        }

        if (sets.size > 0) {
            addStudio(into, { sets, order: mark.order ?? [], themes: mark.themes ?? [] }, files);
        }
    }

    for (const item of pending) {
        if (taken.has(item) || !isObject(item.root)) {
            continue;
        }

        if (isStudioFile(item.root)) {
            const sets = new Map<string, Obj>();

            for (const [name, node] of Object.entries(item.root)) {
                if (!name.startsWith("$") && isObject(node) && sets.size < 40) {
                    sets.set(name, node);
                }
            }

            const metadata = item.root.$metadata;
            const order =
                isObject(metadata) && Array.isArray(metadata.tokenSetOrder)
                    ? metadata.tokenSetOrder.filter(
                          (name): name is string => typeof name === "string",
                      )
                    : [];

            addStudio(
                into,
                {
                    sets,
                    order,
                    themes: Array.isArray(item.root.$themes) ? item.root.$themes : [],
                },
                [item.file],
            );
        } else if (item.named) {
            singleFile(into, item.file, item.root);
        }
    }

    into.pending = [];
}
