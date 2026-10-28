/**
 * The variables of a project, for the scan (stream T): the winning declaration of each in each mode, the twins that supply
 * one mode of another variable, and the values followed through `var()`, Sass variables, interpolation, and arithmetic.
 */
import { type Category, type Facts, type VarFact } from "./scan-facts.ts";
import { kebab, vkey } from "./scan-util.ts";

export interface Variable {
    name: string;
    kind: VarFact["kind"];
    light?: VarFact;
    dark?: VarFact;
    /** A value from the other mode's scope, used only when the default scope has none. */
    spare?: VarFact;
    /** It holds the other mode's value of another variable (`--dark-bg` beside `--bg`). */
    twin?: boolean;
    hint?: Category;
}

/** The winning declaration of each variable in each scope: the best ranked file, and the last in that file. */
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

/**
 * Variables that a project keeps for the other mode under their own names (`--dark-bg`, `--bg-dark`, `$night-ink`) are
 * the other mode's value of the plain variable (`--bg`): they are not colors of their own. A dark-named variable that the
 * plain one points at in the dark scope (`--bg: var(--dark-bg)`) is one for sure; without that, three pairs make a scheme,
 * and a name that has a `-light` or `-main` sibling (`primary-dark` beside `primary-light`) is a shade, not a mode.
 */
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

/**
 * `bodyLight`/`bodyDark`, `text-light`/`text-dark`: two variables, one for each mode, with no plain variable between
 * them, are one variable with two values. Two such pairs make a scheme.
 */
function pairModeSuffixes(map: Map<string, Variable>, alt: "dark" | "light"): void {
    const ends = alt === "dark" ? (["light", "dark"] as const) : (["dark", "light"] as const);
    const stems = new Map<string, { first?: Variable; second?: Variable }>();

    for (const variable of map.values()) {
        const words = kebab(variable.name).replace(/^-/, "").split("-");
        // The mode word is at the end (`bg-light`) or at the start (`light-bg`).
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

/**
 * A custom property that a project sets only in the other mode (`[data-bs-theme="dark"] { --bs-body-bg: #16181d }`) is the
 * other mode's value of the Sass or Less variable of the same name (`$body-bg`), which holds the default.
 */
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

/** A variable's value with its references followed. `via` is the variable it points at first. */
export function follow(
    index: Map<string, Variable>,
    start: Variable,
    scope: "light" | "dark",
): { text: string; via?: Variable } | undefined {
    // A library writes the variables of a theme object under a prefix (`--mantine-color-ink-9` for the theme's `ink` step 9):
    // a name that is not declared is looked for without its first words.
    const find = (name: string, kind: Variable["kind"]) => {
        const lookup = (text: string) =>
            index.get(`${kind}:${text}`) ?? (kind === "css" ? index.get(`js:${text}`) : undefined);
        const exact = lookup(name);

        if (exact !== undefined || kind !== "css") {
            return exact;
        }

        const parts = name.split("-");

        for (let drop = 1; drop <= 3 && drop < parts.length - 1; drop++) {
            const found = lookup(parts.slice(drop).join("-"));

            if (found !== undefined) {
                return found;
            }
        }

        return undefined;
    };

    let current = start;
    // Sass interpolation of one variable (`#{$dark-bg}`) is the variable.
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

    // Interpolation inside a longer value or with arithmetic (`0 1px 2px #{$shadow-ink}`, `#{$space * 2}`): the value.
    if (text.includes("#{")) {
        const value = (name: string, kind: "scss" | "less" | "css") => {
            const target = index.get(`${kind}:${name}`);

            return target === undefined ? undefined : follow(index, target, scope)?.text;
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

    // SCSS and Less arithmetic (`$space-1 * 3`), and CSS `calc()` over custom properties (`calc(var(--radius) - 2px)`).
    const calc = /^calc\((.*)\)$/s.exec(text.trim());

    if (
        (/[$@][A-Za-z_]/.test(text) && /[*/+()]|\s-\s/.test(text)) ||
        (calc !== null && /var\(/.test(text))
    ) {
        const math = evalMath(calc === null ? text : calc[1]!, (name, kind) => {
            const target = index.get(`${kind}:${name}`);

            return target === undefined ? undefined : follow(index, target, scope)?.text;
        });

        if (math !== undefined) {
            text = math;
        }
    }

    return { text: text.trim(), via };
}

/** `$a * 3`, `($a + 4px) / 2`: arithmetic on lengths, with variables looked up by `value`. Undefined if it cannot. */
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

/** The channels of a color written without its function: `222.2 47.4% 11.2%` (HSL) is how shadcn writes them. */
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
