/**
 * The module system of Sass (stream T): a stylesheet that is `@use`d is a module with variables, functions, and mixins of
 * its own, loaded under a namespace (`@use "palette" as p`, then `p.$blue-500`, `p.mix()`), or opened into the user's scope
 * (`as *`). `@forward` hands a module's members on, with a prefix (`as list-*`) and a choice of members (`show`, `hide`),
 * and `@use … with ($a: 1)` configures the `!default` variables of a module before it runs. A module that is configured
 * is a second copy of the module, as in Sass. The members whose names start with `-` or `_` are private.
 *
 * The variables, functions, and mixins that a project declares are also kept in one flat environment (the `Project`), as
 * the scan did before modules: a name that no module explains (a stylesheet that is compiled together with others
 * through a build tool, a package that is not in the repository) is looked up there.
 */
import { splitTop, type Stmt } from "./scan-sass-stmt.ts";
import type { Value } from "./scan-sass-values.ts";

/** A function or a mixin. */
export interface Fn {
    params: { name: string; fallback: string | undefined; rest: boolean }[];
    body: Stmt[];
    /** A mixin that makes a layout of rules (a media query, `@at-root`): it is left to the scan, which reads those itself. */
    layout: boolean;
    /** The module that declared it: its body sees that module's members, not the caller's. */
    module: Module | undefined;
}

type Kind = "vars" | "functions" | "mixins";

/** The flat environment that is the fallback of every module. */
export interface Flat {
    vars: Map<string, Value>;
    functions: Map<string, Fn>;
    mixins: Map<string, Fn>;
}

/** What `@forward` hands on: a module, a prefix, and the names that are shown or hidden (`$name` for a variable). */
export interface Forward {
    module: Module;
    prefix: string;
    show: Set<string> | undefined;
    hide: Set<string> | undefined;
}

export class Module {
    readonly rel: string;
    readonly flat: Flat;
    vars = new Map<string, Value>();
    functions = new Map<string, Fn>();
    mixins = new Map<string, Fn>();
    /** The modules loaded with `@use … as ns`, by namespace; a built-in module (`sass:color`) is its name. */
    uses = new Map<string, Module | string>();
    /** The modules whose members are open in this one: `@use … as *`, and what `@import` brings in. */
    opened: Module[] = [];
    forwards: Forward[] = [];
    /** The configuration of `@use … with (…)`: the values of the `!default` variables. */
    config: Map<string, Value> | undefined;
    /** The built-in modules opened with `@use "sass:math" as *`. */
    openBuiltins: string[] = [];
    /** The configured variables that a `!default` assignment has taken. */
    applied = new Set<string>();
    /** What the stylesheet makes once run. */
    text = "";

    constructor(rel: string, flat: Flat, config?: Map<string, Value>) {
        this.rel = rel;
        this.flat = flat;
        this.config = config;
    }

    /** A member of the module as another module sees it: its own, or one that it forwards. */
    member<T>(kind: Kind, name: string, depth = 0): T | undefined {
        if (/^[-_]/.test(name) || depth > 12) {
            return undefined;
        }

        const own = this[kind].get(name) as T | undefined;

        if (own !== undefined) {
            return own;
        }

        for (const forward of this.forwards) {
            if (forward.prefix !== "" && !name.startsWith(forward.prefix)) {
                continue;
            }

            const shown = kind === "vars" ? `$${name}` : name;

            if (
                (forward.show !== undefined && !forward.show.has(shown)) ||
                forward.hide?.has(shown) === true
            ) {
                continue;
            }

            const found = forward.module.member<T>(
                kind,
                name.slice(forward.prefix.length),
                depth + 1,
            );

            if (found !== undefined) {
                return found;
            }
        }

        return undefined;
    }

    /** A member by its bare name, from inside the module: its own, the open modules', then the project's. */
    lookup<T>(kind: Kind, name: string, flat = true): T | undefined {
        const own = this[kind].get(name) as T | undefined;

        if (own !== undefined) {
            return own;
        }

        for (const open of this.opened) {
            const found = open.member<T>(kind, name);

            if (found !== undefined) {
                return found;
            }
        }

        return flat ? (this.flat[kind].get(name) as T | undefined) : undefined;
    }

    /** The module a namespace names; undefined when there is none, a string for a built-in module. */
    namespace(name: string): Module | string | undefined {
        return this.uses.get(name);
    }

    setVar(name: string, value: Value): void {
        this.vars.set(name, value);
        this.flat.vars.set(name, value);
    }

    deleteVar(name: string): void {
        this.vars.delete(name);
        this.flat.vars.delete(name);
    }
}

// --- The rules ------------------------------------------------------------------------------------------------------------

/** A `@use` or `@forward` rule, read. */
export interface ModuleRule {
    path: string;
    /** `as p` (a namespace), `as *` (open), or none. */
    namespace: string | undefined;
    /** `as list-*` of `@forward`. */
    prefix: string;
    /** The entries of `with (…)`, as written: `$a: 1`, `$b: red !default`. */
    config: string[];
    show: string[] | undefined;
    hide: string[] | undefined;
}

/** The index after the parenthesis that closes the one at `open`. */
function parenEnd(source: string, open: number): number {
    let depth = 0;
    let quote = "";

    for (let at = open; at < source.length; at++) {
        const char = source[at]!;

        if (quote !== "") {
            quote = char === "\\" ? ((at += 1), quote) : char === quote ? "" : quote;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "(") {
            depth += 1;
        } else if (char === ")" && --depth === 0) {
            return at + 1;
        }
    }

    return source.length;
}

/** What follows `@use` or `@forward`: `"path" as ns with ($a: 1)`, `"path" as list-* hide a, $b`. */
export function parseModuleRule(rest: string): ModuleRule | undefined {
    const head = /^\s*(["'])([^"'\n]{1,300})\1\s*/.exec(rest);

    if (head === null) {
        return undefined;
    }

    let tail = rest.slice(head[0].length);
    const rule: ModuleRule = {
        path: head[2]!,
        namespace: undefined,
        prefix: "",
        config: [],
        show: undefined,
        hide: undefined,
    };

    for (let step = 0; step < 6 && tail.trim() !== ""; step++) {
        tail = tail.trimStart();

        const as = /^as\s+([\w-]*)(\*)?\s*/.exec(tail);
        const list = /^(show|hide)\s+((?:[$\w-]+\s*,\s*)*[$\w-]+)\s*/.exec(tail);
        const withs = /^with\s*\(/.exec(tail);

        if (as !== null) {
            if (as[2] === undefined) {
                rule.namespace = as[1];
            } else if (as[1] === "") {
                rule.namespace = "*";
            } else {
                rule.prefix = as[1]!;
            }

            tail = tail.slice(as[0].length);
        } else if (list !== null) {
            const names = list[2]!.split(",").map((name) => name.trim());

            if (list[1] === "show") {
                rule.show = names;
            } else {
                rule.hide = names;
            }

            tail = tail.slice(list[0].length);
        } else if (withs !== null) {
            const open = withs[0].length - 1;
            const end = parenEnd(tail, open);

            rule.config = splitTop(tail.slice(open + 1, end - 1), ",")
                .map((part) => part.trim())
                .filter((part) => part !== "");
            tail = tail.slice(end);
        } else {
            break;
        }
    }

    return rule;
}

/** The namespace a module has when none is given: the last part of its path, without an extension or a `_`. */
export function defaultNamespace(path: string): string {
    return (
        path
            .replace(/^.*[/:]/, "")
            .replace(/^_/, "")
            .replace(/\..*$/, "") || "module"
    );
}

// --- Finding a file -------------------------------------------------------------------------------------------------------

const normalize = (path: string) => {
    const out: string[] = [];

    for (const part of path.split("/")) {
        if (part === "..") {
            out.pop();
        } else if (part !== "." && part !== "") {
            out.push(part);
        }
    }

    return out.join("/");
};

/**
 * The file a `@use` or `@import` names, among the project's files. Sass looks beside the stylesheet first, and then in the
 * load paths (a project's `includePaths`, which the scan does not know): any folder of the project is one, the nearest
 * first. A name may leave out the extension and the `_` of a partial, and name a folder with an `_index`.
 */
export function resolveModule(
    from: string,
    request: string,
    rels: Iterable<string>,
): string | undefined {
    if (/^(?:sass|pkg|https?):|^url\(|^\/\//.test(request) || /\.css$/i.test(request)) {
        return undefined;
    }

    const wanted = normalize(request.replace(/^[~@]\/?/, "").replace(/^\/+/, ""));

    if (wanted === "") {
        return undefined;
    }

    const parts = wanted.split("/");
    const name = parts.pop()!;
    const dir = parts.join("/");
    const stem = name.replace(/\.(?:scss|sass)$/i, "");
    const forms = (prefix: string) =>
        [
            [dir, stem],
            [dir, `_${stem}`],
            [[dir, stem].filter(Boolean).join("/"), "index"],
            [[dir, stem].filter(Boolean).join("/"), "_index"],
        ].map(([folder, file]) => [prefix, folder, file].filter(Boolean).join("/"));
    const all = [...rels];
    const set = new Set(all);
    const extensions = /\.(?:scss|sass)$/i.test(name) ? [""] : [".scss", ".sass"];
    const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";

    // Beside the stylesheet, then up the folders (a load path at each level).
    for (let base = fromDir; ; base = base.slice(0, Math.max(0, base.lastIndexOf("/")))) {
        for (const candidate of forms(base)) {
            for (const extension of extensions) {
                if (set.has(`${candidate}${extension}`)) {
                    return `${candidate}${extension}`;
                }
            }
        }

        if (base === "") {
            break;
        }
    }

    // Anywhere in the project, the nearest folder first.
    let best: string | undefined;
    let bestScore = -1;

    for (const rel of all) {
        for (const candidate of forms("")) {
            for (const extension of extensions) {
                const full = `${candidate}${extension}`;

                if (rel === full || rel.endsWith(`/${full}`)) {
                    const shared = commonDirs(fromDir, rel);

                    if (shared > bestScore || (shared === bestScore && rel < (best ?? "~"))) {
                        best = rel;
                        bestScore = shared;
                    }
                }
            }
        }
    }

    return best;
}

/** How many folders two paths share at the start. */
function commonDirs(a: string, b: string): number {
    const left = a.split("/").filter(Boolean);
    const right = b.split("/");
    let count = 0;

    while (count < left.length && count < right.length - 1 && left[count] === right[count]) {
        count += 1;
    }

    return count;
}
