/** The engines that the System view's routes call, behind one import: tokens (T), checks and fixes (V), and the docs page (G). */
import type { DesignBundle } from "../../design/bundle.ts";
import { applyExactFixes } from "../../design/fix.ts";
import type { CheckFinding, CheckReport, DesignSystem } from "../../design/system-types.ts";

export { loadDesignSystem, writeDesignSystem } from "../../design/tokens.ts";
export { type CheckOptions, checkDesign } from "../../design/lint.ts";
export { renderSystemDoc } from "../../design/docsite.ts";

/** What a one-tap fix did: the new page, how many places changed, and each literal that became a token. */
export interface FixResult {
    content: string;
    fixed: number;
    fixes: { rule: CheckFinding["rule"]; from: string; to: string; count: number }[];
}

/** Whether one tap can fix a finding: the check marks a literal that equals a token exactly with `fix`. */
export function isFixable(finding: CheckFinding, _system?: DesignSystem, _mode?: string): boolean {
    return finding.fix !== undefined;
}

/**
 * Rewrite the exact matches of a check in a version's page (`applyExactFixes`: only `<style>` and `style=""`, only where
 * the place is certain). Findings that it skips are left for Pi.
 */
export function fixExactMatches(
    bundle: DesignBundle,
    system: DesignSystem,
    report: CheckReport,
    _options?: { mode?: string },
): FixResult {
    const fixable = report.findings.filter((finding) => isFixable(finding));
    const result = applyExactFixes(bundle.content, fixable, system);
    const skipped = new Set(result.skipped.map((each) => each.id));
    const fixes = new Map<string, FixResult["fixes"][number]>();

    for (const finding of fixable) {
        if (result.applied === 0 || skipped.has(finding.id ?? "")) {
            continue;
        }

        const key = `${finding.fix!.literal}\u0000${finding.fix!.cssVar}`;
        const known = fixes.get(key);

        if (known === undefined) {
            fixes.set(key, {
                rule: finding.rule,
                from: finding.fix!.literal,
                to: `var(${finding.fix!.cssVar})`,
                count: 1,
            });
        } else {
            known.count += 1;
        }
    }

    return { content: result.content, fixed: result.applied, fixes: [...fixes.values()] };
}
