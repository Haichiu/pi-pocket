/**
 * Phase 3 — lint: run `checkDesign` on the seeded designs and the clean ones, with the bench's own system and golden
 * `tokens.css` (so the result does not depend on the tokens engine), and score what it reports.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignSystem } from "../../../src/server/design/system-types.ts";
import { BENCH } from "./phase-scan.ts";
import {
    type ExpectedFinding,
    type FoundFinding,
    type LintScore,
    scoreLint,
} from "./lint-score.ts";
import { withTimeout, type Modules } from "./modules.ts";
import { readFlat, systemFromFlat } from "./system.ts";

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

/** The seeded and clean designs, clean ones last. */
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

/**
 * The bench system that is handed to `checkDesign`. By default it is read by the bench's own reader, so the lint score does
 * not depend on the tokens engine (the format phase checks the engine on this same system). `prefer: "engine"` loads it
 * with `loadDesignSystem`, as the docs phase does, so that components and compiled files are there.
 */
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

/** Option shapes for `checkDesign`: the plan does not fix them, so try the likely ones until one is accepted. */
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
    /** Findings on the clean designs, in each color scheme: the target is 0. */
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

/** One design in one color scheme through `checkDesign`. `state.shape` remembers which option shape was accepted. */
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

/** The custom properties that a page asks for with `var(--…)`. */
export const variablesUsed = (html: string) => [
    ...new Set([...html.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]!)),
];

export interface FlagshipStyle {
    system: DesignSystem;
    /** The flagship's `tokens.css`. */
    css: string;
}

export async function lintPhase(
    modules: Modules,
    outDir: string,
    cases = loadLintCases(),
    flagship?: FlagshipStyle,
): Promise<LintPhase> {
    const { system, source } = lintSystem(modules);
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

    const tokensCss = readFileSync(join(LINT_SYSTEM, "golden", "tokens.css"));
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

            // A design that failed to run reports nothing: its expected findings are all misses.
            scored.push({ expected: item.clean ? [] : item.expected, found: entry.findings });
        }
    }

    // Beside the score: do the clean designs stay clean on the flagship's own tokens? Only when it defines every variable
    // that they use (the plan's names), because a missing variable would be the design's fault, not the linter's.
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
    // A run that reports nothing has perfect precision and zero recall, and the F1 says 0: that is right.
    phase.score = phase.f1;

    return phase;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export const lintSystemPresent = () =>
    existsSync(join(LINT_SYSTEM, ".pi", "design", "tokens.json"));
