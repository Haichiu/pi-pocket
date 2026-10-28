// The module system of Sass in the scan: `@use` with a namespace, `as *`, `@forward` with a prefix, `show` and `hide`,
// `@use … with (…)`, and the members of other modules (`p.$blue-500`, `p.fn()`, `@include p.mixin`). The expected values are
// what Dart Sass makes of the same files (checked with `sass` itself), not what the evaluator makes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanTokens } from "../src/server/design/scan.ts";
import { expandSassFiles } from "../src/server/design/scan-sass-eval.ts";
import {
    defaultNamespace,
    parseModuleRule,
    resolveModule,
} from "../src/server/design/scan-sass-modules.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-sass-mod-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

/** The custom properties that the evaluated entry file makes, by name. */
function made(files: Record<string, string>, entry: string): Record<string, string> {
    const out = expandSassFiles(Object.entries(files).map(([rel, text]) => ({ rel, text })));
    const text = out.get(entry);

    assert.ok(text !== undefined, `${entry} was worked out`);

    return Object.fromEntries(
        [...text.matchAll(/(--[\w-]+):\s*([^;}]+)/g)].map((match) => [match[1], match[2]!.trim()]),
    );
}

/** A hex within a step of another (Sass rounds half-way channels one way, the model may round the other). */
const near = (actual: string | undefined, expected: string) => {
    const bytes = (text: string | undefined) =>
        /^#([0-9a-f]{6})$/
            .exec(text ?? "")?.[1]
            ?.match(/../g)
            ?.map((byte) => Number.parseInt(byte, 16));
    const [a, b] = [bytes(actual), bytes(expected)];

    return (
        a !== undefined && b !== undefined && a.every((value, at) => Math.abs(value - b[at]!) <= 1)
    );
};

test("rules: the path, the namespace, a prefix, show and hide, and the configuration are read", () => {
    assert.deepEqual(parseModuleRule(`"lib/a"`), {
        path: "lib/a",
        namespace: undefined,
        prefix: "",
        config: [],
        show: undefined,
        hide: undefined,
    });
    assert.equal(parseModuleRule(`"x" as p`)?.namespace, "p");
    assert.equal(parseModuleRule(`'x' as *`)?.namespace, "*");
    assert.equal(parseModuleRule(`"x" as list-*`)?.prefix, "list-");
    assert.deepEqual(parseModuleRule(`"x" as p-* show $p-a, p-f, $p-b`)?.show, [
        "$p-a",
        "p-f",
        "$p-b",
    ]);
    assert.deepEqual(parseModuleRule(`"x" hide $c, m`)?.hide, ["$c", "m"]);
    assert.deepEqual(
        parseModuleRule(`"x" as y with ($a: 1, $b: (k: v, w: 2), $c: "a, b" !default)`)?.config,
        ["$a: 1", "$b: (k: v, w: 2)", `$c: "a, b" !default`],
    );
    assert.equal(parseModuleRule(`url(x)`), undefined);
    assert.equal(defaultNamespace("../lib/_palette.scss"), "palette");
    assert.equal(defaultNamespace("sass:color"), "color");
    assert.equal(defaultNamespace("a/b.module"), "b");
});

test("rules: a path finds the partial, the index of a folder, and the nearest of two", () => {
    const rels = [
        "src/styles/abstracts/_index.scss",
        "src/styles/abstracts/_palette.scss",
        "src/styles/main.scss",
        "other/abstracts/_palette.scss",
        "src/legacy/palette.scss",
    ];

    assert.equal(
        resolveModule("src/styles/main.scss", "abstracts", rels),
        "src/styles/abstracts/_index.scss",
    );
    assert.equal(
        resolveModule("src/styles/main.scss", "./abstracts/palette", rels),
        "src/styles/abstracts/_palette.scss",
    );
    assert.equal(
        resolveModule("src/styles/abstracts/_index.scss", "palette", rels),
        "src/styles/abstracts/_palette.scss",
    );
    assert.equal(
        resolveModule("src/legacy/x.scss", "../styles/abstracts/palette", rels),
        "src/styles/abstracts/_palette.scss",
    );
    assert.equal(
        resolveModule("src/styles/main.scss", "~abstracts/palette", rels),
        "src/styles/abstracts/_palette.scss",
    );
    assert.equal(resolveModule("src/styles/main.scss", "sass:color", rels), undefined);
    assert.equal(
        resolveModule("src/styles/main.scss", "bootstrap/scss/variables", rels),
        undefined,
    );
    assert.equal(resolveModule("src/styles/main.scss", "theme.css", rels), undefined);
});

// Dart Sass: --a-primary #3366cc, --bee-primary #00aa55 (configured), each module its own $name and $gap.
const NAMESPACES: Record<string, string> = {
    "lib/_a.scss": `$primary: #3366cc !default;
$gap: 8px !default;
$-hidden: #010203;
$name: "a";
@function tint($c, $amount: 20%) { @return mix(white, $c, $amount); }
@function gapx($n) { @return $gap * $n; }
@mixin theme-vars($prefix: "a") {
  --#{$prefix}-primary: #{$primary};
  --#{$prefix}-tint: #{tint($primary)};
  --#{$prefix}-gap: #{gapx(3)};
}`,
    "lib/_b.scss": `$primary: #cc3366 !default;
$gap: 4px !default;
$name: "b";
@function tint($c, $amount: 50%) { @return mix(white, $c, $amount); }
@function gapx($n) { @return $gap * $n * 2; }
@mixin theme-vars($prefix: "b") {
  --#{$prefix}-primary: #{$primary};
  --#{$prefix}-tint: #{tint($primary)};
  --#{$prefix}-gap: #{gapx(3)};
}`,
    "lib/_c.scss": `@use "sass:math" as *;
@use "sass:color" as col;
$base: #2d8a6e !default;
$ratio: div(3, 2);
$dark: col.adjust($base, $lightness: -20%);
$light: col.scale($base, $lightness: 40%);
$tau: $pi * 2;`,
    "main.scss": `@use "lib/a";
@use "lib/b" as bee with ($primary: #00aa55);
@use "lib/c" as * with ($base: #aa5500);
@use "sass:math";
@use "sass:color" as k;
:root {
  @include a.theme-vars;
  @include bee.theme-vars("bee");
  --a-name: #{a.$name};
  --b-name: #{bee.$name};
  --a-tint2: #{a.tint(#ff0000, 10%)};
  --b-tint2: #{bee.tint(#ff0000)};
  --dark: #{$dark};
  --light: #{$light};
  --ratio: #{$ratio};
  --k: #{k.mix(#fff, #000, 25%)};
  --pi: #{math.round(math.$pi * 100)};
  --gapx: #{a.gapx(2)};
}`,
};

test("a namespace keeps two modules apart: their variables, functions, and mixins are their own, and a module is configured with `with`", () => {
    const got = made(NAMESPACES, "main.scss");

    assert.equal(got["--a-primary"], "#3366cc");
    assert.ok(near(got["--a-tint"], "#5c85d6"), `${JSON.stringify(got)}`.slice(0, 200));
    assert.equal(got["--a-gap"], "24px", "a's $gap is 8px: 3 * 8");
    assert.equal(got["--bee-primary"], "#00aa55", "the configured value");
    assert.ok(near(got["--bee-tint"], "#80d5aa"), `${JSON.stringify(got)}`.slice(0, 200));
    assert.equal(got["--bee-gap"], "24px", "b's $gap is 4px and its function doubles: 3 * 4 * 2");
    assert.equal(got["--a-name"], "a");
    assert.equal(got["--b-name"], "b");
    assert.ok(near(got["--a-tint2"], "#ff1919"), "a's tint takes 10%");
    assert.ok(near(got["--b-tint2"], "#ff8080"), "b's tint takes 50%");
    assert.equal(got["--gapx"], "16px");
});

test("`as *` opens a module, a built-in module keeps its namespace or opens, and a configuration reaches the variables it names", () => {
    const got = made(NAMESPACES, "main.scss");

    assert.ok(
        near(got["--dark"], "#442200"),
        `${got["--dark"]}: the configured #aa5500, 20% darker`,
    );
    assert.ok(near(got["--light"], "#ff9933"), `${JSON.stringify(got)}`.slice(0, 200));
    assert.equal(got["--ratio"], "1.5", "`div` from `sass:math` opened with `as *`");
    assert.ok(near(got["--k"], "#404040"), `${got["--k"]}: sass:color as k`);
    assert.equal(got["--pi"], "314", "math.$pi");
});

// Dart Sass: --h 160, --radius 10px, --unit 4px, --visible #fedcba, --space-1 4px, --space-2 8px.
const FORWARDS: Record<string, string> = {
    "abstracts/_config.scss": `$brand-hue: 220 !default;
$radius: 6px !default;
$secret: #123456 !default;`,
    "abstracts/_scale.scss": `$unit: 4px !default;
$space: (1: $unit, 2: $unit * 2);`,
    "abstracts/_internal.scss": `$secret: #abcdef;
$visible: #fedcba;`,
    "abstracts/_index.scss": `@forward "config" show $brand-hue, $radius;
@forward "scale" as scale-*;
@forward "internal" hide $secret;`,
    "main.scss": `@use "abstracts" as a with ($brand-hue: 160, $radius: 10px);
:root {
  --h: #{a.$brand-hue};
  --radius: #{a.$radius};
  --unit: #{a.$scale-unit};
  --visible: #{a.$visible};
  --secret: #{a.$secret};
  @each $k, $v in a.$scale-space { --space-#{$k}: #{$v}; }
}`,
};

test("@forward hands members on with a prefix, `show`, and `hide`; a configuration passes through it; what is hidden stays unknown", () => {
    const got = made(FORWARDS, "main.scss");

    assert.equal(got["--h"], "160", "configured through the folder's index");
    assert.equal(got["--radius"], "10px");
    assert.equal(got["--unit"], "4px", "scale's $unit, forwarded as $scale-unit");
    assert.equal(got["--visible"], "#fedcba");
    assert.equal(got["--space-1"], "4px");
    assert.equal(got["--space-2"], "8px");
    assert.ok(
        !/#123456|#abcdef/.test(got["--secret"] ?? ""),
        `a hidden member is not found by its name in another module: ${got["--secret"]}`,
    );
});

// Dart Sass: --panel #ff00ff, --panel-d 30px, --a #e11d48, --n #445566, --d 15px, --p #112233, --m 3, --mm 3.
const FUNCTIONS: Record<string, string> = {
    "ds/_config.scss": `$mult: 2 !default;
$brand: #0ea5e9 !default;`,
    "ds/colors/_base.scss": `@use "../config" as c;
@use "sass:color";
@use "sass:map";
$brand-dark: color.adjust(c.$brand, $lightness: -15%);
$map: (a: c.$brand, b: $brand-dark, nested: (x: #112233, y: #445566));
@function double($n) { @return $n * c.$mult; }
@function pick($k...) { @return map.get($map, $k...); }
@mixin panel($c: c.$brand) { --panel: #{$c}; --panel-d: #{double(10px)}; }`,
    "ds/colors/_index.scss": `@forward "base" as col-* show $col-brand-dark, $col-map, col-double, col-pick, col-panel;`,
    "ds/_index.scss": `@forward "config";
@forward "colors";`,
    "main.scss": `@use "ds" as * with ($mult: 3, $brand: #e11d48);
@use "ds/config" as cfg;
@use "sass:map";
.x {
  @include col-panel(#ff00ff);
  --a: #{map.get($col-map, a)};
  --n: #{map.get($col-map, nested, y)};
  --d: #{col-double(5px)};
  --p: #{col-pick(nested, x)};
  --m: #{cfg.$mult};
  --mm: #{$mult};
}`,
};

test("a function or a mixin of a module runs in that module, with the configuration it was loaded with, through a forward and a prefix", () => {
    const got = made(FUNCTIONS, "main.scss");

    assert.equal(got["--panel"], "#ff00ff");
    assert.equal(got["--panel-d"], "30px", "double(10px) with the configured $mult: 3");
    assert.equal(got["--a"], "#e11d48", "the configured brand");
    assert.equal(got["--n"], "#445566", "map.get with two keys");
    assert.equal(got["--d"], "15px");
    assert.equal(got["--p"], "#112233", "a function with rest arguments (`$k...`)");
    assert.equal(got["--m"], "3", "a plain `@use` after a configured one is the same module");
    assert.equal(got["--mm"], "3");
});

test("a module that is not in the project is read as it was written, and a file never throws on a cycle", () => {
    const got = made(
        {
            "main.scss": `@use "bootstrap/scss/variables" as bs;
@use "self" as me;
:root { --a: #{bs.$primary}; --b: #{mix(#fff, #000, 50%)}; @each $i in 1 { --c-#{$i}: 1px; } }`,
            "_self.scss": `@use "main";\n$x: 1;`,
        },
        "main.scss",
    );

    assert.equal(got["--b"] !== undefined, true);
    assert.equal(got["--c-1"], "1px");
    assert.doesNotThrow(() =>
        expandSassFiles([
            { rel: "a.scss", text: `@use "b" as b; $x: b.$y; @each $i in 1 { --a: #{$x}; }` },
            { rel: "b.scss", text: `@use "a" as a; $y: a.$x; @each $i in 1 { --b: #{$y}; }` },
        ]),
    );
});

// A generated palette: hues and stops in maps, a loop that makes every shade, a function that picks one, all forwarded
// through an index and used by a mixin in another module and by the entry. The values are Dart Sass's.
const GENERATED: Record<string, string> = {
    "scss/tokens/_colors.scss": `@use "sass:map";
@use "sass:color";
$hues: (blue: 217, green: 142, red: 0, amber: 38, slate: 215);
$sats: (blue: 91%, green: 71%, red: 84%, amber: 92%, slate: 16%);
$stops: (50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950);
@function lightness($stop) { @return 98% - ($stop / 1000) * 90%; }
$palette: ();
@each $name, $hue in $hues {
  $shades: ();
  @each $stop in $stops {
    $shades: map.merge($shades, ($stop: hsl($hue, map.get($sats, $name), lightness($stop))));
  }
  $palette: map.merge($palette, ($name: $shades));
}
@function shade($name, $stop: 500) { @return map.get($palette, $name, $stop); }
$primary: shade(blue, 600);
$on-primary: color.scale($primary, $lightness: 90%);`,
    "scss/tokens/_spacing.scss": `$base: 4px !default;
$scale: ();
@for $i from 1 through 6 { $scale: map-merge($scale, ($i: $base * $i)); }
$radii: (sm: 2px, md: 6px, lg: 12px);`,
    "scss/tokens/_index.scss": `@forward "colors";
@forward "spacing" as space-* hide space-base;`,
    "scss/core/_theme.scss": `@use "../tokens" as t;
@mixin emit-palette {
  @each $name, $shades in t.$palette {
    @each $stop, $value in $shades { --color-#{$name}-#{$stop}: #{$value}; }
  }
}
@mixin emit-scale($map, $prefix) { @each $k, $v in $map { --#{$prefix}-#{$k}: #{$v}; } }`,
    "scss/app.scss": `@use "tokens" as *;
@use "core/theme";
:root {
  @include theme.emit-palette;
  @include theme.emit-scale($space-scale, "space");
  @include theme.emit-scale($space-radii, "radius");
  --bg: #{shade(slate, 50)};
  --surface: #ffffff;
  --text: #{shade(slate, 900)};
  --muted: #{shade(slate, 500)};
  --border: #{shade(slate, 200)};
  --accent: #{$primary};
  --on-accent: #{$on-primary};
  --danger: #{shade(red, 600)};
  --success: #{shade(green, 600)};
  --warning: #{shade(amber, 500)};
}`,
};

test("a generated palette behind namespaces and forwards is found whole: every shade, the roles, the scales", () => {
    const scan = scanTokens(project(GENERATED));
    const { roles } = scan.inferred;

    assert.equal(Object.keys(roles).length, 9, "all nine roles");
    assert.ok(near(roles.background?.value, "#ebeef1"), "role");
    assert.ok(near(roles.text?.value, "#242a32"), "role");
    assert.ok(near(roles.muted?.value, "#74849a"), "role");
    assert.ok(near(roles.border?.value, "#c4cbd4"), "role");
    assert.ok(near(roles.accent?.value, "#0a58d6"), "role");
    assert.ok(near(roles.danger?.value, "#ce1212"), "role");
    assert.ok(near(roles.success?.value, "#21c05b"), "role");
    assert.ok(near(roles.warning?.value, "#f5a519"), "role");

    for (const hue of ["blue", "green", "red", "amber", "slate"]) {
        assert.equal(scan.inferred.palette[hue], 11, `${hue}: 11 shades`);
    }

    assert.deepEqual(scan.inferred.radii, ["sm 2px", "md 6px", "lg 12px"]);
    assert.equal(scan.inferred.spacing?.base, 4);
});

test("a scale that a loop makes twice (a map `brand-ramp` and the `--brand-*` properties) is one palette", () => {
    const scan = scanTokens(
        project({
            "_palette.scss": `$steps: (100: 90%, 500: 50%, 900: 15%);
$brand-ramp: ();
@each $step, $light in $steps { $brand-ramp: map-merge($brand-ramp, ($step: hsl(160, 80%, $light))); }`,
            "main.scss": `@use "palette" as p;
:root { @each $k, $v in p.$brand-ramp { --brand-#{$k}: #{$v}; } }`,
        }),
    );

    assert.equal(scan.inferred.palette.brand, 3);
    assert.equal(scan.inferred.palette["brand-ramp"], undefined);
});

test("hostile modules run in bounded time and never throw: cycles, long chains, thousands of forwards, and a deep configuration", () => {
    const started = Date.now();
    const chain = Array.from({ length: 60 }, (_, at) => ({
        rel: `m${at}.scss`,
        text: `@use "m${at + 1}" as n with ($a: ${at}); @forward "m${at + 1}"; $v${at}: ${at}; :root { --x: #{n.$a}; @each $i in 1 { --c-#{$i}: #{$v${at}}; } }`,
    }));
    const forwards = {
        rel: "index.scss",
        text: Array.from({ length: 2000 }, (_, at) => `@forward "p${at}" as p${at}-*;`).join("\n"),
    };
    const partials = Array.from({ length: 300 }, (_, at) => ({
        rel: `p${at}.scss`,
        text: `$x: ${at}px; @use "index" as i; @each $k in 1 { --k: #{i.$x}; }`,
    }));

    for (const files of [
        chain,
        [forwards, ...partials],
        [{ rel: "a.scss", text: `@use "a"; @forward "a"; @each $i in 1 { --a: #{a.$x}; }` }],
        [
            {
                rel: "a.scss",
                text: `@use "b" with (${"$a: 1, ".repeat(5000)}$z: 1); @each $i in 1 { --a: 1; }`,
            },
            { rel: "b.scss", text: "$a: 0 !default;" },
        ],
        [
            {
                rel: "a.scss",
                text: `@use "sass:math" as m with ($a: 1); @use "x" as; @use ; @forward "a" as * hide; @each $i in 1 { --a: #{m.$pi}; }`,
            },
        ],
    ]) {
        assert.doesNotThrow(() => expandSassFiles(files));
    }

    assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
});
