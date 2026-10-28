/**
 * The contracts of the other streams, loaded by path at run time. A module or a function that is not there yet is
 * reported (and scores 0), never an import error. This file is the one place that knows the contracts' names, so a
 * rename in a stream is a change here only.
 *
 * Contracts (docs/design/design-system.md):
 *   tokens.ts   loadDesignSystem(cwd), compileDesignSystem(system), writeDesignSystem(cwd, change), systemSummary(system, max)
 *   lint.ts     checkDesign(bundle, system | undefined, options, host, signal)
 *   docsite.ts  renderSystemDoc(system)
 *   scan.ts     the scan is not fixed by the plan: any of SCAN_NAMES, called with the folder, that returns a DTCG draft
 *               (`{ tokens, modes }`, `{ tokens, dark }`, `{ files: { "tokens.json": … } }`, or a JSON string). Without one,
 *               the 0.26 scan (`scanTokens`) is scored as a baseline.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    CheckReport,
    CompiledFiles,
    DesignSystem,
    SystemChange,
} from "../../../src/server/design/system-types.ts";
import { colorOf } from "./color.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DESIGN = join(ROOT, "src", "server", "design");

type Fn = (...args: any[]) => any;

export interface Modules {
    load?: (cwd: string) => DesignSystem | undefined;
    compile?: (system: DesignSystem) => CompiledFiles;
    write?: (cwd: string, change: SystemChange) => DesignSystem;
    summary?: (system: DesignSystem, maxBytes: number) => string;
    check?: (
        bundle: unknown,
        system: DesignSystem | undefined,
        options: unknown,
        host: unknown,
        signal: AbortSignal,
    ) => Promise<CheckReport>;
    doc?: (system: DesignSystem) => { html: string; assets: { name: string; content: string }[] };
    /** The scan, as `(folder) => draft`. */
    scan?: { name: string; run: Fn };
    /** The 0.26 scan: the baseline. */
    legacyScan?: Fn;
    /** What is missing, and why, for the report. */
    notes: string[];
    /** Which modules were found. */
    present: Record<"tokens" | "lint" | "docsite" | "scan", boolean>;
}

/** The names under which a scan might be exported, most specific first. */
/** The longest a scan may take on one fixture. */
export const SCAN_LIMIT_MS = 60_000;

export const SCAN_NAMES = [
    "scanDesignSystem",
    "scanProjectTokens",
    "scanToDtcg",
    "scanDraft",
    "draftTokens",
    "scanForDesignSystem",
    "scanProject",
];

async function load(file: string, notes: string[]): Promise<Record<string, unknown> | undefined> {
    const path = join(DESIGN, file);

    if (!existsSync(path)) {
        notes.push(`${file} is not in the tree yet.`);

        return undefined;
    }

    try {
        // A computed specifier: the file may not exist yet, so TypeScript must not resolve it.
        return (await import(path)) as Record<string, unknown>;
    } catch (error) {
        notes.push(`${file} did not load: ${String((error as Error).message).split("\n")[0]}`);

        return undefined;
    }
}

const fn = (
    module: Record<string, unknown> | undefined,
    name: string,
    notes: string[],
    file: string,
): Fn | undefined => {
    if (module === undefined) {
        return undefined;
    }

    if (typeof module[name] !== "function") {
        notes.push(`${file} does not export ${name}.`);

        return undefined;
    }

    return module[name] as Fn;
};

/** Load every contract that exists. `skip` leaves some out (the tests use it to prove that missing parts score 0). */
export async function loadModules(skip: string[] = []): Promise<Modules> {
    const notes: string[] = [];
    const wanted = (name: string) => !skip.includes(name);
    const tokens = wanted("tokens") ? await load("tokens.ts", notes) : undefined;
    const lint = wanted("lint") ? await load("lint.ts", notes) : undefined;
    const docsite = wanted("docsite") ? await load("docsite.ts", notes) : undefined;
    const scan = wanted("scan") ? await load("scan.ts", notes) : undefined;
    const out: Modules = {
        load: fn(tokens, "loadDesignSystem", notes, "tokens.ts"),
        compile: fn(tokens, "compileDesignSystem", notes, "tokens.ts"),
        write: fn(tokens, "writeDesignSystem", notes, "tokens.ts"),
        summary: fn(tokens, "systemSummary", notes, "tokens.ts"),
        check: fn(lint, "checkDesign", notes, "lint.ts"),
        doc: fn(docsite, "renderSystemDoc", notes, "docsite.ts"),
        notes,
        present: {
            tokens: tokens !== undefined,
            lint: lint !== undefined,
            docsite: docsite !== undefined,
            scan: scan !== undefined,
        },
    };

    if (scan !== undefined) {
        // The scan may also live in tokens.ts, next to the engine.
        for (const name of SCAN_NAMES) {
            const found = [scan, tokens]
                .map((module) => module?.[name])
                .find((value) => typeof value === "function") as Fn | undefined;

            if (found !== undefined) {
                out.scan = { name, run: found };
                break;
            }
        }

        if (typeof scan.scanTokens === "function") {
            out.legacyScan = scan.scanTokens as Fn;

            // Stream T's structured scan: `scanTokens(root).draft` is the DTCG draft (`{ tokens, modes }`).
            if (out.scan === undefined) {
                const legacy = scan.scanTokens as Fn;
                const probe = (root: string) => (legacy(root) as { draft?: unknown }).draft;

                out.scan = { name: "scanTokens().draft", run: probe as Fn };
            }
        }

        if (out.scan === undefined) {
            notes.push(
                `scan.ts exports none of ${SCAN_NAMES.join(", ")}: the 0.26 scan is scored as the baseline.`,
            );
        }
    }

    return out;
}

/** A DTCG draft: the default tree and the mode override trees. */
export interface Draft {
    tokens: unknown;
    modes: Record<string, unknown>;
}

/** Whether a value holds a DTCG token (a `$value`) within a few levels. */
export function looksDtcg(value: unknown, depth = 0): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value) || depth > 8) {
        return false;
    }

    return Object.entries(value).some(
        ([key, child]) => key === "$value" || (!key.startsWith("$") && looksDtcg(child, depth + 1)),
    );
}

/** Pull a draft out of whatever a scan returned, or `undefined` when it holds no tokens. */
export function coerceDraft(value: unknown): Draft | undefined {
    if (typeof value === "string") {
        const fenced = /```json\s*\n([\s\S]*?)```/.exec(value);

        try {
            return coerceDraft(JSON.parse(fenced?.[1] ?? value));
        } catch {
            return undefined;
        }
    }

    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const object = value as Record<string, any>;
    const files = (object.files ?? object.drafts ?? object.draft?.files) as
        Record<string, unknown> | undefined;
    const modes: Record<string, unknown> = {};

    const take = (source: unknown) => {
        if (typeof source === "object" && source !== null) {
            for (const [name, tree] of Object.entries(source)) {
                if (looksDtcg(tree)) {
                    modes[name.replace(/^tokens\.|\.json$/g, "")] = tree;
                }
            }
        }
    };

    for (const holder of [object, object.draft]) {
        if (typeof holder !== "object" || holder === null) {
            continue;
        }

        take(holder.modes);

        for (const key of ["dark", "tokensDark", "darkTokens"]) {
            if (looksDtcg(holder[key])) {
                modes.dark = holder[key];
            }
        }
    }

    if (files !== undefined) {
        const defaults = files["tokens.json"];

        for (const [file, tree] of Object.entries(files)) {
            const match = /^tokens\.([a-z0-9-]+)\.json$/.exec(file);

            if (match !== null && looksDtcg(tree)) {
                modes[match[1]!] = tree;
            }
        }

        if (looksDtcg(defaults)) {
            return { tokens: defaults, modes };
        }
    }

    for (const candidate of [
        object.tokens,
        object.draft?.tokens,
        object.tokensJson,
        object["tokens.json"],
        object.light,
        object.default,
        object.draft,
        object,
    ]) {
        if (looksDtcg(candidate)) {
            // A tree that holds the `modes` or `dark` keys itself would double count them: strip them.
            return { tokens: candidate, modes };
        }
    }

    return undefined;
}

/**
 * The 0.26 scan's findings as a DTCG draft, the way a person would save them: variables under their own names, the other
 * colors, radii and fonts numbered. This is the baseline; the new scan replaces it.
 */
export function legacyDraft(scan: any): Draft {
    const color: Record<string, unknown> = {};
    const dimension: Record<string, unknown> = {};
    const radius: Record<string, unknown> = {};
    const space: Record<string, unknown> = {};
    const font: Record<string, unknown> = {};
    const family: Record<string, unknown> = {};
    const shadow: Record<string, unknown> = {};
    const slug = (name: string) => name.replace(/^--/, "").replace(/[^a-zA-Z0-9]+/g, "-");

    for (const [name, value] of Object.entries((scan?.variables ?? {}) as Record<string, string>)) {
        const key = slug(name);

        if (colorOf(value) !== undefined) {
            color[key] = { $type: "color", $value: value };
        } else if (/shadow/i.test(name)) {
            shadow[key] = { $type: "shadow", $value: value };
        } else if (/^-?[\d.]+(px|rem|em)$/.test(value)) {
            const target = /radius|rounded/i.test(name)
                ? radius
                : /space|gap|pad|margin/i.test(name)
                  ? space
                  : /font|text|size/i.test(name)
                    ? font
                    : dimension;

            target[key] = { $type: "dimension", $value: value };
        } else if (/font|family/i.test(name) && /,|"|'/.test(value)) {
            family[key] = { $type: "fontFamily", $value: value };
        }
    }

    for (const [index, item] of ((scan?.colors ?? []) as { value: string }[]).entries()) {
        color[`scan-${index + 1}`] = { $type: "color", $value: item.value };
    }

    for (const [index, item] of ((scan?.radii ?? []) as { value: string }[]).entries()) {
        radius[`r${index + 1}`] = { $type: "dimension", $value: item.value };
    }

    for (const [index, item] of ((scan?.fonts ?? []) as { value: string }[]).entries()) {
        family[`f${index + 1}`] = { $type: "fontFamily", $value: item.value };
    }

    const tree: Record<string, unknown> = {};

    for (const [name, group] of Object.entries({
        color,
        dimension,
        radius,
        space,
        font: { size: font, family },
        shadow,
    })) {
        if (Object.keys(group).length > 0) {
            tree[name] = group;
        }
    }

    return { tokens: tree, modes: {} };
}

export interface ScanOutcome {
    draft?: Draft;
    /** `engine` (the new scan), `baseline` (the 0.26 scan), or `none`. */
    source: "engine" | "baseline" | "none";
    note?: string;
    ms: number;
}

/** Reject after `ms`: a scan that never returns must not hold the bench. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${what} did not finish in ${ms / 1000} s.`)),
            ms,
        );
        timer.unref();
    });

    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Run the scan on a folder, with whichever scan exists. Never throws. */
export async function runScan(modules: Modules, dir: string): Promise<ScanOutcome> {
    const start = Date.now();

    if (modules.scan !== undefined) {
        try {
            const draft = coerceDraft(
                await withTimeout(
                    Promise.resolve(modules.scan.run(dir)),
                    SCAN_LIMIT_MS,
                    modules.scan.name,
                ),
            );

            return draft === undefined
                ? {
                      source: "engine",
                      note: `${modules.scan.name} returned no DTCG tokens.`,
                      ms: Date.now() - start,
                  }
                : { draft, source: "engine", ms: Date.now() - start };
        } catch (error) {
            return {
                source: "engine",
                note: `${modules.scan.name} threw: ${String((error as Error).message).split("\n")[0]}`,
                ms: Date.now() - start,
            };
        }
    }

    if (modules.legacyScan !== undefined) {
        try {
            const result = await withTimeout(
                Promise.resolve(modules.legacyScan(dir)),
                SCAN_LIMIT_MS,
                "scanTokens",
            );
            const direct = coerceDraft(result);

            return {
                draft: direct ?? legacyDraft(result),
                source: "baseline",
                ms: Date.now() - start,
            };
        } catch (error) {
            return {
                source: "baseline",
                note: `scanTokens threw: ${String((error as Error).message).split("\n")[0]}`,
                ms: Date.now() - start,
            };
        }
    }

    return { source: "none", note: "scan.ts is missing.", ms: Date.now() - start };
}
