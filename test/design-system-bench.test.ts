// The design system bench: its scoring rules on small hand cases, its fixtures against their own sources, the reference
// implementations as a ceiling, and a run with nothing in the tree as a floor. See test/design-system-bench/README.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import {
    colorOf,
    contrastRatio,
    deltaE,
    parseColor,
    sameColor,
    toHex,
} from "./design-system-bench/lib/color.ts";
import { flatten, families, pixels, shadowLayers } from "./design-system-bench/lib/dtcg.ts";
import {
    dedupe,
    matchFindings,
    namesToken,
    sameValue,
    scoreLint,
} from "./design-system-bench/lib/lint-score.ts";
import {
    coerceDraft,
    legacyDraft,
    loadModules,
    runScan,
} from "./design-system-bench/lib/modules.ts";
import { loadLintCases, LINT_SYSTEM } from "./design-system-bench/lib/phase-lint.ts";
import { BENCH, loadFixtures } from "./design-system-bench/lib/phase-scan.ts";
import { draftFromExpected, referenceModules } from "./design-system-bench/lib/reference.ts";
import {
    extract,
    maxMatching,
    prf,
    roleOf,
    ROLES,
    scoreColors,
    scoreScan,
    scoreShadows,
    scoreSizes,
    type Expected,
} from "./design-system-bench/lib/score.ts";
import {
    contrastPairs,
    goldenCss,
    impliedPairs,
    readFlat,
    systemFromFlat,
} from "./design-system-bench/lib/system.ts";
import { makeGolden } from "./design-system-bench/lint/system/make-golden.ts";
import { runBench } from "./design-system-bench/run.ts";

const browser = findBrowser();
const fixtures = loadFixtures();

// ---- color math ----------------------------------------------------------------------------------------------------

test("colors parse in every syntax and agree with an independent conversion", () => {
    const hex = (text: string) => toHex(parseColor(text)!);

    assert.equal(hex("#3b82f6"), "#3b82f6");
    assert.equal(hex("#38f"), "#3388ff");
    assert.equal(hex("rgb(59 130 246)"), "#3b82f6");
    assert.equal(hex("rgba(0, 0, 0, .5)"), "#00000080");
    assert.equal(hex("hsl(217 91% 60%)"), "#3c83f6");
    assert.equal(hex("white"), "#ffffff");
    // oklch values converted by hand with a separate program (see fixtures/tailwind-v4/expected.json).
    assert.equal(hex("oklch(0.62 0.19 259)"), "#3581f6");
    assert.equal(hex("oklch(0.17 0.01 260)"), "#0d1014");
    assert.equal(hex("hsl(145 55% 32%)"), "#257e4a");
    assert.equal(parseColor("not-a-color"), undefined);
    assert.equal(parseColor("var(--x)"), undefined);
    assert.equal(
        toHex(colorOf({ colorSpace: "srgb", components: [0.2, 0.4, 1], alpha: 0.5 })!),
        "#3366ff80",
    );
    assert.equal(toHex(colorOf({ colorSpace: "display-p3", components: [1, 1, 1] })!), "#ffffff");
});

test("ΔE 2000 and WCAG contrast match their published values", () => {
    const [white, black] = [parseColor("#fff")!, parseColor("#000")!];

    assert.ok(Math.abs(deltaE(white, black) - 100) < 0.01);
    assert.equal(deltaE(white, white), 0);
    // Sharma's test pairs: (50, 2.6772, -79.7751) and (50, 0, -82.7485) differ by 2.0425; the sRGB approximations here must stay close.
    assert.ok(deltaE(parseColor("#3366cc")!, parseColor("#3366cd")!) < 0.5);
    assert.ok(deltaE(parseColor("#333")!, parseColor("#444")!) > 5);
    assert.equal(sameColor(parseColor("#3366cc")!, parseColor("#3365cc")!), true);
    assert.equal(
        sameColor(parseColor("#000000")!, parseColor("#00000080")!),
        false,
        "alpha differs",
    );
    assert.ok(Math.abs(contrastRatio(white, black) - 21) < 0.001);
    assert.ok(Math.abs(contrastRatio(parseColor("#767676")!, white) - 4.54) < 0.01);
    assert.ok(Math.abs(contrastRatio(parseColor("#777")!, white) - 4.48) < 0.01);
    // A translucent foreground blends over its background before it is measured.
    assert.ok(contrastRatio(parseColor("rgba(0,0,0,0.5)")!, white) < 21 / 2);
});

// ---- the DTCG reader -----------------------------------------------------------------------------------------------

test("the reader resolves references, inherited types, $root, and mode overrides that flow through primitives", () => {
    const flat = flatten(
        {
            color: {
                $type: "color",
                blue: { $value: "#0000ff" },
                accent: { default: { $value: "{color.blue}" } },
                text: { $value: { colorSpace: "srgb", components: [0, 0, 0] } },
            },
            space: {
                $type: "dimension",
                $root: { $value: "4px" },
                2: { $value: { value: 0.5, unit: "rem" } },
            },
            bad: {
                $type: "color",
                loop: { $value: "{bad.other}" },
                other: { $value: "{bad.loop}" },
                gone: { $value: "{nope}" },
            },
        },
        { dark: { color: { blue: { $value: "#8080ff" } } } },
    );
    const get = (name: string) => flat.tokens.find((token) => token.name === name)!;

    assert.deepEqual(flat.modes, ["default", "dark"]);
    assert.equal(get("color.accent.default").type, "color");
    assert.equal(get("color.accent.default").values.default, "#0000ff");
    assert.equal(
        get("color.accent.default").values.dark,
        "#8080ff",
        "the override of a primitive flows to its alias",
    );
    assert.equal(get("color.accent.default").aliases.dark, "color.blue");
    assert.equal(pixels(get("space").values.default), 4);
    assert.equal(pixels(get("space.2").values.default), 8);
    assert.ok(flat.problems.some((problem) => /Circular/.test(problem)));
    assert.ok(flat.problems.some((problem) => /\{nope\}/.test(problem)));
    assert.equal(flatten(null).tokens.length, 0);
});

test("lengths, shadows, and font stacks read in every form", () => {
    assert.equal(pixels("1.5rem"), 24);
    assert.equal(pixels({ value: 12, unit: "pt" }), 16);
    assert.equal(pixels("50%"), undefined);
    assert.equal(pixels("auto"), undefined);

    const css = shadowLayers("0 1px 3px 0 rgb(0 0 0 / 0.1), inset 0 -2px 8px -1px #00000040");

    assert.equal(css.length, 2);
    assert.deepEqual([css[0]!.y, css[0]!.blur, css[0]!.inset], [1, 3, false]);
    assert.deepEqual([css[1]!.y, css[1]!.spread, css[1]!.inset], [-2, -1, true]);
    assert.equal(
        shadowLayers({
            color: "#000",
            offsetX: { value: 0, unit: "px" },
            offsetY: "2px",
            blur: "4px",
        })[0]!.blur,
        4,
    );
    assert.deepEqual(families('"Inter", system-ui, sans-serif'), [
        "Inter",
        "system-ui",
        "sans-serif",
    ]);
    assert.deepEqual(families(["JetBrains Mono", "monospace"]), ["JetBrains Mono", "monospace"]);
});

// ---- scoring rules on small hand cases -----------------------------------------------------------------------------

test("precision, recall, and the empty cases", () => {
    assert.deepEqual([prf(4, 5, 4).precision, prf(4, 5, 4).recall], [0.8, 1]);
    assert.equal(prf(0, 0, 0).applicable, false);
    assert.equal(prf(3, 0, 0).recall, 0);
    assert.equal(prf(3, 0, 0).precision, 1, "claiming nothing is not wrong");
    assert.equal(prf(3, 0, 0).f1, 0);
    assert.equal(prf(0, 2, 0).f1, 0, "claiming something when nothing was expected");
});

test("matching is one to one and does not depend on order", () => {
    // A greedy match takes a→1 and leaves b unmatched; the best matching is 2.
    const fits = (entry: string, item: number) => (entry === "a" ? item <= 2 : item === 1);

    assert.equal(maxMatching(["a", "b"], [1, 2], fits), 2);
    assert.equal(maxMatching(["a", "b"], [2, 1], fits), 2);
    assert.equal(maxMatching([], [1], fits), 0);
});

test("colors match within ΔE 2; near-duplicates fill one entry and the second is a false positive", () => {
    const expected = [{ value: "#333333", near: ["#323232", "#343434"] }, "#ffffff"];
    const found = (list: string[]) => list.map((text) => parseColor(text)!);

    assert.equal(scoreColors(expected, found(["#333", "#fff"])).f1, 1);
    assert.equal(
        scoreColors(expected, found(["#323232", "#fffffe"])).f1,
        1,
        "near values are accepted",
    );

    const duplicate = scoreColors(expected, found(["#333333", "#323232", "#ffffff"]));

    assert.equal(duplicate.matched, 2);
    assert.equal(duplicate.precision, 2 / 3, "two colors for one entry");
    assert.equal(
        scoreColors(expected, found(["#000", "#fff"])).matched,
        1,
        "a different color does not match",
    );
    assert.equal(scoreColors(["rgb(0 0 0 / 0.5)"], found(["#00000080"])).matched, 1);
    assert.equal(scoreColors(["rgb(0 0 0 / 0.5)"], found(["#000000"])).matched, 0, "alpha counts");
});

test("sizes: near sizes, tolerance, and the credit of a base unit", () => {
    const scale = [12, { value: 14, near: [13.33] }, 16];

    assert.equal(scoreSizes(scale, [12, 14, 16]).f1, 1);
    assert.equal(scoreSizes(scale, [12, 13.33, 16]).f1, 1);
    assert.equal(scoreSizes(scale, [12, 13, 16]).matched, 2, "13 is not 13.33");
    assert.equal(
        scoreSizes(scale, [12, 14, 14.4, 16]).precision,
        0.75,
        "a duplicate of a cluster is a false positive",
    );

    // A base of 4 px implies steps; they fill recall but are never extra.
    const implied = scoreSizes([4, 8, 12, 16], [4], [2, 4, 6, 8, 12, 16]);

    assert.equal(implied.recall, 1);
    assert.equal(implied.precision, 1);
    assert.equal(
        scoreSizes([4, 8, 12], [4], [2, 4, 6, 8]).recall,
        2 / 3,
        "12 is not implied by those steps",
    );
});

test("shadows match layer by layer", () => {
    const wanted = ["0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"];
    const layers = (text: string) => shadowLayers(text);

    assert.equal(
        scoreShadows(wanted, [layers("0 1px 3px rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)")])
            .f1,
        1,
    );
    assert.equal(
        scoreShadows(wanted, [layers("0 1px 3px rgba(0,0,0,.1)")]).matched,
        0,
        "one layer is not two",
    );
    assert.equal(
        scoreShadows(wanted, [layers("0 4px 3px 0 rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)")])
            .matched,
        0,
    );
    assert.equal(
        scoreShadows(["inset 0 1px 0 #fff"], [layers("0 1px 0 #fff")]).matched,
        0,
        "inset counts",
    );
});

test("a token's role comes from the words in its name", () => {
    const role = (name: string) => roleOf(name.split("."));
    const table: Record<string, string | undefined> = {
        "color.bg.surface": "surface",
        "color.bg": "bg",
        "color.background": "bg",
        "color.bg.subtle": "bg",
        "color.surface.muted": "surface",
        "color.text.primary": "text",
        "color.text.muted": "muted",
        "color.text.secondary": "muted",
        "color.muted-foreground": "muted",
        "color.foreground": "text",
        "color.border.subtle": "border",
        "color.hairline": "border",
        "color.accent.default": "accent",
        "color.brand.500": "accent",
        "color.primary": "accent",
        "color.link": "accent",
        "color.danger.border": "danger",
        "color.destructive": "danger",
        "color.error.default": "danger",
        "color.warn": "warning",
        "color.success.default": "success",
        // Text on a color is a pair, not a role.
        "color.primary-foreground": undefined,
        "color.card-foreground": undefined,
        "color.danger.text": undefined,
        "color.text.on-accent": undefined,
        "color.text.inverse": undefined,
        // A palette step has no role.
        "color.blue.500": undefined,
        "color.gray.100": undefined,
        "color.input": undefined,
        "color.ring": undefined,
    };

    for (const [name, wanted] of Object.entries(table)) {
        assert.equal(role(name), wanted, name);
    }

    assert.equal(roleOf(["fontSize", "textMuted"]), "muted", "camel case is split");
});

test("the representative of a role is the token nearest the plain name", () => {
    const tree = {
        color: {
            $type: "color",
            hairline: { $value: "#eeeeee" },
            border: { $value: "#dddddd" },
            "accent-hover": { $value: "#0000aa" },
            accent: { $value: "#0000ff" },
            brand: { 500: { $value: "#1111ff" }, 600: { $value: "#2222ff" } },
        },
    };
    const found = extract(flatten(tree));

    assert.equal(
        found.roles.border?.token,
        "color.border",
        "border holds the role's own word, hairline does not",
    );
    assert.equal(
        found.roles.accent?.token,
        "color.accent",
        "accent beats accent-hover and brand-500",
    );
    assert.equal(Object.keys(found.roles).length, 2);
});

test("a scan is scored on roles by name, on dark values, and not for a role that was not expected", () => {
    const expected: Expected = {
        name: "t",
        colors: ["#ffffff", "#111111", "#2563eb"],
        darkColors: ["#000000"],
        roles: {
            bg: { light: "#ffffff", dark: "#000000" },
            text: { light: "#111111" },
            accent: { light: "#2563eb" },
        },
        typeScale: [16],
        spacing: [8],
        radii: [4],
        shadows: [],
        fonts: ["Inter"],
        dark: { present: true },
    };
    const draft = (tokens: unknown, modes: Record<string, unknown> = {}) =>
        scoreScan(expected, extract(flatten(tokens, modes)));
    const good = draft(
        {
            color: {
                $type: "color",
                bg: { $value: "#ffffff" },
                text: { $value: "#111111" },
                accent: { $value: "#2563eb" },
                danger: { $value: "#ff0000" },
            },
            font: {
                size: { $type: "dimension", md: { $value: "1rem" } },
                family: { $type: "fontFamily", sans: { $value: "Inter, sans-serif" } },
            },
            space: { $type: "dimension", 2: { $value: "8px" }, 0: { $value: "0px" } },
            radius: { $type: "dimension", sm: { $value: "4px" } },
        },
        { dark: { color: { bg: { $value: "#000000" } } } },
    );

    assert.deepEqual(good.roleDetail, {
        right: ["bg", "text", "accent"],
        wrong: ["danger"],
        missed: [],
    });
    assert.equal(good.roles.precision, 0.75);
    assert.equal(good.roles.recall, 1);
    assert.equal(good.darkRoles.f1, 1);
    assert.equal(good.darkColors.f1, 1);
    assert.equal(good.darkDetected, true);
    assert.equal(good.typeScale.f1, 1);
    assert.equal(good.spacing.f1, 1, "a zero is not a step");
    assert.equal(good.fonts.f1, 1);

    const wrongValue = draft({
        color: { $type: "color", bg: { $value: "#e0e0e0" }, text: { $value: "#111111" } },
    });

    assert.deepEqual(wrongValue.roleDetail.wrong, ["bg"]);
    assert.deepEqual(wrongValue.roleDetail.missed, ["accent"]);
    assert.equal(draft({}).colors.recall, 0);
});

test("the lint matcher pairs by rule, element, and value", () => {
    const expected = [
        {
            rule: "off-system-color",
            pid: "a",
            value: "#2b6ae0",
            suggestion: ["color.accent.default", "color.blue.500"],
        },
        { rule: "off-system-color", pid: "a", value: "#111111" },
        { rule: "overflow" },
    ];
    const found = [
        {
            rule: "off-system-color",
            pid: "a",
            value: "rgb(17, 17, 17)",
            suggestion: "var(--color-text-primary)",
        },
        {
            rule: "off-system-color",
            pid: "a",
            value: "#2b6ae1",
            suggestion: "var(--color-blue-500)",
        },
        { rule: "overflow", value: "600px" },
    ];
    const match = matchFindings(expected, found);

    assert.deepEqual(
        match.pairs.sort(),
        [
            [0, 1],
            [1, 0],
            [2, 2],
        ].sort(),
    );
    assert.deepEqual([match.extra, match.missed], [[], []]);

    // Two values on one element are two findings; a different element or rule is not a match.
    assert.deepEqual(
        matchFindings([{ rule: "contrast", pid: "x" }], [{ rule: "contrast", pid: "y" }]).missed,
        [0],
    );
    assert.deepEqual(
        matchFindings([{ rule: "contrast", pid: "x" }], [{ rule: "image-alt", pid: "x" }]).extra,
        [0],
    );
    assert.deepEqual(
        matchFindings(
            [{ rule: "tap-target", pid: "x", value: "16px" }],
            [{ rule: "tap-target", pid: "x", value: "32px" }],
        ).missed,
        [0],
    );
    assert.deepEqual(
        matchFindings(
            [{ rule: "contrast", pid: "x" }],
            [{ rule: "contrast", selector: 'div[data-pid="x"]' }],
        ).missed,
        [],
    );
});

test("lint scoring counts false findings, misses, and fixes", () => {
    const expected = [
        {
            rule: "off-system-color",
            pid: "a",
            value: "#2b6ae0",
            suggestion: "color.accent.default",
        },
        { rule: "contrast", pid: "b", level: "error" as const },
    ];
    const perfect = scoreLint([
        {
            expected,
            found: [
                {
                    rule: "off-system-color",
                    pid: "a",
                    value: "#2b6ae0",
                    suggestion: "var(--color-accent-default)",
                },
                { rule: "contrast", pid: "b", level: "error" },
            ],
        },
    ]);

    assert.deepEqual([perfect.precision, perfect.recall], [1, 1]);
    assert.deepEqual(
        [perfect.suggestion, perfect.level],
        [
            { wanted: 1, right: 1 },
            { wanted: 1, right: 1 },
        ],
    );

    const noisy = scoreLint([
        {
            expected,
            found: [
                { rule: "contrast", pid: "b", level: "warning" },
                { rule: "tap-target", pid: "c" },
            ],
        },
        { expected: [], found: [{ rule: "contrast", pid: "z" }] },
    ]);

    assert.equal(noisy.tp, 1);
    assert.equal(noisy.fp, 2, "a false finding on a clean design counts");
    assert.equal(noisy.fn, 1);
    assert.equal(noisy.byRule["contrast"]!.precision, 0.5);
    assert.deepEqual(noisy.level, { wanted: 1, right: 0 });
    // The same value on the same element, reported twice, is one finding.
    assert.equal(
        dedupe([
            { rule: "contrast", pid: "a", value: "#fff" },
            { rule: "contrast", pid: "a", value: "#ffffff" },
        ]).length,
        1,
    );
    assert.equal(
        dedupe([{ rule: "missing-pid" }, { rule: "missing-pid" }]).length,
        2,
        "no element: nothing to merge",
    );
    assert.equal(sameValue("15px", "15.2px"), true);
    assert.equal(sameValue("15px", "16px"), false);
    assert.equal(sameValue('"Playfair Display", serif', "Playfair Display"), true);
    assert.equal(
        namesToken("use var(--color-accent-default-hover)", "color.accent.default"),
        false,
    );
    assert.equal(
        namesToken("use var(--color-accent-default)", ["color.nope", "color.accent.default"]),
        true,
    );
});

// ---- the fixtures against their own sources ------------------------------------------------------------------------

/** The color literals in a project's source files, comments removed. `node_modules`, `expected.json` and `package.json` are left out. */
function literals(
    dir: string,
    out: { text: string; line: string }[] = [],
): { text: string; line: string }[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "expected.json", "package.json"].includes(entry.name)) {
            continue;
        }

        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            literals(path, out);
            continue;
        }

        const source = readFileSync(path, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/^\s*\/\/.*$/gm, "");

        for (const line of source.split("\n")) {
            for (const match of line.matchAll(
                /(?<![&\w%-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?|oklch)\([^)]*\)/g,
            )) {
                const before = line.slice(Math.max(0, match.index - 24), match.index);

                // Shadow colors are not palette colors.
                if (/shadow/i.test(line) || /\d(px|rem)\s+$/.test(before)) {
                    continue;
                }

                out.push({ text: match[0], line: line.trim() });
            }
        }
    }

    return out;
}

test("the fixtures load, and each has all four of its parts", () => {
    assert.deepEqual(
        fixtures.map((fixture) => fixture.name),
        ["messy", "plain-css", "scss-ts", "tailwind-v4"],
    );

    for (const { name, expected } of fixtures) {
        assert.equal(expected.name, name);
        assert.ok(expected.colors.length >= 10, name);
        assert.ok(
            expected.typeScale.length >= 6 &&
                expected.spacing.length >= 7 &&
                expected.radii.length >= 4,
            name,
        );
        assert.deepEqual(
            Object.keys(expected.roles).sort(),
            [...ROLES].sort(),
            `${name} expects all nine roles`,
        );
        assert.ok(
            (expected.darkColors?.length ?? 0) > 0 && expected.dark.present,
            `${name} has a dark mode`,
        );
        assert.ok(expected.fonts.length >= 2 && expected.shadows.length >= 2, name);
    }
});

test("every expected color is written in the sources, and every color in the sources is expected", () => {
    for (const { name, dir, expected } of fixtures) {
        const found = literals(dir);
        const parsed = found.map((item) => ({ ...item, color: parseColor(item.text) }));

        assert.ok(
            parsed.every((item) => item.color !== undefined),
            `${name}: every literal parses`,
        );

        const entries = [...expected.colors, ...(expected.darkColors ?? [])].map((entry) =>
            typeof entry === "string"
                ? { value: entry, near: [] as string[] }
                : { value: entry.value, near: entry.near ?? [] },
        );
        const accepted = entries.flatMap((entry) => [entry.value, ...entry.near]);

        for (const entry of entries) {
            for (const text of [entry.value, ...entry.near]) {
                const wanted = parseColor(text);

                // `white` and a color worked out by hand (oklch to hex) are not literals; the rest must be.
                if (/^[a-z]+$/.test(text) || wanted === undefined) {
                    continue;
                }

                assert.ok(
                    parsed.some(
                        (item) =>
                            deltaE(item.color!, wanted) < 1 &&
                            Math.abs(item.color!.a - wanted.a) < 0.02,
                    ),
                    `${name}: ${text} is not in the sources`,
                );
            }
        }

        for (const item of parsed) {
            assert.ok(
                accepted.some((text) => {
                    const color = parseColor(text)!;

                    return (
                        deltaE(item.color!, color) <= 3 && Math.abs(item.color!.a - color.a) <= 0.02
                    );
                }),
                `${name}: ${item.text} in "${item.line.slice(0, 80)}" is not in expected.json`,
            );
        }
    }
});

test("the traps are in the fixtures, and they are not expected", () => {
    const text = (path: string) => readFileSync(join(BENCH, "fixtures", path), "utf8");

    assert.match(text("plain-css/src/styles/app.css"), /#ff00ff/);
    assert.match(text("plain-css/node_modules/some-widget/theme.css"), /#ff0000/);
    assert.match(text("messy/css/legacy.css"), /#ff6600/);
    assert.match(text("messy/index.html"), /&#169;/);
    assert.match(text("scss-ts/src/styles/_variables.scss"), /#ff69b4/);

    for (const { expected } of fixtures) {
        const all = JSON.stringify([expected.colors, expected.darkColors]).toLowerCase();

        for (const trap of ["#ff00ff", "#ff0000", "#00ff00", "#ff6600", "#ff69b4", "#116699"]) {
            assert.ok(!all.includes(trap), `${expected.name} must not expect ${trap}`);
        }
    }
});

test("the oracle scan scores 1 on every fixture, and an empty scan scores 0", () => {
    for (const { name, expected } of fixtures) {
        const draft = draftFromExpected(expected);
        const score = scoreScan(expected, extract(flatten(draft.tokens, draft.modes)));

        for (const category of [
            "colors",
            "darkColors",
            "roles",
            "darkRoles",
            "typeScale",
            "spacing",
            "radii",
            "shadows",
            "fonts",
        ] as const) {
            assert.equal(
                score[category].f1,
                1,
                `${name}: ${category} ${JSON.stringify(score[category])}`,
            );
        }

        assert.deepEqual(score.roleDetail.wrong, []);

        const none = scoreScan(expected, extract(flatten({})));

        assert.equal(
            none.colors.f1 + none.roles.f1 + none.typeScale.f1 + none.spacing.f1 + none.radii.f1,
            0,
            name,
        );
    }
});

// ---- lint designs --------------------------------------------------------------------------------------------------

const RULES = [
    "off-system-color",
    "off-system-font",
    "off-system-size",
    "contrast",
    "tap-target",
    "overflow",
    "image-alt",
    "heading-order",
    "font-fallback",
    "missing-viewport",
    "missing-pid",
    "focus-visible",
];

test("the lint designs: six seeded and two clean, covering every rule, with real pids and real nearest tokens", () => {
    const cases = loadLintCases();
    const seeded = cases.filter((item) => !item.clean);
    const flat = readFlat(join(LINT_SYSTEM, ".pi", "design"));
    const colors = flat.tokens.filter((token) => token.type === "color");

    assert.equal(seeded.length, 6);
    assert.equal(cases.filter((item) => item.clean).length, 2);
    assert.deepEqual(
        [...new Set(seeded.flatMap((item) => item.expected.map((finding) => finding.rule)))].sort(),
        [...RULES].sort(),
    );

    for (const item of cases) {
        for (const finding of item.expected) {
            assert.ok(RULES.includes(finding.rule), finding.rule);

            if (finding.pid !== undefined) {
                assert.ok(
                    item.html.includes(`data-pid="${finding.pid}"`),
                    `${item.name}: no data-pid="${finding.pid}"`,
                );
            }

            // The fix named in an expectation must be a nearest token of the literal.
            if (finding.suggestion !== undefined && parseColor(finding.value ?? "") !== undefined) {
                const color = parseColor(finding.value!)!;
                const distances = colors.map((token) => ({
                    name: token.name,
                    distance: deltaE(color, colorOf(token.values.default)!),
                }));
                const best = Math.min(...distances.map((item) => item.distance));
                const accepted = Array.isArray(finding.suggestion)
                    ? finding.suggestion
                    : [finding.suggestion];

                for (const token of accepted.filter((name) => name.startsWith("color."))) {
                    assert.ok(
                        distances.find((item) => item.name === token)!.distance - best < 0.01,
                        `${item.name}: ${token} is not nearest to ${finding.value}`,
                    );
                }
            }
        }

        assert.ok(item.html.includes('href="ds/tokens.css"'), item.name);
    }

    for (const item of cases.filter((entry) => entry.clean)) {
        assert.deepEqual(item.expected, []);
        assert.deepEqual(item.colorSchemes, ["light", "dark"]);
        assert.ok(
            !/#[0-9a-f]{3,8}\b|rgba?\(|hsl\(/i.test(item.html.replace(/data:image[^"]*/g, "")),
            `${item.name} uses only tokens`,
        );
    }

    // A seeded design is bad for the reason it says: the seeded literals are in it.
    assert.match(cases.find((item) => item.name === "seed-off-colors")!.html, /#e9f0fd/);
    assert.ok(seeded.reduce((sum, item) => sum + item.expected.length, 0) >= 30);
});

test("the golden tokens.css is current, and the lint system's contrast pairs pass in both modes", () => {
    assert.equal(readFileSync(join(LINT_SYSTEM, "golden", "tokens.css"), "utf8"), makeGolden());

    const system = systemFromFlat(readFlat(join(LINT_SYSTEM, ".pi", "design")), "Bench");
    const pairs = contrastPairs(system.tokens, system.modes);

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(pairs.length, 3);
    assert.ok(pairs.every((pair) => pair.passesEverywhere));
    assert.ok(impliedPairs(system.tokens, system.modes).every((pair) => pair.failing.length === 0));

    // A pair that fails in one mode only does not pass.
    const broken = structuredClone(system.tokens);

    broken.find((token) => token.name === "color.text.muted")!.modes.dark!.value = "#222831";
    assert.equal(
        contrastPairs(broken, system.modes).filter((pair) => pair.passesEverywhere).length,
        2,
    );
});

test("every system in format/ and the lint system read without a problem", () => {
    for (const path of [
        join(BENCH, "format", "classic"),
        join(BENCH, "format", "modern"),
        LINT_SYSTEM,
    ]) {
        const flat = readFlat(join(path, ".pi", "design"));

        assert.deepEqual(flat.problems, [], path);
        assert.ok(flat.tokens.length > 30, path);
        assert.ok(flat.modes.length >= 2, path);
    }

    assert.deepEqual(readFlat(join(BENCH, "format", "modern", ".pi", "design")).modes, [
        "default",
        "dark",
        "hc",
    ]);
});

// ---- the scan adapter ----------------------------------------------------------------------------------------------

test("a scan's output is read in the shapes it may come in", () => {
    const tree = { color: { bg: { $type: "color", $value: "#fff" } } };
    const dark = { color: { bg: { $value: "#000" } } };

    assert.deepEqual(coerceDraft({ tokens: tree, modes: { dark } }), {
        tokens: tree,
        modes: { dark },
    });
    assert.deepEqual(coerceDraft({ tokens: tree, dark }), { tokens: tree, modes: { dark } });
    assert.deepEqual(coerceDraft({ files: { "tokens.json": tree, "tokens.dark.json": dark } }), {
        tokens: tree,
        modes: { dark },
    });
    assert.deepEqual(coerceDraft(JSON.stringify(tree)), { tokens: tree, modes: {} });
    assert.deepEqual(coerceDraft({ draft: { tokens: tree } })?.tokens, tree);
    assert.equal(coerceDraft({ colors: ["#fff"] }), undefined);
    assert.equal(coerceDraft("not json"), undefined);
    assert.equal(coerceDraft(42), undefined);

    // The 0.26 scan's findings become variables under their own names, so a role can be read from a name.
    const legacy = legacyDraft({
        variables: { "--bg": "#fff", "--radius-md": "8px", "--font-sans": "Inter, sans-serif" },
        colors: [{ value: "#123456" }],
        radii: [{ value: "4px" }],
        fonts: [],
    });
    const flat = flatten(legacy.tokens);

    assert.deepEqual(flat.tokens.map((token) => token.type).sort(), [
        "color",
        "color",
        "dimension",
        "dimension",
        "fontFamily",
    ]);
    assert.equal(extract(flat).roles.bg?.token, "color.bg");
});

// ---- the floor, the ceiling, and the command line ------------------------------------------------------------------

test("with nothing in the tree every phase scores 0, says why, and nothing throws", async () => {
    const modules = await loadModules(["tokens", "lint", "docsite", "scan"]);
    const outcome = await runScan(modules, join(BENCH, "fixtures", "plain-css"));

    assert.equal(outcome.source, "none");

    const report = await runBench({
        modules,
        browser: false,
        flagship: join(BENCH, "no-such-flagship"),
        out: join(BENCH, "..", "..", "node_modules", ".cache", "ds-bench-test"),
    });
    const text = JSON.stringify(report);

    assert.deepEqual(report.scores, {
        overall: 0,
        scan: 0,
        format: 0,
        lint: 0,
        contrast: 0,
        docs: 0,
    });
    assert.equal(report.scan!.available, false);
    assert.equal(report.lint!.available, false);
    assert.equal(report.docs!.available, false);
    assert.ok(report.notes.some((note) => /scan/i.test(note)));
    assert.ok(report.notes.some((note) => /checkDesign/.test(note)));
    assert.ok(report.notes.some((note) => /renderSystemDoc/.test(note)));
    assert.ok(Object.values(report.targets).every((value) => value === false));
    assert.ok(report.format!.systems.every((item) => item.score === 0 && item.loaded === false));
    assert.equal(JSON.parse(text).scores.overall, 0, "the report is JSON");
});

test("the runner prints one JSON object and rejects bad arguments", () => {
    const run = (...args: string[]) =>
        spawnSync(
            "node",
            [
                join(BENCH, "run.ts"),
                "--no-browser",
                "--out",
                join(BENCH, "..", "..", "node_modules", ".cache", "ds-bench-cli"),
                ...args,
            ],
            { encoding: "utf8" },
        );
    const ok = run("--only", "scan");
    const report = JSON.parse(ok.stdout) as {
        scores: Record<string, number>;
        scan: { fixtures: Record<string, unknown> };
    };

    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(Object.keys(report.scan.fixtures).sort(), [
        "messy",
        "plain-css",
        "scss-ts",
        "tailwind-v4",
    ]);
    assert.ok(
        report.scores.scan !== undefined && report.scores.scan >= 0 && report.scores.scan <= 1,
    );
    assert.equal(run("--only", "nonsense").status, 2);
    assert.equal(run("--wat").status, 2);
});

test(
    "the reference implementations reach 1 in every phase (the ceiling)",
    { skip: browser === undefined, timeout: 180_000 },
    async () => {
        const { BenchBrowser } = await import("./design-system-bench/lib/chromium.ts");
        const chromium = (await BenchBrowser.launch())!;

        try {
            const report = await runBench({
                modules: referenceModules(chromium),
                reference: true,
                out: join(BENCH, "..", "..", "node_modules", ".cache", "ds-bench-ref"),
            });

            assert.deepEqual(
                report.scores,
                { overall: 1, scan: 1, format: 1, lint: 1, contrast: 1, docs: 1 },
                JSON.stringify(report.notes),
            );
            assert.ok(Object.values(report.targets).every(Boolean), JSON.stringify(report.targets));
            assert.equal(report.lint!.cleanFindings, 0);
            assert.equal(report.lint!.seeded!.expected, 30);
            assert.equal(report.docs!.shots.length, 4);
            assert.ok(report.docs!.shots.every((shot) => shot.file !== undefined));

            // Tiles: the first screen, then each section; none taller than 2,000 px; the phone at scale 1.
            for (const shot of report.docs!.shots) {
                const tiles = shot.tiles!;

                assert.ok(tiles.length >= 8, `${shot.viewport} ${shot.scheme}`);
                assert.match(
                    tiles[0]!,
                    new RegExp(`docs-${shot.viewport}-${shot.scheme}-00-first-screen\\.png$`),
                );
                assert.ok(tiles.some((tile) => /-\d\d-components\.png$/.test(tile)));

                for (const tile of tiles) {
                    const header = readFileSync(join(report.bench.out, tile)).subarray(16, 24);
                    const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];

                    assert.ok(height > 0 && height <= 2000, tile);
                    assert.equal(width, shot.viewport === "mobile" ? 390 : 1440, tile);
                }
            }

            assert.ok(report.format!.systems.length >= 7);
        } finally {
            await chromium.close();
        }
    },
);

test(
    "a sabotaged reference scores lower: the bench is not satisfied by anything",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const { BenchBrowser } = await import("./design-system-bench/lib/chromium.ts");
        const chromium = (await BenchBrowser.launch())!;
        const out = join(BENCH, "..", "..", "node_modules", ".cache", "ds-bench-sabotage");

        try {
            const good = referenceModules(chromium);
            // A linter that misses every contrast problem, and sees a problem on a clean page.
            const lazy = {
                ...good,
                check: async (...args: Parameters<NonNullable<typeof good.check>>) => {
                    const report = await good.check!(...args);
                    const clean = String((args[0] as { content: string }).content).includes(
                        "<title>Settings</title>",
                    );

                    report.findings = report.findings.filter(
                        (finding) => finding.rule !== "contrast",
                    );

                    if (clean) {
                        report.findings.push({
                            rule: "overflow",
                            level: "error",
                            selector: "",
                            message: "x",
                        });
                    }

                    return report;
                },
                // A scan that forgets the dark mode and names every color token a role it should not.
                scan: {
                    name: "forgetful",
                    run: (dir: string) => {
                        const draft = good.scan!.run(dir) as { tokens: any; modes: unknown };

                        draft.tokens.color.warning = { default: { $value: "#010101" } };

                        return { tokens: draft.tokens, modes: {} };
                    },
                },
            };
            const report = await runBench({
                modules: lazy,
                reference: true,
                out,
                only: ["scan", "lint"],
            });

            assert.ok(
                report.lint!.recall < 0.9 && report.lint!.recall > 0.5,
                String(report.lint!.recall),
            );
            assert.ok(report.lint!.precision < 1);
            assert.ok(report.lint!.cleanFindings >= 1);
            assert.equal(report.targets["lint: no finding on the clean designs"], false);
            assert.equal(report.targets["lint: recall >= 0.9"], false);
            assert.ok(report.lint!.byRule["contrast"]!.recall === 0);
            assert.ok(report.scan!.score < 0.95);
            assert.equal(report.scan!.aggregate["darkColors"]!.recall, 0);
            assert.ok(
                report.scan!.aggregate["roles"]!.precision < 1,
                "a role that was not expected is wrong",
            );
            assert.equal(report.targets["scan: roles precision and recall >= 0.9"], false);
        } finally {
            await chromium.close();
        }
    },
);

test("a dark-first draft is scored by theme: the mode named light is the light theme", () => {
    const expected: Expected = {
        name: "dark-first",
        colors: ["#ffffff", "#111111"],
        darkColors: ["#000000", "#eeeeee"],
        roles: {
            bg: { light: "#ffffff", dark: "#000000" },
            text: { light: "#111111", dark: "#eeeeee" },
        },
        typeScale: [],
        spacing: [],
        radii: [],
        shadows: [],
        fonts: [],
        dark: { present: true },
    };
    const tree = {
        color: { $type: "color", bg: { $value: "#000000" }, text: { $value: "#eeeeee" } },
    };
    const light = { color: { bg: { $value: "#ffffff" }, text: { $value: "#111111" } } };
    const score = scoreScan(expected, extract(flatten(tree, { light })));

    assert.equal(score.colors.f1, 1);
    assert.equal(score.darkColors.f1, 1);
    assert.equal(score.roles.f1, 1);
    assert.equal(score.darkRoles.f1, 1);
    // A role that the scan does not make differ between themes is not a dark role: precision stays at most 1.
    const flat = extract(flatten(tree, { light: { color: { bg: { $value: "#ffffff" } } } }));
    const partial = scoreScan(expected, flat);

    assert.ok(
        partial.darkRoles.precision <= 1 && partial.darkRoles.matched <= partial.darkRoles.actual,
    );
    assert.equal(partial.darkRoles.matched, 1, "only bg differs between the themes");
    // The same colors with the files the usual way round score the same.
    assert.equal(scoreScan(expected, extract(flatten(light, { dark: tree }))).darkRoles.f1, 1);
});

test("--fixtures and --lint point the runner at other folders", async () => {
    const report = await runBench({
        modules: referenceModules(undefined, join(BENCH, "fixtures")),
        reference: true,
        browser: false,
        fixtures: join(BENCH, "fixtures"),
        lint: join(BENCH, "lint", "designs"),
        only: ["scan"],
        out: join(BENCH, "..", "..", "node_modules", ".cache", "ds-bench-roots"),
    });

    assert.equal(report.scores.scan, 1);
    assert.equal(
        spawnSync(
            "node",
            [
                join(BENCH, "run.ts"),
                "--fixtures",
                "/no/such/folder",
                "--only",
                "scan",
                "--no-browser",
            ],
            { encoding: "utf8" },
        ).status,
        2,
    );
});

test(
    "the CSS probe reads every variable of the flagship right (--space-0 was read as 0.4px from a stale element)",
    { skip: browser === undefined, timeout: 120_000 },
    async () => {
        const { BenchBrowser } = await import("./design-system-bench/lib/chromium.ts");
        const { checkCss } = await import("./design-system-bench/lib/css-check.ts");
        const flat = readFlat(
            join(BENCH, "..", "fixtures", "design-system", "flagship", ".pi", "design"),
        );
        const chromium = (await BenchBrowser.launch())!;

        try {
            // The bench's own compile of the flagship's source: the engine is not involved.
            const result = await checkCss(chromium, goldenCss(flat), flat);

            assert.ok(flat.tokens.length > 250, "the flagship is big enough to show the problem");
            assert.deepEqual(result.problems, []);
            assert.equal(result.correct, result.comparable);
            assert.equal(result.defined, result.expected);
            assert.equal(result.mediaDark, true);
        } finally {
            await chromium.close();
        }
    },
);
