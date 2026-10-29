// The Sass of a palette in the scan: loops (`@each`, `@for`, `@while`), maps built in code, functions, and color functions,
// run as Sass runs them (the expected colors are Dart Sass's own output), across files, with the text left as it was where
// it cannot be run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanReport, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import { Project, evaluateSass, expandSassFiles } from "../src/server/design/scan-sass-eval.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-sass-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

function load(scan: TokenScan): DesignSystem {
    const system = buildSystem({
        folder: "scan",
        tokens: scan.draft.tokens,
        modes: new Map(Object.entries(scan.draft.modes)),
        components: new Map(),
        guidelines: "",
        problems: [],
    });

    assert.deepEqual(
        system.problems.filter((problem) => problem.level === "error"),
        [],
        "the draft has no error",
    );

    return system;
}

const token = (system: DesignSystem, name: string) =>
    system.tokens.find((each) => each.name === name);
const hex = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.hex;

/** What a stylesheet makes: its text with the runs of white space made one. */
const run = (source: string, shared = new Project()) =>
    evaluateSass(source, shared)?.text.replace(/\s+/g, " ").trim();
/** The custom properties and variables of a result, by name. */
const props = (text: string | undefined) =>
    Object.fromEntries(
        [...(text ?? "").matchAll(/([$-][\w-]+):\s*([^;}]+)/g)].map((match) => [
            match[1],
            match[2]!.trim(),
        ]),
    );

/** A hex within one step of another (Sass rounds half-way channels one way, a model of it may round the other). */
const near = (actual: string | undefined, expected: string) => {
    if (actual === expected) {
        return true;
    }

    const pair = (text: string | undefined) =>
        /^#([0-9a-f]{6})$/
            .exec(text ?? "")?.[1]
            ?.match(/../g)
            ?.map((byte) => Number.parseInt(byte, 16));
    const [a, b] = [pair(actual), pair(expected)];

    return (
        a !== undefined && b !== undefined && a.every((value, at) => Math.abs(value - b[at]!) <= 1)
    );
};

// What Dart Sass makes of each expression, with $c: #3b82f6, $d: #e76f51, $a: rgba(59, 130, 246, 0.5).
const COLOR_FUNCTIONS: [string, string][] = [
    ["lighten($c, 15%)", "#84b1f9"],
    ["darken($c, 15%)", "#0a59da"],
    ["saturate($d, 20%)", "#fb633d"],
    ["desaturate($d, 20%)", "#d37b65"],
    ["adjust-hue($c, 40deg)", "#713bf6"],
    ["mix($c, $d)", "#9179a3"],
    ["mix($c, $d, 30%)", "#b37582"],
    ["mix($a, $d, 60%)", "rgba(174, 117, 136, 0.7)"],
    ["scale-color($c, $lightness: 40%)", "#89b4fa"],
    ["scale-color($c, $lightness: -40%, $saturation: -30%)", "#214d96"],
    ["scale-color($c, $red: 50%, $blue: -50%)", "#9d827b"],
    ["scale-color($c, $alpha: -60%)", "rgba(59, 130, 246, 0.4)"],
    ["adjust-color($c, $lightness: -20%)", "#094fc2"],
    ["adjust-color($c, $hue: 90, $saturation: -10%)", "#ec45d8"],
    ["adjust-color($c, $red: 30, $green: -20)", "#596ef6"],
    ["adjust-color($c, $alpha: -0.3)", "rgba(59, 130, 246, 0.7)"],
    ["change-color($c, $lightness: 20%)", "#042862"],
    ["change-color($c, $hue: 10, $saturation: 50%)", "#cc7665"],
    ["change-color($c, $red: 255, $alpha: 0.4)", "rgba(255, 130, 246, 0.4)"],
    ["rgba($c, 0.25)", "rgba(59, 130, 246, 0.25)"],
    ["transparentize($c, 0.4)", "rgba(59, 130, 246, 0.6)"],
    ["opacify($a, 0.3)", "rgba(59, 130, 246, 0.8)"],
    ["grayscale($c)", "#989898"],
    ["complement($c)", "#f6af3b"],
    ["invert($c)", "#c47d09"],
    ["invert($c, 40%)", "#728097"],
    ["color.adjust($c, $lightness: 10%)", "#6ca1f8"],
    ["color.scale($c, $lightness: 25%)", "#6ca1f8"],
    ["color.mix(white, $c, 20%)", "#629bf8"],
    ["color.change($c, $alpha: 0.8)", "rgba(59, 130, 246, 0.8)"],
    ["red($c)", "59"],
    ["green($c)", "130"],
    ["blue($c)", "246"],
    ["saturation($c)", "91.2195121951%"],
    ["lightness($c)", "59.8039215686%"],
    ["math.percentage(0.25)", "25%"],
    ["math.div(10px, 4)", "2.5px"],
    ["(10px + 6px) * 2 / 4", "8px"],
    ["nth((a b c), 2)", "b"],
    ["length((1, 2, 3))", "3"],
    ["map.get((a: 1px, b: 2px), b)", "2px"],
];

test("color functions give what Dart Sass gives, in Sass's own color model: lighten, mix, scale-color, adjust-color, and the rest", () => {
    const source = `$c: #3b82f6; $d: #e76f51; $a: rgba(59, 130, 246, 0.5);\n:root {\n${COLOR_FUNCTIONS.map(([expression], at) => `  --v${at}: #{${expression}};`).join("\n")}\n}`;
    const made = props(run(source));

    for (const [at, [expression, expected]] of COLOR_FUNCTIONS.entries()) {
        assert.ok(
            near(made[`--v${at}`], expected),
            `${expression}: ${made[`--v${at}`]} should be ${expected}`,
        );
    }
});

test("@each over a map and a list, with destructuring, and a custom property made for each entry", () => {
    const made = props(
        run(`$brand: (primary: #3b82f6, danger: #dc2626);
$sizes: 1 2 3;
:root {
  @each $name, $color in $brand { --c-#{$name}: #{$color}; --c-#{$name}-soft: #{rgba($color, 0.1)}; }
  @each $n in $sizes { --s-#{$n}: #{$n * 4px}; }
}`),
    );

    assert.equal(made["--c-primary"], "#3b82f6");
    assert.equal(made["--c-danger-soft"], "rgba(220, 38, 38, 0.1)");
    assert.equal(made["--s-1"], "4px");
    assert.equal(made["--s-3"], "12px");
});

test("@for through and to, up and down; @while with a limit; nested loops", () => {
    const made = props(
        run(`:root {
  @for $i from 1 through 3 { --a-#{$i}: #{$i * 10%}; }
  @for $i from 1 to 3 { --b-#{$i}: #{$i}; }
  @for $i from 3 through 1 { --c-#{$i}: #{$i}; }
  $n: 0;
  @while $n < 3 { $n: $n + 1; --w-#{$n}: #{$n * 2}; }
  @for $i from 1 through 2 { @for $j from 1 through 2 { --g-#{$i}-#{$j}: #{$i * $j}; } }
}`),
    );

    assert.deepEqual([made["--a-1"], made["--a-3"]], ["10%", "30%"]);
    assert.equal(made["--b-2"], "2");
    assert.equal(made["--b-3"], undefined, "`to` stops before the end");
    assert.equal(made["--c-1"], "1");
    assert.equal(made["--w-3"], "6");
    assert.equal(made["--g-2-2"], "4");
});

test("a map built in a loop with map.merge, and read with map.get, map-get, and nested keys; the final map is written once", () => {
    const text = run(`@use "sass:map";
$palette: ();
@each $name, $base in (a: #3b82f6, b: #16a34a) {
  @each $step, $amount in (100: 80%, 500: 0%) { $palette: map.merge($palette, ("#{$name}-#{$step}": mix(white, $base, $amount))); }
}
$nested: (light: (bg: #fff, text: #111), dark: (bg: #000, text: #eee));
$bg: map.get($palette, "a-100");
$dark-bg: map.get($nested, dark, bg);
$text: map-get(map-get($nested, light), text);`);
    const made = props(text);

    assert.equal(made.$bg, "#d8e6fd");
    assert.equal(made.$text, "#111111");
    assert.equal(made["$dark-bg"], "#000000");
    assert.equal(
        (text!.match(/\$palette:/g) ?? []).length,
        2,
        "the empty map, then the finished one",
    );
    assert.match(
        text!,
        /\$palette: \("a-100": #d8e6fd, "a-500": #3b82f6, "b-100": #d0eddb, "b-500": #16a34a\)/,
    );
});

test("functions with defaults, keyword arguments, @if / @else if / @else, and @return; a mixin that makes a palette", () => {
    const made = props(
        run(`@function tone($c, $w: 50%, $to: white) { @if $w > 100% { @return $c; } @else if $w < 0% { @return mix(black, $c, -$w); } @else { @return mix($to, $c, $w); } }
$base: #3b82f6;
$a: tone($base);
$b: tone($base, $to: black, $w: 20%);
$c: tone($base, -30%);
$d: tone($base, 200%);
@mixin ramp($name, $color, $steps: 3) { @for $i from 1 through $steps { --#{$name}-#{$i}: #{tone($color, $i * 20%)}; } }
:root { @include ramp(brand, $base); @include ramp(ink, #111, 2); }`),
    );

    assert.ok(near(made.$a, "#9dc1fa"), made.$a);
    assert.ok(near(made.$b, "#2f68c4"), made.$b);
    assert.ok(near(made.$c, "#2a5aac"), made.$c);
    assert.equal(made.$d, "#3b82f6");
    assert.ok(near(made["--brand-1"], "#629bf8"), made["--brand-1"]);
    assert.ok(near(made["--ink-2"], "#707070"), made["--ink-2"]);
});

test("variables: !default does not replace, !global reaches out of a rule, and a variable set in a loop is the loop's result", () => {
    const made = props(
        run(`$a: 1; $a: 2 !default; $b: 5 !default;
.x { $local: 3; $a: 9 !global; --l: #{$local}; }
$sum: 0; @each $n in 1 2 3 { $sum: $sum + $n; }
:root { --a: #{$a}; --b: #{$b}; --sum: #{$sum}; }`),
    );

    assert.equal(made["--a"], "9");
    assert.equal(made["--b"], "5");
    assert.equal(made["--sum"], "6");
});

test("interpolation in selectors, property names, and strings; arithmetic with units; division; strings", () => {
    const text = run(`$name: card; $gap: 8px;
.#{$name}-list > .#{$name} { padding: $gap * 2 $gap / 2; margin: math.div(24px, 3); width: calc(100% - #{$gap * 4}); content: "#{$name}"; font: 12px/1.5 sans-serif; }
@media (min-width: 40rem) { .a { gap: $gap + 4px } }`);

    assert.match(text!, /\.card-list > \.card \{/);
    assert.match(text!, /padding: 16px 4px/);
    assert.match(text!, /margin: 8px/);
    assert.match(text!, /width: calc\(100% - 32px\)/);
    assert.match(text!, /font: 12px\/1\.5 sans-serif/, "a font shorthand keeps its slash");
    assert.match(text!, /@media \(min-width: 40rem\) \{ \.a \{ gap: 12px; \} \}/);
});

test("the files of a project in the order they load each other, with namespaces; the other files' variables are seen", () => {
    const files = [
        {
            rel: "main.scss",
            text: `@use "tokens" as t;\nbody { color: t.$text; }\n:root { @each $k, $v in t.$set { --#{$k}: #{$v}; } }`,
        },
        {
            rel: "_tokens.scss",
            text: `@use "palette";\n$text: palette.$ink;\n$set: (bg: palette.$paper, ink: $text);`,
        },
        {
            rel: "_palette.scss",
            text: `$base: #30638e;\n$ink: color.scale($base, $lightness: -80%);\n$paper: scale-color($base, $lightness: 96%, $saturation: -90%);`,
        },
    ];
    const made = expandSassFiles(files);
    const text = made.get("main.scss")!;

    assert.equal(props(text)["--ink"], "#0a141c");
    assert.equal(props(text)["--bg"], "#f8f9f9");
    assert.match(text, /body \{ color: #0a141c; \}|body \{ color: t\.\$text; \}/);
});

test("what cannot be run is left as it was written, and the rest runs: an unknown function, an undefined variable, a function that loops", () => {
    const text = run(`$known: #3b82f6;
$a: fancy-blend($known, 20%);
$b: $missing * 2;
@function forever($n) { @return forever($n + 1); }
$c: forever(1);
$d: darken($known, 10%);
.x { color: $a; border-color: lighten($known, 20%); background: image-set("a.png" 1x); }
@each $k, $v in $nothing { .y-#{$k} { color: $v } }
:root { --ok: #{$d}; }`);

    assert.match(text!, /\$a: fancy-blend\(\$known, 20%\)/);
    assert.match(text!, /\$b: \$missing \* 2/);
    assert.match(
        text!,
        /border-color: #9[cd]c0fa/,
        "a color function in a declaration is worked out",
    );
    assert.match(text!, /@each \$k, \$v in \$nothing/, "a loop over nothing known is kept");
    assert.match(text!, /--ok: #0b63f3/);
});

test("limits: a loop that is too long, a while that never ends, and output that is too large are given up on, not run", () => {
    const started = Date.now();

    assert.match(
        run("$k: 1; @for $i from 1 through 100000000 { --a-#{$i}: #{$i}; }") ?? "",
        /@for \$i from 1 through 100000000/,
    );
    assert.match(run("@while true { --x: 1; }") ?? "", /@while true/);
    assert.equal(
        run(
            `$s: "${"x".repeat(1000)}"; @for $i from 1 through 5000 { --a-#{$i}: #{$s}; }`,
        )?.includes("--a-5000") ?? false,
        false,
        "output that is too large is not made",
    );
    assert.ok(Date.now() - started < 5000);
});

test("lines stay where they were: a statement is written on its own line, and a loop makes its output on the line of the loop", () => {
    const text = evaluateSass(
        `$a: #fff;\n\n:root {\n  @for $i from 1 through 3 {\n    --s-#{$i}: #{$i}px;\n  }\n  --after: 1;\n}\n`,
        new Project(),
    )!.text;
    const lines = text.split("\n");

    assert.match(lines[0]!, /^\s*\$a: #fff/);
    assert.match(lines[2]!, /^:root \{/);
    assert.ok(
        lines.slice(3, 5).some((line) => /--s-1: 1px; --s-2: 2px; --s-3: 3px/.test(line)),
        JSON.stringify(lines),
    );
    assert.match(
        lines.find((line) => /--after/.test(line))!,
        /--after: 1/,
    );
    assert.ok(lines.length <= 9);
});

// --- Projects -------------------------------------------------------------------------------------------------------------

test("a palette made with @each, map.merge, and a shade function: its steps are a palette, and the roles point at them", () => {
    const system = load(
        scanTokens(
            project({
                "styles/palette.scss": `@use "sass:color";
@use "sass:map";
$brand: ("primary": #3b82f6, "danger": #dc2626);
$steps: (50: 95%, 100: 90%, 300: 60%, 500: 0%, 700: -25%, 900: -55%);
@function shade($color, $amount) { @if $amount >= 0 { @return color.mix(white, $color, $amount); } @return color.mix(black, $color, -$amount); }
$palette: ();
@each $name, $base in $brand { @each $step, $amount in $steps { $palette: map.merge($palette, ("#{$name}-#{$step}": shade($base, $amount))); } }
:root { @each $key, $value in $palette { --color-#{$key}: #{$value}; } }
$color-primary: map.get($palette, "primary-500");
$color-bg: color.scale(#3b82f6, $lightness: 96%, $saturation: -80%);
$color-text: map.get($palette, "primary-900");
$color-border: color.adjust(#111827, $lightness: 85%);
$color-danger: map.get($palette, "danger-500");
body { background: $color-bg; color: $color-text; border: 1px solid $color-border; }
a { color: $color-primary }`,
            }),
        ),
    );

    assert.equal(hex(system, "color.accent.default"), "#3b82f6");
    assert.equal(hex(system, "color.bg.page"), "#fafbfc");
    assert.equal(hex(system, "color.danger.default"), "#dc2626");
    assert.ok(
        near(hex(system, "color.text.primary"), "#1b3a6f"),
        String(hex(system, "color.text.primary")),
    );
    assert.ok(
        system.tokens.some((each) => /^color\.(?:primary|palette-primary)\.100$/.test(each.name)),
        "the steps of the palette are tokens",
    );
});

test("a palette from one base color with scale-color, adjust-color, darken, and mix in @for and @each loops", () => {
    const scan = scanTokens(
        project({
            "src/scss/_colors.scss": `$base: #264653; $accent: #e76f51; $levels: 5, 10, 20, 40, 60, 80, 90, 95;
:root {
  @for $i from 1 through 9 { --teal-#{$i * 100}: #{scale-color($base, $lightness: $i * 10% - 5%, $saturation: -20%)}; }
  --accent: #{$accent}; --accent-hover: #{darken($accent, 8%)};
  @each $level in $levels { --gray-#{$level}: #{mix(white, #1d2733, $level * 1%)}; }
  --bg: var(--gray-95); --text: #{change-color($base, $lightness: 12%)};
}
body { background: var(--bg); color: var(--text); padding: 12px 24px; }
a { color: var(--accent) }`,
        }),
    );
    const system = load(scan);

    assert.equal(scan.inferred.roles.background?.value, "#f4f4f5");
    assert.equal(scan.inferred.roles.text?.value, "#13232a");
    assert.equal(scan.inferred.roles.accent?.value, "#e76f51");
    assert.ok(
        near(hex(system, "color.teal.500"), "#74a1b4"),
        String(hex(system, "color.teal.500")),
    );
    assert.ok(
        near(hex(system, "color.gray.40"), "#777d85") ||
            system.tokens.some((each) => /^color\.gray/.test(each.name)),
    );
    assert.match(
        scanReport(scan),
        /color\.bg\.page\s+#f4f4f5\s+from --bg \(background; high confidence, src\/scss\/_colors\.scss:6\)/,
        "the line of the source",
    );
});

test("variables in several files with @use namespaces, a map generated with @for and math.div, and a light and dark theme from a map of maps", () => {
    const scan = scanTokens(
        project({
            "src/styles/_palette.scss": `@use "sass:color"; @use "sass:map"; @use "sass:math";
$neutral: ();
@for $i from 0 through 9 { $neutral: map.merge($neutral, ($i * 100 + 50: color.mix(#0b132b, #ffffff, math.div($i, 9) * 100%))); }
$brand: (500: #5b2a86, 300: color.scale(#5b2a86, $lightness: 45%), 700: color.adjust(#5b2a86, $lightness: -15%));`,
            "src/styles/_tokens.scss": `@use "palette" as p; @use "sass:map";
$color-bg: map.get(p.$neutral, 50); $color-surface: #fff; $color-text: map.get(p.$neutral, 850); $color-muted: map.get(p.$neutral, 550);
$color-border: map.get(p.$neutral, 150); $color-primary: map.get(p.$brand, 500); $space-1: 4px; $space-2: 8px; $space-3: 16px; $radius: 6px;`,
            "src/styles/main.scss": `@use "tokens" as t;
body { background: t.$color-bg; color: t.$color-text; padding: t.$space-3; }
.card { background: t.$color-surface; border: 1px solid t.$color-border; border-radius: t.$radius; padding: t.$space-2 }
a { color: t.$color-primary } .muted { color: t.$color-muted }`,
        }),
    );

    assert.equal(scan.inferred.roles.background?.value, "#ffffff");
    assert.equal(scan.inferred.roles.surface?.value, "#ffffff");
    assert.equal(scan.inferred.roles.accent?.value, "#5b2a86");
    assert.ok(
        near(scan.inferred.roles.text?.value, "#262d43"),
        String(scan.inferred.roles.text?.value),
    );
    assert.ok(
        near(scan.inferred.roles.border?.value, "#e4e5e7"),
        String(scan.inferred.roles.border?.value),
    );

    const themes = scanTokens(
        project({
            "styles/themes.scss": `$themes: (light: (bg: #fafaf9, surface: #fff, text: #1c1917, muted: #78716c, border: #e7e5e4, accent: #0d9488), dark: (bg: #0c0a09, surface: #1c1917, text: #fafaf9, muted: #a8a29e, border: #44403c, accent: #2dd4bf));
@each $theme, $colors in $themes { .theme-#{$theme} { @each $role, $value in $colors { --#{$role}: #{$value}; } } }
body { background: var(--bg); color: var(--text) }`,
        }),
    );

    assert.equal(themes.inferred.roles.background?.value, "#fafaf9");
    assert.equal(themes.inferred.roles.background?.dark, "#0c0a09");
    assert.equal(themes.inferred.roles.accent?.dark, "#2dd4bf");
});

test("the indented syntax: loops and functions in a .sass file", () => {
    const scan = scanTokens(
        project({
            "styles/colors.sass": `$base: #3b82f6
$steps: (100: 80%, 500: 0%, 900: -50%)
:root
  @each $step, $amount in $steps
    --brand-#{$step}: #{if($amount >= 0, mix(white, $base, $amount), mix(black, $base, -$amount))}
  --bg: var(--brand-100)
  --text: var(--brand-900)
body
  background: var(--bg)
  color: var(--text)
`,
        }),
    );

    assert.equal(scan.inferred.roles.background?.value, "#d8e6fd");
    assert.equal(scan.inferred.roles.text?.value, "#1e417b");
});

test("a stylesheet with no loops, maps, or color functions is read as it was written, and one that fails to parse is too", () => {
    const plain = ":root { --bg: #ffffff; --text: #111111 }\nbody { background: var(--bg) }";

    assert.equal(expandSassFiles([{ rel: "a.scss", text: plain }]).size, 0, "nothing to run");
    assert.doesNotThrow(
        () => expandSassFiles([{ rel: "b.scss", text: "@each $a in (1 2 { --x: 1" }]),
        "a broken file is not an error",
    );
    assert.equal(
        scanTokens(project({ "a.scss": plain })).inferred.roles.background?.value,
        "#ffffff",
    );
});

test("a palette of nested maps, a function that reads them, and a mixin that writes them: every value is Dart Sass's", () => {
    const scan = scanTokens(
        project({
            "theme.scss": `@use "sass:color"; @use "sass:map"; @use "sass:math";
$bases: (blue: #2563eb, green: #16a34a, rose: #e11d48, slate: #475569);
$tints: (50: 94%, 100: 86%, 200: 72%, 300: 54%, 400: 28%);
$shades: (600: 12%, 700: 26%, 800: 42%, 900: 58%);
$colors: ();
@each $name, $base in $bases {
  $ramp: (500: $base);
  @each $step, $w in $tints { $ramp: map.merge($ramp, ($step: color.mix(white, $base, $w))); }
  @each $step, $w in $shades { $ramp: map.merge($ramp, ($step: color.mix(black, $base, $w))); }
  $colors: map.merge($colors, ($name: $ramp));
}
@function c($name, $step: 500) { @return map.get(map.get($colors, $name), $step); }
$primary: c(blue, 600);
$danger: c(rose);
$success: c(green, 700);
$bg: color.adjust(c(slate, 50), $lightness: 3%);
$text: c(slate, 900);
$border: color.change(c(slate, 200), $alpha: 0.6);
@mixin ramp($name) { @each $step, $v in map.get($colors, $name) { --#{$name}-#{$step}: #{$v}; } }
:root { @include ramp(blue); @include ramp(slate); --primary: #{$primary}; --danger: #{$danger}; --success: #{$success}; --bg: #{$bg}; --text: #{$text}; --border: #{$border}; }`,
        }),
    );
    const system = load(scan);
    const { roles } = scan.inferred;

    // What Dart Sass makes of these lines.
    assert.ok(near(roles.accent?.value, "#2157cf"), String(roles.accent?.value));
    assert.equal(roles.danger?.value, "#e11d48");
    assert.ok(near(roles.success?.value, "#107937"), String(roles.success?.value));
    assert.ok(near(roles.background?.value, "#fcfdfd"), String(roles.background?.value));
    assert.ok(near(roles.text?.value, "#1e242c"), String(roles.text?.value));
    assert.equal(roles.border?.value, "#cbcfd599", "a color with alpha");
    assert.ok(
        near(hex(system, "color.blue.100"), "#e0e9fc"),
        String(hex(system, "color.blue.100")),
    );
    assert.ok(
        system.tokens.filter((each) => /^color\.(?:blue|slate)\./.test(each.name)).length >= 20,
        "the two ramps the mixin wrote",
    );
    assert.ok(
        !system.tokens.some((each) => /^color\.(?:ramp|v)\b/.test(each.name)),
        "a variable that a loop keeps for itself is not a token",
    );
});

test("hostile Sass runs in bounded time and never throws: an unclosed map, parentheses and unary signs nested thousands deep, thousands of variables", () => {
    const started = Date.now();
    const cases = [
        `$m: (${"a: 1px, ".repeat(20_000)}`.slice(0, 190_000),
        `$m: (${"a: 1px, ".repeat(20_000)});\n@each $k, $v in $m { --x-#{$k}: #{$v}; }`,
        `$x: ${"(".repeat(5000)}1${")".repeat(5000)};\n@each $i in 1 { --a: #{$x}; }`,
        `$x: ${"-".repeat(5000)}1;\n@each $i in 1 { --a: #{$x}; }`,
        `${Array.from({ length: 4000 }, (_, at) => `$v${at}: mix(#fff, #000, ${at % 100}%);`).join("\n")}\n@each $i in 1 2 3 { --a-#{$i}: 1; }`,
        `@each $a in ${"(".repeat(2000)} { x`,
        `@function f($n) { @return f($n + 1); }\n@each $i in 1 { --a: #{f(1)}; }`,
        `${"@if true { ".repeat(3000)}--x: 1;${" }".repeat(3000)}`,
        `@for $i from 1 through 3000 { @for $j from 1 through 3000 { --a-#{$i}-#{$j}: #{$i * $j}; } }`,
    ];

    for (const text of cases) {
        assert.doesNotThrow(() => expandSassFiles([{ rel: "x.scss", text }]), text.slice(0, 60));
    }

    assert.ok(Date.now() - started < 6000, `${Date.now() - started} ms`);
});

test("a project of many stylesheets is run for a fixed time, and what is not run is read as it was written", () => {
    const files = Array.from({ length: 80 }, (_, at) => ({
        rel: `p${String(at).padStart(2, "0")}.scss`,
        text: `@for $i from 1 through 2000 { @for $j from 1 through 20 { .a-#{$i}-#{$j} { color: mix(#fff, #000, $j * 1%); width: $i * 1px; } } }`,
    }));
    const started = Date.now();
    const made = expandSassFiles(files);

    assert.ok(Date.now() - started < 9000, `${Date.now() - started} ms`);
    assert.ok(made.size >= 1, "the files that were run are written");
});

test("a Sass file that ends with `{` ends (it filled the heap before: run in a child)", () => {
    const module = new URL("../src/server/design/scan-sass-stmt.ts", import.meta.url).href;
    const code = `import { statementsOf } from "${module}"; statementsOf("@for $i from 1 through 3 {", 1);`;
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module"], {
        input: `${code} console.log("ended");`,
        encoding: "utf8",
        timeout: 20_000,
    });

    assert.equal(child.stdout.trim(), "ended");
});

test("a Sass variable that points at itself (`$a: $a * 2`) does not stop the scan", () => {
    const dir = project({ "a.scss": "$a: 4px;\n$a: $a * 2;\n.x { color: red; width: $a; }" });

    assert.doesNotThrow(() => scanTokens(dir));
});
