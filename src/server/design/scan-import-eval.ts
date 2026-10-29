import { convert, isObject, type Obj } from "./scan-import-convert.ts";
import { parseColor, toHex } from "./color.ts";
import { evalMath } from "./scan-variables.ts";

/** Members of a type style that the scan leaves out, so that a reference of theirs that fails is not a reason to drop the style. */
const OPTIONAL_MEMBERS = new Set([
    "textCase",
    "textDecoration",
    "paragraphSpacing",
    "paragraphIndent",
]);

export const LIMITS = {
    sets: 40,
    tokens: 5000,
    depth: 12,
    refs: 24,
    text: 400,
    // The text that references make: `{a}{a}` at each level doubles it.
    made: 4000,
} as const;

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

const REFERENCE = /\{([^{}]+)\}|(?<![\w$])\$([A-Za-z_][\w-]*(?:\.[\w-]+)+)/g;

const modifies = (node: Obj) =>
    isObject(node.$extensions) &&
    isObject(node.$extensions["studio.tokens"]) &&
    isObject(node.$extensions["studio.tokens"].modify);

export class Mode {
    entries: Map<string, Entry>;
    done = new Map<string, unknown>();
    failed = new Set<string>();

    constructor(entries: Map<string, Entry>) {
        this.entries = entries;
    }

    keyOf(reference: string): string {
        const key = reference.trim().split(".").map(segment).join(".");

        // Style Dictionary writes a reference to a token's value: `{color.base.red.value}` is the token `color.base.red`.
        return this.entries.has(key) ? key : key.replace(/\.\$?value$/, "");
    }

    valueOf(key: string, stack: string[] = []): unknown {
        if (this.done.has(key)) {
            return this.done.get(key);
        }

        const entry = this.entries.get(key);

        if (entry === undefined || stack.includes(key) || stack.length > LIMITS.refs) {
            return undefined;
        }

        const raw = entry.node.$value ?? entry.node.value;
        // A Tokens Studio color modifier (`lighten`, `mix`) is not run: the token is left out rather than drafted wrong.
        const value = modifies(entry.node) ? undefined : this.evaluate(raw, [...stack, key]);

        this.done.set(key, value);

        return value;
    }

    evaluate(raw: unknown, stack: string[], depth = 0): unknown {
        // A value nested deeper than a token's needs (`[[[…]]]`) is not read.
        if (depth > LIMITS.depth) {
            return undefined;
        }

        if (Array.isArray(raw)) {
            const items = raw.slice(0, 16).map((item) => this.evaluate(item, stack, depth + 1));

            return items.some((item) => item === undefined) ? undefined : items;
        }

        if (isObject(raw)) {
            const out: Obj = {};

            for (const [name, member] of Object.entries(raw).slice(0, 24)) {
                const value = this.evaluate(member, stack, depth + 1);

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

                if (
                    found === undefined ||
                    (typeof found === "object" && found !== null) ||
                    String(found).length > LIMITS.made
                ) {
                    missing = true;

                    return "";
                }

                return String(found);
            },
        );

        // A text that grew past the limit is not read: the token is left out.
        if (missing || replaced.length > LIMITS.made) {
            return undefined;
        }

        const math = /^calc\((.*)\)$/is.exec(replaced)?.[1] ?? replaced;
        const result = /[*/+]|\s-\s/.test(math) ? evalMath(math, () => undefined) : undefined;

        // Tokens Studio's math functions (`round({a} * 1.6)`) are not run: the token is left out.
        if (result === undefined && /^(?:round|floor|ceil|abs|sqrt|min|max|pow)\(/i.test(math)) {
            return undefined;
        }

        return result ?? replaced;
    }
}

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
        const target = alias === null ? undefined : mode.keyOf(alias[1] ?? alias[2] ?? "");
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
