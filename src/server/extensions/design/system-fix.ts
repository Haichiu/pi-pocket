/**
 * A STAND-IN for stream V's engine function that rewrites exact matches in a design's source: a literal that is the value of
 * a token (`#7aa2f7` when `color.accent.default` is `#7aa2f7`; `14px` as a font size when `font.size.sm` is 14px) becomes
 * `var(--that-token)`. The route (`system-routes.ts`, `system/fix`) and the Check dock use only the signature below, so that
 * V's function replaces this one by changing the line in `system-api.ts`.
 *
 * What it does, and no more: it takes the findings of a check that say a value is "written as a literal" (the engine's own
 * word for a value that equals a token) and have a `value` and a `suggestion`, and rewrites that value in the declarations of
 * the page's `<style>` blocks and `style=""` attributes: colors anywhere in a declaration, sizes only in the properties the
 * finding names. A value that two findings want as different tokens is left alone. Scripts, text, attributes other than
 * `style`, selectors, and assets are never touched.
 */
import { parseColor } from "../../design/color.ts";
import type { DesignBundle } from "../../design/bundle.ts";
import type { CheckFinding, CheckReport, DesignSystem } from "../../design/system-types.ts";

/** What a rewrite did: the new page, and each value that was changed. */
export interface FixResult {
    /** The page, with the exact matches rewritten. */
    content: string;
    /** How many places were rewritten. */
    fixed: number;
    /** What was rewritten: the literal, the token's variable, and how many places. */
    fixes: { rule: CheckFinding["rule"]; from: string; to: string; count: number }[];
}

/** The signature of V's function: the version's bundle, the system, the report of a check of it, and the mode checked. */
export type FixExactMatches = (
    bundle: DesignBundle,
    system: DesignSystem,
    report: CheckReport,
    options?: { mode?: string },
) => FixResult;

const LITERAL = /is written as a literal/;
const VAR = /^var\(--[A-Za-z0-9_-]{1,78}\)$/;

/**
 * Whether a finding is one that this can fix: a color or a size that is exactly a token's, with the token to use. The check
 * says "written as a literal" for a value that is the token's within a small tolerance too, so, with the system, the value is
 * compared with the token's own in `mode` (the default mode when none): a value that is only close is not rewritten.
 */
export function isFixable(finding: CheckFinding, system?: DesignSystem, mode?: string): boolean {
    if (!(
        (finding.rule === "off-system-color" || finding.rule === "off-system-size") &&
        typeof finding.value === "string" &&
        finding.value.length <= 60 &&
        typeof finding.suggestion === "string" &&
        VAR.test(finding.suggestion) &&
        LITERAL.test(finding.message)
    )) {
        return false;
    }

    if (system === undefined) {
        return true;
    }

    const name = /^var\((--[^)]+)\)$/.exec(finding.suggestion)![1];
    const token = system.tokens.find((each) => each.cssVar === name);
    const value = token?.modes[mode ?? system.modes[0] ?? "light"];

    if (token === undefined || value === undefined) {
        return false;
    }

    if (finding.rule === "off-system-color") {
        const wanted = parseColor(finding.value);
        const have = parseColor(value.literal ?? value.hex ?? "");

        return (
            wanted !== undefined &&
            have !== undefined &&
            (["r", "g", "b", "a"] as const).every(
                (part) => Math.abs(wanted[part] - have[part]) < 1e-6,
            )
        );
    }

    const px = (text: string) => {
        const found = /^(-?\d*\.?\d+)px$/.exec(text.trim());

        return found === null ? undefined : Number(found[1]);
    };

    return px(finding.value) !== undefined && px(finding.value) === px(value.literal ?? "");
}

/** The properties that a size finding names: `font-size 14px is written as a literal…` → `["font-size"]`. */
function propertiesOf(finding: CheckFinding): string[] {
    const found = /^([a-z][a-z, -]{0,80}?) -?\d[\d.]*px is written as a literal/.exec(
        finding.message,
    );

    return found === null
        ? []
        : found[1]!
              .split(",")
              .map((part) => part.trim())
              .filter((part) => /^[a-z-]{1,40}$/.test(part));
}

/** How many findings can be fixed in a report. */
export const fixableCount = (report: CheckReport, system?: DesignSystem, mode?: string): number =>
    report.findings.filter((each) => isFixable(each, system, mode)).length;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Rewrite {
    rule: CheckFinding["rule"];
    from: string;
    to: string;
    /** For a size: the properties it is for. Empty: any. */
    properties: string[];
}

export const fixExactMatches: FixExactMatches = (bundle, system, report, options) => {
    // One rewrite for each literal; a literal that two findings want as different tokens is left alone.
    const wanted = new Map<string, Rewrite | null>();

    for (const finding of report.findings.filter((each) =>
        isFixable(each, system, options?.mode),
    )) {
        const key = `${finding.rule}:${finding.value!.toLowerCase()}`;
        const rewrite: Rewrite = {
            rule: finding.rule,
            from: finding.value!,
            to: finding.suggestion!,
            properties: finding.rule === "off-system-size" ? propertiesOf(finding) : [],
        };
        const before = wanted.get(key);

        if (before === undefined) {
            wanted.set(key, rewrite);
        } else if (
            before !== null &&
            (before.to !== rewrite.to || before.properties.join() !== rewrite.properties.join())
        ) {
            wanted.set(key, null);
        }
    }

    const rewrites = [...wanted.values()].filter(
        (each): each is Rewrite =>
            each !== null && (each.rule === "off-system-color" || each.properties.length > 0),
    );
    const counts = new Map<Rewrite, number>();

    /** The declarations of a block of CSS (`a: b; c: d`), with the values rewritten. */
    const declarations = (css: string): string =>
        css.replace(
            /(-{0,2}[A-Za-z][A-Za-z0-9-]*)(\s*:\s*)([^;{}]*)/g,
            (whole, property: string, colon: string, value: string) => {
                // A custom property is a definition, often of the token itself (`--color-white: #fff` where a token is `#fff`):
                // rewriting it would make a token refer to another, or to itself.
                if (property.startsWith("--")) {
                    return whole;
                }

                let next = value;

                for (const rewrite of rewrites) {
                    if (
                        rewrite.properties.length > 0 &&
                        !rewrite.properties.includes(property.toLowerCase())
                    ) {
                        continue;
                    }

                    const pattern =
                        rewrite.rule === "off-system-color"
                            ? new RegExp(`${escape(rewrite.from)}(?![0-9a-fA-F])`, "gi")
                            : new RegExp(`(?<![\\w.#-])${escape(rewrite.from)}(?![\\w%.])`, "g");

                    next = next.replace(pattern, () => {
                        counts.set(rewrite, (counts.get(rewrite) ?? 0) + 1);

                        return rewrite.to;
                    });
                }

                return next === value ? whole : `${property}${colon}${next}`;
            },
        );

    // The page's `<style>` blocks (the declarations in their rules) and its `style=""` attributes; nothing else.
    let content = bundle.content.replace(
        /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
        (_whole, open: string, css: string, close: string) =>
            `${open}${css.replace(/\{([^{}]*)\}/g, (_block, body: string) => `{${declarations(body)}}`)}${close}`,
    );

    content = content.replace(
        /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi,
        (whole, prefix: string, quoted: string, double?: string, single?: string) => {
            const css = double ?? single ?? "";
            const next = declarations(css);

            return next === css ? whole : `${prefix}${quoted[0]}${next}${quoted[0]}`;
        },
    );

    const fixes = [...counts].map(([rewrite, count]) => ({
        rule: rewrite.rule,
        from: rewrite.from,
        to: rewrite.to,
        count,
    }));

    return {
        content,
        fixed: fixes.reduce((sum, each) => sum + each.count, 0),
        fixes,
    };
};
