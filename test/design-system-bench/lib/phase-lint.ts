import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DesignSystem } from "../../../src/server/design/system-types.ts";
import { BENCH } from "./phase-scan.ts";
import {
    type ExpectedFinding,
    type FoundFinding,
    type LintScore,
    scoreLint,
} from "./lint-score.ts";
import { ROOT, withTimeout, type Modules } from "./modules.ts";
import { goldenCss, readFlat, systemFromFlat } from "./system.ts";

export const LINT_DIR = join(BENCH, "lint");
export const LINT_SYSTEM = join(LINT_DIR, "system");

export interface LintCase {
    name: string;
    clean: boolean;
    html: string;
    viewport: [number, number];
    colorSchemes: ("light" | "dark")[];
    expected: ExpectedFinding[];
    description: string;
}

export function loadLintCases(root = join(LINT_DIR, "designs")): LintCase[] {
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const meta = JSON.parse(
                readFileSync(join(root, entry.name, "expected-findings.json"), "utf8"),
            ) as {
                clean?: boolean;
                viewport: [number, number];
                colorSchemes: ("light" | "dark")[];
                findings: ExpectedFinding[];
                description: string;
            };

            return {
                name: entry.name,
                clean: meta.clean === true,
                html: readFileSync(join(root, entry.name, "index.html"), "utf8"),
                viewport: meta.viewport,
                colorSchemes: meta.colorSchemes,
                expected: meta.findings,
                description: meta.description,
            };
        })
        .sort((a, b) => Number(a.clean) - Number(b.clean) || a.name.localeCompare(b.name));
}

// Read by the bench's own reader by default, so the lint score does not depend on the tokens engine.
export function lintSystem(
    modules: Modules,
    prefer: "bench" | "engine" = "bench",
): { system: DesignSystem; source: string } {
    if (prefer === "engine" && modules.load !== undefined) {
        try {
            const loaded = modules.load(LINT_SYSTEM);

            if (loaded !== undefined && loaded.tokens.length > 0) {
                return { system: loaded, source: "tokens.ts" };
            }
        } catch {
            // Fall through to the bench's reader.
        }
    }

    return {
        system: systemFromFlat(readFlat(join(LINT_SYSTEM, ".pi", "design")), "Bench"),
        source: "bench reader",
    };
}

const OPTION_SHAPES = [
    (width: number, height: number, colorScheme: string) => ({
        viewport: { width, height },
        colorScheme,
    }),
    (width: number, height: number, colorScheme: string) => ({
        viewport: `${width}x${height}`,
        colorScheme,
    }),
    (width: number, height: number, colorScheme: string) => ({ width, height, colorScheme }),
];

const host = {
    fetchPublic: async () => {
        throw new Error("The bench is offline.");
    },
};

export interface LintCaseResult {
    name: string;
    clean: boolean;
    colorScheme: string;
    reportedScheme?: string;
    findings: FoundFinding[];
    expected: number;
    error?: string;
    ms: number;
}

export interface LintPhase {
    available: boolean;
    systemSource: string;
    optionsShape?: number;
    precision: number;
    recall: number;
    f1: number;
    seeded: LintScore | undefined;
    byRule: LintScore["byRule"];
    cleanFindings: number;
    /** Informational, not in the score: the clean designs on the flagship's own CSS, when it defines the same variables. */
    cleanOnFlagship: {
        checked: boolean;
        reason?: string;
        findings?: number;
        errors?: number;
        sample?: FoundFinding[];
    };
    value: LintScore["value"];
    suggestion: LintScore["suggestion"];
    level: LintScore["level"];
    cases: LintCaseResult[];
    missed: ExpectedFinding[];
    extra: FoundFinding[];
    score: number;
}

async function runCase(
    check: NonNullable<Modules["check"]>,
    system: DesignSystem,
    css: Buffer,
    item: LintCase,
    scheme: "light" | "dark",
    state: { shape: number },
): Promise<LintCaseResult> {
    const bundle = {
        meta: { title: item.name, type: "html", versions: [] },
        version: 1,
        content: item.html,
        assets: [{ name: "ds/tokens.css", type: "text/css", bytes: css }],
    };
    const start = Date.now();
    const entry: LintCaseResult = {
        name: item.name,
        clean: item.clean,
        colorScheme: scheme,
        findings: [],
        expected: item.clean ? 0 : item.expected.length,
        ms: 0,
    };

    try {
        let report: Awaited<ReturnType<NonNullable<Modules["check"]>>> | undefined;
        let failure: unknown;

        for (
            let attempt = state.shape;
            attempt < OPTION_SHAPES.length && report === undefined;
            attempt++
        ) {
            try {
                const options = OPTION_SHAPES[attempt]!(item.viewport[0], item.viewport[1], scheme);

                report = await withTimeout(
                    Promise.resolve(
                        check(bundle, system, options, host, AbortSignal.timeout(120_000)),
                    ),
                    150_000,
                    "checkDesign",
                );
                state.shape = attempt;
            } catch (error) {
                failure = error;

                // Only a complaint about the options is worth another shape; a crash in the check is not.
                if (
                    !/option|viewport|width|height|scheme|invalid|must be/i.test(
                        String((error as Error).message),
                    )
                ) {
                    break;
                }
            }
        }

        if (report === undefined) {
            throw failure ?? new Error("checkDesign returned nothing.");
        }

        entry.reportedScheme = report.colorScheme;
        entry.findings = (report.findings ?? []).map((finding) => ({
            rule: finding.rule,
            level: finding.level,
            selector: finding.selector,
            pid: finding.pid,
            value: finding.value,
            suggestion: finding.suggestion,
        }));
    } catch (error) {
        entry.error = String((error as Error).message ?? error).split("\n")[0];
    }

    entry.ms = Date.now() - start;

    return entry;
}

export const variablesUsed = (html: string) => [
    ...new Set([...html.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]!)),
];

export interface FlagshipStyle {
    system: DesignSystem;
    css: string;
}

export interface LintSystemChoice {
    system: DesignSystem;
    css: Buffer;
    source: string;
}

// A lint folder's `system.json` (`{ "project": "<folder>" }`) names the project its designs are written for.
export function lintSystemFor(root: string): LintSystemChoice | undefined {
    const file = join(root, "system.json");

    if (!existsSync(file)) {
        return undefined;
    }

    const config = JSON.parse(readFileSync(file, "utf8")) as { project?: unknown };

    if (typeof config.project !== "string") {
        throw new Error(`${file} needs a "project" folder.`);
    }

    const project = isAbsolute(config.project) ? config.project : resolve(ROOT, config.project);
    const flat = readFlat(join(project, ".pi", "design"));

    return {
        system: systemFromFlat(flat, "Lint system"),
        css: Buffer.from(goldenCss(flat)),
        source: `bench reader, ${config.project}`,
    };
}

export async function lintPhase(
    modules: Modules,
    outDir: string,
    cases = loadLintCases(),
    flagship?: FlagshipStyle,
    choice?: LintSystemChoice,
): Promise<LintPhase> {
    const { system, source } = choice ?? lintSystem(modules);
    const phase: LintPhase = {
        available: modules.check !== undefined,
        systemSource: source,
        precision: 0,
        recall: 0,
        f1: 0,
        seeded: undefined,
        byRule: {},
        cleanFindings: 0,
        cleanOnFlagship: { checked: false, reason: "The flagship is not in the tree." },
        value: { wanted: 0, right: 0 },
        suggestion: { wanted: 0, right: 0 },
        level: { wanted: 0, right: 0 },
        cases: [],
        missed: [],
        extra: [],
        score: 0,
    };

    if (modules.check === undefined) {
        return phase;
    }

    const tokensCss = choice?.css ?? readFileSync(join(LINT_SYSTEM, "golden", "tokens.css"));
    const scored: { expected: ExpectedFinding[]; found: FoundFinding[] }[] = [];
    const state = { shape: 0 };

    mkdirSync(join(outDir, "lint"), { recursive: true });

    for (const item of cases) {
        for (const scheme of item.colorSchemes) {
            const entry = await runCase(modules.check, system, tokensCss, item, scheme, state);

            phase.cases.push(entry);
            writeFileSync(
                join(outDir, "lint", `${item.name}-${scheme}.json`),
                JSON.stringify(entry, null, 2),
            );

            scored.push({ expected: item.clean ? [] : item.expected, found: entry.findings });
        }
    }

    // Only when the flagship defines every variable the designs use: a missing one would be the design's fault.
    if (flagship !== undefined) {
        const defined = new Set(
            [...flagship.css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]!),
        );
        const missing = [
            ...new Set(
                cases.filter((item) => item.clean).flatMap((item) => variablesUsed(item.html)),
            ),
        ].filter((name) => !defined.has(name));

        if (missing.length > 0) {
            phase.cleanOnFlagship = {
                checked: false,
                reason: `The flagship does not define ${missing.length} of the variables that the clean designs use (${missing.slice(0, 4).join(", ")}).`,
            };
        } else {
            const results: LintCaseResult[] = [];

            for (const item of cases.filter((entry) => entry.clean)) {
                for (const scheme of item.colorSchemes) {
                    results.push(
                        await runCase(
                            modules.check,
                            flagship.system,
                            Buffer.from(flagship.css),
                            item,
                            scheme,
                            state,
                        ),
                    );
                }
            }

            phase.cleanOnFlagship = {
                checked: true,
                findings: results.reduce((sum, item) => sum + item.findings.length, 0),
                errors: results.filter((item) => item.error !== undefined).length,
                sample: results.flatMap((item) => item.findings).slice(0, 5),
            };
        }
    }

    phase.optionsShape = state.shape;
    const score = scoreLint(scored);
    const clean = phase.cases.filter((item) => item.clean);

    phase.seeded = score;
    phase.precision = round(score.precision);
    phase.recall = round(score.recall);
    phase.f1 =
        phase.precision + phase.recall === 0
            ? 0
            : round((2 * phase.precision * phase.recall) / (phase.precision + phase.recall));
    phase.byRule = score.byRule;
    phase.cleanFindings = clean.reduce((sum, item) => sum + item.findings.length, 0);
    phase.value = score.value;
    phase.suggestion = score.suggestion;
    phase.level = score.level;
    phase.missed = score.missed;
    phase.extra = score.extra;
    phase.score = phase.f1;

    return phase;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export const lintSystemPresent = () =>
    existsSync(join(LINT_SYSTEM, ".pi", "design", "tokens.json"));
