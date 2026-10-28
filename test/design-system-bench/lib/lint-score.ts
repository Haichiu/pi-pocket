/**
 * Lint scoring: match what `checkDesign` reported with the findings that a design was seeded with. A reported finding
 * is right when its rule and its element (`data-pid`) are the same and, when the expectation names a value, the value
 * is the same. Everything reported that nothing expected is a false finding; everything expected that nothing matched
 * is a miss. Rules in `../README.md`.
 */
import { colorOf, sameColor } from "./color.ts";
import { pixels } from "./dtcg.ts";

/** One finding that a seeded design must produce. */
export interface ExpectedFinding {
    rule: string;
    /** The element's `data-pid`. Leave out for a page-level finding (`missing-viewport`, `overflow`). */
    pid?: string;
    /** The value that breaks the rule (`#7ba3f8`, `15px`). Leave out when any value is fine. */
    value?: string;
    /** The token that the fix should name, in dotted form (`color.accent.default`): one, or any of several equal ones. */
    suggestion?: string | string[];
    level?: "error" | "warning";
}

/** The parts of a reported finding that the bench reads. */
export interface FoundFinding {
    rule: string;
    level?: string;
    selector?: string;
    pid?: string;
    value?: string;
    suggestion?: string;
}

export interface RuleCount {
    tp: number;
    fp: number;
    fn: number;
}

export interface LintMatch {
    /** Pairs of (expected index, found index), strong matches first. */
    pairs: [number, number][];
    /** Indexes of reported findings that nothing expected. */
    extra: number[];
    /** Indexes of expected findings that nothing reported. */
    missed: number[];
}

/** The first number in a text, with its unit stripped (`15px` → 15, `3.1:1` → 3.1). */
const number = (text: string) => {
    const match = /-?\d*\.?\d+/.exec(text);

    return match === null ? undefined : Number(match[0]);
};

/**
 * Whether a reported value is the expected one. Colors: ΔE 2000 within 3. Lengths: within half a pixel (`rem`/`em`
 * at 16 px). Ratios (`3.1:1`): within 0.3. Anything else: the same text without case or space, or the same first font
 * family.
 */
export function sameValue(expected: string, found: string): boolean {
    const [a, b] = [colorOf(expected), colorOf(found)];

    if (a !== undefined && b !== undefined) {
        return sameColor(a, b, 3, 0.05);
    }

    if (/:\s*1$/.test(expected) && /:\s*1$/.test(found)) {
        return Math.abs(number(expected)! - number(found)!) <= 0.3;
    }

    const [px, qx] = [pixels(expected), pixels(found)];

    if (px !== undefined && qx !== undefined) {
        return Math.abs(px - qx) <= 0.5;
    }

    const clean = (text: string) => text.toLowerCase().replace(/["'\s]/g, "");

    return (
        clean(expected) === clean(found) ||
        clean(expected.split(",")[0] ?? "") === clean(found.split(",")[0] ?? "")
    );
}

const onElement = (expected: ExpectedFinding, found: FoundFinding) => {
    if (expected.pid === undefined) {
        return true;
    }

    return (
        found.pid === expected.pid || (found.selector ?? "").includes(`data-pid="${expected.pid}"`)
    );
};

/**
 * One value, one finding: a reported finding with the same rule, element and value as an earlier one is dropped (a linter
 * that reports `color` and `border-color` of one element for the same literal has found one problem).
 */
export function dedupe(found: FoundFinding[]): FoundFinding[] {
    const out: FoundFinding[] = [];

    for (const item of found) {
        // Without an element there is nothing to say two findings are the same one.
        const located = (item.pid ?? "") !== "" || (item.selector ?? "") !== "";
        const same =
            located &&
            out.some(
                (other) =>
                    other.rule === item.rule &&
                    (other.pid ?? "") === (item.pid ?? "") &&
                    (other.selector ?? "") === (item.selector ?? "") &&
                    (other.value === item.value ||
                        (other.value !== undefined &&
                            item.value !== undefined &&
                            sameValue(other.value, item.value))),
            );

        if (!same) {
            out.push(item);
        }
    }

    return out;
}

/** Pair expected and reported findings: exact value first, then a value that is missing on one side. */
export function matchFindings(expected: ExpectedFinding[], found: FoundFinding[]): LintMatch {
    const takenExpected = new Set<number>();
    const takenFound = new Set<number>();
    const pairs: [number, number][] = [];

    const pass = (accept: (entry: ExpectedFinding, item: FoundFinding) => boolean) => {
        for (const [index, entry] of expected.entries()) {
            if (takenExpected.has(index)) {
                continue;
            }

            const hit = found.findIndex(
                (item, at) =>
                    !takenFound.has(at) &&
                    item.rule === entry.rule &&
                    onElement(entry, item) &&
                    accept(entry, item),
            );

            if (hit !== -1) {
                takenExpected.add(index);
                takenFound.add(hit);
                pairs.push([index, hit]);
            }
        }
    };

    // A finding with a value that differs does not match: an element can break a rule twice with two values.
    pass(
        (entry, item) =>
            entry.value !== undefined &&
            item.value !== undefined &&
            sameValue(entry.value, item.value),
    );
    pass(
        (entry, item) => entry.value === undefined || item.value === undefined || item.value === "",
    );

    return {
        pairs,
        extra: found.flatMap((_, index) => (takenFound.has(index) ? [] : [index])),
        missed: expected.flatMap((_, index) => (takenExpected.has(index) ? [] : [index])),
    };
}

/** Whether a fix names the token (`color.accent.default` is `var(--color-accent-default)` or the dotted name). */
export function namesToken(suggestion: string | undefined, accept: string | string[]): boolean {
    return (
        suggestion !== undefined &&
        (Array.isArray(accept) ? accept : [accept]).some((token) => namesOne(suggestion, token))
    );
}

function namesOne(suggestion: string, token: string): boolean {
    const variable = `--${token.replace(/\./g, "-")}`;
    const text = suggestion.toLowerCase();

    return (
        new RegExp(`${variable.toLowerCase()}(?![\\w-])`).test(text) ||
        text.includes(token.toLowerCase())
    );
}

export interface LintScore {
    expected: number;
    reported: number;
    tp: number;
    fp: number;
    fn: number;
    precision: number;
    recall: number;
    byRule: Record<string, RuleCount & { precision: number; recall: number }>;
    /** Of the matched findings that the expectation gave a value or a token for: how many were right. */
    value: { wanted: number; right: number };
    suggestion: { wanted: number; right: number };
    level: { wanted: number; right: number };
    /** For the log: what was missed and what was extra. */
    missed: ExpectedFinding[];
    extra: FoundFinding[];
}

/** Add up the matches of several designs. */
export function scoreLint(
    designs: { expected: ExpectedFinding[]; found: FoundFinding[] }[],
): LintScore {
    const byRule: Record<string, RuleCount> = {};
    const count = (rule: string) => (byRule[rule] ??= { tp: 0, fp: 0, fn: 0 });
    const score: LintScore = {
        expected: 0,
        reported: 0,
        tp: 0,
        fp: 0,
        fn: 0,
        precision: 1,
        recall: 1,
        byRule: {},
        value: { wanted: 0, right: 0 },
        suggestion: { wanted: 0, right: 0 },
        level: { wanted: 0, right: 0 },
        missed: [],
        extra: [],
    };

    for (const { expected, found: reported } of designs) {
        const found = dedupe(reported);
        const match = matchFindings(expected, found);

        score.expected += expected.length;
        score.reported += found.length;

        for (const [e, f] of match.pairs) {
            const entry = expected[e]!;
            const item = found[f]!;

            count(entry.rule).tp++;
            score.tp++;

            if (entry.value !== undefined) {
                score.value.wanted++;
                score.value.right +=
                    item.value !== undefined && sameValue(entry.value, item.value) ? 1 : 0;
            }

            if (entry.suggestion !== undefined) {
                score.suggestion.wanted++;
                score.suggestion.right += namesToken(item.suggestion, entry.suggestion) ? 1 : 0;
            }

            if (entry.level !== undefined) {
                score.level.wanted++;
                score.level.right += item.level === entry.level ? 1 : 0;
            }
        }

        for (const index of match.extra) {
            count(found[index]!.rule).fp++;
            score.fp++;
            score.extra.push(found[index]!);
        }

        for (const index of match.missed) {
            count(expected[index]!.rule).fn++;
            score.fn++;
            score.missed.push(expected[index]!);
        }
    }

    score.precision = score.tp + score.fp === 0 ? 1 : score.tp / (score.tp + score.fp);
    score.recall = score.tp + score.fn === 0 ? 1 : score.tp / (score.tp + score.fn);

    for (const [rule, item] of Object.entries(byRule)) {
        score.byRule[rule] = {
            ...item,
            precision: item.tp + item.fp === 0 ? 1 : item.tp / (item.tp + item.fp),
            recall: item.tp + item.fn === 0 ? 1 : item.tp / (item.tp + item.fn),
        };
    }

    return score;
}
