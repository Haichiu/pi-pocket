import { Unsupported, interpolate } from "./scan-sass-expr.ts";
import { type Flat, type Fn, Module, resolveModule } from "./scan-sass-modules.ts";
import { Run } from "./scan-sass-run.ts";
import { dependenciesOf, statementsOf, type Stmt } from "./scan-sass-stmt.ts";
import { declText, str, type Value } from "./scan-sass-values.ts";

export class Project implements Flat {
    /** When the work for the whole project must stop: a project of many stylesheets must not hold the scan. */
    deadline = Date.now() + 4000;
    vars = new Map<string, Value>();
    functions = new Map<string, Fn>();
    mixins = new Map<string, Fn>();
    files = new Map<string, string>();
    modules = new Map<string, Module>();
    failed = new Set<Module>();
    private parsed = new Map<string, Stmt[]>();
    private depth = 0;
    private compilation: Map<string, Module> | undefined;

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

// The member is found from its `.$`, looking back: a long run of `a-a-a-…` with no `.$` in it costs nothing.
const NEEDS_EVAL =
    /@(?:each|for|while)\b|\bmap[.-](?:merge|get|set|keys|values)\b|\b(?:color|math|map|list|string)\.[a-z-]+\(|\b(?:scale-color|adjust-color|change-color)\(|@function[\s\S]{0,400}?\b(?:mix|lighten|darken|saturate|desaturate|rgba|adjust-hue|color\.)|(?<=\b[a-z][\w-]*)\.\$[\w-]|@use\b[^;]*\bwith\b|@forward\b[^;]*\b(?:as|show|hide|with)\b/;

interface Evaluated {
    text: string;
    complete: boolean;
}

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

const keyOfName = (name: string) =>
    name
        .replace(/^.*\//, "")
        .replace(/\.(?:scss|sass|css)$/, "")
        .replace(/^_/, "");

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
