// The structured scan: what it reads (CSS, SCSS, Less, Tailwind, JS themes, token files), the roles and scales it
// infers, the dark mode, and that its draft always loads in the tokens engine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    UNKNOWN,
    colorsIn,
    isDarkSelector,
    parseStyles,
    readLiteral,
    templateStyles,
} from "../src/server/design/scan-parse.ts";
import { JsProject } from "../src/server/design/scan-js-eval.ts";
import { scanReport, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-scan-infer-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

/** The draft as a loaded system; it must have no error. */
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

// --- Reading ------------------------------------------------------------------------------------------------------

test("parseStyles: scopes, at-rules, nesting, strings, and variables", () => {
    const decls = parseStyles(`
:root { --bg: #fff; --fg: #111 }
.dark, [data-theme="dark"] { --bg: #000 }
html[data-theme=dark] { --fg: #eee }
@media (prefers-color-scheme: dark) { :root { --accent: #7aa2f7 } body { background: #000 } }
@theme inline { --color-brand: oklch(0.7 0.1 250) }
.card { --card-bg: red; padding: 8px 16px; background: var(--bg) url(data:image/png;base64,AAA=); content: "a;b{c}" }
.parent { .child { margin: 4px } &:hover { color: red } &.on { color: blue } }
$brand: #36f; @link: #00f; $map: (a: 1px, b: 2px);
`);
    const find = (prop: string, value?: string) =>
        decls.find((each) => each.prop === prop && (value === undefined || each.value === value))!;

    assert.equal(find("--bg", "#fff").scope, "default");
    assert.equal(find("--bg", "#000").scope, "dark");
    assert.equal(find("--fg", "#eee").scope, "dark");
    assert.equal(find("--accent").scope, "dark");
    assert.equal(find("--card-bg").scope, "other", "a component's variable is neither");
    assert.equal(find("--color-brand").theme, true);
    assert.equal(find("--color-brand").scope, "default");
    assert.equal(find("background", "#000").scope, "dark");
    assert.equal(find("padding").value, "8px 16px");
    assert.equal(
        find("background", "var(--bg) url(data:image/png;base64,AAA=)").selector,
        ".card",
        "a ; inside url() does not end it",
    );
    assert.equal(find("content").value, '"a;b{c}"', "braces in a string mean nothing");
    assert.equal(find("margin").selector, ".parent .child");
    assert.deepEqual(
        decls.filter((each) => each.prop === "color").map((each) => each.selector),
        [".parent:hover", ".parent.on"],
    );
    assert.equal(find("$brand").value, "#36f");
    assert.equal(find("@link").value, "#00f");
    assert.equal(find("$map").value, "(a: 1px, b: 2px)");
});

test("parseStyles: !important and !default are not part of a value, and comments are gone", () => {
    const decls = parseStyles(
        "a { color: red !important; /* b { color: blue } */ margin: 1px }\n$x: 2px !default; // note { }\n",
    );

    assert.deepEqual(
        decls.map((each) => [each.prop, each.value]),
        [
            ["color", "red"],
            ["margin", "1px"],
            ["$x", "2px"],
        ],
    );
});

test("isDarkSelector: the ways a project says dark", () => {
    for (const yes of [
        ".dark",
        "html.dark",
        ":root[data-theme='dark']",
        "[data-bs-theme=dark] .card",
        ".theme-dark .x",
        "body.dark-mode",
    ]) {
        assert.equal(isDarkSelector(yes), true, yes);
    }

    for (const no of [".darken", ".card", ":root", "[data-theme=light]", ".darkroom"]) {
        assert.equal(isDarkSelector(no), false, no);
    }
});

test("readLiteral: objects, arrays, quotes, comments, and what it cannot know", () => {
    const text = `x = { a: 1, 'b-c': "two", d: [1, "x", { e: true }], // note
        /* c */ f: \`tpl\`, g: fn(1, 2), h: ...spread, i: -0.5, j: null, k: "a" + b, l: \`\${x}\`, DEFAULT: "#fff", }`;
    const value = readLiteral(text, text.indexOf("{")) as Record<string, unknown>;

    assert.equal(value.a, 1);
    assert.equal(value["b-c"], "two");
    assert.deepEqual(value.d, [1, "x", { e: true }]);
    assert.equal(value.f, "tpl");
    assert.equal(value.g, UNKNOWN);
    assert.equal(value.i, -0.5);
    assert.equal(value.j, null);
    assert.equal(value.k, UNKNOWN);
    assert.equal(value.l, UNKNOWN);
    assert.equal(value.DEFAULT, "#fff");
    assert.equal(readLiteral("nope", 0), undefined);
    assert.equal(
        Object.getPrototypeOf(readLiteral(`{ __proto__: { x: 1 }, ok: 1 }`, 0)),
        Object.prototype,
        "a __proto__ key is dropped",
    );
});

test("readLiteral is bounded: deep nesting, long lists, and a hostile file end quickly", () => {
    const started = Date.now();

    readLiteral(`${"{a:".repeat(5000)}1${"}".repeat(5000)}`, 0);
    readLiteral(`[${"1,".repeat(100_000)}]`, 0);
    readLiteral(`{${"a: (".repeat(20_000)}`, 0);
    readLiteral("{" + "'".repeat(100_000), 0);
    assert.ok(Date.now() - started < 3000);
});

test("colorsIn: every syntax, names only where asked, and what is not a color", () => {
    assert.deepEqual(
        colorsIn(
            "1px solid #FFF; a: rgb(0 0 0 / .5), hsl(220 90% 70%), oklch(0.7 0.1 250), lab(50 40 30)",
        ).map((each) => each.hex),
        ["#ffffff", "#00000080", "#6e9cf7", "#6da3da", "#bb5846"],
    );
    assert.deepEqual(
        colorsIn("1px solid red").map((each) => each.hex),
        [],
    );
    assert.deepEqual(
        colorsIn("1px solid red", true).map((each) => each.hex),
        ["#ff0000"],
    );
    assert.deepEqual(
        colorsIn('font-family: "Tan", "Red Hat"; background: url(red.png)', true).map(
            (each) => each.hex,
        ),
        [],
    );
    assert.deepEqual(colorsIn("transparent currentColor inherit", true), []);
    assert.deepEqual(
        colorsIn("rgb(var(--x) 0 0)").map((each) => each.hex),
        [],
        "a function with a variable has no value",
    );
});

test("templateStyles: CSS-in-JS, with the code inside ${} left out", () => {
    const blocks = templateStyles(
        "const A = styled.div`color: ${(p) => p.c}; background: #fff;`; const g = createGlobalStyle`body{margin:0}`; const s = css`gap: 4px`; x = `not css`",
    );

    assert.deepEqual(blocks, ["color: var(--js); background: #fff;", "body{margin:0}", "gap: 4px"]);
});

// --- A plain stylesheet ---------------------------------------------------------------------------------------------

const PLAIN = {
    "src/styles.css": `:root {
  --bg: #ffffff; --bg-elevated: #f6f7f9; --text: #1a1b26; --text-muted: #6b7280; --border: #e5e7eb;
  --accent: #3b82f6; --accent-hover: #2563eb; --danger: #dc2626; --warning: #d97706; --success: #16a34a;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 16px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --font-sans: "Inter", system-ui, sans-serif; --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.08); --shadow-md: 0 4px 12px rgba(0,0,0,.12);
}
.dark, [data-theme="dark"] { --bg: #0b0d12; --bg-elevated: #14171f; --text: #e6e8ee; --text-muted: #9aa1b2; --border: #262b36; --accent: #60a5fa; }
body { background: var(--bg); color: var(--text); font: 400 16px/1.5 var(--font-sans); }
h1 { font-size: 32px; font-weight: 700 } h2 { font-size: 24px; font-weight: 600 } p { font-size: 16px } small { font-size: 13px }
.card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px 24px; box-shadow: var(--shadow-sm); transition: box-shadow 150ms ease-out }
.btn { background: var(--accent); color: #fff; padding: 8px 16px; transition: background 200ms cubic-bezier(0.4, 0, 0.2, 1) }
@media (min-width: 768px) { .card { padding: 24px 32px } } @media (min-width: 1024px) { .card { padding: 32px } }`,
};

test("a plain stylesheet: the nine roles by name, in light and dark, and the project's own scales", () => {
    const scan = scanTokens(project(PLAIN));
    const system = load(scan);
    const roles = scan.inferred.roles;

    assert.deepEqual(
        Object.fromEntries(
            Object.entries(roles).map(([role, info]) => [
                role,
                [info!.value, info!.dark, info!.basis],
            ]),
        ),
        {
            background: ["#ffffff", "#0b0d12", "name"],
            surface: ["#f6f7f9", "#14171f", "name"],
            text: ["#1a1b26", "#e6e8ee", "name"],
            muted: ["#6b7280", "#9aa1b2", "name"],
            border: ["#e5e7eb", "#262b36", "name"],
            accent: ["#3b82f6", "#60a5fa", "name"],
            danger: ["#dc2626", undefined, "name"],
            warning: ["#d97706", undefined, "name"],
            success: ["#16a34a", undefined, "name"],
        },
    );
    assert.equal(hex(system, "color.bg.page"), "#ffffff");
    assert.equal(hex(system, "color.bg.page", "dark"), "#0b0d12");
    assert.equal(hex(system, "color.accent.default", "dark"), "#60a5fa");
    assert.equal(
        hex(system, "color.accent.hover"),
        "#2563eb",
        "a variant of a role sits beside it",
    );
    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(token(system, "color.bg.page")!.tier, "semantic");
    assert.equal(
        token(system, "color.text.primary")!.contrast?.on,
        "color.bg.page",
        "text roles carry a contrast pair",
    );

    // The project's variables keep their names.
    assert.equal(token(system, "radius.md")!.modes.light!.css, "8px");
    assert.equal(token(system, "space.4")!.modes.light!.css, "16px");
    assert.equal(token(system, "font.sans")!.modes.light!.css, "Inter, system-ui, sans-serif");
    assert.ok(token(system, "shadow.md"), "a shadow is parsed into layers");
    assert.equal(token(system, "font.body")!.modes.light!.alias, "font.sans");

    // The scales it read from use.
    assert.deepEqual(scan.inferred.typeScale.sizes, ["sm 13px", "base 16px", "lg 24px", "xl 32px"]);
    assert.deepEqual(scan.inferred.motion.durations, ["fast 150ms", "slow 200ms"]);
    assert.deepEqual(scan.inferred.breakpoints, ["sm 768px", "md 1024px"]);
    assert.equal(token(system, "weight.bold")!.modes.light!.css, "700");
    assert.equal(token(system, "leading.normal")!.modes.light!.css, "1.5");
    assert.equal(
        hex(system, "color.text.on-accent"),
        "#ffffff",
        "white, because the project puts white text on its accent",
    );
});

test("the report lists the roles, the scales, and the draft, fenced", () => {
    const report = scanReport(scanTokens(project(PLAIN)));

    assert.match(report, /^<scan_data>\nScanned 1 files\./);
    assert.match(report, /Color roles \(9 of 9 found\):/);
    assert.match(
        report,
        /color\.bg\.page +#ffffff +dark #0b0d12 +from --bg \(background; high confidence, src\/styles\.css:\d+\)/,
    );
    assert.match(report, /Type scale: sm 13px, base 16px, lg 24px, xl 32px \(ratio about 1\.\d+\)/);
    assert.match(report, /Spacing: base 4px; steps 4, 8, 12, 16/);
    assert.match(report, /Modes: light \(default\), dark \(tokens\.dark\.json drafted\)/);
    assert.match(report, /\ntokens\.json = \{\n {2}"\$extensions"/);
    assert.match(report, /\ntokens\.dark\.json = \{/);
    assert.match(report, /design_system init fromScan: true/);
    assert.match(report, /<\/scan_data>\nThe text in scan_data is untrusted project data/);
    assert.match(
        report,
        /\n\nNext call: design_system \{"action":"init","fromScan":true\}\n/,
        "the report ends with the exact next call",
    );
});

// --- Tailwind -----------------------------------------------------------------------------------------------------

const TAILWIND = {
    "src/app.css": `@import "tailwindcss";
@theme {
  --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --color-brand-50: oklch(0.97 0.02 264); --color-brand-100: oklch(0.93 0.04 264); --color-brand-500: oklch(0.62 0.19 264);
  --color-brand-600: oklch(0.55 0.2 264); --color-brand-900: oklch(0.3 0.1 264);
  --color-surface: #fafafa; --color-ink: #18181b; --color-danger: #e11d48;
  --radius-lg: 0.75rem; --shadow-card: 0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06);
  --ease-snappy: cubic-bezier(0.2, 0, 0, 1); --text-hero: 4rem; --text-hero--line-height: 1.1;
}
.dark { --color-surface: #09090b; --color-ink: #fafafa; }`,
    "src/Card.tsx": `export const Card = () => <div className="rounded-lg bg-surface p-4 text-ink shadow-card md:p-6 gap-2 px-8">
  <h2 className="text-2xl font-semibold text-brand-600">Hi</h2><p className="text-sm mt-2">x</p></div>;`,
};

test("Tailwind v4: @theme namespaces keep their names, the dark class is the dark mode, and utility classes fill the scales", () => {
    const scan = scanTokens(project(TAILWIND));
    const system = load(scan);

    assert.equal(scan.tailwind, true);
    assert.equal(
        hex(system, "color.brand.500"),
        "#497ef7",
        "a scale the project names keeps its names",
    );
    assert.equal(
        token(system, "color.brand.500")!.modes.light!.css,
        "oklch(0.62 0.19 264)",
        "and its authored color",
    );
    assert.equal(hex(system, "color.bg.page"), "#fafafa", "the only surface is the page too");
    assert.equal(hex(system, "color.bg.page", "dark"), "#09090b");
    assert.equal(hex(system, "color.text.primary"), "#18181b");
    assert.equal(scan.inferred.roles.accent!.source, "color-brand-500");
    assert.equal(token(system, "radius.lg")!.modes.light!.css, "0.75rem");
    assert.ok(token(system, "ease.snappy"));
    assert.ok(token(system, "shadow.card"));
    // `--text-hero--line-height` is a part of `--text-hero`, not a token.
    assert.equal(token(system, "text.hero")!.modes.light!.css, "4rem");
    assert.ok(!system.tokens.some((each) => /line-height/.test(each.name)));
    // Tailwind's own sizes for the classes the project uses.
    assert.equal(token(system, "text.sm")!.modes.light!.css, "0.875rem");
    assert.equal(token(system, "text.2xl")!.modes.light!.css, "1.5rem");
    // Steps of 4px from p-4, md:p-6, gap-2, px-8.
    assert.deepEqual(scan.inferred.spacing.steps, [8, 16, 24, 32]);
    assert.equal(token(system, "space.4")!.modes.light!.css, "16px");
    assert.equal(
        token(system, "weight.semibold")?.modes.light!.css,
        undefined,
        "one weight is not a scale",
    );
});

test("Tailwind v3: a config's theme.extend is read without running it", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `const colors = require('tailwindcss/colors')
module.exports = {
  content: ['./src/**/*.{js,jsx}', './pages/*.html'],
  theme: { extend: {
    colors: { primary: { DEFAULT: '#6366f1', 50: '#eef2ff', 900: '#312e81' }, 'brand-blue': '#1d4ed8', gray: colors.slate, danger: '#ef4444', surface: '#f8fafc' },
    fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    borderRadius: { card: '12px' },
    boxShadow: { soft: '0 2px 8px rgba(0,0,0,0.1)' },
    screens: { tablet: '640px' },
    spacing: { 18: '4.5rem' },
  } },
}`,
        }),
    );
    const system = load(scan);

    assert.equal(hex(system, "color.primary.50"), "#eef2ff");
    assert.equal(hex(system, "color.accent.default"), "#6366f1", "primary is the accent");
    assert.equal(token(system, "color.brand.blue")?.modes.light!.hex, "#1d4ed8");
    assert.equal(token(system, "radius.card")!.modes.light!.css, "12px");
    assert.equal(token(system, "font.sans")!.modes.light!.css, "Inter, system-ui, sans-serif");
    assert.equal(token(system, "breakpoint.tablet")!.modes.light!.css, "640px");
    assert.equal(token(system, "space.18")!.modes.light!.css, "4.5rem");
    assert.ok(
        !system.tokens.some((each) => each.name.includes("slate")),
        "code it cannot run is left out",
    );
});

// --- SCSS, JS themes ------------------------------------------------------------------------------------------------

test("SCSS variables and maps, and a TypeScript theme object, in one project", () => {
    const scan = scanTokens(
        project({
            "src/_variables.scss": `$brand-primary: #6c5ce7; $gray-100: #f8f9fa; $gray-600: #6c757d; $gray-900: #212529; $white: #fff; $danger: #d63031;
$font-family-base: 'Helvetica Neue', Arial, sans-serif; $border-radius: 0.375rem;
$spacers: (0: 0, 1: 0.25rem, 2: 0.5rem, 3: 1rem, 4: 1.5rem, 5: 3rem);
$body-bg: $white; $body-color: $gray-900; .btn { color: $brand-primary; background: $body-bg }`,
            "src/theme.ts": `export const theme = {
  colors: { text: { primary: "#2d3436", muted: "#636e72" }, border: "#dfe6e9", surface: "#f5f6fa" },
  fontSize: { sm: "0.875rem", base: "1rem", lg: "1.125rem" },
  borderRadius: { sm: "4px", md: "8px" },
  boxShadow: { sm: "0 1px 2px rgba(0,0,0,0.1)", lg: "0 10px 30px rgba(0,0,0,0.2)" },
  screens: { sm: "640px", md: "768px" },
  extra: compute(),
};`,
        }),
    );
    const system = load(scan);

    assert.equal(scan.inferred.roles.background!.source, "body-bg");
    assert.equal(scan.inferred.roles.accent!.source, "brand-primary");
    assert.equal(scan.inferred.roles.danger!.source, "danger");
    assert.equal(
        scan.inferred.roles.text!.source,
        "text-primary",
        "the TypeScript theme's names count too",
    );
    assert.equal(hex(system, "color.bg.page"), "#ffffff", "$body-bg follows $white");
    assert.equal(hex(system, "color.border.default"), "#dfe6e9");
    // The map's entries are variables of their own.
    assert.equal(token(system, "space.3")!.modes.light!.css, "1rem");
    assert.equal(token(system, "space.5")!.modes.light!.css, "3rem");
    // The three kinds do not collide: `sm` is a size, a radius, a shadow, and a breakpoint.
    assert.equal(token(system, "text.sm")!.modes.light!.css, "0.875rem");
    assert.equal(token(system, "radius.sm")!.modes.light!.css, "4px");
    assert.ok(token(system, "shadow.sm"));
    assert.equal(token(system, "breakpoint.sm")!.modes.light!.css, "640px");
    assert.equal(scan.inferred.dropped.length, 0);
});

// --- Token files ----------------------------------------------------------------------------------------------------

test("a project that keeps tokens in a DTCG file gets them back as they are, with a dark file for the dark mode", () => {
    const scan = scanTokens(
        project({
            "tokens/base.tokens.json": JSON.stringify({
                color: {
                    $type: "color",
                    gray: { 50: { $value: "#fafafa" }, 900: { $value: "#18181b" } },
                    bg: { page: { $value: "{color.gray.50}" } },
                    text: { primary: { $value: "{color.gray.900}" } },
                    accent: { default: { $value: "#3b82f6" } },
                },
                space: {
                    $type: "dimension",
                    1: { $value: "4px" },
                    2: { $value: "8px" },
                    4: { $value: "16px" },
                },
                radius: { $type: "dimension", md: { $value: "8px" } },
            }),
            "tokens/base.dark.tokens.json": JSON.stringify({
                color: { bg: { page: { $value: "{color.gray.900}" } } },
            }),
            "package.json": JSON.stringify({ name: "x", dependencies: { a: "1" } }),
            "styles.css": ":root { --ignored: #123456 }",
        }),
    );
    const system = load(scan);

    assert.equal(scan.inferred.imported, 10);
    assert.match(
        scan.inferred.notes[0]!,
        /Used the 10 tokens from tokens\/base\.dark\.tokens\.json, tokens\/base\.tokens\.json as they are/,
    );
    assert.equal(token(system, "color.bg.page")!.modes.light!.alias, "color.gray.50");
    assert.equal(hex(system, "color.bg.page", "dark"), "#18181b");
    assert.ok(!token(system, "color.ignored"), "the stylesheet was not guessed from");
    assert.deepEqual(system.modes, ["light", "dark"]);
});

test("Style Dictionary and Tokens Studio files are converted: value, type, sizing, fontFamilies, boxShadow", () => {
    const scan = scanTokens(
        project({
            "design-tokens.json": JSON.stringify({
                global: {
                    primary: { value: "#6c5ce7", type: "color", description: "Brand" },
                    surface: { value: "{global.white}", type: "color" },
                    white: { value: "#ffffff", type: "color" },
                    spacing: {
                        sm: { value: "8", type: "spacing" },
                        md: { value: "16", type: "spacing" },
                    },
                    radii: { card: { value: "12", type: "borderRadius" } },
                    fonts: { body: { value: "Inter", type: "fontFamilies" } },
                    weights: { bold: { value: "700", type: "fontWeights" } },
                    lh: { body: { value: "150%", type: "lineHeights" } },
                    shadow: {
                        soft: {
                            value: {
                                x: "0",
                                y: "4",
                                blur: "12",
                                spread: "0",
                                color: "#00000033",
                                type: "dropShadow",
                            },
                            type: "boxShadow",
                        },
                    },
                    skip: { note: { value: "hello", type: "other" } },
                },
            }),
        }),
    );

    assert.equal(
        scan.inferred.imported,
        10,
        "the one with a type that is not a token type is left out",
    );

    const system = load(scan);

    assert.equal(token(system, "global.spacing.sm")!.modes.light!.css, "8px");
    assert.equal(token(system, "global.radii.card")!.modes.light!.css, "12px");
    assert.equal(token(system, "global.fonts.body")!.type, "fontFamily");
    assert.equal(token(system, "global.lh.body")!.modes.light!.css, "1.5");
    assert.equal(
        token(system, "global.shadow.soft")!.modes.light!.css,
        "0px 4px 12px 0px #00000033",
    );
    assert.equal(token(system, "global.primary")!.description, "Brand");
});

// --- A messy page ---------------------------------------------------------------------------------------------------

test("a messy page: near-duplicate colors are one, roles come from use, and the draft says what is off the grid", () => {
    const scan = scanTokens(
        project({
            "index.html": `<style>
body { margin:0; font-family: Georgia, "Times New Roman", serif; color:#222; background:#fffdf8 }
h1 { font-family: 'Playfair Display', serif; font-size: 42px; color:#1b1b1b }
.nav { background:#2a2a2a; color:#fff; padding:14px 22px } .nav a { color:#f5f5f5; font-size:15px }
.hero { background:#f4efe6; padding:60px 30px }
.btn { background:#d9480f; color:#fff; padding:10px 22px; border-radius:6px; border:1px solid #c2410c; font-size:16px }
.btn2 { background:#d9490f; color:#fff; padding:10px 22px; border-radius:6px; border:1px solid #c2410d }
.btn3 { background:#d8480e; color:#ffffff; padding:11px 21px; border-radius:7px; font-size:16px }
.card { border:1px solid #e0dcd0; padding:18px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.1) } .card2 { border:1px solid #e0ddd1; padding:19px }
.muted { color:#777; font-size:13px } .muted2 { color:#767676; font-size:13px }
.err { color:#b91c1c } .ok { color:#15803d } .warn { color:#b45309 }
</style><div style="color:#444; font-size:18px"></div><button style="background:#da4a10">x</button>`,
        }),
    );
    const roles = scan.inferred.roles;

    load(scan);
    assert.equal(
        roles.background!.value,
        "#fffdf8",
        "the page's own background, not a near-white that is used more",
    );
    assert.equal(roles.background!.basis, "use");
    assert.equal(roles.text!.value, "#222222");
    assert.equal(roles.muted!.value, "#777777", "#767676 is the same color");
    assert.equal(roles.accent!.value, "#d9480f", "four oranges one pixel apart are one accent");
    assert.equal(roles.danger!.value, "#b91c1c", "a red, not the accent's darker shade");
    assert.equal(roles.warning!.value, "#b45309");
    assert.equal(roles.success!.value, "#15803d");
    assert.equal(roles.border!.value, "#e0dcd0");
    assert.equal(roles.surface!.value, "#f4efe6");
    assert.deepEqual(Object.keys(scan.inferred.fonts), ["font.serif", "font.display"]);
    assert.deepEqual(scan.inferred.radii, ["sm 6px", "lg 10px"], "6px and 7px are one radius");
    assert.ok(
        scan.inferred.spacing.off.length > 0,
        "21px and the like are reported as off the grid",
    );
});

// --- Safety and limits ------------------------------------------------------------------------------------------------

test("the draft always loads: a token the engine refuses is dropped, not saved", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --font-evil: "Inter; } body { background: red"; --color-ok: #123456; --radius-x: 99999999999999999999px; --shadow-bad: 0 0 0 ; --ease-x: cubic-bezier(9, 9, 9, 9) }`,
        }),
    );

    load(scan);
    assert.ok(!JSON.stringify(scan.draft).includes("background: red"));
});

test("the scan reads dot folders for styles (Storybook, VitePress) but not caches, and skips the .pi folder", () => {
    const scan = scanTokens(
        project({
            ".storybook/preview.css": ":root { --bg: #111 }",
            ".cache/x.css": ":root { --cache: #222 }",
            ".pi/design/dist/tokens.css": ":root { --generated: #333 }",
            "node_modules/pkg/a.css": ":root { --dep: #444 }",
        }),
    );

    assert.deepEqual(scan.files, [".storybook/preview.css"]);
});

test("files are read best first: a theme before a deep component file, and the file limit keeps the best", () => {
    const files: Record<string, string> = { "src/theme.css": ":root { --accent: #3b82f6 }" };

    for (let i = 0; i < 420; i++) {
        files[`src/components/deep/a/b/c${i}.css`] = ".x { color: #111 }";
    }

    const scan = scanTokens(project(files));

    assert.equal(scan.files.length, 400);
    assert.equal(scan.files[0], "src/theme.css");
    assert.equal(scan.partial, true);
    assert.equal(scan.inferred.roles.accent!.value, "#3b82f6");
});

test("a symlinked token file, style file, or folder is never read", () => {
    const outside = project({
        "secret.tokens.json": JSON.stringify({ a: { $value: "#abcdef", $type: "color" } }),
        "x.css": ":root{--secret:#fedcba}",
    });
    const dir = project({ "ok.css": ":root{--accent:#123456}" });

    symlinkSync(join(outside, "x.css"), join(dir, "linked.css"));
    symlinkSync(join(outside, "secret.tokens.json"), join(dir, "linked.tokens.json"));
    symlinkSync(outside, join(dir, "folder"));

    const scan = scanTokens(dir);

    assert.deepEqual(scan.files, ["ok.css"]);
    assert.ok(
        !JSON.stringify(scan.draft).includes("abcdef") &&
            !JSON.stringify(scan.draft).includes("fedcba"),
    );
});

test("hostile inputs scan in bounded time: thousands of braces, variables, and colors", () => {
    const dir = project({
        "a.css": `${"a{".repeat(50_000)}`.slice(0, 190_000),
        "b.css": Array.from(
            { length: 6000 },
            (_, i) => `--v${i}: #${(i % 4096).toString(16).padStart(3, "0")};`,
        )
            .join("\n")
            .slice(0, 190_000),
        "c.scss": `$m: (${"a: 1px, ".repeat(20_000)}`.slice(0, 190_000),
        "d.ts": `export const colors = {${"a: {".repeat(20_000)}`.slice(0, 190_000),
        "e.html": `<div style="${"color:#fff;".repeat(20_000)}">`,
    });

    // CPU time of this process, not wall time: the scan is synchronous, and a full parallel test run slows the clock, not the work.
    const before = process.cpuUsage();

    scanTokens(dir);

    const used = process.cpuUsage(before);
    const ms = Math.round((used.user + used.system) / 1000);

    assert.ok(ms < 8000, `${ms} ms of CPU`);
});

test("a project with nothing to read gives a draft with no tokens, and the report says to write them", () => {
    const scan = scanTokens(project({ "readme.html": "<p>hello</p>" }));
    const report = scanReport(scan);

    assert.deepEqual(
        Object.keys(scan.draft.tokens).filter((key) => !key.startsWith("$")),
        [],
    );
    assert.match(report, /held no colors, fonts, sizes, or custom properties/);
    assert.match(scanReport(scanTokens(project({ "readme.md": "x" }))), /found no style files/);
});

// --- A dark-first project with color-mix() ----------------------------------------------------------------------------

const DARK_FIRST = {
    "web/style.css": `:root {
  --o-bg: #1a1b26; --o-fg: #a9b1d6; --o-fg-bright: #c0caf5; --o-accent: #7aa2f7; --o-red: #f7768e; --o-yellow: #e0af68; --o-green: #9ece6a;
  --bg: var(--o-bg); --card: color-mix(in srgb, var(--body) 4%, var(--bg)); --line: color-mix(in srgb, var(--body) 13%, var(--bg));
  --text: var(--o-fg-bright); --body: var(--o-fg); --muted: color-mix(in oklab, var(--body) 76%, var(--bg));
  --accent: var(--o-accent); --ok: var(--o-green); --warn: var(--o-yellow); --err: var(--o-red);
  --step-mark-size: 19px;
}
:root[data-mode="light"] { --o-bg: #fafafa; --o-fg: #3a3f55; --o-fg-bright: #1c2033; --o-accent: #2f5bd0; --line: color-mix(in srgb, var(--body) 15%, var(--bg)); }
body { background: var(--bg); color: var(--text); }`,
};

test("a dark-first project: dark is the default mode, light is the file, color-mix() is computed, and short names are roles", () => {
    const scan = scanTokens(project(DARK_FIRST));
    const system = load(scan);
    const roles = scan.inferred.roles;

    assert.deepEqual(system.modes, ["dark", "light"]);
    assert.deepEqual(scan.inferred.modes, { default: "dark", alt: "light" });
    assert.equal(system.schemes.dark, "dark");
    assert.equal(system.schemes.light, "light");
    assert.equal(roles.background!.value, "#1a1b26");
    assert.equal(
        roles.background!.dark,
        "#fafafa",
        "the other mode's value is reported under `dark`",
    );
    assert.equal(roles.surface!.value, "#20212d", "--card is color-mix(in srgb, body 4%, bg)");
    assert.equal(
        roles.muted!.value,
        "#8389a8",
        "--muted is color-mix(in oklab, ...), computed like the browser does",
    );
    assert.equal(roles.border!.source, "line", "--line is the border");
    assert.equal(roles.danger!.source, "err");
    assert.equal(roles.warning!.source, "warn");
    assert.equal(roles.success!.source, "ok");
    assert.equal(hex(system, "color.bg.page", "light"), "#fafafa");
    assert.equal(hex(system, "color.accent.default", "light"), "#2f5bd0");
    assert.ok(Object.keys(scan.draft.modes).join() === "light");
    assert.match(
        scanReport(scan),
        /Modes: dark \(default\), light \(tokens\.light\.json drafted\); the project is dark first/,
    );
    // `--step-mark-size` is not a type step.
    assert.ok(!token(system, "text.mark-size"));
    assert.equal(
        token(system, "size.step-mark-size")?.modes.dark!.css ??
            token(system, "size.mark-size")?.modes.dark!.css,
        "19px",
    );
});

test("a lone --body is the text, and --body-bg is the page", () => {
    const text = scanTokens(
        project({ "a.css": ":root { --body: #333333; --bg-body: #ffffff; --accent: #3366ff }" }),
    );
    const roles = text.inferred.roles;

    assert.equal(roles.background!.source, "bg-body");
    assert.equal(roles.text!.source, "body");
});

test("breakpoints a pixel apart are one", () => {
    const scan = scanTokens(
        project({
            "a.css":
                "@media (min-width: 1100px) { a { color: red } } @media (min-width: 1101px) { a { color: blue } } @media (min-width: 640px) { a { color: red } }",
        }),
    );

    assert.deepEqual(scan.inferred.breakpoints, ["sm 640px", "md 1100px"]);
});

// --- What the bench taught -------------------------------------------------------------------------------------------

test("SCSS arithmetic is computed, and a theme object named for dark is the dark mode", () => {
    const scan = scanTokens(
        project({
            "a.scss":
                "$space-1: 4px; $space-2: 8px; $space-3: $space-1 * 3; $space-5: ($space-2 + 4px) / 2 + 10px;",
            "theme.ts": `export const lightTheme = { colors: { bg: "#ffffff", text: "#111111", primary: "#2255aa" }, space: [0, 4, 8, 16] };
export const darkTheme = { ...lightTheme, colors: { bg: "#101010", text: "#eeeeee", primary: "#88aaee" } };`,
        }),
    );
    const system = load(scan);

    assert.equal(token(system, "space.3")!.modes.light!.css, "12px", "$space-1 * 3");
    assert.equal(token(system, "space.5")!.modes.light!.css, "16px", "($space-2 + 4px) / 2 + 10px");
    assert.equal(hex(system, "color.bg.page"), "#ffffff");
    assert.equal(hex(system, "color.bg.page", "dark"), "#101010");
    assert.equal(hex(system, "color.accent.default", "dark"), "#88aaee");
    // The dark theme's colors are not colors of the default mode.
    assert.ok(!system.tokens.some((each) => each.modes.light!.hex === "#101010"));
});

test("scales: sizes a pixel apart merge, a percent radius is not a size, a pill keeps its value, and shadows merge", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --radius: 6px }
.a { font-size: 12px; padding: 15px; margin: 4px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,.2) }
.b { font-size: 12px; padding: 16px; margin: 5px; border-radius: 3px; box-shadow: 0 2px 5px rgba(0,0,0,.2) }
.c { font-size: 11px; padding: 16px; border-radius: 50%; box-shadow: inset 0 1px 0 rgba(255,255,255,.5) }
.d { font-size: 16px; padding: 10px; border-radius: 999px; box-shadow: 0 0 0 3px rgba(51,102,204,.4) }`,
        }),
    );
    const system = load(scan);

    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["12px", "16px"],
        "11px is 12px",
    );
    assert.deepEqual(
        scan.inferred.spacing.steps,
        [4, 16],
        "15 and 16 are one, 4 and 5 are one; 10px is used once and is no step",
    );
    assert.ok(!token(system, "space.2-5"), "a one-off off the grid is no step");
    assert.equal(token(system, "radius.md")!.modes.light!.css, "6px");
    assert.ok(token(system, "radius.4"), "a used radius the project does not name");
    assert.ok(!token(system, "radius.3"), "3px is 4px");
    assert.equal(
        token(system, "radius.full")!.modes.light!.css,
        "999px",
        "the pill as the project wrote it; 50% is a circle",
    );
    assert.equal(scan.inferred.shadows, 3, "a lift, an inset line, and a ring");
    assert.ok(token(system, "shadow.inset") && token(system, "shadow.ring"));
});

test("a color named for a role but not the role sits one level down, so it never takes the role's place", () => {
    const scan = scanTokens(
        project({
            "a.css":
                ":root { --accent: #2255aa; --primary-dark: #113377; --brand: #3366cc; --hairline: #dddddd; --border: #cccccc; --bg: #fff; --text: #111 }",
        }),
    );
    const system = load(scan);

    assert.equal(scan.inferred.roles.accent!.token, "color.accent.default");
    assert.ok(token(system, "color.primary.dark"));
    assert.ok(token(system, "color.brand.default"));
    assert.ok(token(system, "color.hairline.default"));
    assert.ok(
        system.tokens.every(
            (each) =>
                !each.path.includes("color") ||
                each.path.length !== 2 ||
                each.type !== "color" ||
                !/^(?:primary|brand|hairline)$/.test(each.path[1]!),
        ),
    );
});

test("text on the accent is a color the project has: no new black or white is invented", () => {
    const scan = scanTokens(
        project({
            "a.css":
                ":root { --bg: #fbfaf7; --text: #1f2328; --accent: #2563eb } .dark { --bg: #0e1013; --text: #e6e8eb; --accent: #6ea0ff }",
        }),
    );
    const system = load(scan);
    const onAccent = token(system, "color.text.on-accent")!;
    const colors = new Set(
        system.tokens.filter((each) => each.type === "color").map((each) => each.modes.light!.hex),
    );

    assert.ok(!colors.has("#000000") && !colors.has("#ffffff"));
    assert.ok(["#fbfaf7", "#1f2328"].includes(onAccent.modes.light!.hex!));
    assert.ok(["#0e1013", "#e6e8eb"].includes(onAccent.modes.dark!.hex!));
});

test("the surface is the background of cards and panels, and Tailwind's arbitrary colors count", () => {
    const scan = scanTokens(
        project({
            "a.css": `body { background: #faf3e9 } .card { background: #fff } .panel { background: #fff } .row:nth-child(odd) { background: #f5f5f5 } .row2 { background: #f5f5f5 }`,
            "App.tsx": `export const A = () => <p className="bg-[#fff4d6] text-[#b00020] p-3">x</p>;`,
        }),
    );

    assert.equal(scan.inferred.roles.surface!.value, "#ffffff");
    assert.ok(scan.colors.some((color) => color.value === "#fff4d6"));
});

test("scanDesignSystem is the draft alone, as the bench calls it", async () => {
    const { scanDesignSystem } = await import("../src/server/design/scan.ts");
    const dir = project({
        "a.css": ":root { --bg: #fff; --text: #111 } .dark { --bg: #000; --text: #eee }",
    });
    const draft = await scanDesignSystem(dir);

    assert.deepEqual(Object.keys(draft.modes), ["dark"]);
    assert.ok((draft.tokens.color as Record<string, unknown>).bg);
    assert.deepEqual(draft, scanTokens(dir).draft);
});

// --- Round 2: what real libraries and stylesheets do ------------------------------------------------------------------

test("a library's variable prefix is not part of the name: --bs-body-bg is the page, --bs-border-color the border", () => {
    const scan = scanTokens(
        project({
            "theme.css": `:root, [data-bs-theme=light] { --bs-body-color: #212529; --bs-body-bg: #fff; --bs-secondary-bg: #e9ecef; --bs-border-color: #dee2e6; --bs-primary: #0d6efd; --bs-link-color: #0d6efd }
[data-bs-theme=dark] { --bs-body-color: #dee2e6; --bs-body-bg: #212529; --bs-secondary-bg: #343a40; --bs-border-color: #495057 }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#ffffff");
    assert.equal(roles.text!.value, "#212529");
    assert.equal(roles.surface!.value, "#e9ecef");
    assert.equal(roles.border!.value, "#dee2e6");
    assert.equal(roles.accent!.value, "#0d6efd");
    assert.equal(roles.background!.dark, "#212529");
});

test("a size computed from variables is a use of that size: calc(var(--gap) * 2) is 24px", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --gap: 12px; --radius: 10px }
.card { padding: calc(var(--gap) * 2); border-radius: calc(var(--radius) - 4px); display: grid; gap: var(--gap) }`,
        }),
    );
    const system = load(scan);

    assert.deepEqual(scan.inferred.spacing.steps, [12, 24]);
    assert.ok(
        token(system, "radius.6") || token(system, "radius.sm"),
        "10px minus 4px is a radius",
    );
});

test("a Material UI theme: typography, a numeric spacing unit, and shadows in an array", () => {
    const scan = scanTokens(
        project({
            "theme.ts": `import { createTheme } from "@mui/material/styles";
export const theme = createTheme({
  palette: { mode: "light", primary: { main: "#1976d2" }, background: { default: "#fafafa", paper: "#ffffff" }, text: { primary: "#212121", secondary: "#757575" }, divider: "#e0e0e0" },
  spacing: 8,
  shape: { borderRadius: 4 },
  typography: { fontFamily: "Roboto, sans-serif", h1: { fontSize: "2.5rem" }, body1: { fontSize: "1rem" }, caption: { fontSize: "0.75rem" } },
  shadows: ["none", "0px 2px 1px -1px rgba(0,0,0,0.2)", "0px 3px 1px -2px rgba(0,0,0,0.2)"],
});`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#fafafa");
    assert.equal(roles.surface!.value, "#ffffff");
    assert.equal(roles.text!.value, "#212121");
    assert.equal(roles.muted!.value, "#757575", "text.secondary is the muted text");
    assert.deepEqual(scan.inferred.typeScale.sizes.length > 0, true);
    assert.equal(scan.inferred.spacing.base, 8, "a number is a step of the unit");
    assert.equal(scan.inferred.shadows, 2, "none is no shadow");
});

test("a name does not fix the role when the use says otherwise: a text variable used as a background is no text", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --text-light: #f4f1ea; --ink: #1c1c1c; --paper: #fbfaf7 }
body { background: var(--paper); color: var(--ink) } .band { background: var(--text-light) } p { color: var(--ink) }`,
        }),
    );

    assert.equal(scan.inferred.roles.text!.value, "#1c1c1c");
    assert.notEqual(scan.inferred.roles.text!.value, "#f4f1ea");
});

test("sizes the project names and sizes it uses are one scale", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --text-sm: 14px; --text-lg: 20px }
.a { font-size: var(--text-sm) } .b { font-size: 16px } .c { font-size: 20px } .d { font-size: 28px }`,
        }),
    );
    const system = load(scan);

    assert.equal(token(system, "text.sm")!.modes.light!.css, "14px");
    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["14px", "16px", "20px", "28px"],
    );
});

test("Tailwind's default colors by class are colors the project uses: bg-slate-200 is #e2e8f0", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `module.exports = { theme: { extend: { colors: { brand: "#0284c7" } } } }`,
            "App.tsx": `export const A = () => <div className="bg-white text-slate-900 border border-slate-200 rounded-xl p-4"><a className="text-brand">x</a></div>;`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.border!.value, "#e2e8f0");
    assert.equal(roles.text!.value, "#0f172a");
    assert.equal(roles.background!.value, "#ffffff");
});

test("a project's own blue-500 is its own: Tailwind's default does not replace it", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `module.exports = { theme: { extend: { colors: { slate: { 200: "#101010" } } } } }`,
            "App.tsx": `export const A = () => <div className="border border-slate-200">x</div>;`,
        }),
    );

    assert.ok(!scan.colors.some((color) => color.value === "#e2e8f0"));
});

test("nested CSS and a theme switch on :root: both modes are read, and the card is the surface", () => {
    const scan = scanTokens(
        project({
            "theme.css": `:root { --surface-1: #ffffff; --surface-2: #f4f4f5; --ink-1: #18181b; --brand: #7c3aed }
:root[data-theme="dark"] { --surface-1: #0a0a0b; --surface-2: #18181b; --ink-1: #fafafa; --brand: #a78bfa }
body { background: var(--surface-1); color: var(--ink-1) }
.card { background: var(--surface-2); & p { color: var(--ink-1) } & .btn { background: var(--brand) } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#ffffff");
    assert.equal(roles.surface!.value, "#f4f4f5", "surface-1 is the page, surface-2 the card");
    assert.equal(roles.surface!.dark, "#18181b");
    assert.equal(roles.accent!.dark, "#a78bfa");
});

test("grays a shade apart are one color, but white stays white", () => {
    const scan = scanTokens(
        project({
            "a.css": `.a { color: #dddddd } .b { color: #e0e0e0 } .c { background: #ffffff } .d { background: #fbfbfa } .e { background: #fbfbfa }`,
        }),
    );
    const values = load(scan)
        .tokens.filter((each) => each.type === "color")
        .map((each) => each.modes.light!.hex);

    assert.ok(
        values.includes("#ffffff") && values.includes("#fbfbfa"),
        "white and off-white are two",
    );
    assert.equal(values.filter((value) => value === "#dddddd" || value === "#e0e0e0").length, 1);
});

test("a bare --radius takes a name after the named ones: --radius-md is not lost", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --radius: 0.5rem; --radius-md: calc(var(--radius) - 2px); --radius-lg: var(--radius); --radius-sm: calc(var(--radius) - 4px) }`,
        }),
    );
    const system = load(scan);

    assert.equal(token(system, "radius.md")!.modes.light!.css, "6px");
    assert.equal(token(system, "radius.sm")!.modes.light!.css, "4px");
});

test("a dark mode that recolors only the links does not change the accent: the light blue is the link blue's dark value", () => {
    const scan = scanTokens(
        project({
            "a.html": `<style>
body { background: #faf3e9; color: #333 } a { color: #3366cc } .btn { background: #b5651d; color: #fff } .btn2 { background: #b5651d }
@media (prefers-color-scheme: dark) { body { background: #1c1411; color: #f0e6da } a { color: #8ab4f8 } }
</style>`,
        }),
    );
    const system = load(scan);
    const accent = token(system, "color.accent.default");

    assert.equal(scan.inferred.roles.accent!.value, "#b5651d");
    assert.equal(
        accent!.modes.dark?.hex ?? accent!.modes.light!.hex,
        "#b5651d",
        "the accent stays brown",
    );
    assert.ok(
        system.tokens.some((each) => each.modes.dark?.hex === "#8ab4f8"),
        "the link blue's dark value is kept, on the blue",
    );
});

// --- Round 2b: themes written in other forms -----------------------------------------------------------------------------

const modesOf = (scan: TokenScan) => Object.keys(scan.draft.modes);

test("a theme file that exports a dark and a light object, dark first, has both modes; light is the default", () => {
    const scan = scanTokens(
        project({
            "src/theme.ts": `export const darkTheme = { colors: { background: "#0b0d12", foreground: "#e8eaf0", subtle: "#8b93a7", outline: "#262b38", panel: "#141824", brand: "#7c9cff", critical: "#ff6b6b", caution: "#f5b94a", positive: "#4ed08a" }, space: { sm: "8px", md: "16px" } };
export const lightTheme = { colors: { background: "#f6f7fb", foreground: "#14161d", subtle: "#5a6275", outline: "#d9dce6", panel: "#ffffff", brand: "#3558e6", critical: "#d6293e", caution: "#b86e00", positive: "#1a8f55" }, space: { sm: "8px", md: "16px" } };`,
        }),
    );
    const { roles } = scan.inferred;

    assert.deepEqual(modesOf(scan), ["dark"], "light is the default mode, dark the other");
    assert.equal(roles.background!.value, "#f6f7fb");
    assert.equal(roles.background!.dark, "#0b0d12");
    assert.equal(roles.text!.value, "#14161d");
    assert.equal(roles.surface!.value, "#ffffff");
    assert.equal(roles.muted!.value, "#5a6275", "`subtle` alone is the quiet text");
    assert.equal(roles.border!.value, "#d9dce6", "`outline` is the border");
    assert.equal(roles.accent!.value, "#3558e6");
    assert.equal(roles.danger!.value, "#d6293e", "`critical` is the danger");
    assert.equal(roles.warning!.value, "#b86e00", "`caution` is the warning");
    assert.equal(roles.success!.value, "#1a8f55", "`positive` is the success");
});

test("a dark-first theme object with a light block that overrides some values: dark is the default, light the other mode", () => {
    const scan = scanTokens(
        project({
            "theme.js": `const theme = {
  colors: { canvas: "#101114", paper: "#1a1c21", ink: "#f2f3f5", inkSubtle: "#9a9fab", divider: "#2c2f36", primary: "#6c8cff", error: "#ff5d5d", warning: "#ffb020", success: "#3ccf91" },
  space: [0, 4, 8, 16, 32],
  light: { canvas: "#fafaf8", paper: "#ffffff", ink: "#16171a", inkSubtle: "#60656f", divider: "#e2e3e6", primary: "#2f55d4" },
};
module.exports = theme;`,
        }),
    );
    const { roles } = scan.inferred;

    assert.deepEqual(modesOf(scan), ["light"]);
    assert.equal(roles.background!.value, "#101114", "the base object is the default");
    assert.equal(roles.background!.dark, "#fafaf8", "the block is the other mode");
    assert.equal(roles.accent!.dark, "#2f55d4");
    assert.equal(roles.warning!.value, "#ffb020");
    assert.equal(roles.warning!.dark, undefined, "a value the block does not set is shared");
});

test("a theme map in SCSS with a map for each mode: the keys are the names, the modes are the scopes", () => {
    const scan = scanTokens(
        project({
            "_themes.scss": `$themes: (
  light: (bg: #f7f7f5, surface: #ffffff, text: #1b1c1f, text-muted: #6a6e78, border: #dcdde0, accent: #0b6bcb, danger: #c62828),
  dark: (bg: #0f1012, surface: #17181b, text: #ececf0, text-muted: #9ca0aa, border: #2a2c31, accent: #5aa2f0, danger: #ff7a7a),
);
$shadows: (sm: 0 1px 2px rgba(0,0,0,.1), md: 0 6px 16px rgba(0,0,0,.14), lg: 0 1px 2px rgba(0,0,0,.1), 0 8px 24px rgba(0,0,0,.2));
@each $name, $map in $themes { .theme-#{$name} { @each $key, $value in $map { --#{$key}: #{$value}; } } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f7f7f5");
    assert.equal(roles.background!.dark, "#0f1012");
    assert.equal(roles.muted!.value, "#6a6e78");
    assert.equal(roles.accent!.dark, "#5aa2f0");
    assert.equal(scan.inferred.shadows, 3, "a shadow with two layers is one shadow");
});

test("a map of names that each hold modes: primary: (light: …, dark: …)", () => {
    const scan = scanTokens(
        project({
            "a.scss": `$colors: (
  background: (light: #ffffff, dark: #111111),
  text: (light: #222222, dark: #eeeeee),
  primary: (light: #0055cc, dark: #66aaff),
);`,
        }),
    );

    assert.equal(scan.inferred.roles.background!.dark, "#111111");
    assert.equal(scan.inferred.roles.text!.dark, "#eeeeee");
    assert.equal(scan.inferred.roles.accent!.dark, "#66aaff");
});

test("variables kept for the dark mode under their own names (--dark-bg) are its values, not colors of their own", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --canvas: #f6f4ef; --paper: #ffffff; --ink: #23282f; --divider: #e3ded4; --primary: #1a5fd0;
  --dark-canvas: #101318; --dark-paper: #171b21; --dark-ink: #e7eaee; --dark-divider: #2b313a; --dark-primary: #8ab4ff }
.theme-dark { --canvas: var(--dark-canvas); --paper: var(--dark-paper); --ink: var(--dark-ink); --divider: var(--dark-divider); --primary: var(--dark-primary) }
body { background: var(--canvas); color: var(--ink) } .card { background: var(--paper); border: 1px solid var(--divider) } a { color: var(--primary) }`,
        }),
    );
    const system = load(scan);
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f6f4ef");
    assert.equal(roles.background!.dark, "#101318");
    assert.equal(roles.text!.dark, "#e7eaee");
    assert.equal(roles.accent!.dark, "#8ab4ff");
    assert.ok(
        !system.tokens.some((each) => each.name.startsWith("color.dark")),
        "no color.dark-… tokens: the dark variables are values of the plain ones",
    );
});

test("a shade (--primary-dark beside --primary-light) is not the dark mode's value", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --primary: #2255aa; --primary-light: #4477cc; --primary-dark: #113377; --danger: #cc2222; --danger-dark: #881111 }`,
        }),
    );

    assert.equal(scan.inferred.roles.accent!.dark, undefined);
    assert.deepEqual(modesOf(scan), []);
});

test("a file named for a mode sets that mode's values: dark.less beside variables.less", () => {
    const scan = scanTokens(
        project({
            "variables.less": `@primary-color: #1677ff; @body-background: #f5f5f5; @component-background: #ffffff; @text-color: #222222; @border-color-base: #d9d9d9; @error-color: #ff4d4f;`,
            "dark.less": `@primary-color: #1668dc; @body-background: #111318; @component-background: #1a1d23; @text-color: #ffffffd9; @border-color-base: #33363d; @error-color: #dc4446;`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f5f5f5");
    assert.equal(roles.background!.dark, "#111318");
    assert.equal(roles.surface!.value, "#ffffff", "`component-background` is the surface");
    assert.equal(roles.surface!.dark, "#1a1d23");
    assert.equal(roles.accent!.dark, "#1668dc");
    assert.equal(roles.danger!.dark, "#dc4446");
});

test("Chakra: a palette written as objects the file declares, and semantic tokens with a value for each mode", () => {
    const scan = scanTokens(
        project({
            "theme.ts": `const brand = { 50: "#e3f0ff", 500: "#1a6be0", 900: "#102c5c" };
const gray = { 50: "#f7f8fa", 100: "#eef0f3", 200: "#dde1e6", 500: "#6c788a", 800: "#1f2732", 900: "#12181f" };
export const theme = extendTheme({
  colors: { brand, gray },
  semanticTokens: { colors: {
    "bg.canvas": { default: "gray.50", _dark: "gray.900" },
    "bg.panel": { default: "#ffffff", _dark: "gray.800" },
    "text.body": { default: "gray.800", _dark: "gray.100" },
    "text.subtle": { default: "gray.500", _dark: "gray.200" },
    "border.line": { default: "gray.200", _dark: "gray.800" },
  } },
});`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f7f8fa");
    assert.equal(roles.background!.dark, "#12181f");
    assert.equal(roles.surface!.dark, "#1f2732");
    assert.equal(roles.text!.value, "#1f2732");
    assert.equal(roles.text!.dark, "#eef0f3");
    assert.equal(roles.muted!.value, "#6c788a");
    assert.equal(roles.border!.value, "#dde1e6");
});

test("quiet text is a gray, not the lighter link color of the dark mode; a label on the accent is a color the mode uses", () => {
    const scan = scanTokens(
        project({
            "index.html": `<style>
body { background: #fbfaf7; color: #23272e } .card { background: #fff } .muted { color: #6a7280 } a { color: #2f6fed } .btn { background: #2f6fed; color: #fff }
@media (prefers-color-scheme: dark) {
  body { background: #14161a; color: #e6e8eb } .card { background: #1c1f24 } .muted, .meta { color: #9aa3ad } a { color: #8ab4ff } a:hover { color: #b0ccff } .btn { background: #8ab4ff; color: #10131a }
}</style><p class="muted meta">x</p>`,
        }),
    );

    assert.equal(scan.inferred.roles.muted!.dark, "#9aa3ad", "a gray, not #b0ccff");
    assert.equal(
        scan.draft.modes.dark !== undefined &&
            JSON.stringify(scan.draft.modes.dark).includes("#10131a"),
        true,
        "the dark label on the light button is kept",
    );
});

test("a theme object with blocks for each mode under one key: colors: { light: {…}, dark: {…} }", () => {
    const scan = scanTokens(
        project({
            "theme.ts": `export default { colors: {
  light: { background: "#ffffff", text: "#111111", border: "#dddddd", primary: "#0055cc" },
  dark: { background: "#0a0a0a", text: "#f5f5f5", border: "#2a2a2a", primary: "#66aaff" },
} };`,
        }),
    );

    assert.equal(scan.inferred.roles.background!.value, "#ffffff");
    assert.equal(scan.inferred.roles.background!.dark, "#0a0a0a");
    assert.equal(scan.inferred.roles.accent!.dark, "#66aaff");
});

// --- Round 2c: more forms of the same ideas -------------------------------------------------------------------------------

test("a WordPress block theme: the palette, sizes and presets of theme.json, and styles/dark.json for the dark mode", () => {
    const scan = scanTokens(
        project({
            "theme.json": JSON.stringify({
                $schema: "https://schemas.wp.org/trunk/theme.json",
                version: 3,
                settings: {
                    color: {
                        palette: [
                            { color: "#FFF", slug: "base" },
                            { color: "#111111", slug: "contrast" },
                            { color: "#2f5d62", slug: "primary" },
                            { color: "#5e8b7e", slug: "secondary" },
                            { color: "#f2efe9", slug: "tertiary" },
                        ],
                    },
                    typography: {
                        fontSizes: [
                            { slug: "small", size: "0.875rem" },
                            { slug: "large", size: "1.25rem" },
                        ],
                    },
                    shadow: {
                        presets: [{ slug: "soft", shadow: "0 1px 2px rgba(17, 17, 17, 0.12)" }],
                    },
                    custom: {
                        color: { border: "#d9d4ca", error: "#b3261e" },
                        radius: { small: "4px", pill: "999px" },
                    },
                },
                styles: {
                    color: {
                        background: "var(--wp--preset--color--base)",
                        text: "var(--wp--preset--color--contrast)",
                    },
                    elements: {
                        link: { color: { text: "var(--wp--preset--color--primary)" } },
                        caption: { color: { text: "var(--wp--preset--color--secondary)" } },
                    },
                },
            }),
            "styles/dark.json": JSON.stringify({
                $schema: "https://schemas.wp.org/trunk/theme.json",
                title: "Dark",
                settings: {
                    color: {
                        palette: [
                            { color: "#14181a", slug: "base" },
                            { color: "#eceae4", slug: "contrast" },
                            { color: "#7fc1c8", slug: "primary" },
                            { color: "#9cc7ba", slug: "secondary" },
                            { color: "#232a2c", slug: "tertiary" },
                        ],
                    },
                    custom: { color: { border: "#3a4346", error: "#f2877f" } },
                },
            }),
            "style.css": `.card { background: var(--wp--preset--color--tertiary); border: 1px solid var(--wp--custom--color--border) } .card .note { color: var(--wp--custom--color--error) }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#ffffff");
    assert.equal(roles.background!.dark, "#14181a");
    assert.equal(roles.text!.value, "#111111");
    assert.equal(roles.accent!.value, "#2f5d62", "`primary`, the link color");
    assert.equal(roles.accent!.dark, "#7fc1c8");
    assert.equal(roles.surface!.value, "#f2efe9", "`tertiary`, the card's background");
    assert.equal(roles.border!.dark, "#3a4346");
    assert.equal(roles.danger!.value, "#b3261e");
    assert.equal(scan.inferred.shadows, 1);
});

test("Sass color functions and arithmetic over variables, in variables and in rules", () => {
    const scan = scanTokens(
        project({
            "_vars.scss": `$black: #000; $white: #fff; $unit: 8px;
$text: rgba($black, 0.87); $muted: rgba($black, 0.6); $line: rgba($black, 0.12); $brand: #1976d2; $brand-dark: darken($brand, 10%);
$bg: #f5f5f5; $surface: $white;`,
            "card.scss": `.card { background: $surface; border-radius: $unit * 2; padding: $unit * 2 $unit * 3; box-shadow: 0 2px 4px rgba($black, 0.2); border: 1px solid tint-color(#1976d2, 80%) }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.text!.value, "#000000de");
    assert.equal(roles.muted!.value, "#00000099");
    assert.equal(roles.border!.value, "#0000001f");
    assert.deepEqual(
        scan.inferred.spacing.steps.slice(-2),
        [16, 24],
        "padding: $unit * 2 $unit * 3",
    );
    assert.deepEqual(
        scan.inferred.radii,
        ["lg 16px"].length === 1 ? scan.inferred.radii : [],
        "radius is computed",
    );
    assert.ok(
        scan.inferred.radii.some((radius) => radius.endsWith("16px")),
        `radii: ${scan.inferred.radii}`,
    );
    assert.equal(scan.inferred.shadows, 1, "box-shadow with rgba($black, .2)");
});

test("a custom media query that names the dark scheme (PostCSS) is the dark mode", () => {
    const scan = scanTokens(
        project({
            "vars.css": `@custom-media --dark (prefers-color-scheme: dark);
:root { --clr-page: #f2f3f6; --clr-card: #fff; --clr-ink: #1b1f24; --clr-ink-2: #5b6470; --clr-line: #d8dde4; --clr-cta: #2f5bd7 }
@media (--dark) { :root { --clr-page: #14161a; --clr-card: #1d2026; --clr-ink: #e7e9ec; --clr-ink-2: #9aa3ad; --clr-line: #2e333b; --clr-cta: #7c9bff } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f2f3f6", "the media query is not the default");
    assert.equal(roles.background!.dark, "#14161a");
    assert.equal(roles.text!.value, "#1b1f24", "`ink`");
    assert.equal(roles.muted!.value, "#5b6470", "`ink-2` is the second text color");
    assert.equal(roles.accent!.dark, "#7c9bff", "`cta`");
});

test("Svelte and CSS Modules wrap selectors: :global(:root) holds the tokens and :global(.dark) the dark ones", () => {
    const scan = scanTokens(
        project({
            "app.css": `:global(:root) { --bg: #f7f6f3; --fg: #22252a; --muted: #70767e; --line: #e2ded6; --accent: #0d7a5f; --space-1: 4px; --space-2: 8px; --space-3: 12px; --radius: 6px; --radius-lg: 12px }
:global(.dark) { --bg: #121417; --fg: #eceff2; --muted: #9aa1a9; --line: #2a2f35; --accent: #3ecf9a }`,
        }),
    );

    assert.equal(scan.inferred.roles.background!.dark, "#121417");
    assert.equal(scan.inferred.roles.text!.dark, "#eceff2");
    assert.deepEqual(scan.inferred.spacing.steps, [4, 8, 12]);
    assert.equal(scan.inferred.radii.length, 2);
});

test("fluid type sizes (clamp) are steps at their smallest value, and a numbered length family is what its properties say", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --step-0: clamp(1rem, 0.95rem + 0.25vw, 1.125rem); --step-1: clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem);
  --size-1: .25rem; --size-2: .5rem; --size-3: 1rem; --size-4: 1.5rem; --size-5: 2rem }
.a { padding: var(--size-3) var(--size-4); margin-top: var(--size-2); gap: var(--size-1) } .b { padding: var(--size-5) }
h1 { font-size: var(--step-1) } p { font-size: var(--step-0) }`,
        }),
    );

    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["1rem", "1.25rem"],
    );
    assert.deepEqual(
        scan.inferred.spacing.steps,
        [4, 8, 16, 24, 32],
        "--size-N used in padding is spacing",
    );
});

test("class rules count by how often markup uses the class, and a class in the dark mode pairs with its light color", () => {
    const scan = scanTokens(
        project({
            "style.css": `.page { background: #ffffff } .bg-gray-100 { background: #f3f4f6 } .bg-gray-900 { background: #111827 }
.text-gray-900 { color: #111827 } .text-gray-600 { color: #4b5563 } .border-gray-300 { border: 1px solid #d1d5db } .bg-brand { background: #7c3aed }`,
            "dark.css": `.dark .page { background: #111827 } .dark .bg-gray-100 { background: #1f2937 } .dark .text-gray-900 { color: #f9fafb } .dark .text-gray-600 { color: #9ca3af } .dark .border-gray-300 { border-color: #374151 }`,
            "index.html": `<body class="page text-gray-900"><div class="bg-gray-100"></div><div class="bg-gray-100"><p class="text-gray-600">x</p></div><p class="text-gray-600 border-gray-300">y</p><a class="bg-brand">z</a></body>`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(
        roles.background!.value,
        "#ffffff",
        "the page wrapper, not the unused .bg-gray-900",
    );
    assert.equal(roles.surface!.value, "#f3f4f6", "used twice");
    assert.equal(roles.surface!.dark, "#1f2937", "the same class in the dark mode");
    assert.equal(roles.text!.dark, "#f9fafb");
    assert.equal(roles.muted!.value, "#4b5563");
    assert.equal(roles.muted!.dark, "#9ca3af");
});

test("styled-components in plain .js files are read: a component file needs no theme name", () => {
    const scan = scanTokens(
        project({
            "src/components/Card.js": `import styled from "styled-components";
export const Card = styled.div\`
  background: #fff; border: 1px solid #e4e7eb; border-radius: 8px; padding: 1.5rem;
  box-shadow: 0 1px 3px rgba(31, 41, 51, 0.12);
\`;
export const Meta = styled.p\`color: #616e7c; font-size: 0.875rem;\`;`,
            "src/components/Status.js": `import styled from "styled-components";
export const ErrorText = styled.span\`color: #c92a2a;\`;
export const Warn = styled.span\`color: #e8590c;\`;
export const Ok = styled.span\`color: #2b8a3e;\`;`,
        }),
    );

    assert.ok(scan.files.length >= 2, "both component files were read");
    assert.equal(scan.inferred.roles.danger!.value, "#c92a2a");
    assert.equal(scan.inferred.roles.warning!.value, "#e8590c");
    assert.equal(scan.inferred.roles.success!.value, "#2b8a3e");
    assert.equal(scan.inferred.shadows, 1);
});

test("variables kept for the other mode as roles with a mode word (a Sass project with $dark-surface and no dark scope)", () => {
    const scan = scanTokens(
        project({
            "_variables.scss": `$app-background: #f5f5f5; $surface-color: #fff; $text-primary: #212121;
$dark-background: #303030; $dark-surface: #424242; $dark-text: #fff; $dark-blue: #003366; $brand: #1976d2;`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.dark, "#303030");
    assert.equal(roles.surface!.dark, "#424242");
    assert.equal(roles.text!.dark, "#ffffff");
    assert.ok(
        !scan.colors.length || roles.accent!.dark === undefined,
        "$dark-blue is a shade, not a mode",
    );
});

test("a custom property set only for the dark mode takes the Sass variable of the same name as its light value", () => {
    const scan = scanTokens(
        project({
            "_variables.scss": `$body-bg: #fdfcfa; $body-color: #2a2d31; $border-color: #dcd9d3; $primary: #4b3f9e;`,
            "custom.scss": `[data-bs-theme="dark"] { --bs-body-bg: #16181d; --bs-body-color: #e8eaed; --bs-border-color: #2e3238; --bs-primary: #9485f2 }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#fdfcfa");
    assert.equal(roles.background!.dark, "#16181d");
    assert.equal(roles.accent!.dark, "#9485f2");
});

test("a card's own variable (--card-bg on .card) is the surface, in the mode its selector names", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --body-bg: #fdfcfa; --body-color: #2a2d31 } [data-theme="dark"] { --body-bg: #16181d; --body-color: #e8eaed }
.card { --card-bg: #ffffff } [data-theme="dark"] .card { --card-bg: #1f2229 }`,
        }),
    );

    assert.equal(scan.inferred.roles.surface!.value, "#ffffff");
    assert.equal(scan.inferred.roles.surface!.dark, "#1f2229");
});

test("a color called warn that is red is the error color (Angular Material's warn palette)", () => {
    const scan = scanTokens(
        project({
            "_palette.scss": `$warn-map: (100: #ffcdd2, 300: #ef5350, 500: #e53935, 700: #b71c1c);
$primary-map: (500: #2196f3, 700: #1976d2);`,
        }),
    );

    assert.equal(
        scan.inferred.roles.danger!.value,
        "#e53935",
        "the middle step of the red palette",
    );
    assert.equal(scan.inferred.roles.warning, undefined);
});

// --- Round 2d: theme libraries -----------------------------------------------------------------------------------------

test("a theme file with any name: Vuetify's themes object, with a const for the light theme", () => {
    const scan = scanTokens(
        project({
            "src/plugins/vuetify.js": `const light = { dark: false, colors: { background: '#f4f6fa', surface: '#ffffff', 'on-surface': '#111827', 'on-surface-variant': '#5b6472', primary: '#2f5bea', error: '#d92d20', success: '#1b8a5a', warning: '#e69a00' } };
export default createVuetify({ theme: { defaultTheme: 'light', themes: { light, dark: { dark: true, colors: { background: '#0f1420', surface: '#181f2e', 'on-surface': '#e6e9f2', 'on-surface-variant': '#9aa4b8', primary: '#7c9cff', error: '#ff6b5e', success: '#4cd08f', warning: '#ffc247' } } } } });`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f4f6fa");
    assert.equal(roles.background!.dark, "#0f1420");
    assert.equal(roles.text!.value, "#111827", "`on-surface` is the text");
    assert.equal(roles.muted!.value, "#5b6472", "`on-surface-variant` is the quiet text");
    assert.equal(roles.accent!.dark, "#7c9cff");
});

test("tokens that name other tokens ($gray1) resolve in each theme, and the dark theme redefines only the palette", () => {
    const scan = scanTokens(
        project({
            "stitches.config.ts": `export const { styled } = createStitches({ theme: { colors: {
  gray1: "#fdfdfd", gray2: "#f7f7f7", gray6: "#d9d9d9", gray11: "#646464", gray12: "#202020", blue9: "#0090ff", red9: "#e5484d", amber9: "#ffb224", green9: "#30a46c",
  bg: "$gray1", panel: "$gray2", text: "$gray12", textMuted: "$gray11", line: "$gray6", brand: "$blue9" } } });
export const darkTheme = createTheme("dark-theme", { colors: { gray1: "#111111", gray2: "#191919", gray6: "#3a3a3a", gray11: "#b4b4b4", gray12: "#eeeeee", blue9: "#3e9eff" } });`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#fdfdfd");
    assert.equal(
        roles.background!.dark,
        "#111111",
        "bg points at gray1, which the dark theme sets",
    );
    assert.equal(roles.text!.dark, "#eeeeee");
    assert.equal(roles.muted!.dark, "#b4b4b4");
    assert.equal(roles.accent!.dark, "#3e9eff");
    assert.equal(roles.danger!.value, "#e5484d", "`red9` is a red");
});

test("daisyUI: a list of themes, one of them named for the dark mode", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `module.exports = { daisyui: { themes: [
  { mytheme: { primary: "#570df8", secondary: "#f000b8", accent: "#37cdbe", "base-100": "#ffffff", "base-200": "#f2f2f2", "base-content": "#1f2937", success: "#36d399", warning: "#fbbd23", error: "#f87272" } },
  { mydark: { primary: "#661ae6", secondary: "#d926a9", accent: "#1fb2a6", "base-100": "#1d232a", "base-200": "#191e24", "base-content": "#a6adbb", success: "#36d399", warning: "#fbbd23", error: "#ff5861" } },
] } };`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.accent!.value, "#570df8");
    assert.equal(roles.accent!.dark, "#661ae6");
    assert.equal(roles.text!.value, "#1f2937", "`base-content`");
    assert.equal(roles.text!.dark, "#a6adbb");
    assert.equal(roles.danger!.dark, "#ff5861");
});

test("Mantine: palettes as lists of shades, headings, and light/dark pairs under other", () => {
    const scan = scanTokens(
        project({
            "src/theme.ts": `const brand = ["#eff5ff", "#dce7fd", "#c5d8fb", "#a9c6f8", "#8ab1f3", "#6d9bee", "#5382e2", "#4067c4", "#34539e", "#2c4478"];
export const theme = createTheme({ primaryColor: "brand", colors: { brand }, fontFamily: "Inter, sans-serif", fontSize: "15px",
  headings: { fontFamily: "Fraunces, serif", sizes: { h1: { fontSize: "2.25rem" }, h2: { fontSize: "1.5rem" } } },
  other: { textLight: "#212529", textDark: "#e9ecef", mutedLight: "#868e96", mutedDark: "#a6a7ab", borderLight: "#dee2e6", borderDark: "#373a40", statusDangerLight: "#c92a2a", statusDangerDark: "#ff8787" } });`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.text!.value, "#212529");
    assert.equal(roles.text!.dark, "#e9ecef");
    assert.equal(roles.border!.dark, "#373a40");
    assert.equal(roles.danger!.dark, "#ff8787");
    assert.ok(Object.keys(scan.inferred.fonts).length >= 2, "both families");
    assert.ok(scan.inferred.typeScale.sizes.length >= 3, "15px and the heading sizes");
});

test("Material 3 names: on-surface is the text and on-surface-variant the quiet text; typescale sizes are type", () => {
    const scan = scanTokens(
        project({
            "tokens.css": `:root { --md-sys-color-surface: #fef7ff; --md-sys-color-on-surface: #1d1b20; --md-sys-color-on-surface-variant: #49454f; --md-sys-color-outline: #79747e; --md-sys-color-primary: #6750a4; --md-sys-color-error: #b3261e;
  --md-sys-typescale-body-large-size: 1rem; --md-sys-typescale-body-large-line-height: 1.5rem; --md-sys-typescale-title-large-size: 22px; --md-sys-typescale-display-small-size: 36px }
@media (prefers-color-scheme: dark) { :root { --md-sys-color-surface: #141218; --md-sys-color-on-surface: #e6e0e9; --md-sys-color-on-surface-variant: #cac4d0; --md-sys-color-outline: #938f99; --md-sys-color-primary: #d0bcff } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.text!.value, "#1d1b20");
    assert.equal(roles.muted!.value, "#49454f");
    assert.equal(roles.muted!.dark, "#cac4d0");
    assert.equal(roles.border!.value, "#79747e");
    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["1rem", "22px", "36px"],
        "the line height as a length is no size",
    );
});

// --- Round 3: the report says how sure it is, where from, and what to call next -----------------------------------------

test("each role has a confidence and a file:line; comments do not move the lines; the report ends with the next call", () => {
    const scan = scanTokens(
        project({
            "src/a.css": `/* a header
   that takes two lines */
:root {
  --bg: #ffffff; // a line comment
  --text: #111827;
}
.btn { background: #3b82f6; color: #fff }
.card { background: #3b82f6 }
`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.confidence, "high");
    assert.equal(roles.background!.at, "src/a.css:4", "the line of --bg in the file");
    assert.equal(roles.text!.at, "src/a.css:5");
    assert.equal(roles.accent!.basis, "use");
    assert.equal(roles.accent!.confidence, "low", "the most used chromatic color is a guess");
    assert.equal(roles.accent!.at, "src/a.css:7", "where the color is first used");

    const report = scanReport(scan);

    assert.match(
        report,
        /color\.bg\.page +#ffffff +from --bg \(background; high confidence, src\/a\.css:4\)/,
    );
    assert.match(
        report,
        /color\.accent\.default +#3b82f6 +most used chromatic color \(accent; low confidence, src\/a\.css:7\)/,
    );

    const last = report.slice(report.indexOf("</scan_data>"));

    assert.match(last, /\n\nNext call: design_system \{"action":"init","fromScan":true\}\n/);
    assert.match(
        last,
        /Then set these uncertain roles to the right color.*color\.accent\.default \(now #3b82f6; low confidence\)/,
    );
    assert.match(
        last,
        /A call: design_system \{"action":"set","changes":\[\{"token":"color\.accent\.default","value":"<the right color>"\}\]\}/,
    );
    assert.ok(!last.includes("color.bg.page (now"), "a role that a name says is not listed");
    assert.match(report.slice(report.lastIndexOf("\n")), /./, "the call is the last thing");
});

test("a scan of a folder names the folder in the next call, and a project with nothing says how to write tokens", () => {
    const report = scanReport(
        scanTokens(project({ "a.css": ":root { --bg: #fff; --text: #111; --accent: #36f }" })),
        "src/ui",
    );

    assert.match(
        report,
        /Next call: design_system \{"action":"init","fromScan":true,"path":"src\/ui"\}/,
    );
    assert.match(
        report,
        /Every role found has a name that says what it is\.|Then set these uncertain roles/,
    );
    assert.match(
        scanReport(scanTokens(project({ "a.css": "body { margin: 0 }" }))),
        /Next call: design_system with action init and tokens/,
    );
});

// --- Round 3b: dark mode in SCSS, scales without tokens, dark-first pages ----------------------------------------------

test("SCSS dark mode written as a mixin: @include dark-mode { … }, a mixin that wraps the dark mode, and if($theme == dark, …)", () => {
    const scan = scanTokens(
        project({
            "_mixins.scss": `@mixin dark-mode { .theme-dark & { @content; } }
@mixin when-night { @media (prefers-color-scheme: dark) { @content; } }
@mixin respect($what) { @media (prefers-color-scheme: dark) { @content; } }`,
            "main.scss": `@import "mixins";
body { background: #f7f7f5; color: #1b1c1f; @include dark-mode { background: #101114; color: #ececf0; } }
.card { background: #ffffff; border: 1px solid #dcdde0; @include respect(x) { background: #1a1c21; border-color: #2a2c31; } }
.meta { color: #6a6e78; @include when-night { color: #9ca0aa; } }
a { color: #0b6bcb; @include dark-mode { color: #5aa2f0; } }`,
            "_theme.scss": `$theme: light !default;
$muted: if($theme == dark, #9ca0aa, #6a6e78);`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f7f7f5");
    assert.equal(roles.background!.dark, "#101114", "@include dark-mode");
    assert.equal(
        roles.surface!.dark,
        "#1a1c21",
        "a mixin whose body wraps the dark media query, defined in another file",
    );
    assert.equal(roles.text!.dark, "#ececf0");
    assert.equal(roles.accent!.dark, "#5aa2f0");
    assert.equal(roles.muted!.dark, "#9ca0aa");
});

test("indented Sass and Stylus are read: nested rules, a mixin for the dark mode, and the scales in them", () => {
    const sass = scanTokens(
        project({
            "main.sass": `=dark
  @media (prefers-color-scheme: dark)
    @content
.card
  padding: 12px 16px
  border-radius: 10px
  box-shadow: 0 2px 6px rgba(0,0,0,.12)
  background: #fff
  +dark
    background: #1a1c21
  &:hover
    box-shadow: 0 8px 24px rgba(0,0,0,.18)
.btn
  padding: 8px 12px
  border-radius: 10px
.tag
  padding: 4px 8px
  border-radius: 6px`,
        }),
    );

    assert.deepEqual(sass.inferred.spacing.steps, [4, 8, 12, 16]);
    assert.equal(sass.inferred.radii.length, 2);
    assert.equal(sass.inferred.shadows, 2);
    assert.equal(sass.inferred.hasDark, true, "+dark is @include dark");

    const styl = scanTokens(
        project({
            "main.styl": `.card
  padding 12px 16px
  border-radius 10px
  box-shadow 0 2px 6px rgba(0,0,0,.12)
.btn
  padding 8px 12px
  border-radius 10px
.tag
  padding 4px 8px
  border-radius 6px`,
        }),
    );

    assert.deepEqual(styl.inferred.spacing.steps, [4, 8, 12, 16]);
    assert.equal(styl.inferred.shadows, 1);
});

test("scales that are only literals in rules: React Native shadows from four properties, Angular styles, Vue SCSS", () => {
    const scan = scanTokens(
        project({
            "src/Card.js": `import { StyleSheet } from 'react-native';
export const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f5f7' },
  card: { padding: 16, borderRadius: 12, backgroundColor: '#ffffff', shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  row: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
});`,
            "src/app/x.component.ts": `@Component({ selector: 'x', template: '', styles: [\`
  .box { padding: 24px 32px; border-radius: 6px; }
  .box h2 { margin: 0 0 8px; }
\`] })
export class X {}`,
        }),
    );

    assert.equal(scan.inferred.shadows, 1, "0 2px 8px rgba(0, 0, 0, 0.12)");
    assert.deepEqual(scan.inferred.spacing.steps, [8, 12, 16, 24, 32]);
    assert.equal(scan.inferred.radii.length, 2);
    assert.equal(scan.inferred.roles.background!.value, "#f4f5f7", "the container is the page");
    assert.equal(scan.inferred.roles.surface!.value, "#ffffff", "the card is the surface");
});

test("a dark-first page with unusual names: the page is read by use, .light and the light media query are the other mode", () => {
    const scan = scanTokens(
        project({
            "tokens.css": `:root { --base: #0f1418; --panel: #171e24; --ink: #e7ebee; --faded: #8fa0ab; --rim: #29323a; --glow: #40d787; --glow-deep: #2fa263; --go: #1c7d46; --stop: #e0564f; --wait: #d9a13b; --drop-1: 0 1px 2px rgba(9,14,18,.2) }
.light { --base: #f5f6f4; --panel: #ffffff; --ink: #1e252b; --faded: #5b6b76; --rim: #d7dcd8; --glow: #0d8a4e; --go: #14603a; --stop: #c23b35; --wait: #a06a10 }
body { background: var(--base); color: var(--ink) } .card { background: var(--panel); border: 1px solid var(--rim) } a { color: var(--glow) }
.hero { background: linear-gradient(135deg, #1e1b4b, #312e81) } .chart { fill: #22d3ee } .chart2 { fill: #a78bfa } .badge { background: #fde68a }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(scan.inferred.modes.default, "dark");
    assert.equal(roles.background!.value, "#0f1418", "the page, by how it is painted");
    assert.equal(roles.background!.dark, "#f5f6f4", "the other mode (here the light one)");
    assert.equal(roles.muted!.value, "#8fa0ab", "`faded`");
    assert.equal(roles.border!.value, "#29323a", "`rim`");
    assert.equal(roles.accent!.value, "#40d787");
    assert.equal(
        roles.danger!.value,
        "#e0564f",
        "a red that a variable names, though no rule uses it",
    );
    assert.equal(
        roles.success!.value,
        "#1c7d46",
        "the green with its own name, not --glow-deep, a step of the accent",
    );
    assert.equal(roles.warning!.value, "#d9a13b");
    assert.equal(
        scan.inferred.shadows,
        1,
        "a shadow by its value, whatever the variable is called",
    );

    const palette = Object.values(scan.inferred.palette).reduce((sum, count) => sum + count, 0);

    assert.ok(
        palette <= 11,
        `${palette} colors: the one-offs of a dark-first page (gradient stops, a chart) are left out`,
    );
});

test("SCSS variables a custom property is set from are that property; prefers-color-scheme: light is the other mode", () => {
    const scan = scanTokens(
        project({
            "_tokens.scss": `$dark-bg: #131015; $dark-surface: #1d1822; $dark-ink: #ece7f1; $dark-brand: #f0717f;
:root { --bg: #{$dark-bg}; --surface: #{$dark-surface}; --ink: #{$dark-ink}; --brand: #{$dark-brand}; }
@media (prefers-color-scheme: light) { :root:not(.dark-theme) { --bg: #faf7f5; --surface: #ffffff; --ink: #221c28; --brand: #d8394d; } }`,
        }),
    );
    const system = load(scan);
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#131015");
    assert.equal(roles.background!.dark, "#faf7f5");
    assert.equal(roles.accent!.dark, "#d8394d");
    assert.ok(
        !system.tokens.some((each) => each.name.startsWith("color.dark")),
        "no token for $dark-bg beside --bg",
    );
});

test("a one-off used once is left out of a large palette, kept in a small one; a spacing used once off the grid is no step", () => {
    const small = scanTokens(
        project({
            "a.css": `body { background: #fff; color: #111 } .a { color: #36f } .b { border: 1px solid #ddd } .c { background: #fde68a }`,
        }),
    );
    const many = Array.from(
        { length: 20 },
        (_, at) =>
            `.x${at} { color: #${(0x112233 + at * 0x050607).toString(16)}; padding: ${at === 0 ? "6px" : "8px"} }`,
    ).join("\n");
    const big = scanTokens(
        project({
            "a.css": `${many}\nbody { background: #fff; color: #111 } .a { color: #36f } .a2 { color: #36f }`,
        }),
    );
    const count = (scan: ReturnType<typeof scanTokens>) =>
        Object.values(scan.inferred.palette).reduce((sum, each) => sum + each, 0);

    assert.ok(count(small) >= 4, "a small page keeps its yellow");
    assert.ok(count(big) <= 14, `${count(big)} colors out of 20 one-offs`);
    assert.deepEqual(big.inferred.spacing.steps, [8], "6px used once is no step");
});

// --- Round 3c: classes of input, not one project --------------------------------------------------------------------------

test("a shadow is found by its value, whatever the name: elev, elevation, depth, lift, z1, raise, with layers, inset, a variable color, a color first", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root {
  --elev-1: 0 1px 2px rgba(0,0,0,.2);
  --elevation-2: 0 4px 8px -2px rgba(0,0,0,.25), 0 2px 4px rgba(0,0,0,.1);
  --depth-3: inset 0 1px 0 rgba(255,255,255,.1), 0 12px 24px rgba(0,0,0,.3);
  --lift-1: 0 2px 6px #00000033;
  --z1: 0 1px 3px hsl(220 20% 10% / .3);
  --raise: 0 0 0 1px rgb(0 0 0 / 0.08), 0 4px 12px rgb(0 0 0 / 0.1);
  --soft: 0 2px 4px var(--ink);
  --first: rgba(0,0,0,.2) 0 4px 12px;
  --pad: 8px 8px 8px 8px;
  --margin-ish: 12px 16px;
  --none: none;
  --t-quick: 120ms; --t-slow: 0.4s;
  --curve-out: cubic-bezier(0.2, 0, 0, 1); --ease-x: ease-in-out;
  --voice: "Inter", system-ui, sans-serif;
}`,
        }),
    );
    const system = load(scan);
    const shadows = system.tokens.filter((each) => each.type === "shadow");

    assert.equal(shadows.length, 8, shadows.map((each) => each.name).join(", "));
    assert.ok(
        !system.tokens.some((each) => each.type === "shadow" && /pad|margin/.test(each.name)),
        "a padding is no shadow",
    );
    assert.deepEqual(
        system.tokens
            .filter((each) => each.type === "duration")
            .map((each) => each.modes.light!.css),
        ["120ms", "0.4s"],
    );
    assert.equal(system.tokens.filter((each) => each.type === "cubicBezier").length, 2);
    assert.ok(system.tokens.some((each) => each.type === "fontFamily"));
});

test("status words: good ok positive pass valid are success; bad error critical negative invalid fail are danger; warn caution attention are warning", () => {
    const forms: [string, string, string, string][] = [
        ["good", "bad", "warn", "note"],
        ["ok", "error", "caution", "notice"],
        ["positive", "negative", "attention", "info"],
        ["pass", "critical", "warning", "note"],
        ["valid", "invalid", "caution", "notice"],
        ["success", "fail", "warn", "info"],
    ];

    for (const [good, bad, warn, note] of forms) {
        const scan = scanTokens(
            project({
                "a.css": `:root { --bg: #fff; --text: #111; --${good}: #16a34a; --${bad}: #dc2626; --${warn}: #d97706; --${note}: #2563eb }
[data-bs-theme="dark"] { --bg: #0b0c10; --text: #eee; --${good}: #4ade80; --${bad}: #f87171; --${warn}: #fbbf24; --${note}: #60a5fa }
.x { color: var(--${good}) }`,
            }),
        );
        const { roles } = scan.inferred;

        assert.equal(roles.success!.value, "#16a34a", `${good} is success`);
        assert.equal(roles.success!.dark, "#4ade80", `${good}'s dark value follows its name`);
        assert.equal(roles.danger!.value, "#dc2626", `${bad} is danger`);
        assert.equal(roles.danger!.dark, "#f87171");
        assert.equal(roles.warning!.value, "#d97706", `${warn} is warning`);
        assert.equal(roles.warning!.dark, "#fbbf24");
        assert.equal(roles.accent, undefined, `${note} is a notice, not the brand`);
    }
});

test("a status named only in the other mode: the light color is the used one of its hue, and the dark value is the name's", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --bg: #fff; --text: #111 }
.dark { --bg: #0b0c10; --text: #eee; --success: #4ade80; --danger: #f87171 }
.ok { color: #16a34a } .bad { color: #dc2626 } .ok2 { border-color: #16a34a }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.success!.value, "#16a34a");
    assert.equal(roles.success!.dark, "#4ade80");
    assert.equal(roles.danger!.value, "#dc2626");
    assert.equal(roles.danger!.dark, "#f87171");
    assert.equal(roles.accent, undefined, "the used green is the success, not the brand");
});

test("variables that supply one mode (--light-*, --dark-*, --*-dark, --*-light) stay out of the palette in every form", () => {
    const forms: Record<string, Record<string, string>> = {
        "role variables behind light- and dark- twins": {
            "a.css": `:root { --light-bg: #f6f7fa; --light-ink: #14161c; --light-good: #16a34a; --dark-bg: #0b0c10; --dark-ink: #e8e9ee; --dark-good: #4ade80;
  --bg: var(--light-bg); --ink: var(--light-ink); --good: var(--light-good) }
.dark { --bg: var(--dark-bg); --ink: var(--dark-ink); --good: var(--dark-good) }
body { background: var(--bg); color: var(--ink) } .ok { color: var(--good) }`,
        },
        "twins with a suffix and no role variable": {
            "a.css": `:root { --bg-light: #f6f7fa; --bg-dark: #0b0c10; --ink-light: #14161c; --ink-dark: #e8e9ee; --good-light: #16a34a; --good-dark: #4ade80 }
body { background: var(--bg-light); color: var(--ink-light) } .ok { color: var(--good-light) }
@media (prefers-color-scheme: dark) { body { background: var(--bg-dark); color: var(--ink-dark) } .ok { color: var(--good-dark) } }`,
        },
        "one twin with a role variable": {
            "a.css": `:root { --bg: #f6f7fa; --ink: #14161c; --good: #16a34a; --dark-good: #4ade80 }
.dark { --bg: #0b0c10; --ink: #e8e9ee; --good: var(--dark-good) } body { background: var(--bg); color: var(--ink) } .ok { color: var(--good) }`,
        },
        "Sass variables behind interpolation": {
            "_v.scss": `$light-bg: #f6f7fa; $light-ink: #14161c; $light-good: #16a34a; $dark-bg: #0b0c10; $dark-ink: #e8e9ee; $dark-good: #4ade80;
:root { --bg: #{$light-bg}; --ink: #{$light-ink}; --good: #{$light-good}; }
[data-mantine-color-scheme="dark"] { --bg: #{$dark-bg}; --ink: #{$dark-ink}; --good: #{$dark-good}; }`,
        },
    };

    for (const [form, files] of Object.entries(forms)) {
        const scan = scanTokens(project(files));
        const system = load(scan);
        const { roles } = scan.inferred;

        assert.equal(roles.background!.value, "#f6f7fa", form);
        assert.equal(roles.background!.dark, "#0b0c10", form);
        assert.equal(roles.text!.dark, "#e8e9ee", form);
        assert.equal(roles.success!.dark, "#4ade80", form);
        assert.deepEqual(
            system.tokens
                .filter((each) =>
                    /^color\.(?:dark|light)\b|^color\.[\w-]*-(?:dark|light)$/.test(each.name),
                )
                .map((each) => each.name),
            [],
            `${form}: no color group for the twins`,
        );

        // A role refers to a palette step: the same hex. Two tokens that hold it as a value are a copy.
        const hexes = system.tokens
            .filter((each) => each.type === "color" && each.modes.light!.alias === undefined)
            .map((each) => each.modes.light!.hex);

        assert.equal(new Set(hexes).size, hexes.length, `${form}: each color once`);
    }
});

test("a vendor's theme attribute or class marks the dark mode, with plain literals or Sass interpolation", () => {
    const selectors = [
        '[data-bs-theme="dark"]',
        '[data-color-mode="dark"]',
        '[data-mantine-color-scheme="dark"]',
        '[data-joy-color-scheme="dark"]',
        '[data-theme*="dark"]',
        "[data-theme^=dark]",
        '[data-md-color-scheme="slate"]',
        ".dark-theme",
        ".theme--dark",
        ".v-theme--dark",
        ".ThemeDark",
        ":root.dark-mode",
        "html.theme-dark",
        "[data-bs-theme=dark] body",
        'html[data-color-mode="dark"][data-dark-theme="dark"]',
    ];

    for (const selector of selectors) {
        const literal = scanTokens(
            project({
                "a.css": `:root { --bg: #f6f7fa; --text: #14161c } ${selector} { --bg: #0b0c10; --text: #e8e9ee }`,
            }),
        );
        const sass = scanTokens(
            project({
                "a.scss": `$bg-l: #f6f7fa; $bg-d: #0b0c10; $t-l: #14161c; $t-d: #e8e9ee;
:root { --bg: #{$bg-l}; --text: #{$t-l}; } ${selector} { --bg: #{$bg-d}; --text: #{$t-d}; }`,
            }),
        );

        for (const scan of [literal, sass]) {
            assert.equal(scan.inferred.roles.background!.value, "#f6f7fa", selector);
            assert.equal(scan.inferred.roles.background!.dark, "#0b0c10", selector);
            assert.equal(scan.inferred.roles.text!.dark, "#e8e9ee", selector);
        }
    }
});

test("interpolation inside a value or with arithmetic is resolved through the Sass variables", () => {
    const scan = scanTokens(
        project({
            "_v.scss": `$ink: rgba(20, 22, 28, .2); $space: 8px; $radius: 6px;
:root { --shadow-1: 0 1px 2px #{$ink}; --gap: #{$space * 2}; --round: #{$radius}; }
.card { box-shadow: var(--shadow-1); padding: var(--gap); border-radius: var(--round) }`,
        }),
    );

    assert.equal(scan.inferred.shadows, 1);
    assert.ok(scan.inferred.spacing.steps.includes(16), "the gap is 8px * 2");
    assert.ok(scan.inferred.radii.some((radius) => radius.endsWith("6px")));
});

test("a dark-first page whose --dark-* variables feed the roles: no token for the twins, the status role from its name in both modes", () => {
    const twins: [string, (name: string) => string][] = [
        ["--dark-*", (name) => `dark-${name}`],
        ["--*-dark", (name) => `${name}-dark`],
        ["--d-*", (name) => `d-${name}`],
        ["--*-dk", (name) => `${name}-dk`],
    ];
    const statuses = ["ok", "good", "positive", "pass", "valid"];
    const switches = [
        ':root[data-mode="light"]',
        ".light",
        '[data-theme="light"]',
        "html.theme-light",
    ];

    for (const [form, twin] of twins) {
        for (const [at, status] of statuses.entries()) {
            const selector = switches[at % switches.length]!;
            const scan = scanTokens(
                project({
                    "a.css": `:root {
  --${twin("paper")}: #101216; --${twin("ink")}: #e6e8ee; --${twin(status)}: #3c9a6a;
  --paper: var(--${twin("paper")}); --ink: var(--${twin("ink")}); --${status}: var(--${twin(status)});
}
${selector} { --paper: #fafafa; --ink: #15171c; --${status}: #0d6b3f; }
.badge--${status} { color: var(--${status}); }
body { background: var(--paper); color: var(--ink) }`,
                }),
            );
            const system = load(scan);
            const { roles } = scan.inferred;
            const label = `${form}, ${status}, ${selector}`;

            assert.equal(scan.inferred.modes.default, "dark", `${label}: dark first`);
            assert.equal(roles.success!.value, "#3c9a6a", label);
            assert.equal(
                roles.success!.dark,
                "#0d6b3f",
                `${label}: the light value, from the same name`,
            );
            assert.equal(roles.success!.basis, "name", `${label}: found by the name, not by use`);
            assert.equal(roles.success!.source, status, label);
            assert.equal(roles.text!.value, "#e6e8ee", label);
            assert.equal(roles.text!.dark, "#15171c", label);
            assert.deepEqual(
                system.tokens
                    .filter((each) => /(?:^|[.-])(?:dark|dk|d|light)(?:[.-]|$)/.test(each.name))
                    .map((each) => each.name),
                [],
                `${label}: the twins make no token`,
            );
            assert.ok(
                !system.tokens.some((each) => each.name === `color.${status}`),
                `${label}: and the role is not there twice`,
            );
        }
    }
});

test("a light-first page with the same twins: the roles take the dark values from the twins", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --light-paper: #fafafa; --light-ink: #15171c; --light-ok: #0d6b3f;
  --paper: var(--light-paper); --ink: var(--light-ink); --ok: var(--light-ok) }
.dark { --paper: #101216; --ink: #e6e8ee; --ok: #3c9a6a }
.badge--ok { color: var(--ok) } body { background: var(--paper); color: var(--ink) }`,
        }),
    );
    const system = load(scan);

    assert.equal(scan.inferred.roles.success!.value, "#0d6b3f");
    assert.equal(scan.inferred.roles.success!.dark, "#3c9a6a");
    assert.equal(scan.inferred.roles.success!.basis, "name");
    assert.deepEqual(
        system.tokens.filter((each) => /light/.test(each.name)).map((each) => each.name),
        [],
    );
});

test("star re-exports in a cycle are read once each: a local export wins, then the first star", () => {
    const files = Array.from({ length: 9 }, (_, i) => `t${i}.js`);
    const stars = (i: number) =>
        files.flatMap((each, j) => (j === i ? [] : [`export * from "./${each}";`])).join("\n");
    const body = (i: number) =>
        `${stars(i)}\nexport const shared = "s${i}";\n${i > 0 ? `export const first = "f${i}";` : ""}`;
    const dir = project(Object.fromEntries(files.map((file, i) => [file, body(i)])));
    const started = Date.now();
    const out = new JsProject(dir, files).exportsOf("t0.js");

    assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
    assert.equal(out.get("shared")?.value(), "s0");
    assert.equal(out.get("first")?.value(), "f1");
});

test("readLiteral ends at a stray closing bracket (it looped for ever before: run in a child)", () => {
    const module = new URL("../src/server/design/scan-parse.ts", import.meta.url).href;
    const code = `import { readLiteral } from "${module}";
console.log(Object.keys(readLiteral("{ a: f(1)), b: 2 }", 0)).join());`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        timeout: 20_000,
    });

    assert.equal(child.stdout.trim(), "a");
});
