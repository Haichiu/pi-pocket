// The stand-in for V's rewrite of exact matches (`extensions/design/system-fix.ts`): what it rewrites, and what it never touches.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CheckFinding } from "../src/server/design/system-types.ts";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { fixExactMatches, isFixable } from "../src/server/extensions/design/system-fix.ts";
import { writeSystemFixture } from "./design-system-fixtures.ts";

const folder = mkdtempSync(join(tmpdir(), "pi-pocket-fix-"));

writeSystemFixture(folder);

const system = loadDesignSystem(folder)!;
const hex = (name: string) =>
    system.tokens.find((each) => each.name === name)!.modes.light!.hex as string;

const finding = (
    value: string,
    suggestion: string,
    rule: CheckFinding["rule"] = "off-system-color",
    words = `${value} is written as a literal (text on 1 element), so it does not follow the system.`,
): CheckFinding => ({ rule, level: "warning", selector: "x", value, suggestion, message: words });

const fix = (content: string, findings: CheckFinding[]) =>
    fixExactMatches({ content } as never, system, { findings } as never, { mode: "light" });

test("a finding is fixable when its value is exactly the token's, not when it is only close", () => {
    const text = hex("color.text.primary");

    assert.equal(isFixable(finding(text, "var(--color-text-primary)"), system, "light"), true);
    // One step off in a channel: the check calls it a literal too, but it is not the token's value.
    const close = `#${(parseInt(text.slice(1, 3), 16) + 1).toString(16).padStart(2, "0")}${text.slice(3)}`;

    assert.equal(isFixable(finding(close, "var(--color-text-primary)"), system, "light"), false);
    // Not an exact-match finding: a color that is off the system, a rule that is not for a value, a suggestion that is no variable.
    assert.equal(
        isFixable(
            finding(
                text,
                "var(--color-text-primary)",
                "off-system-color",
                `${text} is not a system color.`,
            ),
            system,
            "light",
        ),
        false,
    );
    assert.equal(
        isFixable(finding(text, "var(--color-text-primary)", "contrast"), system, "light"),
        false,
    );
    assert.equal(isFixable(finding(text, "#fff"), system, "light"), false);
    assert.equal(isFixable(finding(text, "var(--nothing-here)"), system, "light"), false);
});

test("exact matches are rewritten in styles and style attributes, and nothing else is touched", () => {
    const text = hex("color.text.primary");
    const border = hex("color.border.default");
    const page = `<!doctype html><title>${text}</title>
<style>
:root { --mine: ${text}; }
.a { color: ${text.toUpperCase()}; border: 1px solid ${border}; box-shadow: 0 0 0 1px ${border}; }
.${text.slice(1)} { margin: 8px; }
@media (min-width: 600px) { .b { background: ${border}; } }
</style>
<p style="color:${text};margin:8px" data-x="${text}">${text}</p>
<script>var color = "${text}"; document.title = '${border}';</script>`;
    const result = fix(page, [
        finding(text, "var(--color-text-primary)"),
        finding(border, "var(--color-border-default)"),
    ]);

    assert.match(
        result.content,
        /\.a \{ color: var\(--color-text-primary\); border: 1px solid var\(--color-border-default\);/,
    );
    assert.match(result.content, /box-shadow: 0 0 0 1px var\(--color-border-default\)/);
    assert.match(
        result.content,
        /@media \(min-width: 600px\) \{ \.b \{ background: var\(--color-border-default\); \} \}/,
    );
    assert.match(result.content, /style="color:var\(--color-text-primary\);margin:8px"/);
    // Custom properties, selectors, other attributes, text, and scripts stay as they are.
    assert.ok(result.content.includes(`--mine: ${text};`));
    assert.ok(result.content.includes(`.${text.slice(1)} { margin: 8px; }`));
    assert.ok(result.content.includes(`data-x="${text}">${text}</p>`));
    assert.ok(result.content.includes(`<title>${text}</title>`));
    assert.ok(result.content.includes(`var color = "${text}"; document.title = '${border}';`));
    assert.equal(result.fixed, 5);
    assert.deepEqual(
        result.fixes.map((each) => [each.from, each.count]),
        [
            [text, 2],
            [border, 3],
        ],
    );
});

test("a size is rewritten only in the properties the finding names, and a value two findings want as different tokens is left alone", () => {
    const size = fix(
        `<style>.a { font-size: 14px; padding: 14px; margin: 114px; } .b { font-size:14px }</style>`,
        [
            finding(
                "14px",
                "var(--font-size-sm)",
                "off-system-size",
                "font-size 14px is written as a literal (2 uses), so it does not follow the system. Set `font-size` to var(--font-size-sm).",
            ),
        ],
    );

    assert.equal(
        size.content,
        `<style>.a { font-size: var(--font-size-sm); padding: 14px; margin: 114px; } .b { font-size:var(--font-size-sm) }</style>`,
    );
    assert.equal(size.fixed, 2);

    // Two tokens that are the same color, each wanted by a finding: which one is not for this to say.
    const white = hex("color.bg.surface");

    assert.equal(hex("color.bg.raised"), white);

    const both = fix(`<style>.a { background: ${white}; }</style>`, [
        finding(white, "var(--color-bg-surface)"),
        finding(white, "var(--color-bg-raised)"),
    ]);

    assert.equal(both.fixed, 0);
    assert.ok(both.content.includes(`background: ${white}`));
});
