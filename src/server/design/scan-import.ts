import { parseColor } from "./color.ts";
import { isObject, type Obj } from "./scan-import-convert.ts";
import {
    changesBetween,
    DARK,
    type Entry,
    flatten,
    hasWord,
    LIGHT,
    LIMITS,
    Mode,
    segment,
    tokensOf,
    words,
} from "./scan-import-eval.ts";

interface Pending {
    file: string;
    root: unknown;
    named: boolean;
}

export interface Imported {
    default: Obj;
    dark: Obj;
    extra: Record<string, Obj>;
    count: number;
    files: string[];
    /** A Tokens Studio source was read: it is one for sure, however few tokens it holds. */
    certain: boolean;
    /** Token files read and not yet sorted into modes (`finishImports` does that, once, when every file has been read). */
    pending: Pending[];
    notes: string[];
    done: boolean;
}

/** A file that may hold tokens: by its name, so `package.json` and `tsconfig.json` are never read as tokens. */
const TOKEN_FILE =
    /(?:^|\/)(?:[^/]*tokens?[^/]*|[^/]*theme[^/]*)\.json$|(?:^|\/)(?:design-?tokens?|tokens?|properties|brands?|themes?|style-?dictionary|dictionary)\/(?:[^/]+\/)*[^/]+\.json$|(?:^|\/)\$(?:themes|metadata)\.json$/i;

const MAX_FILES = 300;
const STUDIO_MARK = /(?:^|\/)\$(?:themes|metadata)\.json$/;
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

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

interface StudioSource {
    sets: Map<string, Obj>;
    order: string[];
    themes: unknown[];
}

interface Found {
    default: Obj;
    dark: Obj;
    extra: Record<string, Obj>;
    count: number;
    notes: string[];
}

function addStudio(into: Imported, source: StudioSource, files: string[]): void {
    const found = studioTokens(source);

    if (found.count === 0) {
        return;
    }

    into.certain = true;
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
            taken.add(item);

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
        }
    }

    const files = pending
        .filter((item) => !taken.has(item) && isObject(item.root) && item.named)
        .map((item) => ({ file: item.file, root: item.root as Obj }));

    if (files.length > 0) {
        const found = styleDictionaryTokens(files);

        if (found.count > 0) {
            addTo(into.default, found.default);
            addTo(into.dark, found.dark);

            for (const [mode, tree] of Object.entries(found.extra)) {
                into.extra[mode] ??= {};
                addTo(into.extra[mode]!, tree);
            }

            into.count +=
                found.count +
                leavesIn(found.dark) +
                Object.values(found.extra).reduce((sum, tree) => sum + leavesIn(tree), 0);
            into.files.push(...files.map((item) => item.file).sort());
            into.notes.push(...found.notes);
        }
    }

    into.pending = [];
}

function leavesIn(tree: Obj): number {
    return Object.entries(tree).reduce(
        (sum, [key, child]) =>
            sum +
            (key.startsWith("$") || !isObject(child) ? 0 : "$value" in child ? 1 : leavesIn(child)),
        0,
    );
}

const looksLikeSets = (keys: string[]) =>
    keys.some((key) => hasWord(key, DARK) || hasWord(key, LIGHT));

interface Theme {
    name: string;
    group?: string;
    enabled: string[];
    source: string[];
}

function themesOf(themes: unknown[]): Theme[] {
    const out: Theme[] = [];

    for (const item of themes.slice(0, 40)) {
        if (!isObject(item) || !isObject(item.selectedTokenSets)) {
            continue;
        }

        const on = (status: string) =>
            Object.entries(item.selectedTokenSets as Obj)
                .filter(([, value]) => value === status || (status === "enabled" && value === true))
                .map(([name]) => name);

        out.push({
            name: String(item.name ?? item.id ?? "").slice(0, 60),
            ...(typeof item.group === "string" ? { group: item.group.slice(0, 60) } : {}),
            enabled: on("enabled"),
            source: on("source"),
        });
    }

    return out;
}

function pickModes(
    themes: Theme[],
    names: string[],
    notes: string[],
): { light: string[]; dark: string[] | undefined; extra: [string, string[]][] } {
    const order = (list: string[]) => names.filter((name) => list.includes(name));
    const setsOf = (list: Theme[]) =>
        order(list.flatMap((theme) => [...theme.source, ...theme.enabled]));
    const isDarkTheme = (theme: Theme) =>
        hasWord(theme.name, DARK) || theme.enabled.some((name) => hasWord(name, DARK));
    const stem = (theme: Theme) =>
        words(theme.name)
            .filter((word) => !DARK.has(word) && !LIGHT.has(word))
            .join(" ");
    const darkSets = names.filter((name) => hasWord(name, DARK));
    const lightSets = names.filter((name) => !hasWord(name, DARK) && hasWord(name, LIGHT));
    const baseSets = names.filter((name) => !hasWord(name, DARK) && !hasWord(name, LIGHT));
    let light: string[] | undefined;
    let dark: string[] | undefined;
    const extra: [string, string[]][] = [];

    if (themes.length > 0) {
        // Themes of different groups apply together (a mode group and a brand group): the first of each other group is
        // part of every mode, and the mode group gives the light theme and the dark one.
        const groups = new Map<string, Theme[]>();

        for (const theme of themes) {
            const key = theme.group ?? "";

            groups.set(key, [...(groups.get(key) ?? []), theme]);
        }

        const modeList =
            [...groups.values()].find((list) => list.some(isDarkTheme)) ?? [...groups.values()][0]!;
        const others = [...groups.values()]
            .filter((list) => list !== modeList)
            .map((list) => list[0]!);
        const lightTheme =
            modeList.find((theme) => !isDarkTheme(theme) && hasWord(theme.name, LIGHT)) ??
            modeList.find((theme) => !isDarkTheme(theme));
        const darkTheme =
            modeList.find(
                (theme) =>
                    isDarkTheme(theme) &&
                    lightTheme !== undefined &&
                    stem(theme) === stem(lightTheme),
            ) ?? modeList.find(isDarkTheme);

        if (lightTheme !== undefined) {
            light = setsOf([...others, lightTheme]);
        }

        if (darkTheme !== undefined) {
            dark = setsOf([...others, darkTheme]);
        }

        const spare =
            lightTheme === undefined
                ? []
                : modeList.filter((theme) => theme !== lightTheme && theme !== darkTheme);
        const modeOf = (theme: Theme) => words(theme.name).join("-");
        const used: Theme[] = [];

        for (const theme of spare.slice(0, 3)) {
            const mode = modeOf(theme);

            if (
                /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mode) &&
                mode !== "dark" &&
                mode !== "light" &&
                !extra.some(([name]) => name === mode)
            ) {
                extra.push([mode, setsOf([...others, theme])]);
                used.push(theme);
            }
        }

        const read = [...others, lightTheme, darkTheme, ...used].filter(
            (theme): theme is Theme => theme !== undefined,
        );

        if (read.length < themes.length) {
            notes.push(
                `Tokens Studio has ${themes.length} themes (${themes.map((theme) => theme.name).join(", ")}); the scan reads ${read.map((theme) => theme.name).join(", ")}.`,
            );
        }
    }

    if (light === undefined && dark === undefined) {
        light = darkSets.length > 0 ? [...baseSets, ...lightSets] : names;
        dark = darkSets.length > 0 ? [...baseSets, ...darkSets] : undefined;
    } else if (light === undefined) {
        light = dark;
        dark = undefined;
    } else if (dark === undefined && darkSets.length > 0) {
        dark = [
            ...light.filter((name) => !hasWord(name, LIGHT)),
            ...darkSets.filter((name) => !light!.includes(name)),
        ];
    }

    return { light: light ?? [], dark, extra };
}

function studioTokens(input: StudioSource): Found {
    const notes: string[] = [];
    const names = [
        ...input.order.filter((name) => input.sets.has(name)),
        ...[...input.sets.keys()].filter((name) => !input.order.includes(name)),
    ].slice(0, LIMITS.sets);
    const { light, dark, extra } = pickModes(themesOf(input.themes), names, notes);

    notes.push(
        `Tokens Studio sets: the default mode is ${light.join(" + ") || "none"}${dark === undefined ? "" : `; the dark mode is ${dark.join(" + ")}`}${extra.map(([mode, sets]) => `; ${mode} is ${sets.join(" + ")}`).join("")}.`,
    );

    const budget = { left: LIMITS.tokens };

    const read = (list: string[]) => {
        const entries = new Map<string, Entry>();

        for (const name of list) {
            const set = new Map<string, Entry>();

            flatten(input.sets.get(name)!, set, budget);
            set.forEach((entry, key) => entries.set(key, entry));
        }

        return new Mode(entries);
    };

    const first = tokensOf(read(light));
    const result = {
        default: first.tree,
        dark: {} as Obj,
        extra: {} as Record<string, Obj>,
        count: first.flat.size,
        notes,
    };

    const changes = (sets: string[], label: string): Obj => {
        const { tree, skipped } = changesBetween(first.flat, tokensOf(read(sets)).flat);

        if (skipped > 0) {
            notes.push(`${skipped} tokens that only the ${label} mode has were left out.`);
        }

        return tree;
    };

    if (dark !== undefined && dark.join("\n") !== light.join("\n")) {
        result.dark = changes(dark, "dark");
    }

    for (const [mode, sets] of extra) {
        result.extra[mode] = changes(sets, mode);
    }

    return result;
}

interface SdFile {
    file: string;
    root: Obj;
}

const MODE_FOLDER = /^(?:brands?|themes?|modes?|skins?|variants?|schemes?)$/i;

function modeOfFile(file: string): string | undefined {
    const parts = file.replace(/\.[^./]+$/, "").split("/");
    const at = parts.findIndex((part, index) => index < parts.length - 1 && MODE_FOLDER.test(part));

    if (at !== -1) {
        return segment(parts[at + 1]!).toLowerCase() || undefined;
    }

    return hasWord(parts.at(-1)!, DARK) ? "dark" : undefined;
}

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

function styleDictionaryTokens(files: SdFile[]): Found {
    const notes: string[] = [];
    const ordered = [...files].sort((a, b) => a.file.localeCompare(b.file));
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

    const names = [...modes.keys()];
    const lightName = names.find(
        (name) =>
            !hasWord(name, DARK) &&
            (hasWord(name, LIGHT) || /^(?:default|base|main|standard)$/.test(name)),
    );
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

    return result;
}
