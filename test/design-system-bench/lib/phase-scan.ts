/** Phase 1 — scan accuracy: run the scan on each fixture project and score the draft against `expected.json`. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flatten } from "./dtcg.ts";
import { runScan, type Draft, type Modules } from "./modules.ts";
import {
    aggregateScans,
    extract,
    SCAN_CATEGORIES,
    scoreScan,
    type Expected,
    type PRF,
    type ScanCategory,
    type ScanScore,
} from "./score.ts";

export const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Fixture {
    name: string;
    dir: string;
    expected: Expected;
}

/** The fixture projects, in name order. */
export function loadFixtures(root = join(BENCH, "fixtures")): Fixture[] {
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .map((name) => ({
            name,
            dir: join(root, name),
            expected: JSON.parse(
                readFileSync(join(root, name, "expected.json"), "utf8"),
            ) as Expected,
        }));
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const brief = (item: PRF) => ({
    precision: round(item.precision),
    recall: round(item.recall),
    f1: round(item.f1),
    expected: item.expected,
    actual: item.actual,
    matched: item.matched,
});

export interface ScanPhase {
    available: boolean;
    /** `engine` (the new scan), `baseline` (the 0.26 scan), or `none`. */
    source: string;
    fixtures: Record<
        string,
        {
            source: string;
            ms: number;
            note?: string;
            tokens: number;
            problems: string[];
            roles: ScanScore["roleDetail"];
            darkDetected: boolean;
            darkExpected: boolean;
            categories: Record<string, ReturnType<typeof brief>>;
        }
    >;
    aggregate: Record<
        string,
        ReturnType<typeof brief> & { fixtures: number; target: number; meetsTarget: boolean }
    >;
    /** The mean F1 over the categories: the number to climb. */
    score: number;
    drafts: Map<string, Draft>;
}

export async function scanPhase(
    modules: Modules,
    outDir: string,
    fixtures = loadFixtures(),
): Promise<ScanPhase> {
    const available = modules.scan !== undefined || modules.legacyScan !== undefined;
    const result: ScanPhase = {
        available,
        source: "none",
        fixtures: {},
        aggregate: {},
        score: 0,
        drafts: new Map(),
    };
    const scores: ScanScore[] = [];

    for (const fixture of fixtures) {
        const outcome = await runScan(modules, fixture.dir);

        result.source = outcome.source === "none" ? result.source : outcome.source;

        const flat = flatten(outcome.draft?.tokens ?? {}, outcome.draft?.modes ?? {});
        const score = scoreScan(fixture.expected, extract(flat));

        scores.push(score);

        if (outcome.draft !== undefined) {
            result.drafts.set(fixture.name, outcome.draft);
            const folder = join(outDir, "scan", fixture.name);

            mkdirSync(folder, { recursive: true });
            writeFileSync(
                join(folder, "tokens.json"),
                JSON.stringify(outcome.draft.tokens, null, 2),
            );

            for (const [mode, tree] of Object.entries(outcome.draft.modes)) {
                writeFileSync(join(folder, `tokens.${mode}.json`), JSON.stringify(tree, null, 2));
            }
        }

        result.fixtures[fixture.name] = {
            source: outcome.source,
            ms: outcome.ms,
            ...(outcome.note === undefined ? {} : { note: outcome.note }),
            tokens: flat.tokens.length,
            problems: flat.problems.slice(0, 5),
            roles: score.roleDetail,
            darkDetected: score.darkDetected,
            darkExpected: score.darkExpected,
            categories: Object.fromEntries(
                (Object.keys(SCAN_CATEGORIES) as ScanCategory[]).map((category) => [
                    category,
                    brief(score[category]),
                ]),
            ),
        };
    }

    const aggregate = aggregateScans(scores);

    for (const category of Object.keys(SCAN_CATEGORIES) as ScanCategory[]) {
        const item = aggregate[category];
        const target = SCAN_CATEGORIES[category];

        result.aggregate[category] = {
            ...brief(item),
            fixtures: item.fixtures,
            target,
            meetsTarget: item.applicable && item.precision >= target && item.recall >= target,
        };
    }

    const applicable = (Object.keys(SCAN_CATEGORIES) as ScanCategory[]).filter(
        (category) => aggregate[category].applicable,
    );

    result.score =
        available && applicable.length > 0
            ? round(
                  applicable.reduce((sum, category) => sum + aggregate[category].f1, 0) /
                      applicable.length,
              )
            : 0;

    return result;
}
