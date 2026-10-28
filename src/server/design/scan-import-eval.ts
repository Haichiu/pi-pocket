/**
 * The shared reading of token files (stream T): a token file's tokens flattened to dotted paths, a mode of them with every
 * reference followed (`{color.primary}`, `{color.primary.value}`, `$color.primary`), math evaluated (`{spacing.base} * 2`),
 * and color modifiers applied, and the tree of a mode in the DTCG form that the engine reads. Tokens Studio and Style
 * Dictionary files both go through it.
 */
import { convert, isObject, type Obj } from "./scan-import-convert.ts";
import { mixColors, parseColor, type Rgba, toHex } from "./color.ts";

/** Members of a type style that the scan leaves out, so that a reference of theirs that fails is not a reason to drop the style. */
const OPTIONAL_MEMBERS = new Set([
    "textCase",
    "textDecoration",
    "paragraphSpacing",
    "paragraphIndent",
]);

export const LIMITS = { sets: 40, tokens: 5000, depth: 12, refs: 24, text: 400 } as const;

/** A token of a set, with the type that its group gave it. */
export interface Entry {
    path: string[];
    node: Obj;
    type: string | undefined;
}

export const segment = (text: string) => text.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
export const words = (text: string) =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== "");
export const DARK = new Set(["dark", "night", "midnight", "black"]);
export const LIGHT = new Set(["light", "day", "daylight"]);
export const hasWord = (text: string, list: Set<string>) =>
    words(text).some((word) => list.has(word));

/** The tokens of one set, flat, by dotted path. A group's `type` (or `$type`) goes to the tokens under it. */
export function flatten(tree: Obj, into: Map<string, Entry>, budget: { left: number }): void {
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
export class Mode {
    entries: Map<string, Entry>;
    done = new Map<string, unknown>();
    failed = new Set<string>();

    constructor(entries: Map<string, Entry>) {
        this.entries = entries;
    }

    /** The key of an entry for a reference text. */
    keyOf(reference: string): string {
        const key = reference.trim().split(".").map(segment).join(".");

        // Style Dictionary writes a reference to a token's value: `{color.base.red.value}` is the token `color.base.red`.
        return this.entries.has(key) ? key : key.replace(/\.\$?value$/, "");
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
                    // A member that the engine has no use for (`textCase`) may refer to a token that is not there.
                    if (OPTIONAL_MEMBERS.has(name)) {
                        continue;
                    }

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
export function tokensOf(mode: Mode): { tree: Obj; flat: Map<string, Obj> } {
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

/**
 * The tokens of a mode whose value differs from the default's, as a tree (the mode's file holds only what changes). A
 * token that the default mode lacks is left out, and counted.
 */
export function changesBetween(
    base: Map<string, Obj>,
    mode: Map<string, Obj>,
): { tree: Obj; skipped: number } {
    const tree: Obj = {};
    let skipped = 0;

    for (const [key, token] of mode) {
        const first = base.get(key);

        if (first === undefined) {
            skipped += 1;

            continue;
        }

        if (JSON.stringify(first.$value) === JSON.stringify(token.$value)) {
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

    return { tree, skipped };
}
