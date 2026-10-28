/**
 * The Sass of a palette (stream T): a stylesheet's `@each` and `@for` loops, `@if`, `@function`, `@mixin`, maps, and color
 * functions run, and the result written as the stylesheet that Sass would make, on the same lines as the source: the
 * variables as they end (`$palette: (primary-500: #3b82f6, …)`), the custom properties a loop makes
 * (`--color-brand-300: #93c5fd`), and the rules and declarations with their values worked out. The scan then reads that text
 * as it reads any stylesheet. Whatever cannot be evaluated is left as it was written.
 *
 * Variables, functions, and mixins live in one environment for the whole project, so that a file that `@use`s or `@import`s
 * another sees its variables, in the order the files depend on each other.
 */
import { Unsupported, evaluate, interpolate, parseExpression, type Env } from "./scan-sass-expr.ts";
import {
    type Flat,
    type Fn,
    Module,
    defaultNamespace,
    parseModuleRule,
    resolveModule,
} from "./scan-sass-modules.ts";
import { LIMITS, dependenciesOf, splitTop, statementsOf, type Stmt } from "./scan-sass-stmt.ts";
import {
    NULL,
    builtinConstant,
    declText,
    hasBuiltin,
    itemsOf,
    list,
    num,
    str,
    text,
    truthy,
    type Value,
} from "./scan-sass-values.ts";

/** The Sass modules that come with it: a namespace of one of them is a call to a built-in function. */
const BUILTIN_MODULES = new Set(["color", "math", "map", "list", "string", "meta", "selector"]);

// --- The environment ------------------------------------------------------------------------------------------------------

/**
 * The stylesheets of a project: the modules they make, and the flat environment of the variables, functions, and mixins
 * that every one declared (the fallback for a name that no module explains).
 */
export class Project implements Flat {
    /** When the work for the whole project must stop: a project of many stylesheets must not hold the scan. */
    deadline = Date.now() + 4000;
    vars = new Map<string, Value>();
    functions = new Map<string, Fn>();
    mixins = new Map<string, Fn>();
    /** The text of each stylesheet, by path: what `@use` and `@import` can load. */
    files = new Map<string, string>();
    /** The modules that were run, by path and configuration; a configured module is a copy. */
    modules = new Map<string, Module>();
    failed = new Set<Module>();
    private parsed = new Map<string, Stmt[]>();
    private depth = 0;
    private compilation: Map<string, Module> | undefined;

    /** Runs a stylesheet as a module (once for each configuration) and returns it; undefined when the project has no such file. */
    load(rel: string, config?: Map<string, Value>): Module | undefined {
        const key =
            config === undefined || config.size === 0
                ? rel
                : `${rel}\0${[...config].map(([name, value]) => `${name}=${declText(value)}`).join("\0")}`;
        // A module is loaded once in a compilation: a plain `@use` of one that an earlier `@use … with` configured gets that copy.
        const root = this.compilation === undefined;
        const loaded = this.compilation?.get(rel);

        if (loaded !== undefined && key === rel) {
            return loaded;
        }

        const have = this.modules.get(key);

        if (have !== undefined) {
            this.compilation?.set(rel, have);

            return have;
        }

        const text = this.files.get(rel);

        if (text === undefined) {
            return undefined;
        }

        if (this.depth > 24) {
            throw new Unsupported("modules nest too deep");
        }

        const module = new Module(
            rel,
            this,
            config === undefined || config.size === 0 ? undefined : config,
        );

        this.modules.set(key, module);
        this.compilation ??= new Map();
        this.compilation.set(rel, module);
        this.depth += 1;

        try {
            let stmts = this.parsed.get(rel);

            if (stmts === undefined) {
                stmts = statementsOf(text, 1);
                this.parsed.set(rel, stmts);
            }

            const run = new Run(this, module);

            run.block(stmts, true);
            module.text = run.out.join("");
        } catch (error) {
            if (!(error instanceof Unsupported) && !(error instanceof RangeError)) {
                throw error;
            }

            this.failed.add(module);
        } finally {
            this.depth -= 1;

            if (root) {
                this.compilation = undefined;
            }
        }

        return module;
    }
}

class Scope {
    vars = new Map<string, Value>();
    parent: Scope | undefined;
    /** Control flow (`@each`, `@if`) does not make a variable of its own: an assignment reaches the scope outside it. */
    flow: boolean;

    constructor(parent: Scope | undefined, flow: boolean) {
        this.parent = parent;
        this.flow = flow;
    }

    get(name: string, module: Module, flat = true): Value | undefined {
        for (let scope: Scope | undefined = this; scope !== undefined; scope = scope.parent) {
            const found = scope.vars.get(name);

            if (found !== undefined) {
                return found;
            }
        }

        return module.lookup<Value>("vars", name, flat);
    }

    /** Sets a variable and says whether it is the module's own (a global one). */
    set(name: string, value: Value, module: Module, forceGlobal: boolean): boolean {
        if (forceGlobal || this.parent === undefined) {
            module.setVar(name, value);

            return true;
        }

        // An assignment reaches a variable that exists in this scope or in the control flow around it.
        let scope: Scope = this;

        for (;;) {
            if (scope.vars.has(name)) {
                scope.vars.set(name, value);

                return false;
            }

            if (!scope.flow || scope.parent === undefined) {
                break;
            }

            scope = scope.parent;
        }

        // Control flow at the top level assigns the project's variable when there is one; else the variable is its own.
        if (scope.parent === undefined && (module.vars.has(name) || module.flat.vars.has(name))) {
            module.setVar(name, value);

            return true;
        }

        this.vars.set(name, value);

        return false;
    }
}

/** What a run of one stylesheet makes. */
class Run implements Env {
    project: Project;
    /** The module whose code runs: a function from another module runs in its own. */
    module: Module;
    scope: Scope;
    ticks = 0;
    iterations = 0;
    out: string[] = [];
    /** The line the output has reached: a statement is written on the line it had in the source. */
    outLine = 1;
    /** How deep the statements are in control flow that repeats: a variable set there is written when the flow ends. */
    repeating = 0;
    pending = new Map<string, Value>();
    size = 0;
    depth = 0;
    returned: Value | undefined;
    returnFlag = false;
    content: Stmt[] | undefined;
    contentScope: Scope | undefined;
    contentModule: Module | undefined;

    constructor(project: Project, module: Module) {
        this.project = project;
        this.module = module;
        this.scope = new Scope(undefined, false);
    }

    tick(): void {
        if (++this.ticks > LIMITS.ticks) {
            throw new Unsupported("too much work");
        }

        if ((this.ticks & 255) === 0 && Date.now() > this.project.deadline) {
            throw new Unsupported("out of time");
        }
    }

    get(name: string, namespace?: string): Value | undefined {
        if (namespace !== undefined) {
            const target = this.module.namespace(namespace);

            if (target instanceof Module) {
                return target.member<Value>("vars", name);
            }

            if (typeof target === "string") {
                return builtinConstant(target, name);
            }
        }

        return this.scope.get(name, this.module);
    }

    /** The built-in name of a call: `c.adjust` for `@use "sass:color" as c`, `div` for `@use "sass:math" as *`. */
    builtin(name: string): string {
        const dot = name.indexOf(".");

        if (dot > 0) {
            const target = this.module.namespace(name.slice(0, dot));

            return typeof target === "string" ? `${target}.${name.slice(dot + 1)}` : name;
        }

        for (const library of this.module.openBuiltins) {
            if (hasBuiltin(`${library}.${name}`)) {
                return `${library}.${name}`;
            }
        }

        return name;
    }

    /** A function or a mixin: by its bare name, or through a namespace (`p.fn`); a name through a built-in namespace is none. */
    find(kind: "functions" | "mixins", name: string): Fn | undefined {
        const dot = name.indexOf(".");

        if (dot <= 0) {
            return this.module.lookup<Fn>(kind, name);
        }

        const target = this.module.namespace(name.slice(0, dot));
        const bare = name.slice(dot + 1);

        if (target instanceof Module) {
            return target.member<Fn>(kind, bare);
        }

        // A namespace that no module explains is the old reading: the name without it (but not a built-in module's).
        return typeof target === "string" || BUILTIN_MODULES.has(name.slice(0, dot))
            ? undefined
            : this.module.lookup<Fn>(kind, bare);
    }

    call(name: string, positional: Value[], named: Map<string, Value>): Value | undefined {
        const fn = this.find("functions", name);

        if (fn === undefined) {
            return undefined;
        }

        if (this.depth > 20) {
            throw new Unsupported("functions nest too deep");
        }

        const saved = [this.scope, this.returned, this.returnFlag, this.module] as const;
        const away = fn.module !== undefined && fn.module !== this.module;

        // The body sees the members of the module that declared it.
        if (away) {
            this.module = fn.module!;
        }

        this.scope = new Scope(
            away
                ? new Scope(undefined, false)
                : this.scope.parent === undefined
                  ? this.scope
                  : this.rootScope(),
            false,
        );
        this.bind(fn, positional, named);
        this.depth += 1;
        this.returned = undefined;
        this.returnFlag = false;

        try {
            this.block(fn.body, false);

            return this.returned;
        } finally {
            this.depth -= 1;
            [this.scope, this.returned, this.returnFlag, this.module] = saved;
        }
    }

    /** The outermost scope (variables of a function body do not see the caller's locals). */
    rootScope(): Scope {
        let scope = this.scope;

        while (scope.parent !== undefined) {
            scope = scope.parent;
        }

        return scope;
    }

    bind(fn: Fn, positional: Value[], named: Map<string, Value>): void {
        fn.params.forEach((param, at) => {
            if (param.rest) {
                this.scope.vars.set(param.name, list(positional.slice(at)));

                return;
            }

            const given = named.get(param.name) ?? positional[at];

            if (given !== undefined) {
                this.scope.vars.set(param.name, given);
            } else if (param.fallback !== undefined) {
                this.scope.vars.set(param.name, evaluate(parseExpression(param.fallback), this));
            } else {
                throw new Unsupported(`missing ${param.name}`);
            }
        });
    }

    /** Writes text on the line the statement had. */
    write(textOut: string, line: number): void {
        if (this.repeating > 0 && line < this.outLine) {
            line = this.outLine;
        }

        const pad = line > this.outLine ? "\n".repeat(Math.min(line - this.outLine, 40)) : " ";

        this.out.push(pad, textOut);
        this.size += textOut.length;
        this.outLine = Math.max(this.outLine, line);

        if (this.size > LIMITS.output) {
            throw new Unsupported("too much output");
        }
    }

    /** `#{…}` in a piece of text, evaluated. */
    interpolated(source: string): string {
        let out = "";
        let at = 0;

        while (at < source.length) {
            const open = source.indexOf("#{", at);

            if (open === -1) {
                out += source.slice(at);

                break;
            }

            let level = 0;
            let close = open + 1;

            for (; close < source.length; close++) {
                level += source[close] === "{" ? 1 : source[close] === "}" ? -1 : 0;

                if (level === 0) {
                    break;
                }
            }

            out += source.slice(at, open);

            const value = evaluate(parseExpression(source.slice(open + 2, close)), this);

            out += value.t === "str" ? value.s : text(value);
            at = close + 1;
        }

        return out;
    }

    /** Runs the statements of a block. `emit` says whether rules and declarations are written. */
    block(stmts: Stmt[], emit: boolean): void {
        for (let at = 0; at < stmts.length; at++) {
            if (this.returnFlag) {
                return;
            }

            const stmt = stmts[at]!;

            // `@if` and the `@else`s after it are one statement.
            if (/^@if\b/.test(stmt.head)) {
                let end = at + 1;

                while (end < stmts.length && /^@else\b/.test(stmts[end]!.head)) {
                    end += 1;
                }

                const chain = stmts.slice(at, end);

                try {
                    this.conditional(chain, emit);
                } catch (error) {
                    if (!(error instanceof Unsupported)) {
                        throw error;
                    }

                    chain.forEach((each) => this.fallback(each, emit));
                }

                at = end - 1;

                continue;
            }

            try {
                this.statement(stmt, emit);
            } catch (error) {
                if (!(error instanceof Unsupported) && !(error instanceof RangeError)) {
                    throw error;
                }

                this.fallback(stmt, emit);
            }
        }
    }

    /** A statement that cannot be run is written as it was, with the variables it loses forgotten. */
    fallback(stmt: Stmt, emit: boolean): void {
        const assign = /^\$([\w-]+)\s*:/.exec(stmt.head);

        if (assign !== null) {
            this.scope.vars.delete(assign[1]!);
            this.module.deleteVar(assign[1]!);
        }

        if (
            emit &&
            stmt.raw !== "" &&
            !/^@(?:use|forward|import|function|mixin|return|include|content)\b/.test(stmt.head)
        ) {
            this.write(
                stmt.raw.endsWith("}") || stmt.raw.endsWith(";") ? stmt.raw : `${stmt.raw};`,
                stmt.line,
            );
        }
    }

    statement(stmt: Stmt, emit: boolean): void {
        this.tick();

        const head = stmt.head;

        // A variable: `$name: expression [!default] [!global];`
        const assign = /^\$([\w-]+)\s*:\s*([\s\S]*)$/.exec(head);

        if (assign !== null && stmt.body === undefined) {
            this.assign(stmt, assign[1]!, assign[2]!, emit);

            return;
        }

        if (head.startsWith("@")) {
            this.atRule(stmt, emit);

            return;
        }

        if (stmt.body !== undefined) {
            this.rule(stmt, emit);

            return;
        }

        if (emit) {
            this.declaration(stmt);
        }
    }

    assign(stmt: Stmt, name: string, rawValue: string, emit: boolean): void {
        const flags = /\s*!(default|global)\b/g;
        const isDefault = /!default\b/.test(rawValue);
        const isGlobal = /!global\b/.test(rawValue);
        const source = rawValue.replace(flags, "").trim();

        // A `!default` variable of a module that `@use … with (…)` configured takes the configured value.
        const configured =
            isDefault && this.scope.parent === undefined && !this.module.applied.has(name)
                ? this.module.config?.get(name)
                : undefined;

        if (configured !== undefined) {
            this.module.applied.add(name);
        } else if (
            isDefault &&
            this.scope.get(name, this.module, false) !== undefined &&
            this.scope.get(name, this.module, false)!.t !== "null"
        ) {
            // `!default`: a variable that this stylesheet or what it opens already has stays. The project's flat environment
            // does not count: other stylesheets are compiled apart.
            return;
        }

        let value: Value;

        try {
            value = configured ?? evaluate(parseExpression(source), this);
        } catch (error) {
            if (!(error instanceof Unsupported)) {
                throw error;
            }

            // Left as it was written: the value of the variable is unknown here, but the text may still be read.
            if (emit) {
                this.write(`$${name}: ${this.interpolatedSafe(source)};`, stmt.line);
            }

            this.scope.vars.delete(name);
            this.module.deleteVar(name);

            return;
        }

        const global = this.scope.set(name, value, this.module, isGlobal);

        // A variable that a loop or a function keeps for itself is not the stylesheet's: only globals and a rule's own are written.
        if (emit && value.t !== "null" && (global || !this.scope.flow)) {
            // An alias (`$a: $b`) or a plain value keeps its text: the scan follows an alias by itself.
            const plain =
                /^\$[\w-]+$/.test(source) ||
                (!/[\w-]\(|[+*/%]|#\{/.test(source) && !/\$/.test(source));

            if (this.repeating > 0 && (value.t === "map" || value.t === "list")) {
                this.pending.set(name, value);
            } else {
                this.write(`$${name}: ${plain ? source : declText(value)};`, stmt.line);
            }
        }
    }

    interpolatedSafe(source: string): string {
        try {
            return this.interpolated(source);
        } catch {
            return source;
        }
    }

    rule(stmt: Stmt, emit: boolean): void {
        const selector = this.interpolatedSafe(stmt.head).replace(/\s+/g, " ");
        const before = this.scope;

        this.scope = new Scope(this.scope, false);

        try {
            this.write(`${selector} {`, stmt.line);
            this.block(stmt.body!, emit);
            this.write("}", this.outLine);
        } finally {
            this.scope = before;
        }
    }

    declaration(stmt: Stmt): void {
        const colon = stmt.head.indexOf(":");

        if (colon === -1) {
            return;
        }

        const name = this.interpolatedSafe(stmt.head.slice(0, colon).trim());
        const value = stmt.head.slice(colon + 1).trim();

        // A custom property is text: only `#{}` is evaluated in it. Any other property is an expression.
        if (name.startsWith("--") || !/[$()]|#\{/.test(value)) {
            this.write(`${name}: ${this.interpolatedSafe(value)};`, stmt.line);

            return;
        }

        // A value with variables and plain CSS in it (`1px solid $border`) keeps its text: the scan follows the variables. A
        // value that calculates (`math.div($a, 2)`, `$a * 2`) is worked out.
        if (!/[\w-]\(|[+*/%]|#\{/.test(value.replace(/\$[\w-]+/g, ""))) {
            this.write(`${name}: ${value};`, stmt.line);

            return;
        }

        const important = /\s*!important\s*$/i.test(value);
        const source = value.replace(/\s*!important\s*$/i, "");

        try {
            const result = evaluate(parseExpression(source), this);

            this.write(`${name}: ${text(result)}${important ? " !important" : ""};`, stmt.line);
        } catch (error) {
            if (!(error instanceof Unsupported)) {
                throw error;
            }

            this.write(`${name}: ${this.interpolatedSafe(value)};`, stmt.line);
        }
    }

    atRule(stmt: Stmt, emit: boolean): void {
        const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(stmt.head)!;
        const name = match[1]!;
        const rest = match[2]!.trim();

        switch (name) {
            case "use":
                this.useRule(rest);

                return;

            case "forward":
                this.forwardRule(rest);

                return;

            case "import":
                this.importRule(rest);

                return;

            case "charset":
            case "debug":
            case "warn":
            case "error":
            case "extend":
                return;

            case "function":
            case "mixin":
                this.define(name, rest, stmt);

                return;

            case "return": {
                this.returned = evaluate(parseExpression(rest), this);
                this.returnFlag = true;

                return;
            }

            case "include":
                this.include(rest, stmt, emit);

                return;

            case "content":
                if (this.content !== undefined && this.contentScope !== undefined) {
                    const saved = [this.scope, this.module] as const;

                    this.scope = this.contentScope;
                    this.module = this.contentModule ?? this.module;

                    try {
                        this.block(this.content, emit);
                    } finally {
                        [this.scope, this.module] = saved;
                    }
                }

                return;

            case "each":
                this.each(stmt, rest, emit);

                return;

            case "for":
                this.forLoop(stmt, rest, emit);

                return;

            case "while":
                this.whileLoop(stmt, rest, emit);

                return;

            default:
                break;
        }

        // Another at-rule (`@media`, `@supports`, `@layer`, `@keyframes`, `@font-face`) is written with its block.
        if (stmt.body !== undefined) {
            const before = this.scope;

            this.scope = new Scope(this.scope, true);

            try {
                if (emit) {
                    this.write(
                        `@${name} ${this.interpolatedSafe(rest)} {`.replace(/\s+\{/, " {"),
                        stmt.line,
                    );
                }

                this.block(stmt.body, emit);

                if (emit) {
                    this.write("}", this.outLine);
                }
            } finally {
                this.scope = before;
            }
        } else if (emit) {
            this.write(`${stmt.head};`, stmt.line);
        }
    }

    /** The values of `with ($a: 1, $b: red !default)`, evaluated here; a `!default` entry may be overridden by an outer configuration. */
    configOf(entries: string[], outer?: Map<string, Value>): Map<string, Value> | undefined {
        const config = new Map<string, Value>(outer ?? []);

        for (const entry of entries.slice(0, 60)) {
            const match = /^\$([\w-]+)\s*:\s*([\s\S]+?)\s*(!default)?$/.exec(entry);

            if (match === null) {
                continue;
            }

            try {
                if (match[3] === undefined || !config.has(match[1]!)) {
                    config.set(match[1]!, evaluate(parseExpression(match[2]!), this));
                }
            } catch (error) {
                if (!(error instanceof Unsupported)) {
                    throw error;
                }
            }
        }

        return config.size === 0 ? undefined : config;
    }

    /** `@use "path" as ns with (…)`: the module under its namespace. A path that is no file of the project is read as it was. */
    useRule(rest: string): void {
        const rule = parseModuleRule(rest);

        if (rule === undefined) {
            return;
        }

        if (rule.path.startsWith("sass:")) {
            const library = rule.path.slice(5);

            if (rule.namespace === "*") {
                this.module.openBuiltins.push(library);
            } else {
                this.module.uses.set(rule.namespace ?? library, library);
            }

            return;
        }

        const rel = resolveModule(this.module.rel, rule.path, this.project.files.keys());
        const loaded =
            rel === undefined ? undefined : this.project.load(rel, this.configOf(rule.config));

        if (loaded === undefined) {
            return;
        }

        if (rule.namespace === "*") {
            this.module.opened.push(loaded);
        } else {
            this.module.uses.set(rule.namespace ?? defaultNamespace(rule.path), loaded);
        }
    }

    /** `@forward "path" as list-* show a, $b`: the module's members, handed on to whoever `@use`s this one. */
    forwardRule(rest: string): void {
        const rule = parseModuleRule(rest);

        if (rule === undefined || rule.path.startsWith("sass:")) {
            return;
        }

        const rel = resolveModule(this.module.rel, rule.path, this.project.files.keys());
        const loaded =
            rel === undefined
                ? undefined
                : this.project.load(rel, this.configOf(rule.config, this.module.config));

        if (loaded === undefined) {
            return;
        }

        this.module.forwards.push({
            module: loaded,
            prefix: rule.prefix,
            show: rule.show === undefined ? undefined : new Set(rule.show),
            hide: rule.hide === undefined ? undefined : new Set(rule.hide),
        });
    }

    /** `@import "a", "b"`: the files' members are the importer's own. */
    importRule(rest: string): void {
        for (const match of rest.matchAll(/["']([^"'\n]{1,300})["']/g)) {
            const rel = resolveModule(this.module.rel, match[1]!, this.project.files.keys());
            const loaded =
                rel === undefined || rel === this.module.rel ? undefined : this.project.load(rel);

            if (
                loaded !== undefined &&
                loaded !== this.module &&
                !this.module.opened.includes(loaded)
            ) {
                this.module.opened.push(loaded);
            }
        }
    }

    define(kind: "function" | "mixin", rest: string, stmt: Stmt): void {
        const open = rest.indexOf("(");
        const name = (open === -1 ? rest : rest.slice(0, open)).trim();
        const params: Fn["params"] = [];

        if (open !== -1) {
            const close = rest.lastIndexOf(")");

            for (const part of splitTop(rest.slice(open + 1, close), ",")) {
                const match = /^\$([\w-]+)(\.\.\.)?\s*(?::\s*([\s\S]+))?$/.exec(part.trim());

                if (match !== null) {
                    params.push({
                        name: match[1]!,
                        fallback: match[3]?.trim(),
                        rest: match[2] !== undefined,
                    });
                }
            }
        }

        const fn: Fn = {
            params,
            body: stmt.body ?? [],
            layout: /@(?:media|at-root|supports|container)\b/.test(stmt.raw),
            module: this.module,
        };
        const own = kind === "function" ? this.module.functions : this.module.mixins;

        own.set(name, fn);
        (kind === "function" ? this.project.functions : this.project.mixins).set(name, fn);
    }

    include(rest: string, stmt: Stmt, emit: boolean): void {
        const match = /^([\w.-]+)\s*(?:\(([\s\S]*)\))?\s*(?:using\s*\([^)]*\))?$/.exec(rest);
        const mixin = match?.[1] === undefined ? undefined : this.find("mixins", match[1]);

        if (match === null || mixin === undefined || mixin.layout) {
            // A mixin that is not here: its content block is kept, and the call is written as it was.
            if (emit && stmt.body !== undefined) {
                this.write(`@include ${this.interpolatedSafe(rest)} {`, stmt.line);
                this.block(stmt.body, emit);
                this.write("}", this.outLine);
            }

            return;
        }

        const positional: Value[] = [];
        const named = new Map<string, Value>();

        for (const part of splitTop(match[2] ?? "", ",")) {
            const trimmed = part.trim();

            if (trimmed === "") {
                continue;
            }

            const keyword = /^\$([\w-]+)\s*:\s*([\s\S]+)$/.exec(trimmed);

            if (keyword !== null) {
                named.set(keyword[1]!, evaluate(parseExpression(keyword[2]!), this));
            } else {
                positional.push(evaluate(parseExpression(trimmed), this));
            }
        }

        if (this.depth > 12) {
            throw new Unsupported("mixins nest too deep");
        }

        const saved = [
            this.scope,
            this.content,
            this.contentScope,
            this.contentModule,
            this.module,
        ] as const;
        const away = mixin.module !== undefined && mixin.module !== this.module;

        this.content = stmt.body;
        this.contentScope = this.scope;
        this.contentModule = this.module;

        // The body sees the members of the module that declared the mixin.
        if (away) {
            this.module = mixin.module!;
        }

        this.scope = new Scope(away ? new Scope(undefined, false) : this.rootScope(), false);
        this.bind(mixin, positional, named);
        this.depth += 1;

        try {
            this.block(mixin.body, emit);
        } finally {
            this.depth -= 1;
            [this.scope, this.content, this.contentScope, this.contentModule, this.module] = saved;
        }
    }

    /** `@if`, `@else if`, `@else`: the body of the first whose condition holds. */
    conditional(chain: Stmt[], emit: boolean): void {
        for (const stmt of chain) {
            const head = stmt.head.replace(/^@(?:else\s+)?(?:if)?\s*/, "");
            const isElse = /^@else\b/.test(stmt.head) && !/^@else\s+if\b/.test(stmt.head);

            if (stmt.body === undefined) {
                throw new Unsupported("@if without a block");
            }

            if (isElse || truthy(evaluate(parseExpression(head), this))) {
                const before = this.scope;

                this.scope = new Scope(before, true);

                try {
                    this.block(stmt.body, emit);
                } finally {
                    this.scope = before;
                }

                return;
            }
        }
    }

    each(stmt: Stmt, rest: string, emit: boolean): void {
        const match = /^((?:\$[\w-]+\s*,\s*)*\$[\w-]+)\s+in\s+([\s\S]+)$/.exec(rest);

        if (match === null || stmt.body === undefined) {
            throw new Unsupported("@each");
        }

        const names = match[1]!.split(",").map((each) => each.trim().replace(/^\$/, ""));
        const items = itemsOf(evaluate(parseExpression(match[2]!), this));

        this.loop(
            stmt,
            items.map((item) => (scope: Scope) => {
                const parts = names.length === 1 ? [item] : itemsOf(item);

                names.forEach((name, at) => scope.vars.set(name, parts[at] ?? NULL));
            }),
            emit,
        );
    }

    forLoop(stmt: Stmt, rest: string, emit: boolean): void {
        const match = /^\$([\w-]+)\s+from\s+([\s\S]+?)\s+(through|to)\s+([\s\S]+)$/.exec(rest);

        if (match === null || stmt.body === undefined) {
            throw new Unsupported("@for");
        }

        const from = evaluate(parseExpression(match[2]!), this);
        const to = evaluate(parseExpression(match[4]!), this);

        if (from.t !== "num" || to.t !== "num") {
            throw new Unsupported("@for bounds");
        }

        const steps: ((scope: Scope) => void)[] = [];
        const last = match[3] === "through" ? to.n : from.n <= to.n ? to.n - 1 : to.n + 1;
        const up = from.n <= last;

        for (let n = from.n; up ? n <= last : n >= last; n += up ? 1 : -1) {
            if (steps.length > LIMITS.iterations) {
                throw new Unsupported("@for too long");
            }

            steps.push((scope) => scope.vars.set(match[1]!, num(n, from.unit)));
        }

        this.loop(stmt, steps, emit);
    }

    whileLoop(stmt: Stmt, rest: string, emit: boolean): void {
        if (stmt.body === undefined) {
            throw new Unsupported("@while");
        }

        const condition = parseExpression(rest);
        const before = this.scope;
        let count = 0;

        this.repeating += 1;

        try {
            while (truthy(evaluate(condition, this))) {
                if (++count > 400 || ++this.iterations > LIMITS.iterations) {
                    throw new Unsupported("@while too long");
                }

                this.scope = new Scope(before, true);
                this.block(stmt.body, emit);
                this.scope = before;
            }
        } finally {
            this.scope = before;
            this.repeating -= 1;
            this.flush(stmt);
        }
    }

    /** The body of a loop once for each step, in a scope of control flow. */
    loop(stmt: Stmt, steps: ((scope: Scope) => void)[], emit: boolean): void {
        const before = this.scope;

        this.repeating += 1;

        try {
            for (const bind of steps) {
                if (++this.iterations > LIMITS.iterations) {
                    throw new Unsupported("too many iterations");
                }

                this.scope = new Scope(before, true);
                bind(this.scope);
                this.block(stmt.body!, emit);

                if (this.returnFlag) {
                    break;
                }
            }
        } finally {
            this.scope = before;
            this.repeating -= 1;
            this.flush(stmt);
        }
    }

    /** The maps and lists that a loop built, written once when the loop ends. */
    flush(stmt: Stmt): void {
        if (this.repeating > 0) {
            return;
        }

        for (const [name, value] of this.pending) {
            this.write(`$${name}: ${declText(value)};`, stmt.line);
        }

        this.pending.clear();
    }
}

/**
 * Whether a stylesheet has Sass that the scan cannot read as it is: a loop, a map built in code, a module's function, a
 * member of another module (`p.$blue-500`), a configuration (`@use … with`), or a function that works out a color. Mixins and
 * conditions are left to the scan, which has its own reading of them.
 */
export const NEEDS_EVAL =
    /@(?:each|for|while)\b|\bmap[.-](?:merge|get|set|keys|values)\b|\b(?:color|math|map|list|string)\.[a-z-]+\(|\b(?:scale-color|adjust-color|change-color)\(|@function[\s\S]{0,400}?\b(?:mix|lighten|darken|saturate|desaturate|rgba|adjust-hue|color\.)|\b[a-z][\w-]*\.\$[\w-]+|@use\b[^;]*\bwith\b|@forward\b[^;]*\b(?:as|show|hide|with)\b/;

/** The result of running one stylesheet. */
export interface Evaluated {
    text: string;
    /** Whether the run gave up on a statement: the text is then partly as it was written. */
    complete: boolean;
}

/**
 * Runs a stylesheet in `project` and returns what it writes. A statement that cannot be evaluated is written as it was
 * (with its `#{}` filled in where they can be); a run that fails as a whole gives undefined.
 */
export function evaluateSass(source: string, project: Project): Evaluated | undefined {
    const run = new Run(project, new Module("", project));

    try {
        run.block(statementsOf(source, 1), true);
    } catch (error) {
        if (error instanceof Unsupported || error instanceof RangeError) {
            return undefined;
        }

        throw error;
    }

    return { text: run.out.join(""), complete: true };
}

export { interpolate, str };

/** A name as a file is known by: without its folder, its extension, and the `_` of a partial (`./theme/_colors.scss` is `colors`). */
const keyOfName = (name: string) =>
    name
        .replace(/^.*\//, "")
        .replace(/\.(?:scss|sass|css)$/, "")
        .replace(/^_/, "");

/**
 * Runs the Sass files of a project in the order they depend on each other (a file after the files it `@use`s or
 * `@import`s), and returns the text of each file that has Sass the scan cannot read as it is: its loops and functions
 * run, its variables as they end. Each file is a module with its own variables, functions, and mixins; the modules it
 * loads are found by their paths, with their namespaces, `@forward`s, and configurations (`@use "x" with ($a: 1)`). The
 * other files are run too, for their variables. A file that was configured gives the text of its configured copy.
 */
export function expandSassFiles(files: { rel: string; text: string }[]): Map<string, string> {
    const project = new Project();
    const byKey = new Map<string, { rel: string; text: string }[]>();

    for (const file of files) {
        const key = keyOfName(file.rel);

        byKey.set(key, [...(byKey.get(key) ?? []), file]);
        project.files.set(file.rel, file.text);
    }

    const ordered: { rel: string; text: string }[] = [];
    const state = new Map<string, 1 | 2>();

    const visit = (file: { rel: string; text: string }, depth: number) => {
        if (state.has(file.rel) || depth > 40) {
            return;
        }

        state.set(file.rel, 1);

        for (const name of dependenciesOf(file.text)) {
            // The file that module resolution finds, else the one with that name that is nearest: in the same folder first.
            const rel = resolveModule(file.rel, name, project.files.keys());
            const found =
                rel === undefined
                    ? byKey.get(keyOfName(name))
                    : [{ rel, text: project.files.get(rel)! }];
            const near = found?.find(
                (each) =>
                    each.rel.slice(0, each.rel.lastIndexOf("/")) ===
                    file.rel.slice(0, Math.max(0, file.rel.lastIndexOf("/"))),
            );
            const target = near ?? found?.[0];

            if (target !== undefined && target.rel !== file.rel) {
                visit(target, depth + 1);
            }
        }

        state.set(file.rel, 2);
        ordered.push(file);
    };

    // Partials (`_colors.scss`) and files that others load come first by their dependencies; the rest by path.
    for (const file of [...files].sort(
        (a, b) =>
            Number(/(?:^|\/)_/.test(b.rel)) - Number(/(?:^|\/)_/.test(a.rel)) ||
            a.rel.localeCompare(b.rel),
    )) {
        visit(file, 0);
    }

    for (const file of ordered) {
        // A project of many stylesheets gets a fixed time: what is not run in it is read as written.
        if (Date.now() > project.deadline) {
            break;
        }

        project.load(file.rel);
    }

    const out = new Map<string, string>();

    // A stylesheet that calls a function of the project's, or a mixin that loops or calculates, needs its text worked out.
    const names = (list: Iterable<string>) =>
        [...list]
            .slice(0, 300)
            .map((name) => name.replace(/[^\w-]/g, "\\$&"))
            .join("|");
    const heavy = [...project.mixins].filter(([, mixin]) =>
        mixin.body.some((stmt) => NEEDS_EVAL.test(stmt.raw)),
    );
    const callsProject = new RegExp(
        [
            project.functions.size === 0
                ? ""
                : String.raw`(?<![\w$@-])(?:${names(project.functions.keys())})\(`,
            heavy.length === 0
                ? ""
                : String.raw`@include\s+(?:[\w-]+\.)?(?:${names(heavy.map(([name]) => name))})\b`,
        ]
            .filter((part) => part !== "")
            .join("|") || "(?!)",
    );

    for (const file of ordered) {
        const copies = [...project.modules.values()].filter(
            (module) => module.rel === file.rel && !project.failed.has(module),
        );
        const configured = copies.filter((module) => module.config !== undefined).at(-1);
        const chosen =
            configured ?? copies.find((module) => module.config === undefined) ?? copies[0];

        // A configured copy is written even when the file has nothing to run: its `!default` variables are other values.
        if (
            chosen !== undefined &&
            (NEEDS_EVAL.test(file.text) ||
                callsProject.test(file.text.replace(/@(?:function|mixin)\s+[\w-]+/g, "")) ||
                (configured !== undefined && /!default\b/.test(file.text)))
        ) {
            out.set(file.rel, chosen.text);
        }
    }

    return out;
}
