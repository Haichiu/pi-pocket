import type { DesignBundle } from "../../design/bundle.ts";
import { applyExactFixes } from "../../design/fix.ts";
import type { CheckFinding, CheckReport, DesignSystem } from "../../design/system-types.ts";

export { loadDesignSystem, writeDesignSystem } from "../../design/tokens.ts";
export { type CheckOptions, checkDesign } from "../../design/lint.ts";
export { renderSystemDoc } from "../../design/docsite.ts";

export interface FixResult {
    content: string;
    fixed: number;
    fixes: { rule: CheckFinding["rule"]; from: string; to: string; count: number }[];
}

export function isFixable(finding: CheckFinding): boolean {
    return finding.fix !== undefined;
}

export function fixExactMatches(
    bundle: DesignBundle,
    system: DesignSystem,
    report: CheckReport,
    options?: { mode?: string; accepted?: ReadonlySet<string> },
): FixResult {
    const fixable = report.findings.filter(
        (finding) =>
            isFixable(finding) && !(finding.id !== undefined && options?.accepted?.has(finding.id)),
    );
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
