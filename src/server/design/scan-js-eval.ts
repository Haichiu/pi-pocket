/**
 * A reader for the values of JavaScript and TypeScript modules (stream T): `export const blue = ['#eef5ff', …]`,
 * `const light = { background: gray[0], primary: blue[6] }`, `export const themes = { light, dark }`, across files
 * (`import { blue, gray } from './colors'`, `export * from`, `export { a as b } from`, `require('./x')`, `@/` and `~/`
 * aliases, workspace package names). It evaluates what a theme is made of and nothing else: object and array literals,
 * strings, templates, numbers, names, member access (`gray[0]`, `colors.brand.primary`, `palette['blue']`), spreads,
 * string `+`, `as const` and `satisfies`, and the calls that wrap an object (`defineConfig({…})`, `Object.freeze({…})`,
 * `createTheme({…})`, `rgb(1, 2, 3)`). A function body, a condition, or a call to anything else is not known. Nothing runs.
 * Every read is bounded in size, depth, and number of files.
 */
import { readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { readHead } from "./scan-files.ts";
import { type Literal, UNKNOWN } from "./scan-parse.ts";

const LIMITS = { files: 90, bytes: 300_000, nodes: 30_000, depth: 14, steps: 400_000 };

/** A name a module exports, as a way to get its value. */
interface Binding {
    value: () => Literal;
}

/** What a module declares: its constants, what it imports, and what it exports. */
interface ModuleInfo {
    file: string;
    text: string;
    /** `const name = …`: where the expression starts. */
    decls: Map<string, number>;
    /** Names bound by `import`: the file they come from, and the name in it (`*` for the whole module, `default`). */
    imports: Map<string, { from: string; name: string }>;
    /** Names the module exports: a local name, or a name of another module. */
    exports: Map<string, { local?: string; from?: string; name?: string; start?: number }>;
    /** `export * from`. */
    stars: string[];
}

const ID = String.raw`[A-Za-z_$][\w$]*`;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];

/** Wrappers whose first object argument is the value: `defineConfig({…})`, `createTheme({…})`, `Object.freeze({…})`. */
const WRAPPER =
    /^(?:define\w*|create\w*|extend\w*|make\w*|with\w*|freeze|identity|theme|tokens|config|css\w*|style\w*|as\w*)$/i;
/** Wrappers that merge their object arguments: `Object.assign({}, a, b)`, `merge(a, b)`, `deepmerge`. */
const MERGER = /^(?:assign|merge|deepmerge|defaultsDeep|mergeDeep|extend|mixin)$/i;

export class JsProject {
    readonly root: string;
    private readonly modules = new Map<string, ModuleInfo | null>();
    private readonly values = new Map<string, Literal>();
    private readonly active = new Set<string>();
    private readonly rels: Set<string>;
    private aliases: [string, string][] | undefined;
    private names: Map<string, string> | undefined;
    steps = 0;

    constructor(root: string, rels: Iterable<string>) {
        this.root = root;
        this.rels = new Set(rels);
    }

    /** The text of a file of the project, or undefined (not a file of it, too large, not readable). */
    textOf(rel: string): string | undefined {
        try {
            return readHead(join(this.root, ...rel.split("/")), LIMITS.bytes);
        } catch {
            return undefined;
        }
    }

    /** The file a specifier names, from a file: relative, an alias (`@/`, `~/`, a `paths` entry), or a workspace package. */
    resolve(from: string, spec: string): string | undefined {
        const tries: string[] = [];

        if (spec.startsWith(".")) {
            tries.push(posix.normalize(posix.join(posix.dirname(from), spec)));
        } else {
            for (const [prefix, target] of this.aliasList()) {
                if (spec === prefix || spec.startsWith(`${prefix}/`)) {
                    tries.push(posix.normalize(posix.join(target, spec.slice(prefix.length))));
                }
            }

            const [scope, name, ...rest] = spec.split("/");
            const pkg = spec.startsWith("@") ? `${scope}/${name}` : scope!;
            const dir = this.packageNames().get(pkg);

            if (dir !== undefined) {
                const sub = (spec.startsWith("@") ? rest : [name, ...rest]).filter(
                    (part): part is string => part !== undefined && part !== "",
                );

                tries.push(
                    posix.join(dir, ...(sub.length === 0 ? ["src"] : ["src", ...sub])),
                    posix.join(dir, ...sub),
                    posix.join(dir, "src", "index"),
                    posix.join(dir, "index"),
                );
            }

            for (const fallback of ["src", ""]) {
                tries.push(posix.join(fallback, spec));
            }
        }

        for (const base of tries) {
            const clean = base.replace(/^\.\//, "").replace(/\.(?:js|jsx|mjs|cjs)$/, "");

            for (const candidate of [base, clean]) {
                for (const extension of ["", ...EXTENSIONS]) {
                    for (const form of [
                        `${candidate}${extension}`,
                        `${candidate}/index${extension}`,
                    ]) {
                        if (this.rels.has(form) && /\.(?:[cm]?[jt]sx?|json)$/.test(form)) {
                            return form;
                        }
                    }
                }
            }
        }

        return undefined;
    }

    /** The `paths` of a tsconfig or jsconfig, and the usual `@/` and `~/` for `src`. */
    private aliasList(): [string, string][] {
        if (this.aliases !== undefined) {
            return this.aliases;
        }

        const out: [string, string][] = [
            ["@", "src"],
            ["~", "src"],
            ["#", "src"],
        ];

        for (const rel of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
            const text = this.textOf(rel);

            if (text === undefined) {
                continue;
            }

            for (const match of text.matchAll(
                /"([^"*]+)\/?\*?"\s*:\s*\[\s*"\.?\/?([^"*]*?)\/?\*?"/g,
            )) {
                out.push([match[1]!.replace(/\/$/, ""), match[2]!.replace(/\/$/, "")]);
            }
        }

        this.aliases = out.slice(0, 40);

        return this.aliases;
    }

    /** The names of the project's own packages (a monorepo's `packages/*`), by the folder of each. */
    private packageNames(): Map<string, string> {
        if (this.names !== undefined) {
            return this.names;
        }

        const out = new Map<string, string>();

        for (const rel of this.rels) {
            if (/(?:^|\/)package\.json$/.test(rel)) {
                const text = this.textOf(rel);
                const name =
                    text === undefined ? undefined : /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];

                if (name !== undefined && out.size < 80) {
                    out.set(name, dirname(rel) === "." ? "" : dirname(rel));
                }
            }
        }

        // `package.json` files are not in the list of scanned files: look for them beside the folders that are.
        if (out.size === 0) {
            for (const folder of new Set(
                [...this.rels].map((rel) => rel.split("/").slice(0, 2).join("/")),
            )) {
                for (const dir of [folder, folder.split("/")[0]!]) {
                    const text = this.textOf(`${dir}/package.json`);
                    const name =
                        text === undefined ? undefined : /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];

                    if (name !== undefined && out.size < 80) {
                        out.set(name, dir);
                    }
                }
            }

            for (const dir of ["packages", "libs", "apps", "modules"]) {
                try {
                    for (const entry of readdirSync(join(this.root, dir), {
                        withFileTypes: true,
                    })) {
                        const text = entry.isDirectory()
                            ? this.textOf(`${dir}/${entry.name}/package.json`)
                            : undefined;
                        const name =
                            text === undefined
                                ? undefined
                                : /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];

                        if (name !== undefined && out.size < 80) {
                            out.set(name, `${dir}/${entry.name}`);
                        }
                    }
                } catch {
                    // No such folder.
                }
            }
        }

        this.names = out;

        return out;
    }

    // --- Modules ---------------------------------------------------------------------------------------------------------

    module(file: string): ModuleInfo | undefined {
        if (this.modules.has(file)) {
            return this.modules.get(file) ?? undefined;
        }

        if (this.modules.size >= LIMITS.files) {
            return undefined;
        }

        const text = this.textOf(file);

        if (text === undefined) {
            this.modules.set(file, null);

            return undefined;
        }

        const info = this.parseModule(file, text);

        this.modules.set(file, info);

        return info;
    }

    private parseModule(file: string, text: string): ModuleInfo {
        const info: ModuleInfo = {
            file,
            text,
            decls: new Map(),
            imports: new Map(),
            exports: new Map(),
            stars: [],
        };

        if (file.endsWith(".json")) {
            info.exports.set("default", { start: 0 });

            return info;
        }

        const resolve = (spec: string) => this.resolve(file, spec);

        for (const match of text.matchAll(
            new RegExp(
                String.raw`^import\s+(?:type\s+)?([\s\S]{1,600}?)\s+from\s+["']([^"']+)["']`,
                "gm",
            ),
        )) {
            const from = resolve(match[2]!);

            if (from === undefined) {
                continue;
            }

            const clause = match[1]!;
            const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
            const star = new RegExp(String.raw`\*\s+as\s+(${ID})`).exec(clause)?.[1];
            const first = new RegExp(String.raw`^(${ID})\s*(?:,|$)`).exec(clause.trim())?.[1];

            if (first !== undefined && first !== "type") {
                info.imports.set(first, { from, name: "default" });
            }

            if (star !== undefined) {
                info.imports.set(star, { from, name: "*" });
            }

            for (const part of (named ?? "").split(",")) {
                const [, original, alias] =
                    new RegExp(String.raw`^\s*(?:type\s+)?(${ID})(?:\s+as\s+(${ID}))?\s*$`).exec(
                        part,
                    ) ?? [];

                if (original !== undefined) {
                    info.imports.set(alias ?? original, { from, name: original });
                }
            }
        }

        // CommonJS: `const { a, b } = require('./x')`, `const x = require('./x')`.
        for (const match of text.matchAll(
            new RegExp(
                String.raw`^(?:const|let|var)\s+(\{[^}]*\}|${ID})\s*=\s*require\(\s*["']([^"']+)["']\s*\)`,
                "gm",
            ),
        )) {
            const from = resolve(match[2]!);

            if (from === undefined) {
                continue;
            }

            if (match[1]!.startsWith("{")) {
                for (const part of match[1]!.slice(1, -1).split(",")) {
                    const [, original, alias] =
                        new RegExp(String.raw`^\s*(${ID})\s*(?::\s*(${ID}))?\s*$`).exec(part) ?? [];

                    if (original !== undefined) {
                        info.imports.set(alias ?? original, { from, name: original });
                    }
                }
            } else {
                info.imports.set(match[1]!, { from, name: "*" });
            }
        }

        for (const match of text.matchAll(
            new RegExp(
                String.raw`^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+(${ID})\s*(?::[^=\n]{1,200})?=(?!=|>)\s*`,
                "gm",
            ),
        )) {
            info.decls.set(match[2]!, match.index + match[0].length);

            if (match[1] !== undefined) {
                info.exports.set(match[2]!, { local: match[2]! });
            }
        }

        for (const match of text.matchAll(/^export\s+default\s+/gm)) {
            info.exports.set("default", { start: match.index + match[0].length });
        }

        for (const match of text.matchAll(/^module\.exports\s*=\s*/gm)) {
            info.exports.set("default", { start: match.index + match[0].length });
        }

        for (const match of text.matchAll(
            new RegExp(String.raw`^(?:module\.)?exports\.(${ID})\s*=\s*`, "gm"),
        )) {
            info.exports.set(match[1]!, { start: match.index + match[0].length });
        }

        for (const match of text.matchAll(
            /^export\s*(?:type\s*)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm,
        )) {
            const from = match[2] === undefined ? undefined : resolve(match[2]);

            for (const part of match[1]!.split(",")) {
                const [, original, alias] =
                    new RegExp(String.raw`^\s*(?:type\s+)?(${ID})(?:\s+as\s+(${ID}))?\s*$`).exec(
                        part,
                    ) ?? [];

                if (original === undefined) {
                    continue;
                }

                if (match[2] === undefined) {
                    info.exports.set(alias ?? original, { local: original });
                } else if (from !== undefined) {
                    info.exports.set(alias ?? original, { from, name: original });
                }
            }
        }

        for (const match of text.matchAll(
            /^export\s*\*\s*(?:as\s+(\w+)\s*)?from\s*["']([^"']+)["']/gm,
        )) {
            const from = resolve(match[2]!);

            if (from !== undefined) {
                if (match[1] === undefined) {
                    info.stars.push(from);
                } else {
                    info.exports.set(match[1], { from, name: "*" });
                }
            }
        }

        return info;
    }

    /** Every name a module exports, with a way to get its value. */
    exportsOf(file: string, depth = 0): Map<string, Binding> {
        const out = new Map<string, Binding>();
        const info = this.module(file);

        if (info === undefined || depth > 8) {
            return out;
        }

        for (const from of info.stars) {
            for (const [name, binding] of this.exportsOf(from, depth + 1)) {
                if (name !== "default" && !out.has(name)) {
                    out.set(name, binding);
                }
            }
        }

        for (const [name, entry] of info.exports) {
            out.set(name, {
                value: () => {
                    if (entry.local !== undefined) {
                        return this.declared(info, entry.local);
                    }

                    if (entry.from !== undefined) {
                        return this.imported(entry.from, entry.name!);
                    }

                    return entry.start === undefined ? UNKNOWN : this.evaluate(info, entry.start);
                },
            });
        }

        return out;
    }

    /** The value that a module exports under a name (`*` is an object of all of them). */
    imported(file: string, name: string): Literal {
        const all = this.exportsOf(file);

        if (name === "*") {
            const out: { [key: string]: Literal } = {};

            for (const [key, binding] of all) {
                out[key] = binding.value();
            }

            return out;
        }

        return all.get(name)?.value() ?? UNKNOWN;
    }

    /** The value of a constant that a module declares. */
    declared(info: ModuleInfo, name: string): Literal {
        const key = `${info.file}\0${name}`;

        if (this.values.has(key)) {
            return this.values.get(key)!;
        }

        const start = info.decls.get(name);

        if (start === undefined || this.active.has(key) || this.active.size > LIMITS.depth) {
            return UNKNOWN;
        }

        this.active.add(key);

        try {
            const value = this.evaluate(info, start);

            this.values.set(key, value);

            return value;
        } finally {
            this.active.delete(key);
        }
    }

    /** What a name means in a module: its own constant, or an import. */
    lookup(info: ModuleInfo, name: string): Literal {
        if (info.decls.has(name)) {
            return this.declared(info, name);
        }

        const binding = info.imports.get(name);

        return binding === undefined ? UNKNOWN : this.imported(binding.from, binding.name);
    }

    evaluate(info: ModuleInfo, start: number): Literal {
        if (info.file.endsWith(".json")) {
            try {
                return JSON.parse(info.text) as Literal;
            } catch {
                return UNKNOWN;
            }
        }

        const parser = new Parser(this, info, start);

        try {
            return parser.expression();
        } catch {
            return UNKNOWN;
        }
    }
}

// --- The expression reader -------------------------------------------------------------------------------------------------

class Stop extends Error {}

class Parser {
    private at: number;
    private nodes = 0;
    private readonly project: JsProject;
    private readonly info: ModuleInfo;
    private readonly text: string;

    constructor(project: JsProject, info: ModuleInfo, start: number) {
        this.project = project;
        this.info = info;
        this.text = info.text;
        this.at = start;
    }

    private tick(): void {
        if (++this.nodes > LIMITS.nodes || ++this.project.steps > LIMITS.steps) {
            throw new Stop();
        }
    }

    private skip(): void {
        for (;;) {
            const char = this.text[this.at];

            if (char !== undefined && /\s/.test(char)) {
                this.at += 1;
            } else if (this.text.startsWith("//", this.at)) {
                const end = this.text.indexOf("\n", this.at);

                this.at = end === -1 ? this.text.length : end + 1;
            } else if (this.text.startsWith("/*", this.at)) {
                const end = this.text.indexOf("*/", this.at + 2);

                this.at = end === -1 ? this.text.length : end + 2;
            } else {
                return;
            }
        }
    }

    private peek(): string {
        this.skip();

        return this.text[this.at] ?? "";
    }

    /** Skips to the end of an expression that cannot be read: the next `,` `;` `)` `]` `}` outside brackets. */
    private skipExpression(): Literal {
        let depth = 0;

        while (this.at < this.text.length) {
            this.tick();

            const char = this.text[this.at]!;

            if (char === '"' || char === "'" || char === "`") {
                this.readString();

                continue;
            }

            if ("([{".includes(char)) {
                depth += 1;
            } else if (")]}".includes(char)) {
                if (depth === 0) {
                    break;
                }

                depth -= 1;
            } else if ((char === "," || char === ";") && depth === 0) {
                break;
            } else if (
                char === "\n" &&
                depth === 0 &&
                !/[+\-*/%&|?:=<>,([{]\s*$/.test(
                    this.text.slice(Math.max(0, this.at - 3), this.at),
                ) &&
                !/^\s*(?:[+\-*/%&|?:.]|\|\||&&|\?\?)/.test(
                    this.text.slice(this.at + 1, this.at + 6),
                )
            ) {
                break;
            }

            this.at += 1;
        }

        return UNKNOWN;
    }

    private readString(): string | typeof UNKNOWN {
        const quote = this.text[this.at]!;

        this.at += 1;

        let out = "";
        let unknown = false;

        while (this.at < this.text.length && this.text[this.at] !== quote) {
            this.tick();

            const char = this.text[this.at]!;

            if (char === "\\") {
                const next = this.text[this.at + 1] ?? "";

                out += next === "n" ? "\n" : next === "t" ? "\t" : next;
                this.at += 2;
            } else if (quote === "`" && char === "$" && this.text[this.at + 1] === "{") {
                this.at += 2;

                const inner = this.expression();

                this.skip();

                if (this.text[this.at] === "}") {
                    this.at += 1;
                }

                if (typeof inner === "string" || typeof inner === "number") {
                    out += String(inner);
                } else {
                    unknown = true;
                }
            } else {
                out += char;
                this.at += 1;
            }

            if (out.length > 4000) {
                out = out.slice(0, 4000);
            }
        }

        this.at += 1;

        return unknown ? UNKNOWN : out;
    }

    /** An expression: a primary, its member accesses and calls, string `+`, and a TypeScript cast after it. */
    expression(depth = 0): Literal {
        this.tick();

        if (depth > LIMITS.depth) {
            throw new Stop();
        }

        let value = this.postfix(depth);

        for (;;) {
            const char = this.peek();

            if (char === "+" && this.text[this.at + 1] !== "+" && this.text[this.at + 1] !== "=") {
                this.at += 1;

                const right = this.postfix(depth);

                value =
                    (typeof value === "string" || typeof value === "number") &&
                    (typeof right === "string" || typeof right === "number")
                        ? typeof value === "number" && typeof right === "number"
                            ? value + right
                            : `${value}${right}`
                        : UNKNOWN;
            } else if (/^(?:as|satisfies)\s/.test(this.text.slice(this.at, this.at + 11))) {
                this.at += this.text.startsWith("as", this.at) ? 2 : 10;
                this.skipType();
            } else if (
                char === "?" ||
                char === "|" ||
                char === "&" ||
                char === "-" ||
                char === "*" ||
                char === "/" ||
                char === "=" ||
                char === "<" ||
                char === ">" ||
                char === "%"
            ) {
                // A condition, a calculation, a comparison: not a value that is known.
                this.skipExpression();

                return UNKNOWN;
            } else {
                return value;
            }
        }
    }

    /** Skips a TypeScript type after `as` or `satisfies`: `const`, `Theme`, `Record<string, string>`, `{ a: string }`. */
    private skipType(): void {
        this.skip();

        let depth = 0;

        while (this.at < this.text.length) {
            this.tick();

            const char = this.text[this.at]!;

            if ("<([{".includes(char)) {
                depth += 1;
            } else if (">)]}".includes(char)) {
                if (depth === 0) {
                    return;
                }

                depth -= 1;
            } else if (
                depth === 0 &&
                (char === "," ||
                    char === ";" ||
                    char === "\n" ||
                    char === "=" ||
                    (char === "&" && this.text[this.at + 1] === "&"))
            ) {
                return;
            } else if (
                depth === 0 &&
                char === " " &&
                !/^\s*(?:[|&.\w$]|\[|<)/.test(this.text.slice(this.at, this.at + 3))
            ) {
                return;
            }

            this.at += 1;
        }
    }

    private postfix(depth: number): Literal {
        let value = this.primary(depth);

        for (;;) {
            const char = this.peek();

            if (char === "." || (char === "?" && this.text[this.at + 1] === ".")) {
                const optional = char === "?";
                const from = this.at + (optional ? 2 : 1);
                const name = new RegExp(String.raw`^${ID}`).exec(
                    this.text.slice(from, from + 80),
                )?.[0];

                if (name === undefined) {
                    return value;
                }

                this.at = from + name.length;
                value = this.member(value, name);

                if (this.peek() === "(") {
                    this.at += 1;
                    this.arguments(depth);
                    value = UNKNOWN;
                }
            } else if (char === "[") {
                this.at += 1;

                const key = this.expression(depth + 1);

                if (this.peek() === "]") {
                    this.at += 1;
                }

                value =
                    typeof key === "string" || typeof key === "number"
                        ? this.member(value, String(key))
                        : UNKNOWN;
            } else if (char === "!" && this.text[this.at + 1] !== "=") {
                this.at += 1;
            } else {
                return value;
            }
        }
    }

    private member(value: Literal, key: string): Literal {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            return UNKNOWN;
        }

        if (Array.isArray(value)) {
            return /^\d+$/.test(key)
                ? (value[Number(key)] ?? UNKNOWN)
                : key === "length"
                  ? value.length
                  : UNKNOWN;
        }

        if (typeof value === "object" && value !== null) {
            return Object.hasOwn(value, key)
                ? (value as { [key: string]: Literal })[key]!
                : UNKNOWN;
        }

        return UNKNOWN;
    }

    /** The arguments of a call, evaluated; the `)` is read. */
    private arguments(depth: number): Literal[] {
        const out: Literal[] = [];

        while (this.at < this.text.length) {
            const char = this.peek();

            if (char === ")") {
                this.at += 1;

                break;
            }

            if (char === ",") {
                this.at += 1;

                continue;
            }

            if (this.text.startsWith("...", this.at)) {
                this.at += 3;
            }

            out.push(this.expression(depth + 1));

            if (out.length > 20) {
                break;
            }
        }

        return out;
    }

    private primary(depth: number): Literal {
        const char = this.peek();

        if (char === "{") {
            return this.object(depth);
        }

        if (char === "[") {
            return this.array(depth);
        }

        if (char === '"' || char === "'" || char === "`") {
            return this.readString();
        }

        if (char === "(") {
            // An arrow function (`(mode) => ({…})`), or a parenthesised expression.
            const close = this.matching(this.at);

            if (
                close !== undefined &&
                /^\s*(?::[^=]{1,80})?=>/.test(this.text.slice(close + 1, close + 100))
            ) {
                return this.arrow(close + 1);
            }

            this.at += 1;

            const inner = this.expression(depth + 1);

            if (this.peek() === ")") {
                this.at += 1;
            }

            return inner;
        }

        if (char === "-" || char === "+") {
            const sign = char === "-" ? -1 : 1;

            this.at += 1;

            const inner = this.postfix(depth);

            return typeof inner === "number" ? sign * inner : UNKNOWN;
        }

        if (char === "<") {
            // A TypeScript cast, `<Theme>{…}`, or JSX: skip the angle brackets, read what follows.
            const close = this.text.indexOf(">", this.at);

            if (close !== -1 && close - this.at < 80) {
                this.at = close + 1;

                return this.postfix(depth);
            }

            return this.skipExpression();
        }

        const number = /^(?:0x[0-9a-f]+|\d[\d_]*\.?\d*(?:e[+-]?\d+)?|\.\d+)/i.exec(
            this.text.slice(this.at, this.at + 40),
        );

        if (number !== null) {
            this.at += number[0].length;

            return number[0].toLowerCase().startsWith("0x")
                ? Number.parseInt(number[0], 16)
                : Number(number[0].replaceAll("_", ""));
        }

        const word = new RegExp(String.raw`^${ID}`).exec(
            this.text.slice(this.at, this.at + 100),
        )?.[0];

        if (word === undefined) {
            return this.skipExpression();
        }

        this.at += word.length;

        if (word === "true" || word === "false") {
            return word === "true";
        }

        if (word === "null") {
            return null;
        }

        if (word === "undefined") {
            return UNKNOWN;
        }

        if (
            word === "async" ||
            word === "function" ||
            word === "class" ||
            word === "new" ||
            word === "typeof" ||
            word === "await"
        ) {
            return this.skipExpression();
        }

        // `name<Type>(`: a call with type arguments.
        if (this.text[this.at] === "<") {
            const generic = this.matchingAngle(this.at);

            if (generic !== undefined && this.text[generic + 1] === "(") {
                this.at = generic + 1;
            }
        }

        // A dotted callee: `Object.freeze`, `theme.extend`, `utils.merge`.
        let callee = word;

        for (;;) {
            const next = new RegExp(String.raw`^\.(${ID})`).exec(
                this.text.slice(this.at, this.at + 80),
            );

            if (next === null || this.text[this.at + next[0].length] === undefined) {
                break;
            }

            // A member of a value we know is read by `postfix`; a call through dots is a callee.
            if (this.knownName(word)) {
                break;
            }

            callee = `${callee}.${next[1]}`;
            this.at += next[0].length;
        }

        if (this.peek() === "(") {
            this.at += 1;

            return this.call(callee, this.arguments(depth));
        }

        if (
            this.text.startsWith("=>", this.at) ||
            /^\s*=>/.test(this.text.slice(this.at, this.at + 6))
        ) {
            this.skip();

            return this.arrow(this.at);
        }

        return this.project.lookup(this.info, word);
    }

    private knownName(name: string): boolean {
        return this.info.decls.has(name) || this.info.imports.has(name);
    }

    /** The index of the bracket that closes the one at `open`, or undefined. */
    private matching(open: number): number | undefined {
        let depth = 0;

        for (let at = open; at < Math.min(this.text.length, open + 3000); at++) {
            const char = this.text[at]!;

            if (char === '"' || char === "'" || char === "`") {
                const end = this.text.indexOf(char, at + 1);

                if (end === -1) {
                    return undefined;
                }

                at = end;
            } else if ("([{".includes(char)) {
                depth += 1;
            } else if (")]}".includes(char) && --depth === 0) {
                return at;
            }
        }

        return undefined;
    }

    private matchingAngle(open: number): number | undefined {
        let depth = 0;

        for (let at = open; at < Math.min(this.text.length, open + 200); at++) {
            const char = this.text[at]!;

            if (char === "<") {
                depth += 1;
            } else if (char === ">" && --depth === 0) {
                return at;
            } else if (!/[\w$<>,\s.[\]|&{}:'"?]/.test(char)) {
                return undefined;
            }
        }

        return undefined;
    }

    /** An arrow function: its body is known when it is an object (`() => ({…})`) or a plain expression of no parameters. */
    private arrow(arrowFrom: number): Literal {
        this.at = arrowFrom;
        this.skip();

        if (!this.text.startsWith("=>", this.at)) {
            const colon = this.text.indexOf("=>", this.at);

            this.at = colon === -1 ? this.text.length : colon;
        }

        this.at += 2;

        if (this.peek() === "{") {
            // A block body: not known.
            const close = this.matching(this.at);

            this.at = close === undefined ? this.text.length : close + 1;

            return UNKNOWN;
        }

        return this.expression(1);
    }

    private call(callee: string, args: Literal[]): Literal {
        const last = callee.split(".").at(-1)!;
        const objects = args.filter(
            (arg): arg is { [key: string]: Literal } =>
                typeof arg === "object" && arg !== null && !Array.isArray(arg),
        );

        if (
            /^(?:rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch)$/i.test(callee) &&
            args.every((arg) => typeof arg === "number" || typeof arg === "string")
        ) {
            return `${callee}(${args.length === 4 && /^(?:rgb|hsl)$/i.test(callee) ? args.slice(0, 3).join(", ") + " / " + args[3] : args.join(", ")})`.replace(
                /^(rgb|hsl)a?\(/i,
                (m) => m,
            );
        }

        if (MERGER.test(last) || /^(?:Object\.)?assign$/i.test(callee)) {
            return Object.assign({}, ...objects);
        }

        if (WRAPPER.test(last) && objects.length > 0) {
            return objects.length === 1 ? objects[0]! : Object.assign({}, ...objects);
        }

        if (
            args.length === 1 &&
            (typeof args[0] === "object" || typeof args[0] === "string") &&
            /^(?:String|Object|Number)$/.test(callee)
        ) {
            return args[0]!;
        }

        return UNKNOWN;
    }

    private object(depth: number): Literal {
        this.at += 1;

        const out: { [key: string]: Literal } = {};

        while (this.at < this.text.length) {
            const char = this.peek();

            if (char === "}") {
                this.at += 1;

                break;
            }

            if (char === ",") {
                this.at += 1;

                continue;
            }

            this.tick();

            if (this.text.startsWith("...", this.at)) {
                this.at += 3;

                const spread = this.expression(depth + 1);

                if (typeof spread === "object" && spread !== null && !Array.isArray(spread)) {
                    for (const [key, child] of Object.entries(spread)) {
                        if (key !== "__proto__" && key !== "constructor") {
                            out[key] = child;
                        }
                    }
                }

                continue;
            }

            let key: string | undefined;

            if (char === '"' || char === "'" || char === "`") {
                const read = this.readString();

                key = typeof read === "string" ? read : undefined;
            } else if (char === "[") {
                this.at += 1;

                const computed = this.expression(depth + 1);

                if (this.peek() === "]") {
                    this.at += 1;
                }

                key =
                    typeof computed === "string" || typeof computed === "number"
                        ? String(computed)
                        : undefined;
            } else {
                const bare = /^(?:-?\d+(?:\.\d+)?|[A-Za-z_$][\w$-]*)/.exec(
                    this.text.slice(this.at, this.at + 100),
                )?.[0];

                if (bare === undefined) {
                    this.skipExpression();

                    continue;
                }

                // `get x() {…}`, `async method() {…}`: not values.
                key = bare;
                this.at += bare.length;
            }

            const after = this.peek();

            if (after === ":") {
                this.at += 1;

                const value = this.expression(depth + 1);

                if (
                    key !== undefined &&
                    key !== "__proto__" &&
                    key !== "constructor" &&
                    key !== "prototype"
                ) {
                    out[key] = value;
                }
            } else if ((after === "," || after === "}") && key !== undefined) {
                // Shorthand: `{ blue, gray }`.
                const found = this.project.lookup(this.info, key);

                if (found !== UNKNOWN) {
                    out[key] = found;
                }
            } else if (after === "(" || after === "<") {
                // A method.
                const close = this.matching(this.text.indexOf("(", this.at));

                this.at = close === undefined ? this.text.length : close + 1;
                this.skip();

                if (this.text[this.at] === ":") {
                    this.skipExpression();
                }

                if (this.peek() === "{") {
                    const end = this.matching(this.at);

                    this.at = end === undefined ? this.text.length : end + 1;
                }
            } else {
                this.skipExpression();
            }
        }

        return out;
    }

    private array(depth: number): Literal {
        this.at += 1;

        const out: Literal[] = [];

        while (this.at < this.text.length) {
            const char = this.peek();

            if (char === "]") {
                this.at += 1;

                break;
            }

            if (char === ",") {
                this.at += 1;

                continue;
            }

            if (this.text.startsWith("...", this.at)) {
                this.at += 3;

                const spread = this.expression(depth + 1);

                if (Array.isArray(spread)) {
                    out.push(...spread);
                }

                continue;
            }

            out.push(this.expression(depth + 1));

            if (out.length > 600) {
                break;
            }
        }

        return out;
    }
}
