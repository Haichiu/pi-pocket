/**
 * The design system bench. `node test/design-system-bench/run.ts [--out dir] [--only scan,format,lint,contrast,docs]`
 * prints one JSON object with every metric and writes screenshots and drafts to `--out` (default /tmp/ds-bench).
 * It needs no model. A part that is not in the tree yet scores 0 with a note; it never stops the run.
 * What each number means, and how it is matched: `README.md`.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesignSystem } from "../../src/server/design/system-types.ts";
import { BenchBrowser } from "./lib/chromium.ts";
import { loadModules, ROOT, type Modules } from "./lib/modules.ts";
import { referenceModules } from "./lib/reference.ts";
import { contrastPhase, docsPhase, type ContrastPhase, type DocsPhase } from "./lib/phase-docs.ts";
import { formatPhase, isFolder, type FormatPhase, type SystemSource } from "./lib/phase-format.ts";
import {
    lintPhase,
    LINT_SYSTEM,
    lintSystem,
    loadLintCases,
    type LintPhase,
} from "./lib/phase-lint.ts";
import { BENCH, loadFixtures, scanPhase, type ScanPhase } from "./lib/phase-scan.ts";
import { COLOR_TOLERANCE, SCAN_CATEGORIES, SIZE_TOLERANCE } from "./lib/score.ts";
import { readFlat, systemFromFlat } from "./lib/system.ts";

export const PHASES = ["scan", "format", "lint", "contrast", "docs"] as const;
export type Phase = (typeof PHASES)[number];

/** Where Stream G's flagship may be, in order. A folder with `.pi/design/` in it, or the contents of `.pi/design/`. */
export const FLAGSHIP_CANDIDATES = [
    "test/fixtures/design-system/flagship",
    "docs/examples/design-system/pocket",
];

export interface BenchOptions {
    out?: string;
    only?: Phase[];
    modules?: Modules;
    /** False skips everything that needs Chromium (CSS check, docs page). */
    browser?: boolean;
    /** Run against the reference implementations (the ceiling check), not the streams' code. */
    reference?: boolean;
    /** A flagship folder, instead of looking in FLAGSHIP_CANDIDATES. */
    flagship?: string;
    /** A folder of fixture projects (each with `expected.json`), instead of `fixtures/`. */
    fixtures?: string;
    /** A folder of lint designs (each a folder with `index.html` and `expected-findings.json`), instead of `lint/designs/`. */
    lint?: string;
    log?: (text: string) => void;
}

export interface BenchReport {
    bench: { version: number; node: string; started: string; ms: number; out: string };
    environment: {
        chromium: boolean;
        modules: Modules["present"];
        flagship: { present: boolean; path?: string };
    };
    /** Everything that was missing or failed and why, in plain words. */
    notes: string[];
    scan?: Omit<ScanPhase, "drafts">;
    format?: FormatPhase;
    lint?: LintPhase;
    contrast?: ContrastPhase;
    docs?: DocsPhase;
    /** 0 to 1 for each phase that ran. The rubric lines they feed: scan 2, lint 3, contrast 4, docs 7. */
    scores: Partial<Record<Phase, number>> & { overall: number };
    /** Whether each number reaches its target (docs/design/design-system.md, Rubric). */
    targets: Record<string, boolean>;
    matching: {
        colorDeltaE: number;
        sizeTolerancePx: number;
        scanCategories: Record<string, number>;
    };
}

/** The flagship's project folder, or `undefined`. A folder that holds `tokens.json` directly is copied into a project. */
export function findFlagship(parent: string, explicit?: string): string | undefined {
    for (const candidate of explicit === undefined
        ? FLAGSHIP_CANDIDATES.map((path) => join(ROOT, path))
        : [resolve(explicit)]) {
        if (existsSync(join(candidate, ".pi", "design", "tokens.json"))) {
            return candidate;
        }

        if (existsSync(join(candidate, "tokens.json"))) {
            const project = join(parent, "flagship-project");

            mkdirSync(join(project, ".pi"), { recursive: true });
            cpSync(candidate, join(project, ".pi", "design"), { recursive: true });

            return project;
        }
    }

    return undefined;
}

/** The flagship's `tokens.css`: the committed `dist/` file, else what the engine compiled. */
function flagshipCss(project: string | undefined, system: DesignSystem): string {
    const file =
        project === undefined ? undefined : join(project, ".pi", "design", "dist", "tokens.css");

    try {
        return file !== undefined && existsSync(file)
            ? readFileSync(file, "utf8")
            : system.compiled.css;
    } catch {
        return system.compiled.css;
    }
}

/** The hand-written systems that the format phase checks beside the flagship and the scan drafts. */
export function formatSources(): SystemSource[] {
    return [
        { name: "classic", kind: "fixture", project: join(BENCH, "format", "classic") },
        { name: "modern", kind: "fixture", project: join(BENCH, "format", "modern") },
        { name: "bench-lint", kind: "fixture", project: LINT_SYSTEM },
    ];
}

const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number) => Math.round(value * 1000) / 1000;

export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
    const started = Date.now();
    const log = options.log ?? (() => {});
    const out = resolve(options.out ?? "/tmp/ds-bench");
    const only = options.only ?? [...PHASES];
    const parent = mkdtempSync(join(tmpdir(), "pocket-bench-run-"));
    const notes: string[] = [];
    const browser =
        options.browser === false
            ? undefined
            : await BenchBrowser.launch().catch((error) => {
                  notes.push(
                      `Chromium did not start: ${String((error as Error).message).split("\n")[0]}`,
                  );

                  return undefined;
              });
    const modules =
        options.modules ??
        (options.reference === true
            ? referenceModules(
                  browser,
                  options.fixtures === undefined ? undefined : resolve(options.fixtures),
              )
            : await loadModules());

    notes.push(...modules.notes);
    // The ceiling run has no flagship of its own: the bench's system stands in, so every phase can reach 1.
    const flagship =
        options.reference === true && options.flagship === undefined
            ? LINT_SYSTEM
            : findFlagship(parent, options.flagship);

    mkdirSync(out, { recursive: true });

    if (
        options.browser !== false &&
        browser === undefined &&
        !notes.some((note) => note.startsWith("Chromium"))
    ) {
        notes.push(
            "No Chromium or Chrome was found: the CSS check and the docs page are scored 0.",
        );
    }

    if (flagship === undefined) {
        notes.push(
            `The flagship is not in the tree yet (looked in ${FLAGSHIP_CANDIDATES.join(", ")}): the contrast and docs phases use the bench's own system.`,
        );
    }

    const report: BenchReport = {
        bench: {
            version: 1,
            node: process.version,
            started: new Date(started).toISOString(),
            ms: 0,
            out,
        },
        environment: {
            chromium: browser !== undefined,
            modules: modules.present,
            flagship: {
                present: flagship !== undefined,
                ...(flagship === undefined ? {} : { path: flagship }),
            },
        },
        notes,
        scores: { overall: 0 },
        targets: {},
        matching: {
            colorDeltaE: COLOR_TOLERANCE,
            sizeTolerancePx: SIZE_TOLERANCE,
            scanCategories: { ...SCAN_CATEGORIES },
        },
    };

    const guard = async <T>(phase: Phase, run: () => Promise<T>): Promise<T | undefined> => {
        log(`phase ${phase}`);

        try {
            return await run();
        } catch (error) {
            notes.push(
                `The ${phase} phase failed: ${String((error as Error).stack ?? error)
                    .split("\n")
                    .slice(0, 3)
                    .join(" | ")}`,
            );

            return undefined;
        }
    };

    try {
        let drafts = new Map<string, import("./lib/modules.ts").Draft>();

        if (only.includes("scan") || only.includes("format")) {
            const scan = await guard("scan", () =>
                scanPhase(
                    modules,
                    out,
                    options.fixtures === undefined
                        ? undefined
                        : loadFixtures(resolve(options.fixtures)),
                ),
            );

            if (scan !== undefined) {
                drafts = scan.drafts;

                if (only.includes("scan")) {
                    const { drafts: _drafts, ...rest } = scan;

                    report.scan = rest;
                    report.scores.scan = rest.score;

                    if (!rest.available) {
                        notes.push("There is no scan (scan.ts is missing): the scan scores 0.");
                    } else if (rest.source === "baseline") {
                        notes.push(
                            "The scan is the 0.26 scan (scanTokens): the numbers are a baseline.",
                        );
                    }
                }
            }
        }

        if (only.includes("format")) {
            const format = await guard("format", () =>
                formatPhase(modules, browser, formatSources(), drafts, flagship),
            );

            if (format !== undefined) {
                report.format = format;
                report.scores.format = format.score;
            }
        }

        // The system that the contrast and docs phases read: the flagship, else the bench's own.
        let primary: DesignSystem | undefined;
        let label = "bench";

        if (only.includes("contrast") || only.includes("docs") || only.includes("lint")) {
            const load = (project: string) => {
                try {
                    return modules.load?.(project);
                } catch {
                    return undefined;
                }
            };

            if (flagship !== undefined) {
                label = "flagship";
                primary = load(flagship);

                // The tokens engine may be missing or may refuse the flagship; the bench's reader gives the contrast.
                if (primary === undefined) {
                    try {
                        primary = systemFromFlat(
                            readFlat(join(flagship, ".pi", "design")),
                            "flagship",
                        );
                        notes.push(
                            "The flagship was read by the bench's own reader (the tokens engine did not load it).",
                        );
                    } catch (error) {
                        notes.push(
                            `The flagship could not be read: ${String((error as Error).message).split("\n")[0]}`,
                        );
                    }
                }
            }

            if (primary === undefined) {
                label = "bench";
                primary = lintSystem(modules, "engine").system;
            }
        }

        if (only.includes("lint")) {
            const lint = await guard("lint", () =>
                lintPhase(
                    modules,
                    out,
                    options.lint === undefined ? undefined : loadLintCases(resolve(options.lint)),
                    label === "flagship" && primary !== undefined
                        ? { system: primary, css: flagshipCss(flagship, primary) }
                        : undefined,
                ),
            );

            if (lint !== undefined) {
                report.lint = lint;
                report.scores.lint = lint.score;

                if (!lint.available) {
                    notes.push("There is no checkDesign (lint.ts is missing): lint scores 0.");
                }
            }
        }

        if (only.includes("contrast")) {
            report.contrast = contrastPhase(primary, label, label === "flagship");
            report.scores.contrast = report.contrast.score;

            if (label !== "flagship") {
                notes.push("Contrast earns nothing until the flagship is in the tree.");
            } else if (report.contrast.declared === 0) {
                notes.push(`The ${label} system declares no contrast pairs: contrast scores 0.`);
            }
        }

        if (only.includes("docs")) {
            const docs = await guard("docs", () =>
                docsPhase(modules, browser, primary, label, out),
            );

            if (docs !== undefined) {
                report.docs = docs;
                report.scores.docs = docs.score;

                if (!docs.available) {
                    notes.push(
                        "There is no renderSystemDoc (docsite.ts is missing): docs scores 0.",
                    );
                }
            }
        }

        const run = PHASES.filter((phase) => only.includes(phase));

        // A phase that failed has no report and scores 0.
        for (const phase of run) {
            report.scores[phase] ??= 0;
        }

        report.scores.overall = round(mean(run.map((phase) => report.scores[phase] ?? 0)));
        report.targets = {
            "scan: colors precision and recall >= 0.9":
                report.scan?.aggregate.colors?.meetsTarget ?? false,
            "scan: roles precision and recall >= 0.9":
                report.scan?.aggregate.roles?.meetsTarget ?? false,
            "scan: type, spacing, radii >= 0.85": ["typeScale", "spacing", "radii"].every(
                (key) => report.scan?.aggregate[key]?.meetsTarget === true,
            ),
            "lint: precision >= 0.95":
                (report.lint?.available ?? false) && (report.lint?.precision ?? 0) >= 0.95,
            "lint: recall >= 0.9":
                (report.lint?.available ?? false) && (report.lint?.recall ?? 0) >= 0.9,
            "lint: no finding on the clean designs":
                (report.lint?.available ?? false) &&
                report.lint?.cleanFindings === 0 &&
                (report.lint?.cases.every((item) => item.error === undefined) ?? false),
            "contrast: every declared pair passes in every mode":
                report.contrast?.system === "flagship" &&
                (report.contrast?.declared ?? 0) > 0 &&
                report.contrast?.passRate === 1,
            "format: every system scores 1":
                (report.format?.systems.length ?? 0) > 0 &&
                report.format!.systems.every((item) => item.score === 1),
            "docs: every check passes":
                report.docs?.available === true &&
                Object.values(report.docs.checks).length > 0 &&
                Object.values(report.docs.checks).every(Boolean),
        };
    } finally {
        await browser?.close().catch(() => {});
        rmSync(parent, { recursive: true, force: true });
    }

    report.bench.ms = Date.now() - started;

    return report;
}

function parseArgs(argv: string[]): BenchOptions & { help: boolean } {
    const options: BenchOptions & { help: boolean } = { help: false };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === "--out") {
            options.out = argv[++index];
        } else if (arg === "--only") {
            options.only = (argv[++index] ?? "").split(",").filter(Boolean) as Phase[];
        } else if (arg === "--flagship") {
            options.flagship = argv[++index];
        } else if (arg === "--fixtures") {
            options.fixtures = argv[++index];
        } else if (arg === "--lint") {
            options.lint = argv[++index];
        } else if (arg === "--no-browser") {
            options.browser = false;
        } else if (arg === "--reference") {
            options.reference = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    for (const phase of options.only ?? []) {
        if (!PHASES.includes(phase)) {
            throw new Error(`--only takes ${PHASES.join(", ")}.`);
        }
    }

    for (const [flag, folder] of [
        ["--flagship", options.flagship],
        ["--fixtures", options.fixtures],
        ["--lint", options.lint],
    ] as const) {
        if (folder !== undefined && !isFolder(resolve(folder))) {
            throw new Error(`${flag} ${folder} is not a folder.`);
        }
    }

    return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const options = parseArgs(process.argv.slice(2));

        if (options.help) {
            console.error(
                "node test/design-system-bench/run.ts [--out dir] [--only scan,format,lint,contrast,docs] [--flagship dir] [--no-browser] [--reference] [--fixtures dir] [--lint dir]",
            );
        } else {
            const report = await runBench({
                ...options,
                log: (text) => console.error(`[bench] ${text}`),
            });

            console.log(JSON.stringify(report, null, 2));
        }
    } catch (error) {
        console.error(String((error as Error).message ?? error));
        process.exitCode = 2;
    }
}

// Keep the bench's reader linked for tools that import this module to build a system without the engine.
export { readFlat, systemFromFlat };
