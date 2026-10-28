/**
 * Tokens Studio files (stream T): the Figma plugin's JSON. Token sets are the top-level keys (`global`, `light`, `dark`,
 * `brand/acme`), `$themes` says which sets each theme turns on (`enabled`, `source`, or `disabled`), and `$metadata` has
 * `tokenSetOrder`. A value is `value` and `type` in older files and `$value` and `$type` in newer ones; a reference is
 * `{color.primary}` (or `$color.primary` in the oldest), and a value may do math (`{spacing.base} * 2`, `round({x} / 4)`)
 * or modify a color (`$extensions["studio.tokens"].modify`).
 *
 * A mode is the sets that its theme turns on, in the order of `tokenSetOrder`, a later set over an earlier one. A theme
 * that turns on a dark set, or is named for dark, is the dark mode. Without themes, the sets named for dark are the dark
 * mode and the others are the default. References are followed across sets, math is evaluated, and what the engine
 * cannot hold (`text`, `asset`, `composition`) is left out.
 */
import { convert, isObject, type Obj } from "./scan-import-convert.ts";
import { mixColors, parseColor, type Rgba, toHex } from "./color.ts";

/** What one Tokens Studio source holds: the sets by name, their order, and the `$themes` array as read. */
export interface StudioSource {
    sets: Map<string, Obj>;
    order: string[];
    themes: unknown[];
}

const LIMITS = { sets: 40, tokens: 5000, depth: 12, refs: 24, text: 400 } as const;

/** A token of a set, with the type that its group gave it. */
interface Entry {
    path: string[];
    node: Obj;
    type: string | undefined;
}

const segment = (text: string) => text.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
const words = (text: string) =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== "");
const DARK = new Set(["dark", "night", "midnight", "black"]);
const LIGHT = new Set(["light", "day", "daylight"]);
const hasWord = (text: string, list: Set<string>) => words(text).some((word) => list.has(word));

/** Whether top-level keys are token sets: one of them is named for light or dark (`light`, `Mode/Dark`, `theme-dark`). */
export const looksLikeSets = (keys: string[]) =>
    keys.some((key) => hasWord(key, DARK) || hasWord(key, LIGHT));

/** The tokens of one set, flat, by dotted path. A group's `type` (or `$type`) goes to the tokens under it. */
function flatten(tree: Obj, into: Map<string, Entry>, budget: { left: number }): void {
    const visit = (node: Obj, path: string[], inherited: string | undefined, depth: number) => {
        const own =
            typeof node.$type === "string"
                ? node.$type
                : typeof node.type === "string" && !("value" in node) && !("$value" in node)
                  ? node.type
                  : inherited;

        for (const [rawKey, child] of Object.entries(node)) {
            const key = segment(rawKey);

            if (
                rawKey.startsWith("$") ||
                key === "" ||
                key === "__proto__" ||
                key === "constructor" ||
                key === "prototype" ||
                !isObject(child) ||
                depth > LIMITS.depth ||
                budget.left <= 0
            ) {
                continue;
            }

            if ("$value" in child || "value" in child) {
                const type =
                    typeof child.$type === "string"
                        ? child.$type
                        : typeof child.type === "string"
                          ? child.type
                          : own;

                budget.left -= 1;
                into.set([...path, key].join("."), { path: [...path, key], node: child, type });
            } else {
                visit(child, [...path, key], own, depth + 1);
            }
        }
    };

    visit(tree, [], undefined, 0);
}

// --- Math ---------------------------------------------------------------------------------------------------------------

interface Quantity {
    n: number;
    unit: string;
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
    round: ([x, digits]) =>
        Number(x!.toFixed(digits === undefined ? 0 : Math.min(8, Math.max(0, digits)))),
    floor: ([x]) => Math.floor(x!),
    ceil: ([x]) => Math.ceil(x!),
    abs: ([x]) => Math.abs(x!),
    sqrt: ([x]) => Math.sqrt(x!),
    min: (args) => Math.min(...args),
    max: (args) => Math.max(...args),
    pow: ([x, y]) => x! ** y!,
};

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;
const UNIT = /^(?:px|rem|em|%|pt|vw|vh|ms|s|deg)(?![a-z])/i;

/**
 * The value of an arithmetic text (`16px * 2`, `(8 + 4) / 2`, `round(10.5 * 1.5)`), or undefined when the text is not
 * arithmetic: a color, a word, or a value that is only a number. A recursive descent over numbers with a unit, `+ - * /`,
 * parentheses, and a few functions. Units: `a px + b px` is px, a number with a length is that length, and the same unit
 * over itself is a ratio.
 */
function calculate(text: string): string | undefined {
    let source = text.trim();

    if (/^calc\(.*\)$/i.test(source)) {
        source = source.slice(5, -1);
    }

    if (source.length > 200 || !/^[\d\s.+\-*/()%a-z,]+$/i.test(source) || !/[\d)]/.test(source)) {
        return undefined;
    }

    let at = 0;
    let operations = 0;

    const fail = () => {
        throw new Error("not arithmetic");
    };

    const skip = () => {
        while (source[at] === " " || source[at] === "\t") {
            at += 1;
        }
    };

    const combine = (a: Quantity, b: Quantity, operator: string): Quantity => {
        operations += 1;

        if (operator === "+" || operator === "-") {
            const unit = a.unit === "" ? b.unit : a.unit;

            return { n: operator === "+" ? a.n + b.n : a.n - b.n, unit };
        }

        if (operator === "*") {
            return { n: a.n * b.n, unit: a.unit === "" ? b.unit : a.unit };
        }

        if (b.n === 0) {
            return fail();
        }

        return { n: a.n / b.n, unit: a.unit === b.unit ? "" : a.unit === "" ? b.unit : a.unit };
    };

    const factor = (): Quantity => {
        skip();

        if (source[at] === "-") {
            at += 1;

            const inner = factor();

            return { n: -inner.n, unit: inner.unit };
        }

        if (source[at] === "+") {
            at += 1;

            return factor();
        }

        if (source[at] === "(") {
            at += 1;

            const inner = expression();

            skip();

            if (source[at] !== ")") {
                return fail();
            }

            at += 1;

            return inner;
        }

        const number = NUMBER.exec(source.slice(at));

        if (number !== null) {
            at += number[0].length;

            const unit = UNIT.exec(source.slice(at));

            if (unit !== null) {
                at += unit[0].length;
            }

            return { n: Number(number[0]), unit: (unit?.[0] ?? "").toLowerCase() };
        }

        const name = /^[a-z]+/i.exec(source.slice(at))?.[0]?.toLowerCase();

        if (name === undefined || FUNCTIONS[name] === undefined) {
            return fail();
        }

        at += name.length;
        skip();

        if (source[at] !== "(") {
            return fail();
        }

        at += 1;
        operations += 1;

        const args: Quantity[] = [];

        for (;;) {
            args.push(expression());
            skip();

            if (source[at] === ",") {
                at += 1;

                continue;
            }

            break;
        }

        if (source[at] !== ")") {
            return fail();
        }

        at += 1;

        return {
            n: FUNCTIONS[name]!(args.map((each) => each.n)),
            unit: args.find((each) => each.unit !== "")?.unit ?? "",
        };
    };

    const term = (): Quantity => {
        let left = factor();

        for (;;) {
            skip();

            const operator = source[at];

            if (operator !== "*" && operator !== "/") {
                return left;
            }

            at += 1;
            left = combine(left, factor(), operator);
        }
    };

    function expression(): Quantity {
        let left = term();

        for (;;) {
            skip();

            const operator = source[at];

            if (operator !== "+" && operator !== "-") {
                return left;
            }

            at += 1;
            left = combine(left, term(), operator);
        }
    }

    try {
        const result = expression();

        skip();

        if (at !== source.length || operations === 0 || !Number.isFinite(result.n)) {
            return undefined;
        }

        return `${Number(result.n.toFixed(4))}${result.unit}`;
    } catch {
        return undefined;
    }
}

// --- Resolution ---------------------------------------------------------------------------------------------------------

/** A color moved `ratio` of the way to another, mixed in sRGB (what Tokens Studio's lighten, darken, and mix do). */
const towards = (color: Rgba, other: Rgba, ratio: number): Rgba =>
    mixColors(
        "srgb",
        { color, percent: 100 - ratio * 100 },
        { color: other, percent: ratio * 100 },
    );

/** `{a.b.c}` and the oldest `$a.b.c`: the dotted path of a reference. */
const REFERENCE = /\{([^{}]+)\}|(?<![\w$])\$([A-Za-z_][\w-]*(?:\.[\w-]+)+)/g;

/** The tokens of one mode, ready to read: references followed, math evaluated, color modifiers applied. */
class Mode {
    entries: Map<string, Entry>;
    done = new Map<string, unknown>();
    failed = new Set<string>();

    constructor(entries: Map<string, Entry>) {
        this.entries = entries;
    }

    /** The key of an entry for a reference text. */
    keyOf(reference: string): string {
        return reference.trim().split(".").map(segment).join(".");
    }

    /** The value of a token with every reference followed. Undefined when it cannot be (a loop, a missing token). */
    valueOf(key: string, stack: string[] = []): unknown {
        if (this.done.has(key)) {
            return this.done.get(key);
        }

        const entry = this.entries.get(key);

        if (entry === undefined || stack.includes(key) || stack.length > LIMITS.refs) {
            return undefined;
        }

        const raw = entry.node.$value ?? entry.node.value;
        let value = this.evaluate(raw, [...stack, key]);

        if (value !== undefined) {
            value = this.modify(value, entry);
        }

        this.done.set(key, value);

        return value;
    }

    /** A value with every reference in it replaced and its math done; composite values member by member. */
    evaluate(raw: unknown, stack: string[]): unknown {
        if (Array.isArray(raw)) {
            const items = raw.slice(0, 16).map((item) => this.evaluate(item, stack));

            return items.some((item) => item === undefined) ? undefined : items;
        }

        if (isObject(raw)) {
            const out: Obj = {};

            for (const [name, member] of Object.entries(raw).slice(0, 24)) {
                const value = this.evaluate(member, stack);

                if (value === undefined) {
                    return undefined;
                }

                out[name] = value;
            }

            return out;
        }

        if (typeof raw !== "string") {
            return raw;
        }

        const text = raw.slice(0, LIMITS.text).trim();
        let missing = false;

        // `rgba({color.red}, 0.5)`: a color with an alpha.
        const alpha =
            /^rgba?\(\s*(\{[^{}]+\}|\$[\w.-]+|#[0-9a-f]{3,8})\s*,\s*(\d*\.?\d+%?)\s*\)$/i.exec(
                text,
            );

        if (alpha !== null) {
            const base = /^[{$]/.test(alpha[1]!)
                ? this.valueOf(this.keyOf(alpha[1]!.replace(/^\{|\}$|^\$/g, "")), stack)
                : alpha[1];
            const color = typeof base === "string" ? parseColor(base) : undefined;
            const opacity = alpha[2]!.endsWith("%")
                ? Number.parseFloat(alpha[2]!) / 100
                : Number(alpha[2]);

            if (color !== undefined) {
                return toHex({ ...color, a: Math.min(1, Math.max(0, opacity)) });
            }

            return undefined;
        }

        const whole = /^\{([^{}]+)\}$|^\$([A-Za-z_][\w-]*(?:\.[\w-]+)+)$/.exec(text);

        // A value that is only a reference is that token's value, in its own form (a shadow, a list, a number).
        if (whole !== null) {
            return this.valueOf(this.keyOf(whole[1] ?? whole[2] ?? ""), stack);
        }

        const replaced = text.replace(
            REFERENCE,
            (_, braced: string | undefined, dollar: string | undefined) => {
                const found = this.valueOf(this.keyOf(braced ?? dollar ?? ""), stack);

                if (found === undefined || (typeof found === "object" && found !== null)) {
                    missing = true;

                    return "";
                }

                return String(found);
            },
        );

        if (missing) {
            return undefined;
        }

        return calculate(replaced) ?? replaced;
    }

    /** `$extensions["studio.tokens"].modify`: alpha, lighten, darken, or mix, on a color. */
    modify(value: unknown, entry: Entry): unknown {
        const extension = isObject(entry.node.$extensions)
            ? (entry.node.$extensions["studio.tokens"] as unknown)
            : undefined;
        const modifier = isObject(extension) ? extension.modify : undefined;

        if (!isObject(modifier) || typeof value !== "string") {
            return value;
        }

        const color = parseColor(value);
        const amount = Number(this.evaluate(modifier.value, []));

        if (color === undefined || !Number.isFinite(amount)) {
            return value;
        }

        const ratio = Math.min(1, Math.max(0, amount));

        switch (modifier.type) {
            case "alpha":
                return toHex({ ...color, a: ratio });
            case "lighten":
                return toHex(towards(color, { r: 1, g: 1, b: 1, a: color.a }, ratio));
            case "darken":
                return toHex(towards(color, { r: 0, g: 0, b: 0, a: color.a }, ratio));

            case "mix": {
                const other = this.evaluate(modifier.color, []);
                const target = typeof other === "string" ? parseColor(other) : undefined;

                return target === undefined ? value : toHex(towards(color, target, ratio));
            }

            default:
                return value;
        }
    }
}

/** The tree of a mode as a DTCG tree: references kept where a token is only a reference, every other value followed. */
function tokensOf(mode: Mode): { tree: Obj; flat: Map<string, Obj> } {
    const tree: Obj = {};
    const flat = new Map<string, Obj>();

    for (const [key, entry] of mode.entries) {
        const raw = entry.node.$value ?? entry.node.value;
        const text = typeof raw === "string" ? raw.trim() : undefined;
        const alias =
            text === undefined
                ? null
                : /^\{([^{}]+)\}$|^\$([A-Za-z_][\w-]*(?:\.[\w-]+)+)$/.exec(text);
        // A token that modifies its color is not only a reference.
        const modifies =
            isObject(entry.node.$extensions) && "studio.tokens" in entry.node.$extensions;
        const target =
            alias === null || modifies ? undefined : mode.keyOf(alias[1] ?? alias[2] ?? "");
        let value: unknown;

        if (target !== undefined && mode.entries.has(target) && mode.valueOf(key) !== undefined) {
            value = `{${target}}`;
        } else {
            value = mode.valueOf(key);
        }

        if (value === undefined) {
            continue;
        }

        const token = convert(
            { ...entry.node, $value: value, value: undefined, $type: undefined, type: entry.type },
            undefined,
        );

        if (token === undefined) {
            continue;
        }

        // A reference needs a type only when the target has none the engine knows.
        let group = tree;

        for (const part of entry.path.slice(0, -1)) {
            const next = group[part];

            if (isObject(next) && !("$value" in next)) {
                group = next;
            } else {
                const made: Obj = {};

                group[part] = made;
                group = made;
            }
        }

        group[entry.path.at(-1)!] = token;
        flat.set(key, token);
    }

    return { tree, flat };
}

// --- Modes --------------------------------------------------------------------------------------------------------------

interface Theme {
    name: string;
    group?: string;
    enabled: string[];
    source: string[];
}

/** The themes of a `$themes` array that name sets. */
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

/** The sets of the default mode and of the dark mode: from the themes when there are some, else from the set names. */
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

        // The other themes of the mode group (`high-contrast`, `sepia`) are modes of their own.
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
        // No theme gave a mode: the sets named for dark are the dark mode, and the rest are the default.
        light = darkSets.length > 0 ? [...baseSets, ...lightSets] : names;
        dark = darkSets.length > 0 ? [...baseSets, ...darkSets] : undefined;
    } else if (light === undefined) {
        // Only dark themes: the dark theme is the default mode.
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

/** The tokens of a Tokens Studio source: the default mode, the dark mode's changes, and what happened. */
export function studioTokens(input: StudioSource): {
    default: Obj;
    dark: Obj;
    extra: Record<string, Obj>;
    count: number;
    notes: string[];
} {
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

    /** The tokens of a mode whose value differs from the default's, as a tree. Tokens that the default lacks are left out. */
    const changes = (sets: string[], label: string): Obj => {
        const second = tokensOf(read(sets));
        const tree: Obj = {};
        let skipped = 0;

        for (const [key, token] of second.flat) {
            const base = first.flat.get(key);

            if (base === undefined) {
                skipped += 1;

                continue;
            }

            if (JSON.stringify(base.$value) === JSON.stringify(token.$value)) {
                continue;
            }

            let group = tree;
            const path = key.split(".");

            for (const part of path.slice(0, -1)) {
                const next = group[part];

                if (isObject(next)) {
                    group = next;
                } else {
                    const made: Obj = {};

                    group[part] = made;
                    group = made;
                }
            }

            group[path.at(-1)!] = token;
        }

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
