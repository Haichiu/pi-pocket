import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DesignSystem, SystemChange } from "../../../src/server/design/system-types.ts";
import type { BenchBrowser } from "./chromium.ts";
import { checkCss, type CssCheck } from "./css-check.ts";
import type { Draft, Modules } from "./modules.ts";
import { readFlat } from "./system.ts";

export interface SystemSource {
    name: string;
    kind: "fixture" | "scan" | "flagship";
    project: string;
}

export interface FormatResult {
    name: string;
    kind: string;
    present: boolean;
    loaded: boolean;
    errors: number;
    warnings: number;
    tokens: number;
    modes: string[];
    roundTrip: boolean | undefined;
    idempotent: boolean | undefined;
    compiled: boolean;
    dist: boolean | undefined;
    namesAgree: number | undefined;
    css: CssCheck | undefined;
    problems: string[];
    score: number;
}

const rate = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

function snapshot(
    root: string,
    base = root,
    out: Record<string, string> = {},
): Record<string, string> {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);

        if (entry.isDirectory()) {
            snapshot(path, base, out);
        } else if (entry.isFile()) {
            out[path.slice(base.length + 1)] = readFileSync(path, "utf8");
        }
    }

    return out;
}

const plain = (value: unknown) => JSON.stringify(value);

export function changeFromDisk(design: string): SystemChange {
    const change: SystemChange = { modes: {}, components: {} };

    for (const file of readdirSync(design).sort()) {
        if (file === "tokens.json") {
            change.tokens = JSON.parse(readFileSync(join(design, file), "utf8"));
        } else if (/^tokens\.[a-z0-9-]+\.json$/.test(file)) {
            change.modes![file.slice(7, -5)] = JSON.parse(readFileSync(join(design, file), "utf8"));
        } else if (file === "guidelines.md") {
            change.guidelines = readFileSync(join(design, file), "utf8");
        }
    }

    if (existsSync(join(design, "components"))) {
        for (const file of readdirSync(join(design, "components")).sort()) {
            if (file.endsWith(".html")) {
                change.components![file.slice(0, -5)] = readFileSync(
                    join(design, "components", file),
                    "utf8",
                );
            }
        }
    }

    return change;
}

/** A copy of a project's `.pi/design/` (never `dist/`) in a fresh folder named `name`, so two copies have the same name. */
function copyDesign(project: string, parent: string, name: string): string {
    const root = join(parent, name);

    mkdirSync(join(root, ".pi"), { recursive: true });
    cpSync(join(project, ".pi", "design"), join(root, ".pi", "design"), {
        recursive: true,
        filter: (source) => basename(source) !== "dist",
    });

    return root;
}

export function saveDraft(
    modules: Modules,
    draft: Draft,
    parent: string,
    name: string,
): { project: string; error?: string } {
    const root = join(parent, name);
    const design = join(root, ".pi", "design");

    mkdirSync(design, { recursive: true });

    // Raw files first: the bench's own reader and a failed save both need something on disk.
    writeFileSync(join(design, "tokens.json"), JSON.stringify(draft.tokens, null, 2));

    for (const [mode, tree] of Object.entries(draft.modes)) {
        writeFileSync(join(design, `tokens.${mode}.json`), JSON.stringify(tree, null, 2));
    }

    if (modules.write !== undefined) {
        try {
            modules.write(root, { tokens: draft.tokens, modes: draft.modes });
        } catch (error) {
            return { project: root, error: String((error as Error).message).split("\n")[0] };
        }
    }

    return { project: root };
}

export async function checkSystem(
    modules: Modules,
    browser: BenchBrowser | undefined,
    source: SystemSource,
    parent: string,
): Promise<FormatResult> {
    const result: FormatResult = {
        name: source.name,
        kind: source.kind,
        present: existsSync(join(source.project, ".pi", "design", "tokens.json")),
        loaded: false,
        errors: 0,
        warnings: 0,
        tokens: 0,
        modes: [],
        roundTrip: undefined,
        idempotent: undefined,
        compiled: false,
        dist: undefined,
        namesAgree: undefined,
        css: undefined,
        problems: [],
        score: 0,
    };

    const note = (text: string) => {
        if (result.problems.length < 8) {
            result.problems.push(text);
        }
    };

    if (!result.present) {
        note("The system is not in the tree.");

        return result;
    }

    if (modules.load === undefined) {
        note("loadDesignSystem is missing.");

        return result;
    }

    const slug = source.name.replace(/[^a-z0-9-]+/gi, "-");
    const dirA = copyDesign(source.project, parent, `${slug}-a/${slug}`);
    const dirB = copyDesign(source.project, parent, `${slug}-b/${slug}`);
    let first: DesignSystem | undefined;

    try {
        first = modules.load(dirA);
    } catch (error) {
        note(`load threw: ${String((error as Error).message).split("\n")[0]}`);
    }

    if (first === undefined) {
        note("loadDesignSystem returned nothing.");

        return result;
    }

    result.loaded = true;
    result.errors = first.problems.filter((problem) => problem.level === "error").length;
    result.warnings = first.problems.filter((problem) => problem.level === "warning").length;
    result.tokens = first.tokens.length;
    result.modes = first.modes;

    for (const problem of first.problems.filter((item) => item.level === "error").slice(0, 3)) {
        note(`error: ${problem.token ?? problem.file ?? ""} ${problem.message}`.trim());
    }

    const mine = readFlat(join(dirA, ".pi", "design"));
    const names = new Set(mine.tokens.map((token) => token.name));
    const theirs = new Set(first.tokens.map((token) => token.name));
    const shared = [...names].filter((name) => theirs.has(name)).length;

    result.namesAgree = rate(shared, new Set([...names, ...theirs]).size);

    const compiled = first.compiled;
    const json = (() => {
        try {
            return JSON.parse(compiled?.json ?? "") as unknown;
        } catch {
            return undefined;
        }
    })();

    result.compiled =
        typeof compiled?.css === "string" &&
        compiled.css.includes(":root") &&
        typeof compiled.tailwind === "string" &&
        compiled.tailwind.includes("@theme") &&
        json !== undefined &&
        (first.components.length === 0 ||
            (typeof compiled.components === "string" && compiled.components.trim() !== ""));

    if (!result.compiled) {
        note(
            "compiled output is incomplete (css with :root, tailwind with @theme, valid json, components.css).",
        );
    }

    if (modules.write !== undefined) {
        try {
            const change = changeFromDisk(join(dirB, ".pi", "design"));

            modules.write(dirB, change);
            const second = modules.load(dirB);

            result.roundTrip = second !== undefined && plain(first) === plain(second);

            if (result.roundTrip === false) {
                note("load, write, load gave a different system.");
            }

            const before = snapshot(join(dirB, ".pi", "design"));

            modules.write(dirB, change);
            result.idempotent = plain(before) === plain(snapshot(join(dirB, ".pi", "design")));

            if (result.idempotent === false) {
                note("writing the same change twice changed a file.");
            }

            const dist = join(dirB, ".pi", "design", "dist");
            const read = (file: string) =>
                existsSync(join(dist, file)) ? readFileSync(join(dist, file), "utf8") : undefined;

            result.dist =
                second !== undefined &&
                read("tokens.css") === second.compiled.css &&
                read("tailwind.css") === second.compiled.tailwind &&
                read("tokens.resolved.json") === second.compiled.json;

            if (result.dist === false) {
                note("dist/ does not hold the compiled files.");
            }
        } catch (error) {
            result.roundTrip = false;
            note(`write threw: ${String((error as Error).message).split("\n")[0]}`);
        }
    } else {
        note("writeDesignSystem is missing.");
    }

    if (browser !== undefined && typeof compiled?.css === "string") {
        try {
            result.css = await checkCss(browser, compiled.css, mine);

            for (const problem of result.css.problems.slice(0, 3)) {
                note(`css: ${problem}`);
            }
        } catch (error) {
            note(`css check failed: ${String((error as Error).message).split("\n")[0]}`);
        }
    }

    // The score: the mean of the parts that apply. A part that could not run counts as 0.
    const parts: number[] = [
        1,
        result.errors === 0 ? 1 : 0,
        result.namesAgree ?? 0,
        result.compiled ? 1 : 0,
        result.roundTrip === true ? 1 : 0,
        result.idempotent === true ? 1 : 0,
        result.dist === true ? 1 : 0,
        result.css?.parsed === true ? 1 : 0,
        result.css === undefined ? 0 : rate(result.css.defined, result.css.expected),
        result.css === undefined ? 0 : rate(result.css.valid, result.css.expected),
        result.css === undefined ? 0 : rate(result.css.correct, result.css.comparable),
    ];

    if (result.css?.mediaDark !== undefined) {
        parts.push(result.css.mediaDark ? 1 : 0);
    }

    result.score = parts.reduce((sum, part) => sum + part, 0) / parts.length;

    return result;
}

export interface FormatPhase {
    systems: FormatResult[];
    score: number;
    flagship: { present: boolean; path?: string };
}

export const isFolder = (path: string) => {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
};

export async function formatPhase(
    modules: Modules,
    browser: BenchBrowser | undefined,
    sources: SystemSource[],
    drafts: Map<string, Draft>,
    flagship: string | undefined,
): Promise<FormatPhase> {
    const parent = mkdtempSync(join(tmpdir(), "pocket-bench-format-"));
    const all = [...sources];
    const saveErrors = new Map<string, string>();

    try {
        for (const [name, draft] of drafts) {
            const saved = saveDraft(modules, draft, join(parent, "drafts"), `scan-${name}`);

            if (saved.error !== undefined) {
                saveErrors.set(`scan:${name}`, saved.error);
            }

            all.push({ name: `scan:${name}`, kind: "scan", project: saved.project });
        }

        if (flagship !== undefined) {
            all.push({ name: "flagship", kind: "flagship", project: flagship });
        }

        const systems: FormatResult[] = [];

        for (const source of all) {
            const result = await checkSystem(modules, browser, source, parent);
            const error = saveErrors.get(source.name);

            if (error !== undefined) {
                result.problems.unshift(`the engine refused to save the draft: ${error}`);
                result.loaded = false;
                result.score = 0;
            }

            systems.push(result);
        }

        const score =
            systems.length === 0
                ? 0
                : systems.reduce((sum, item) => sum + item.score, 0) / systems.length;

        return {
            systems,
            score: Math.round(score * 1000) / 1000,
            flagship: {
                present: flagship !== undefined,
                ...(flagship === undefined ? {} : { path: flagship }),
            },
        };
    } finally {
        rmSync(parent, { recursive: true, force: true });
    }
}
