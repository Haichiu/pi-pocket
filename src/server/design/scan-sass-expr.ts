/**
 * Sass expressions (stream T): `mix(white, $c, $i * 10%)`, `map.get($palette, "a-#{$i}")`, `($a + $b) / 2`, `(k: v, k2: v2)`,
 * `$a == dark and not $b`. A tokenizer and a recursive descent parser make a tree, and `evaluate` reads the tree in an
 * environment. Anything it does not understand throws `Unsupported`, and the caller leaves that text as it was.
 */
import {
    NULL,
    bool,
    callBuiltin,
    colorFromText,
    equal,
    list,
    num,
    str,
    text,
    truthy,
    type Num,
    type Value,
} from "./scan-sass-values.ts";

export class Unsupported extends Error {}

// --- Tokens ---------------------------------------------------------------------------------------------------------------

type Tok =
    | { k: "num"; n: number; unit: string; ws: boolean }
    | { k: "str"; parts: Part[]; ws: boolean }
    | { k: "color"; text: string; ws: boolean }
    | { k: "var"; name: string; ws: boolean }
    | { k: "ident"; parts: Part[]; ws: boolean }
    | { k: "interp"; source: string; ws: boolean }
    | { k: "op"; op: string; ws: boolean }
    | { k: "end"; ws: boolean };

/** A piece of a string or a name: text, or `#{expression}` as source. */
type Part = string | { interp: string };

const OPERATORS = [
    "==",
    "!=",
    "<=",
    ">=",
    "+",
    "-",
    "*",
    "/",
    "%",
    "<",
    ">",
    "(",
    ")",
    "[",
    "]",
    ",",
    ":",
];

/** The end of a `#{...}` that starts at `at` (the index of `#`): the index after its `}`. */
function interpEnd(source: string, at: number): number {
    let depth = 0;
    let index = at + 1;

    for (; index < source.length; index++) {
        const char = source[index]!;

        if (char === '"' || char === "'") {
            index = quoteEnd(source, index);
        } else if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;

            if (depth === 0) {
                return index + 1;
            }
        }
    }

    throw new Unsupported("unclosed interpolation");
}

/** The index of the quote that closes the one at `at`. */
function quoteEnd(source: string, at: number): number {
    const quote = source[at];

    for (let index = at + 1; index < source.length; index++) {
        if (source[index] === "\\") {
            index += 1;
        } else if (source[index] === "#" && source[index + 1] === "{") {
            index = interpEnd(source, index) - 1;
        } else if (source[index] === quote) {
            return index;
        }
    }

    throw new Unsupported("unclosed string");
}

/** Parts of a string or a name: the text between `#{...}` and the `#{...}` themselves. */
function partsOf(source: string): Part[] {
    const parts: Part[] = [];
    let buffer = "";

    for (let at = 0; at < source.length; at++) {
        if (source[at] === "#" && source[at + 1] === "{") {
            const end = interpEnd(source, at);

            if (buffer !== "") {
                parts.push(buffer);
                buffer = "";
            }

            parts.push({ interp: source.slice(at + 2, end - 1) });
            at = end - 1;
        } else if (source[at] === "\\" && at + 1 < source.length) {
            buffer += source[at + 1];
            at += 1;
        } else {
            buffer += source[at];
        }
    }

    if (buffer !== "") {
        parts.push(buffer);
    }

    return parts;
}

/** A sticky pattern matched at a position, without cutting the text (the tokenizer stays linear). */
const at_ = (pattern: RegExp, source: string, at: number): RegExpExecArray | null => {
    pattern.lastIndex = at;

    return pattern.exec(source);
};

const COLOR = /#([0-9a-fA-F]{3,8})(?![\w-])/y;
const VARIABLE = /((?:[a-z][\w-]*\.)?\$[\w-]+)/iy;
const NUMBER_AT = /(\d*\.?\d+)(?:e[+-]?\d+)?(%|[a-z]+(?![\w-]))?/iy;
const NAME_LIKE = /\d+[a-z]*-/y;
const NAME_START = /(?:-{0,2}[a-z_]|#\{)/iy;

function tokenize(source: string): Tok[] {
    if (source.length > 120_000) {
        throw new Unsupported("expression too long");
    }

    const out: Tok[] = [];
    let at = 0;

    while (at < source.length) {
        const before = at;

        while (at < source.length && /\s/.test(source[at]!)) {
            at += 1;
        }

        const ws = at > before || out.length === 0;

        if (at >= source.length) {
            break;
        }

        const char = source[at]!;
        let match: RegExpExecArray | null;

        if (char === '"' || char === "'") {
            const end = quoteEnd(source, at);

            out.push({ k: "str", parts: partsOf(source.slice(at + 1, end)), ws });
            at = end + 1;
        } else if (char === "#" && source[at + 1] === "{") {
            const end = interpEnd(source, at);
            const next = source[end];

            // `#{...}` that runs into a name (`--color-#{$k}`) is part of that name; a lone one is a value.
            if (next !== undefined && /[\w-]/.test(next)) {
                // Walk the name with its interpolations.
                let index = at;

                while (index < source.length) {
                    if (source[index] === "#" && source[index + 1] === "{") {
                        index = interpEnd(source, index);
                    } else if (/[\w-]/.test(source[index]!)) {
                        index += 1;
                    } else {
                        break;
                    }
                }

                out.push({ k: "ident", parts: partsOf(source.slice(at, index)), ws });
                at = index;
            } else {
                out.push({ k: "interp", source: source.slice(at + 2, end - 1), ws });
                at = end;
            }
        } else if ((match = at_(COLOR, source, at)) !== null) {
            out.push({ k: "color", text: match[0], ws });
            at += match[0].length;
        } else if ((match = at_(VARIABLE, source, at)) !== null) {
            out.push({ k: "var", name: match[1]!.replace(/^[\w-]+\./, ""), ws });
            at += match[1]!.length;
        } else if (
            (match = at_(NUMBER_AT, source, at)) !== null &&
            at_(NAME_LIKE, source, at) === null
        ) {
            out.push({
                k: "num",
                n: Number(match[0].replace(/[a-z%]+$/i, "")),
                unit: match[2] ?? "",
                ws,
            });
            at += match[0].length;
        } else if (at_(NAME_START, source, at) !== null) {
            // A name, with `module.` in front of a function and `#{}` inside.
            let index = at;

            while (index < source.length) {
                if (source[index] === "#" && source[index + 1] === "{") {
                    index = interpEnd(source, index);
                } else if (
                    /[\w-]/.test(source[index]!) ||
                    (source[index] === "." &&
                        /[a-z]/i.test(source[index + 1] ?? "") &&
                        /^[\w-]+$/.test(source.slice(at, index)))
                ) {
                    index += 1;
                } else {
                    break;
                }
            }

            out.push({ k: "ident", parts: partsOf(source.slice(at, index)), ws });
            at = index;
        } else {
            const op = OPERATORS.find((each) => source.startsWith(each, at));

            if (op === undefined) {
                throw new Unsupported(`unexpected ${char}`);
            }

            out.push({ k: "op", op, ws });
            at += op.length;
        }
    }

    out.push({ k: "end", ws: true });

    return out;
}

// --- The tree -------------------------------------------------------------------------------------------------------------

export type Node =
    | { k: "num"; n: number; unit: string }
    | { k: "str"; parts: Part[]; quoted: boolean }
    | { k: "color"; text: string }
    | { k: "var"; name: string }
    | { k: "call"; name: string; args: Node[]; named: [string, Node][] }
    | { k: "list"; items: Node[]; sep: "comma" | "space"; bracket: boolean }
    | { k: "map"; entries: [Node, Node][] }
    | { k: "bin"; op: string; left: Node; right: Node }
    | { k: "un"; op: string; value: Node }
    | { k: "interp"; source: string };

class Parser {
    tokens: Tok[];
    at = 0;
    depth = 0;
    nest = 0;

    constructor(source: string) {
        this.tokens = tokenize(source);
    }

    peek(): Tok {
        return this.tokens[this.at]!;
    }

    next(): Tok {
        return this.tokens[this.at++]!;
    }

    isOp(op: string, token = this.peek()): boolean {
        return token.k === "op" && token.op === op;
    }

    expectOp(op: string): void {
        if (!this.isOp(op)) {
            throw new Unsupported(`expected ${op}`);
        }

        this.at += 1;
    }

    /** The whole text as one expression (a comma list at the top). */
    parse(): Node {
        const node = this.commaList();

        if (this.peek().k !== "end") {
            throw new Unsupported("text after the expression");
        }

        return node;
    }

    commaList(): Node {
        const first = this.spaceList();

        if (!this.isOp(",")) {
            return first;
        }

        const items = [first];

        while (this.isOp(",")) {
            this.at += 1;

            if (this.peek().k === "end" || this.isOp(")") || this.isOp("]")) {
                break;
            }

            items.push(this.spaceList());
        }

        return { k: "list", items, sep: "comma", bracket: false };
    }

    /** Values side by side are a list; an operator or a comma ends it. */
    spaceList(): Node {
        const items = [this.or()];

        while (this.startsValue()) {
            items.push(this.or());
        }

        return items.length === 1 ? items[0]! : { k: "list", items, sep: "space", bracket: false };
    }

    /** Whether the next token begins another value of a space list. */
    startsValue(): boolean {
        const token = this.peek();

        if (token.k === "end") {
            return false;
        }

        if (token.k === "op") {
            // A `-` or `+` with space before and none after (`$a -$b`) starts a new value; so does `(` and `[`.
            return (
                token.op === "(" ||
                token.op === "[" ||
                ((token.op === "-" || token.op === "+") &&
                    token.ws &&
                    !this.tokens[this.at + 1]!.ws)
            );
        }

        return !(
            token.k === "ident" &&
            token.parts.length === 1 &&
            ["and", "or", "from", "through", "to", "in"].includes(String(token.parts[0]))
        );
    }

    or(): Node {
        let left = this.and();

        while (this.isWord("or")) {
            this.at += 1;
            left = { k: "bin", op: "or", left, right: this.and() };
        }

        return left;
    }

    and(): Node {
        let left = this.equality();

        while (this.isWord("and")) {
            this.at += 1;
            left = { k: "bin", op: "and", left, right: this.equality() };
        }

        return left;
    }

    isWord(word: string): boolean {
        const token = this.peek();

        return token.k === "ident" && token.parts.length === 1 && token.parts[0] === word;
    }

    equality(): Node {
        let left = this.relation();

        while (this.isOp("==") || this.isOp("!=")) {
            const op = (this.next() as { op: string }).op;

            left = { k: "bin", op, left, right: this.relation() };
        }

        return left;
    }

    relation(): Node {
        let left = this.additive();

        while (["<", ">", "<=", ">="].some((op) => this.isOp(op))) {
            const op = (this.next() as { op: string }).op;

            left = { k: "bin", op, left, right: this.additive() };
        }

        return left;
    }

    additive(): Node {
        let left = this.multiplicative();

        for (;;) {
            const token = this.peek();

            if (token.k !== "op" || (token.op !== "+" && token.op !== "-")) {
                return left;
            }

            // `$a -$b` is two values, not a subtraction.
            if (
                token.ws &&
                !this.tokens[this.at + 1]!.ws &&
                this.depth >= 0 &&
                this.startsValue()
            ) {
                return left;
            }

            this.at += 1;
            left = { k: "bin", op: token.op, left, right: this.multiplicative() };
        }
    }

    multiplicative(): Node {
        let left = this.unary();

        while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
            const op = (this.next() as { op: string }).op;

            left = { k: "bin", op, left, right: this.unary() };
        }

        return left;
    }

    unary(): Node {
        if (++this.nest > 120) {
            throw new Unsupported("nested too deep");
        }

        try {
            return this.unaryInner();
        } finally {
            this.nest -= 1;
        }
    }

    unaryInner(): Node {
        const token = this.peek();

        if (token.k === "op" && (token.op === "-" || token.op === "+")) {
            this.at += 1;

            return { k: "un", op: token.op, value: this.unary() };
        }

        if (this.isWord("not")) {
            this.at += 1;

            return { k: "un", op: "not", value: this.unary() };
        }

        return this.primary();
    }

    primary(): Node {
        const token = this.next();

        switch (token.k) {
            case "num":
                return { k: "num", n: token.n, unit: token.unit };
            case "str":
                return { k: "str", parts: token.parts, quoted: true };
            case "color":
                return { k: "color", text: token.text };
            case "var":
                return { k: "var", name: token.name };
            case "interp":
                return { k: "interp", source: token.source };
            case "ident":
                return this.identifier(token);
            case "op":
                if (token.op === "(") {
                    return this.parenthesized();
                }

                if (token.op === "[") {
                    const inner =
                        this.peek().k === "op" && this.isOp("]")
                            ? {
                                  k: "list" as const,
                                  items: [],
                                  sep: "space" as const,
                                  bracket: false,
                              }
                            : this.commaList();

                    this.expectOp("]");

                    return inner.k === "list"
                        ? { ...inner, bracket: true }
                        : { k: "list", items: [inner], sep: "space", bracket: true };
                }

                throw new Unsupported(`unexpected ${token.op}`);
            default:
                throw new Unsupported("unexpected end");
        }
    }

    /** A name: a function call when `(` follows with no space, else a word (`white`, `solid`, `true`). */
    identifier(token: Extract<Tok, { k: "ident" }>): Node {
        const word =
            token.parts.length === 1 && typeof token.parts[0] === "string"
                ? token.parts[0]
                : undefined;
        const open = this.peek();

        if (this.isOp("(", open) && !open.ws) {
            this.at += 1;

            const name =
                word ?? token.parts.map((part) => (typeof part === "string" ? part : "")).join("");
            const args: Node[] = [];
            const named: [string, Node][] = [];

            while (!this.isOp(")")) {
                const here = this.peek();
                const after = this.tokens[this.at + 1]!;

                if (here.k === "var" && this.isOp(":", after)) {
                    this.at += 2;
                    named.push([here.name.replace(/^\$/, ""), this.spaceList()]);
                } else if (here.k === "op" && here.op === ".") {
                    throw new Unsupported("rest arguments");
                } else {
                    args.push(this.spaceList());
                }

                if (this.isOp(",")) {
                    this.at += 1;
                } else if (!this.isOp(")")) {
                    throw new Unsupported("expected , or )");
                }
            }

            this.at += 1;

            return { k: "call", name, args, named };
        }

        if (word === "true" || word === "false") {
            return { k: "call", name: word, args: [], named: [] };
        }

        if (word === "null") {
            return { k: "call", name: "null", args: [], named: [] };
        }

        return { k: "str", parts: token.parts, quoted: false };
    }

    /** `( … )`: grouping, a list, or a map. */
    parenthesized(): Node {
        if (this.isOp(")")) {
            this.at += 1;

            return { k: "list", items: [], sep: "space", bracket: false };
        }

        this.depth += 1;

        const first = this.spaceList();

        if (this.isOp(":")) {
            const entries: [Node, Node][] = [];
            let key = first;

            for (;;) {
                this.expectOp(":");
                entries.push([key, this.spaceList()]);

                if (!this.isOp(",")) {
                    break;
                }

                this.at += 1;

                if (this.isOp(")")) {
                    break;
                }

                key = this.spaceList();
            }

            this.depth -= 1;
            this.expectOp(")");

            return { k: "map", entries };
        }

        let inner: Node = first;

        if (this.isOp(",")) {
            const items = [first];

            while (this.isOp(",")) {
                this.at += 1;

                if (this.isOp(")")) {
                    break;
                }

                items.push(this.spaceList());
            }

            inner = { k: "list", items, sep: "comma", bracket: false };
        }

        this.depth -= 1;
        this.expectOp(")");

        // A single value in parentheses is that value (grouping); a list of one keeps being a list only with a comma.
        return inner;
    }
}

export function parseExpression(source: string): Node {
    return new Parser(source).parse();
}

// --- Evaluation -----------------------------------------------------------------------------------------------------------

/** What an evaluation needs from its surroundings. */
export interface Env {
    get(name: string): Value | undefined;
    /** A user function, or undefined. */
    call(name: string, positional: Value[], named: Map<string, Value>): Value | undefined;
    /** Counts an operation; throws when the budget is spent. */
    tick(): void;
}

/** A string or name with its interpolations evaluated. */
export function interpolate(parts: Part[], env: Env): string {
    return parts
        .map((part) => {
            if (typeof part === "string") {
                return part;
            }

            const value = evaluate(parseExpression(part.interp), env);

            return value.t === "str" ? value.s : text(value);
        })
        .join("");
}

const numeric = (value: Value): Num => {
    if (value.t !== "num") {
        throw new Unsupported("not a number");
    }

    return value;
};

/** The sum, difference, product, and quotient of two numbers, with their units (a missing unit takes the other's). */
function arithmetic(op: string, a: Num, b: Num): Value {
    switch (op) {
        case "+":
            return num(a.n + b.n, a.unit || b.unit);
        case "-":
            return num(a.n - b.n, a.unit || b.unit);
        case "*":
            return num(a.n * b.n, a.unit || b.unit);
        case "/":
            if (b.n === 0) {
                throw new Unsupported("division by zero");
            }

            return num(a.n / b.n, a.unit === b.unit ? "" : a.unit || b.unit);
        default:
            return num(b.n === 0 ? Number.NaN : a.n % b.n, a.unit || b.unit);
    }
}

export function evaluate(node: Node, env: Env): Value {
    env.tick();

    switch (node.k) {
        case "num":
            return num(node.n, node.unit);
        case "str":
            return str(interpolate(node.parts, env), node.quoted);
        case "color":
            return colorFromText(node.text) ?? str(node.text);

        case "interp": {
            const value = evaluate(parseExpression(node.source), env);

            return value.t === "str" ? str(value.s, false) : str(text(value));
        }

        case "var": {
            const value = env.get(node.name.replace(/^\$/, ""));

            if (value === undefined) {
                throw new Unsupported(`undefined ${node.name}`);
            }

            return value;
        }

        case "list":
            return list(
                node.items.map((item) => evaluate(item, env)),
                node.sep,
                node.bracket,
            );
        case "map":
            return {
                t: "map",
                entries: node.entries.map(([key, value]) => [
                    evaluate(key, env),
                    evaluate(value, env),
                ]),
            };

        case "un": {
            const value = evaluate(node.value, env);

            if (node.op === "not") {
                return bool(!truthy(value));
            }

            return node.op === "-" ? num(-numeric(value).n, numeric(value).unit) : value;
        }

        case "bin": {
            if (node.op === "and") {
                const left = evaluate(node.left, env);

                return truthy(left) ? evaluate(node.right, env) : left;
            }

            if (node.op === "or") {
                const left = evaluate(node.left, env);

                return truthy(left) ? left : evaluate(node.right, env);
            }

            const left = evaluate(node.left, env);
            const right = evaluate(node.right, env);

            switch (node.op) {
                case "==":
                    return bool(equal(left, right));
                case "!=":
                    return bool(!equal(left, right));
                case "<":
                case ">":
                case "<=":

                case ">=": {
                    const [a, b] = [numeric(left), numeric(right)];

                    return bool(
                        node.op === "<"
                            ? a.n < b.n
                            : node.op === ">"
                              ? a.n > b.n
                              : node.op === "<="
                                ? a.n <= b.n
                                : a.n >= b.n,
                    );
                }

                default:
                    break;
            }

            // Numbers calculate. A literal `16px/1.5` stays text (a font shorthand), `$a / 2` divides.
            if (left.t === "num" && right.t === "num") {
                if (node.op === "/" && node.left.k === "num" && node.right.k === "num") {
                    return str(`${text(left)}/${text(right)}`);
                }

                return arithmetic(node.op, left, right);
            }

            if (node.op === "+" && (left.t === "str" || right.t === "str")) {
                return str(
                    `${left.t === "str" ? left.s : text(left)}${right.t === "str" ? right.s : text(right)}`,
                    left.t === "str" && left.quoted,
                );
            }

            if (node.op === "/") {
                return str(`${text(left)}/${text(right)}`);
            }

            throw new Unsupported(`cannot ${node.op}`);
        }

        case "call": {
            const name = node.name;

            if (name === "true" || name === "false") {
                return bool(name === "true");
            }

            if (name === "null") {
                return NULL;
            }

            const positional = node.args.map((arg) => evaluate(arg, env));
            const named = new Map(
                node.named.map(([key, value]) => [key, evaluate(value, env)] as const),
            );
            const user = env.call(name, positional, named);

            if (user !== undefined) {
                return user;
            }

            const built = callBuiltin(name.replace(/^(?:sass:)?/, ""), { positional, named });

            if (built !== undefined) {
                return built;
            }

            // A CSS function (`var()`, `calc()`, `url()`): its arguments are written out.
            if (
                /^(?:var|calc|url|min|max|clamp|env|attr|translate|rotate|scale|linear-gradient|radial-gradient|cubic-bezier|rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|repeat|minmax|format|local)$/.test(
                    name,
                )
            ) {
                return str(
                    `${name}(${[...positional.map((value) => text(value)), ...[...named].map(([key, value]) => `${key}: ${text(value)}`)].join(", ")})`,
                );
            }

            throw new Unsupported(`unknown function ${name}`);
        }
    }
}
