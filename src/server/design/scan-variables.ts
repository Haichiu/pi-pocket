import type { Category, Facts, VarFact } from "./scan-facts.ts";
import { kebab, vkey } from "./scan-colors.ts";
import { parseColor } from "./color.ts";

export interface Variable {
    name: string;
    kind: VarFact["kind"];
    light?: VarFact;
    dark?: VarFact;
    spare?: VarFact;
    twin?: boolean;
    hint?: Category;
}

export function variables(facts: Facts, alt: "dark" | "light"): Variable[] {
    const map = new Map<string, Variable>();
    const better = (a: VarFact | undefined, b: VarFact) =>
        a === undefined || b.rank < a.rank || (b.rank === a.rank && b.order > a.order);

    for (const fact of facts.vars) {
        const key = vkey(fact);
        const variable = map.get(key) ?? { name: fact.name, kind: fact.kind, hint: fact.hint };

        // The default scope is the page's own values; `alt` is the other mode. The scope that is neither (the
        // opposite mode of the project) only fills in what the default scope does not set.
        if (fact.scope === "default" && better(variable.light, fact)) {
            variable.light = fact;
        } else if (fact.scope === alt && better(variable.dark, fact)) {
            variable.dark = fact;
        } else if (
            fact.scope === (alt === "dark" ? "light" : "dark") &&
            variable.light === undefined
        ) {
            variable.spare = fact;
        }

        if (fact.hint !== undefined) {
            variable.hint = fact.hint;
        }

        map.set(key, variable);
    }

    for (const variable of map.values()) {
        variable.light ??= variable.spare;
    }

    pairModeTwins(map, alt);
    pairSassNames(map, alt);
    pairModeSuffixes(map, alt);

    return [...map.values()].filter(
        (variable) => variable.light !== undefined || variable.dark !== undefined,
    );
}

// A dark-named variable that the plain one points at in the dark scope (`--bg: var(--dark-bg)`) is one for sure; without that, three pairs make a scheme, and a name with a `-light` or `-main` sibling (`primary-dark` beside `primary-light`) is a shade, not a mode.
function pairModeTwins(map: Map<string, Variable>, alt: "dark" | "light"): void {
    const mode = alt === "dark" ? /^(?:dark|night|dk|drk|d)$/ : /^(?:light|day|lt|lgt|l)$/;
    const plain = (name: string) => kebab(name).replace(/^(?:color|colour|clr)-/, "");
    const byName = new Map<string, Variable>();

    for (const [key, variable] of map) {
        if (
            key.startsWith("css:") ||
            key.startsWith("scss:") ||
            key.startsWith("less:") ||
            key.startsWith("js:")
        ) {
            byName.set(`${variable.kind}:${plain(variable.name)}`, variable);
        }
    }

    const pairs: { twin: Variable; base: Variable; sure: boolean }[] = [];

    for (const variable of map.values()) {
        const words = plain(variable.name).split("-");
        const at = words.findIndex((word) => mode.test(word));

        if (at === -1 || words.length < 2 || variable.light === undefined) {
            continue;
        }

        const base = byName.get(
            `${variable.kind}:${words.filter((_, index) => index !== at).join("-")}`,
        );

        if (base === undefined || base === variable) {
            continue;
        }

        const target = new RegExp(String.raw`var\(\s*--${variable.name}\s*[,)]`);
        const sure = base.dark !== undefined && target.test(base.dark.value);
        const shade =
            at === words.length - 1 &&
            [...map.values()].some(
                (other) =>
                    /^(?:light|main|base|default)$/.test(
                        plain(other.name).slice(words.slice(0, at).join("-").length + 1),
                    ) && plain(other.name).startsWith(`${words.slice(0, at).join("-")}-`),
            );

        if (sure || !shade) {
            pairs.push({ twin: variable, base, sure });
        }
    }

    if (pairs.length < 3 && !pairs.some((pair) => pair.sure)) {
        return;
    }

    for (const { twin, base } of pairs) {
        base.dark ??= { ...twin.light!, scope: alt };
        twin.twin = true;
    }
}

function pairModeSuffixes(map: Map<string, Variable>, alt: "dark" | "light"): void {
    const ends = alt === "dark" ? (["light", "dark"] as const) : (["dark", "light"] as const);
    const stems = new Map<string, { first?: Variable; second?: Variable }>();

    for (const variable of map.values()) {
        const words = kebab(variable.name).replace(/^-/, "").split("-");
        const at = [ends[0], ends[1]].includes(words.at(-1) as never)
            ? words.length - 1
            : [ends[0], ends[1]].includes(words[0] as never)
              ? 0
              : -1;

        if (
            at === -1 ||
            words.length < 2 ||
            variable.light === undefined ||
            variable.twin === true
        ) {
            continue;
        }

        const mode = words[at];
        const stem = `${variable.kind}:${variable.hint ?? ""}:${words.filter((_, index) => index !== at).join("-")}`;
        const pair = stems.get(stem) ?? {};

        pair[mode === ends[0] ? "first" : "second"] = variable;
        stems.set(stem, pair);
    }

    const complete = [...stems].filter(
        ([, pair]) => pair.first !== undefined && pair.second !== undefined,
    );

    if (complete.length < 2) {
        return;
    }

    for (const [key, { first, second }] of complete) {
        const name = key.split(":").slice(2).join(":");

        if (map.has(`${first!.kind}:${first!.hint ?? ""}:${name}`)) {
            continue;
        }

        const merged: Variable = {
            name,
            kind: first!.kind,
            light: first!.light,
            dark: { ...second!.light!, scope: alt },
            ...(first!.hint === undefined ? {} : { hint: first!.hint }),
        };

        first!.twin = true;
        second!.twin = true;
        map.set(vkey(merged), merged);
    }
}

function pairSassNames(map: Map<string, Variable>, alt: "dark" | "light"): void {
    const plain = (name: string) =>
        kebab(name).replace(/^(?:bs|ifm|sl|mui|ant|chakra|mantine|pico|vt)-/, "");
    const preprocessed = new Map<string, Variable>();

    for (const variable of map.values()) {
        if (variable.kind === "scss" || variable.kind === "less") {
            preprocessed.set(plain(variable.name), variable);
        }
    }

    for (const variable of map.values()) {
        if (
            (variable.kind === "css" || variable.kind === "theme") &&
            variable.light === undefined
        ) {
            const base = preprocessed.get(plain(variable.name));

            if (base !== undefined && base.dark === undefined && variable.dark !== undefined) {
                base.dark = { ...variable.dark, scope: alt };
                variable.twin = true;
            }
        }
    }
}

export function follow(
    index: Map<string, Variable>,
    start: Variable,
    scope: "light" | "dark",
    active: Set<Variable> = new Set(),
    memo: Map<Variable, { text: string; via?: Variable } | undefined> = new Map(),
): { text: string; via?: Variable } | undefined {
    // A variable that arithmetic points back at (`$a: $a * 2`) is not followed into itself, nor a chain past 256.
    if (active.has(start) || active.size >= 256) {
        return undefined;
    }

    // Each variable is followed once in a walk: `$b: $a + $a; $c: $b + $b; …` does not double the work at each step.
    if (memo.has(start)) {
        return memo.get(start);
    }

    active.add(start);

    try {
        const out = followOnce(index, start, scope, active, memo);

        memo.set(start, out);

        return out;
    } finally {
        active.delete(start);
    }
}

function followOnce(
    index: Map<string, Variable>,
    start: Variable,
    scope: "light" | "dark",
    active: Set<Variable>,
    memo: Map<Variable, { text: string; via?: Variable } | undefined>,
): { text: string; via?: Variable } | undefined {
    const find = (name: string, kind: Variable["kind"]) => index.get(`${kind}:${name}`);

    let current = start;
    const bare = (value: string | undefined) => value?.replace(/#\{\s*([$@][\w-]+)\s*\}/g, "$1");
    let text = bare(
        (scope === "dark" ? (current.dark ?? current.light) : (current.light ?? current.dark))
            ?.value,
    );
    let via: Variable | undefined;

    for (let hop = 0; hop < 8 && text !== undefined; hop++) {
        const css = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(text);
        const scss = /^\$([\w-]+)$/.exec(text);
        const less = /^@([\w-]+)$/.exec(text);
        const next =
            css !== null
                ? find(css[1]!, "css")
                : scss !== null
                  ? find(scss[1]!, "scss")
                  : less !== null
                    ? find(less[1]!, "less")
                    : undefined;

        if (css === null && scss === null && less === null) {
            break;
        }

        if (next === undefined) {
            if (css?.[2] !== undefined) {
                text = css[2].trim();

                continue;
            }

            return undefined;
        }

        via ??= next;
        current = next;
        text = bare(
            (scope === "dark" ? (next.dark ?? next.light) : (next.light ?? next.dark))?.value,
        );
    }

    if (text === undefined) {
        return undefined;
    }

    if (text.includes("#{")) {
        const value = (name: string, kind: "scss" | "less" | "css") => {
            const target = index.get(`${kind}:${name}`);

            return target === undefined
                ? undefined
                : follow(index, target, scope, active, memo)?.text;
        };

        text = text.replace(/#\{\s*([^{}]+?)\s*\}/g, (all, expression: string) => {
            const lone = /^(?:[\w-]+\.)?[$@]([\w-]+)$/.exec(expression);

            return (
                (lone === null
                    ? evalMath(expression, value)
                    : (value(lone[1]!, "scss") ?? value(lone[1]!, "less"))) ?? all
            );
        });
    }

    const calc = /^calc\((.*)\)$/s.exec(text.trim());

    if (
        (/[$@][A-Za-z_]/.test(text) && /[*/+()]|\s-\s/.test(text)) ||
        (calc !== null && /var\(/.test(text))
    ) {
        const math = evalMath(calc === null ? text : calc[1]!, (name, kind) => {
            const target = index.get(`${kind}:${name}`);

            return target === undefined
                ? undefined
                : follow(index, target, scope, active, memo)?.text;
        });

        if (math !== undefined) {
            text = math;
        }
    }

    return { text: text.trim(), via };
}

export function evalMath(
    text: string,
    value: (name: string, kind: "scss" | "less" | "css") => string | undefined,
): string | undefined {
    const tokens = text.match(/var\(\s*--[\w-]+\s*\)|\$[\w-]+|@[\w-]+|\d*\.?\d+[a-z%]*|[()+*/-]/g);
    let at = 0;

    if (tokens === null || tokens.join("").length < text.replace(/\s/g, "").length) {
        return undefined;
    }

    interface Quantity {
        n: number;
        unit: string;
    }

    const operand = (token: string): Quantity | undefined => {
        const source = token.startsWith("var(")
            ? value(/--([\w-]+)/.exec(token)![1]!, "css")
            : /^[$@]/.test(token)
              ? value(token.slice(1), token[0] === "$" ? "scss" : "less")
              : token;
        const match = source === undefined ? null : /^(-?\d*\.?\d+)([a-z%]*)$/.exec(source.trim());

        return match === null ? undefined : { n: Number(match[1]), unit: match[2]! };
    };

    const factor = (): Quantity | undefined => {
        const token = tokens[at++];

        if (token === undefined) {
            return undefined;
        }

        if (token === "(") {
            const inner = sum();

            return tokens[at++] === ")" ? inner : undefined;
        }

        if (token === "-") {
            const inner = factor();

            return inner === undefined ? undefined : { n: -inner.n, unit: inner.unit };
        }

        return operand(token);
    };

    const product = (): Quantity | undefined => {
        let left = factor();

        while (left !== undefined && (tokens[at] === "*" || tokens[at] === "/")) {
            const op = tokens[at++];
            const right = factor();

            if (right === undefined || (op === "/" && right.n === 0)) {
                return undefined;
            }

            left =
                op === "*"
                    ? { n: left.n * right.n, unit: left.unit || right.unit }
                    : { n: left.n / right.n, unit: left.unit === right.unit ? "" : left.unit };
        }

        return left;
    };

    const sum = (): Quantity | undefined => {
        let left = product();

        while (left !== undefined && (tokens[at] === "+" || tokens[at] === "-")) {
            const op = tokens[at++];
            let right = product();

            // rem and em are 16px when a sum mixes them with pixels (`0.5rem - 2px`).
            if (right !== undefined && left.unit !== right.unit) {
                const pixels = (quantity: Quantity): Quantity =>
                    quantity.unit === "rem" || quantity.unit === "em"
                        ? { n: quantity.n * 16, unit: "px" }
                        : quantity;

                if (
                    ["px", "rem", "em"].includes(left.unit) &&
                    ["px", "rem", "em"].includes(right.unit)
                ) {
                    left = pixels(left);
                    right = pixels(right);
                }
            }

            if (
                right === undefined ||
                (left.unit !== right.unit && left.unit !== "" && right.unit !== "")
            ) {
                return undefined;
            }

            left = {
                n: op === "+" ? left.n + right.n : left.n - right.n,
                unit: left.unit || right.unit,
            };
        }

        return left;
    };

    const result = sum();

    return result === undefined || at !== tokens.length || !Number.isFinite(result.n)
        ? undefined
        : `${Math.round(result.n * 1000) / 1000}${result.unit}`;
}

export function channelColor(text: string, name: string): string | undefined {
    if (
        /^\d+(?:\.\d+)?(?:deg)?[ ,]+\d+(?:\.\d+)?%[ ,]+\d+(?:\.\d+)?%(?:\s*\/\s*[\d.]+%?)?$/.test(
            text,
        )
    ) {
        return `hsl(${text})`;
    }

    if (/-rgb$/.test(name) && /^\d{1,3}[ ,]+\d{1,3}[ ,]+\d{1,3}$/.test(text)) {
        return `rgb(${text})`;
    }

    return undefined;
}

const FUNCTION = String.raw`\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*`;

export function noteChannels(facts: Facts, value: string): void {
    if (!value.includes("var(") || facts.channels.size > 400) {
        return;
    }

    for (const call of value.matchAll(
        new RegExp(String.raw`${FUNCTION}((?:[^()]|\([^()]*\))*)\)`, "gi"),
    )) {
        const kind = call[1]!.toLowerCase().replace(/a$/, "");

        for (const name of call[2]!.matchAll(/var\(\s*--([\w-]+)/g)) {
            facts.channels.set(name[1]!, kind);
        }
    }
}

const NUMBERS =
    /^\s*-?[\d.]+(?:deg|%)?(?:\s*[ ,]\s*-?[\d.]+(?:deg|%)?){2,3}(?:\s*\/\s*[\d.]+%?)?\s*$/;

function fill(text: string, values: Map<string, string>, depth = 0): string | undefined {
    if (depth > 4) {
        return undefined;
    }

    let missing = false;
    const out = text.replace(
        /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g,
        (_, name: string, fallback?: string) => {
            const value = values.get(name) ?? fallback?.trim();

            if (value === undefined) {
                missing = true;

                return "";
            }

            const inner = value.includes("var(") ? fill(value, values, depth + 1) : value;

            if (inner === undefined) {
                missing = true;

                return "";
            }

            return inner;
        },
    );

    return missing ? undefined : out;
}

export function resolveChannels(facts: Facts): void {
    const scopes = ["default", "dark", "light"] as const;
    const by = new Map<string, Map<string, string>>(scopes.map((scope) => [scope, new Map()]));

    for (const variable of facts.vars) {
        by.get(variable.scope)?.set(variable.name, variable.value);
    }

    // Built once: a copy for each property made the scan quadratic in the number of properties.
    const lookups = {
        default: by.get("default")!,
        dark: new Map([...by.get("default")!, ...by.get("dark")!]),
    };

    for (const variable of facts.vars) {
        const lookup = lookups[variable.scope === "dark" ? "dark" : "default"];

        const kind = facts.channels.get(variable.name);

        if (kind !== undefined && !variable.value.includes("(") && NUMBERS.test(variable.value)) {
            const color = `${kind}(${variable.value.trim().replace(/,\s*/g, " ")})`;

            if (parseColor(color) !== undefined) {
                variable.value = color;
            }

            continue;
        }

        if (
            variable.value.includes("var(") &&
            new RegExp(String.raw`^${FUNCTION}`, "i").test(variable.value.trim())
        ) {
            const text = variable.value.replace(/<alpha-value>/g, "1");
            const filled = fill(text, lookup);

            if (filled !== undefined) {
                const color = parseColor(filled.replace(/\s*\/\s*1\s*\)/, ")"));

                if (color !== undefined) {
                    variable.value = filled.replace(/\s*\/\s*1\s*\)/, ")");
                }
            }
        }
    }
}
