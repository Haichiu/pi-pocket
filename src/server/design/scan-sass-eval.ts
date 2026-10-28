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
import { LIMITS, dependenciesOf, splitTop, statementsOf, type Stmt } from "./scan-sass-stmt.ts";
import {
    NULL,
    declText,
    itemsOf,
    list,
    num,
    str,
    text,
    truthy,
    type Value,
} from "./scan-sass-values.ts";

// --- The environment ------------------------------------------------------------------------------------------------------

interface Fn {
    params: { name: string; fallback: string | undefined; rest: boolean }[];
    body: Stmt[];
    /** A mixin that makes a layout of rules (a media query, `@at-root`): it is left to the scan, which reads those itself. */
    layout: boolean;
}

/** The variables, functions, and mixins of a project. */
export class Project {
    /** When the work for the whole project must stop: a project of many stylesheets must not hold the scan. */
    deadline = Date.now() + 4000;
    vars = new Map<string, Value>();
    functions = new Map<string, Fn>();
    mixins = new Map<string, Fn>();
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

    get(name: string, project: Project): Value | undefined {
        for (let scope: Scope | undefined = this; scope !== undefined; scope = scope.parent) {
            const found = scope.vars.get(name);

            if (found !== undefined) {
                return found;
            }
        }

        return project.vars.get(name);
    }

    /** Sets a variable and says whether it is the project's own (a global one). */
    set(name: string, value: Value, project: Project, forceGlobal: boolean): boolean {
        if (forceGlobal || this.parent === undefined) {
            project.vars.set(name, value);

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
        if (scope.parent === undefined && project.vars.has(name)) {
            project.vars.set(name, value);

            return true;
        }

        this.vars.set(name, value);

        return false;
    }
}

/** What a run of one stylesheet makes. */
class Run implements Env {
    project: Project;
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

    constructor(project: Project) {
        this.project = project;
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

    get(name: string): Value | undefined {
        return this.scope.get(name, this.project);
    }

    call(name: string, positional: Value[], named: Map<string, Value>): Value | undefined {
        const fn = this.project.functions.get(name.replace(/^[\w-]+\./, ""));

        if (fn === undefined) {
            return undefined;
        }

        if (this.depth > 20) {
            throw new Unsupported("functions nest too deep");
        }

        const saved = [this.scope, this.returned, this.returnFlag] as const;

        this.scope = new Scope(
            this.scope.parent === undefined ? this.scope : this.rootScope(),
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
            [this.scope, this.returned, this.returnFlag] = saved;
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
            this.project.vars.delete(assign[1]!);
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

        if (
            isDefault &&
            this.scope.get(name, this.project) !== undefined &&
            this.scope.get(name, this.project)!.t !== "null"
        ) {
            return;
        }

        let value: Value;

        try {
            value = evaluate(parseExpression(source), this);
        } catch (error) {
            if (!(error instanceof Unsupported)) {
                throw error;
            }

            // Left as it was written: the value of the variable is unknown here, but the text may still be read.
            if (emit) {
                this.write(`$${name}: ${this.interpolatedSafe(source)};`, stmt.line);
            }

            this.scope.vars.delete(name);
            this.project.vars.delete(name);

            return;
        }

        const global = this.scope.set(name, value, this.project, isGlobal);

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
            case "forward":
            case "import":
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
                    const saved = this.scope;

                    this.scope = this.contentScope;

                    try {
                        this.block(this.content, emit);
                    } finally {
                        this.scope = saved;
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

        (kind === "function" ? this.project.functions : this.project.mixins).set(name, {
            params,
            body: stmt.body ?? [],
            layout: /@(?:media|at-root|supports|container)\b/.test(stmt.raw),
        });
    }

    include(rest: string, stmt: Stmt, emit: boolean): void {
        const match = /^([\w.-]+)\s*(?:\(([\s\S]*)\))?\s*(?:using\s*\([^)]*\))?$/.exec(rest);
        const name = match?.[1]?.replace(/^[\w-]+\./, "");
        const mixin = name === undefined ? undefined : this.project.mixins.get(name);

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

        const saved = [this.scope, this.content, this.contentScope] as const;

        this.content = stmt.body;
        this.contentScope = this.scope;
        this.scope = new Scope(this.rootScope(), false);
        this.bind(mixin, positional, named);
        this.depth += 1;

        try {
            this.block(mixin.body, emit);
        } finally {
            this.depth -= 1;
            [this.scope, this.content, this.contentScope] = saved;
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
 * Whether a stylesheet has Sass that the scan cannot read as it is: a loop, a map built in code, a module's function, or a
 * function that works out a color. Mixins and conditions are left to the scan, which has its own reading of them.
 */
export const NEEDS_EVAL =
    /@(?:each|for|while)\b|\bmap[.-](?:merge|get|set|keys|values)\b|\b(?:color|math|map|list|string)\.[a-z-]+\(|\b(?:scale-color|adjust-color|change-color)\(|@function[\s\S]{0,400}?\b(?:mix|lighten|darken|saturate|desaturate|rgba|adjust-hue|color\.)/;

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
    const run = new Run(project);

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
 * `@import`s), in one environment, and returns the text of each file that has Sass the scan cannot read as it is: its
 * loops and functions run, its variables as they end. The other files are run too, for their variables.
 */
export function expandSassFiles(files: { rel: string; text: string }[]): Map<string, string> {
    const project = new Project();
    const byKey = new Map<string, { rel: string; text: string }[]>();

    for (const file of files) {
        const key = keyOfName(file.rel);

        byKey.set(key, [...(byKey.get(key) ?? []), file]);
    }

    const ordered: { rel: string; text: string }[] = [];
    const state = new Map<string, 1 | 2>();

    const visit = (file: { rel: string; text: string }, depth: number) => {
        if (state.has(file.rel) || depth > 40) {
            return;
        }

        state.set(file.rel, 1);

        for (const name of dependenciesOf(file.text)) {
            // The file with that name that is nearest: in the same folder first.
            const found = byKey.get(keyOfName(name));
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

    const out = new Map<string, string>();

    for (const file of ordered) {
        // A project of many stylesheets gets a fixed time: what is not run in it is read as written.
        if (Date.now() > project.deadline) {
            break;
        }

        const result = evaluateSass(file.text, project);

        if (result !== undefined && NEEDS_EVAL.test(file.text)) {
            out.set(file.rel, result.text);
        }
    }

    return out;
}
