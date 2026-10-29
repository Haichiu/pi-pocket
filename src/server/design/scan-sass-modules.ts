// A configured module is a second copy, as in Sass. A name that no module explains is looked up in the flat `Project` environment.
import { splitTop, type Stmt } from "./scan-sass-stmt.ts";
import type { Value } from "./scan-sass-values.ts";

export interface Fn {
    params: { name: string; fallback: string | undefined; rest: boolean }[];
    body: Stmt[];
    /** A mixin that makes a layout of rules (a media query, `@at-root`): it is left to the scan, which reads those itself. */
    layout: boolean;
    /** The module that declared it: its body sees that module's members, not the caller's. */
    module: Module | undefined;
}

type Kind = "vars" | "functions" | "mixins";

export interface Flat {
    vars: Map<string, Value>;
    functions: Map<string, Fn>;
    mixins: Map<string, Fn>;
}

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
    uses = new Map<string, Module | string>();
    opened: Module[] = [];
    forwards: Forward[] = [];
    config: Map<string, Value> | undefined;
    openBuiltins: string[] = [];
    applied = new Set<string>();
    text = "";

    constructor(rel: string, flat: Flat, config?: Map<string, Value>) {
        this.rel = rel;
        this.flat = flat;
        this.config = config;
    }

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

export interface ModuleRule {
    path: string;
    namespace: string | undefined;
    prefix: string;
    config: string[];
    show: string[] | undefined;
    hide: string[] | undefined;
}

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

export function defaultNamespace(path: string): string {
    return (
        path
            .replace(/^.*[/:]/, "")
            .replace(/^_/, "")
            .replace(/\..*$/, "") || "module"
    );
}

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

// Beside the stylesheet first, then in the load paths (which the scan does not know): any folder of the project is one, the nearest first.
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

function commonDirs(a: string, b: string): number {
    const left = a.split("/").filter(Boolean);
    const right = b.split("/");
    let count = 0;

    while (count < left.length && count < right.length - 1 && left[count] === right[count]) {
        count += 1;
    }

    return count;
}
