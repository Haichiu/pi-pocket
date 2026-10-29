// Style Dictionary sources and other token folders in the scan: files in several folders, in the classic form
// (`value`, references with `.value`) and the DTCG form (`$value`), merged in source order, with brands and themes as modes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanReport, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import { globToRegExp, sdConfigIn } from "../src/server/design/scan-import-sd.ts";
import { modeOfConfigFile, sdConfigsIn } from "../src/server/design/scan-import-sd-config.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-sd-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(
            join(dir, name),
            typeof body === "string" ? body : JSON.stringify(body, null, 2),
        );
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
const css = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.literal;
const hex = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.hex;

const classic = (value: unknown, extra: Record<string, unknown> = {}) => ({ value, ...extra });

const BASE = {
    color: {
        base: {
            gray: {
                50: classic("#f9fafb"),
                200: classic("#e5e7eb"),
                500: classic("#6b7280"),
                800: classic("#1f2937"),
                900: classic("#111827"),
            },
            blue: { 600: classic("#2563eb") },
            red: { 600: classic("#dc2626") },
            white: classic("#ffffff"),
        },
    },
};
const SEMANTIC = {
    color: {
        bg: {
            page: classic("{color.base.gray.50.value}"),
            surface: classic("{color.base.white.value}"),
        },
        text: {
            primary: classic("{color.base.gray.900.value}", { comment: "Body text" }),
            muted: classic("{color.base.gray.500}"),
        },
        border: { default: classic("{color.base.gray.200.value}") },
        accent: { default: classic("{color.base.blue.600.value}") },
        danger: { default: classic("{color.base.red.600.value}") },
        overlay: classic("rgba({color.base.gray.900.value}, 0.5)"),
    },
};
const SIZES = {
    size: {
        space: { 1: classic("4px"), 2: classic("8px"), 4: classic("16px"), 6: classic(24) },
        radius: { sm: classic("4"), md: classic("8px"), pill: classic("9999px") },
        font: { sm: classic("14px"), base: classic("16px"), lg: classic("20px") },
    },
};
const OTHERS = {
    font: {
        family: { sans: classic("Inter, system-ui, sans-serif") },
        weight: { bold: classic("700") },
    },
    shadow: {
        sm: classic("0 1px 2px rgba(0,0,0,0.2)"),
        md: classic(
            { x: "0", y: "4", blur: "12", spread: "0", color: "rgba(0,0,0,0.18)" },
            { type: "shadow" },
        ),
    },
    time: { fast: classic("120ms"), slow: classic(300) },
};
const SOURCE = {
    "tokens/color/base.json": BASE,
    "tokens/color/semantic.json": SEMANTIC,
    "tokens/size/spacing.json": SIZES,
    "tokens/font.json": { font: OTHERS.font },
    "tokens/shadow.json": { shadow: OTHERS.shadow },
    "tokens/motion.json": { time: OTHERS.time },
};

test("the classic format in several folders, with a config: files merge, references with and without .value, types from the categories", () => {
    const scan = scanTokens(
        project({
            "config.json": {
                source: ["tokens/**/*.json"],
                platforms: { css: { transformGroup: "css", files: [] } },
            },
            ...SOURCE,
            "package.json": { name: "x", scripts: { build: "style-dictionary build" } },
        }),
    );
    const system = load(scan);

    assert.ok(scan.inferred.imported >= 30, String(scan.inferred.imported));
    assert.ok(
        scan.inferred.notes.some((note) =>
            /Style Dictionary config: the token files are the globs of its source \(tokens\/\*\*\/\*\.json\)/.test(
                note,
            ),
        ),
    );
    // Two files that both start with `color` are one group.
    assert.ok(token(system, "color.base.gray.50") && token(system, "color.bg.page"));
    assert.equal(
        token(system, "color.bg.page")!.modes.light!.alias,
        "color.base.gray.50",
        "a reference with .value is a reference",
    );
    assert.equal(
        token(system, "color.text.muted")!.modes.light!.alias,
        "color.base.gray.500",
        "and one without",
    );
    assert.equal(token(system, "color.text.primary")!.description, "Body text");
    assert.equal(hex(system, "color.overlay"), "#11182780", "rgba of a reference");
    // Types from the category and the value.
    assert.equal(css(system, "size.space.1"), "4px");
    assert.equal(css(system, "size.space.6"), "24px", "a bare number in size is px");
    assert.equal(css(system, "size.radius.sm"), "4px");
    assert.equal(token(system, "font.family.sans")!.type, "fontFamily");
    assert.equal(token(system, "font.weight.bold")!.modes.light!.value, 700);
    assert.equal(token(system, "shadow.sm")!.type, "shadow");
    assert.equal(token(system, "shadow.md")!.type, "shadow");
    assert.equal(css(system, "time.fast"), "120ms");
    assert.equal(css(system, "time.slow"), "300ms", "a bare number in time is ms");
    assert.equal(system.modes.length, 1);
    assert.equal(token(system, "package.name"), undefined, "package.json is not a token file");
});

test("brands and themes are modes: the same paths with other values; a theme named for dark is the dark mode", () => {
    const scan = scanTokens(
        project({
            "config.json": {
                source: ["tokens/**/*.json", "brands/*/*.json", "themes/*/*.json"],
                platforms: { css: { files: [] } },
            },
            ...SOURCE,
            "brands/acme/color.json": { color: { accent: { default: classic("#ea580c") } } },
            "brands/globex/color.json": { color: { accent: { default: classic("#7c3aed") } } },
            "themes/dark/color.json": {
                color: {
                    bg: {
                        page: classic("{color.base.gray.900.value}"),
                        surface: classic("{color.base.gray.800.value}"),
                    },
                    text: { primary: classic("{color.base.gray.50.value}") },
                },
            },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark", "globex"]);
    assert.equal(hex(system, "color.accent.default"), "#ea580c", "the first brand is the default");
    assert.equal(hex(system, "color.accent.default", "globex"), "#7c3aed");
    assert.equal(hex(system, "color.bg.page", "dark"), "#111827");
    assert.equal(hex(system, "color.text.primary", "dark"), "#f9fafb");
    assert.equal(
        hex(system, "color.border.default", "dark"),
        "#e5e7eb",
        "a mode holds only what it changes",
    );
    assert.ok(scan.inferred.notes.some((note) => /modes found: acme, globex, dark/.test(note)));
});

test("the DTCG format, with a config written in JavaScript; files named for dark hold the dark mode", () => {
    const system = load(
        scanTokens(
            project({
                "sd.config.mjs": `import StyleDictionary from "style-dictionary";
export default {
  source: ["tokens/core/**/*.json", "tokens/semantic/*.json"],
  platforms: { css: { transformGroup: "css", files: [{ destination: "tokens.css", format: "css/variables" }] } },
};`,
                "tokens/core/color.json": {
                    color: {
                        $type: "color",
                        neutral: {
                            0: { $value: "#ffffff" },
                            100: { $value: "#f4f4f5" },
                            900: { $value: "#18181b" },
                            950: { $value: "#09090b" },
                        },
                        teal: { 400: { $value: "#2dd4bf" }, 600: { $value: "#0d9488" } },
                    },
                },
                "tokens/core/dimension.json": {
                    space: { $type: "dimension", sm: { $value: "8px" }, md: { $value: "16px" } },
                    font: {
                        weight: { $type: "fontWeight", bold: { $value: 700 } },
                        family: {
                            $type: "fontFamily",
                            body: { $value: ["Source Sans 3", "sans-serif"] },
                        },
                    },
                },
                "tokens/semantic/light.json": {
                    color: {
                        $type: "color",
                        bg: { page: { $value: "{color.neutral.0}" } },
                        accent: { default: { $value: "{color.teal.600}" } },
                    },
                },
                "tokens/semantic/dark.json": {
                    color: {
                        $type: "color",
                        bg: { page: { $value: "{color.neutral.950}" } },
                        accent: { default: { $value: "{color.teal.400}" } },
                    },
                },
            }),
        ),
    );

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg.page"), "#ffffff");
    assert.equal(hex(system, "color.bg.page", "dark"), "#09090b");
    assert.equal(hex(system, "color.accent.default", "dark"), "#2dd4bf");
    assert.equal(css(system, "space.md"), "16px");
    assert.equal(token(system, "font.family.body")!.type, "fontFamily");
});

test("no config: the usual folders, the old `properties/` layout, attributes and comments", () => {
    const system = load(
        scanTokens(
            project({
                "properties/color/base.json": {
                    color: {
                        base: {
                            gray: {
                                light: classic("#f5f5f5", { comment: "light gray" }),
                                dark: classic("#222222"),
                            },
                            red: classic("#e11d48", {
                                attributes: { category: "color", type: "base" },
                            }),
                        },
                    },
                },
                "properties/color/font.json": {
                    color: {
                        font: { base: classic("{color.base.gray.dark.value}") },
                        background: { base: classic("{color.base.gray.light.value}") },
                        danger: classic("{color.base.red.value}"),
                    },
                },
                "properties/size/size.json": {
                    size: {
                        font: { small: classic("0.75rem"), base: classic("1rem") },
                        padding: { tiny: classic("0.25rem"), small: classic("0.5rem") },
                        radius: { base: classic("4") },
                    },
                },
                "properties/time.json": {
                    time: { duration: { fast: classic("150"), slow: classic("400") } },
                },
            }),
        ),
    );

    assert.equal(hex(system, "color.base.gray.light"), "#f5f5f5");
    assert.equal(token(system, "color.font.base")!.modes.light!.alias, "color.base.gray.dark");
    assert.equal(token(system, "color.base.gray.light")!.description, "light gray");
    assert.equal(css(system, "size.font.small"), "0.75rem");
    assert.equal(css(system, "size.radius.base"), "4px");
    assert.equal(css(system, "time.duration.fast"), "150ms");
});

test("source order decides: a later file overrides an earlier one, a file outside the globs is not read", () => {
    const system = load(
        scanTokens(
            project({
                "config.js": `module.exports = {
  source: ['tokens/base/**/*.json', 'tokens/semantic/**/*.json', 'tokens/overrides.json'],
  platforms: { scss: { transformGroup: 'scss', files: [] } },
};`,
                "tokens/base/colors.json": {
                    color: {
                        brand: { 500: classic("#2563eb"), 700: classic("#1d4ed8") },
                        neutral: { 0: classic("#fff"), 900: classic("#111") },
                    },
                },
                "tokens/semantic/theme.json": {
                    color: {
                        bg: classic("{color.neutral.0}"),
                        text: classic("{color.neutral.900}"),
                        accent: classic("{color.brand.500}"),
                    },
                    space: { 1: classic("4px"), 2: classic("8px"), 3: classic("16px") },
                },
                "tokens/overrides.json": { color: { accent: classic("{color.brand.700}") } },
                "tokens/archive/old.json": {
                    color: { accent: classic("#ff0000"), legacy: classic("#00ff00") },
                },
            }),
        ),
    );

    assert.equal(
        token(system, "color.accent")!.modes.light!.alias,
        "color.brand.700",
        "overrides.json is last",
    );
    assert.equal(
        token(system, "color.legacy"),
        undefined,
        "tokens/archive is not in the source globs",
    );
});

test("a config whose globs are built in code is not read: the token folders are", () => {
    const system = load(
        scanTokens(
            project({
                "sd.config.js":
                    "const brands = ['a', 'b'];\nmodule.exports = { source: [`tokens/${brands[0]}/**/*.json`], platforms: { css: {} } };",
                ...SOURCE,
            }),
        ),
    );

    assert.ok(token(system, "color.bg.page"), "the files of tokens/ were read");
});

test("globs: **, *, ?, braces; a template, a long pattern, and many ** are refused; a config needs platforms and a source list", () => {
    const match = (glob: string, path: string) => globToRegExp(glob)?.test(path);

    assert.equal(match("tokens/**/*.json", "tokens/color/base.json"), true);
    assert.equal(match("tokens/**/*.json", "tokens/base.json"), true);
    assert.equal(match("tokens/*.json", "tokens/color/base.json"), false);
    assert.equal(match("brands/{a,b}/*.json", "brands/b/x.json"), true);
    assert.equal(match("brands/{a,b}/*.json", "brands/c/x.json"), false);
    assert.equal(match("tokens/colo?/x.json", "tokens/color/x.json"), true);
    assert.equal(match("tokens/**/*.json", "tokens/a.b.json"), true, "a dot is a dot");
    assert.equal(globToRegExp("tokens/${brand}/*.json"), undefined);
    assert.equal(globToRegExp(`${"a/".repeat(120)}*.json`), undefined);
    assert.equal(globToRegExp("**/**/**/**/x.json"), undefined);

    // A long path against a pattern with `**` stays fast.
    const started = Date.now();

    globToRegExp("tokens/**/a/**/b/**/*.json")!.test(`tokens/${"x/".repeat(2000)}c.json`);
    assert.ok(Date.now() - started < 200);

    // Many `*` against a long name do not backtrack (seconds before, under a millisecond now).
    assert.equal(match(`${"a*".repeat(12)}b.json`, `${"a".repeat(30)}.json`), false);
    assert.ok(Date.now() - started < 400, `${Date.now() - started} ms`);

    assert.deepEqual(
        sdConfigIn("", `{ "source": ["a/*.json"], "include": ["b/*.json"], "platforms": {} }`),
        { dir: "", include: ["b/*.json"], source: ["a/*.json"] },
    );
    assert.equal(
        sdConfigIn("", `{ "source": ["a/*.json"] }`),
        undefined,
        "no platforms: not a config",
    );
    assert.equal(
        sdConfigIn("", `module.exports = { platforms: {}, source: getSources() }`),
        undefined,
        "a list built in code",
    );
});

test("the report names the Style Dictionary reading, and a repository with only a config and no tokens is not a design system", () => {
    const text = scanReport(
        scanTokens(
            project({
                "config.json": { source: ["tokens/**/*.json"], platforms: { css: {} } },
                ...SOURCE,
            }),
        ),
    );

    assert.match(text, /Style Dictionary config: the token files are the globs of its source/);
    assert.match(text, /Used the \d+ tokens from tokens\/color\/base\.json/);

    const empty = scanTokens(
        project({ "config.json": { source: ["tokens/**/*.json"], platforms: { css: {} } } }),
    );

    assert.equal(empty.inferred.imported, 0);
});

// --- Configs for modes ----------------------------------------------------------------------------------------------------

const PLATFORMS = `platforms: { css: { transformGroup: "css", buildPath: "build/", files: [{ destination: "v.css", format: "css/variables" }] } }`;
const JSON_PLATFORMS = { css: { transformGroup: "css", buildPath: "build/", files: [] } };

/** The colors of a design: a palette, the roles in light, and the roles that dark changes. */
const palette = {
    color: {
        base: {
            gray: {
                "50": classic("#f8fafc"),
                "200": classic("#e2e8f0"),
                "500": classic("#64748b"),
                "800": classic("#1e293b"),
                "900": classic("#0f172a"),
            },
            blue: { "400": classic("#60a5fa"), "500": classic("#3b82f6") },
            red: { "400": classic("#f87171"), "500": classic("#ef4444") },
            white: classic("#ffffff"),
        },
    },
};
const light = {
    color: {
        bg: {
            page: classic("{color.base.gray.50.value}"),
            surface: classic("{color.base.white.value}"),
        },
        text: {
            primary: classic("{color.base.gray.900.value}"),
            muted: classic("{color.base.gray.500.value}"),
        },
        border: { default: classic("{color.base.gray.200.value}") },
        accent: { default: classic("{color.base.blue.500.value}") },
        danger: { default: classic("{color.base.red.500.value}") },
    },
};
const dark = {
    color: {
        bg: {
            page: classic("{color.base.gray.900.value}"),
            surface: classic("{color.base.gray.800.value}"),
        },
        text: {
            primary: classic("{color.base.gray.50.value}"),
            muted: classic("{color.base.gray.200.value}"),
        },
        border: { default: classic("{color.base.gray.800.value}") },
        accent: { default: classic("{color.base.blue.400.value}") },
        danger: { default: classic("{color.base.red.400.value}") },
    },
};

/** The roles of a scan, light and dark, as hex. */
function roles(scan: TokenScan) {
    const system = load(scan);

    return Object.fromEntries(
        [
            "bg.page",
            "bg.surface",
            "text.primary",
            "text.muted",
            "border.default",
            "accent.default",
            "danger.default",
        ].map((name) => [
            name,
            [hex(system, `color.${name}`), hex(system, `color.${name}`, "dark")],
        ]),
    );
}

const DARK_ROLES = {
    "bg.page": ["#f8fafc", "#0f172a"],
    "bg.surface": ["#ffffff", "#1e293b"],
    "text.primary": ["#0f172a", "#f8fafc"],
    "text.muted": ["#64748b", "#e2e8f0"],
    "border.default": ["#e2e8f0", "#1e293b"],
    "accent.default": ["#3b82f6", "#60a5fa"],
    "danger.default": ["#ef4444", "#f87171"],
};

test("a config for a mode: config.json builds the base, config.dark.json adds the dark folder over it", () => {
    const scan = scanTokens(
        project({
            "config.json": { source: ["tokens/base/**/*.json"], platforms: JSON_PLATFORMS },
            "config.dark.json": {
                include: ["tokens/base/**/*.json"],
                source: ["tokens/dark/**/*.json"],
                platforms: JSON_PLATFORMS,
            },
            "tokens/base/palette.json": palette,
            "tokens/base/semantic.json": light,
            "tokens/dark/semantic.json": dark,
        }),
    );

    assert.deepEqual(roles(scan), DARK_ROLES);
    assert.ok(scan.inferred.notes.some((note) => /configs for modes: dark/.test(note)));
});

test("a mode config whose source is only the mode's file, config-<mode>.json and a dark word in a folder's name, in any case", () => {
    for (const [darkConfig, source] of [
        ["config-dark.json", ["tokens/dark.json"]],
        ["style-dictionary.config.Dark.json", ["tokens/semantic.dark.json"]],
        ["dark/config.json", ["tokens/themes/night.json"]],
    ] as const) {
        const scan = scanTokens(
            project({
                "config.json": {
                    source: ["tokens/*.json"].concat("tokens/palette/*.json"),
                    platforms: JSON_PLATFORMS,
                },
                [darkConfig]: { source, platforms: JSON_PLATFORMS },
                "tokens/palette/palette.json": palette,
                "tokens/semantic.json": light,
                [source[0]!.replace("tokens/", "tokens/")]: dark,
            }),
        );

        assert.deepEqual(roles(scan), DARK_ROLES, darkConfig);
    }
});

test("configs in one script: a list of configs, a function that returns one for each theme, and a loop", () => {
    const tokens = {
        "tokens/core/palette.json": palette,
        "tokens/light/semantic.json": light,
        "tokens/dark/semantic.json": dark,
    };

    for (const [file, text] of [
        [
            "build.js",
            `const SD = require("style-dictionary");
module.exports = [
  { source: ["tokens/core/**/*.json", "tokens/light/**/*.json"], ${PLATFORMS} },
  { source: ["tokens/core/**/*.json", "tokens/dark/**/*.json"], ${PLATFORMS} },
];`,
        ],
        [
            "build.mjs",
            `import StyleDictionary from "style-dictionary";
function getConfig(theme) {
  return { include: ["tokens/core/**/*.json"], source: [\`tokens/\${theme}/**/*.json\`], ${PLATFORMS} };
}
for (const theme of ["light", "dark"]) { await new StyleDictionary(getConfig(theme)).buildAllPlatforms(); }`,
        ],
        [
            "sd.config.ts",
            `const THEMES = ["light", "dark"];
THEMES.forEach((theme) => {
  const sd = StyleDictionary.extend({ source: ["tokens/core/**/*.json", \`tokens/\${theme}/**/*.json\`], ${PLATFORMS} });
  sd.buildAllPlatforms();
});`,
        ],
        [
            "build.js",
            `const build = (mode) => ({ source: ["tokens/core/**/*.json", \`tokens/\${mode}/*.json\`], ${PLATFORMS} });
["light", "dark"].map(build).forEach((config) => StyleDictionary.extend(config).buildAllPlatforms());`,
        ],
    ] as const) {
        assert.deepEqual(
            roles(scanTokens(project({ ...tokens, [file]: text }))),
            DARK_ROLES,
            text.slice(0, 80),
        );
    }
});

test("the mode of a config: a name, a key, the folders of its globs; a config for a platform is no mode", () => {
    assert.deepEqual(
        scanTokens(
            project({
                "config.json": { source: ["tokens/*.json"], platforms: JSON_PLATFORMS },
                "config.android.json": { source: ["tokens/*.json"], platforms: JSON_PLATFORMS },
                "config.web.json": { source: ["tokens/*.json"], platforms: JSON_PLATFORMS },
                "tokens/a.json": { size: { radius: { md: classic("8px") } } },
            }),
        ).inferred.notes.filter((note) => /configs for modes/.test(note)),
        [],
    );

    const scan = scanTokens(
        project({
            "config.json": { source: ["tokens/global/**/*.json"], platforms: JSON_PLATFORMS },
            "config.acme.json": {
                source: ["tokens/global/**/*.json", "tokens/brands/acme/*.json"],
                platforms: JSON_PLATFORMS,
            },
            "tokens/global/color.json": {
                color: {
                    accent: { default: classic("#3b82f6") },
                    text: { primary: classic("#111111") },
                    bg: { page: classic("#ffffff") },
                },
            },
            "tokens/brands/acme/color.json": { color: { accent: { default: classic("#e11d48") } } },
        }),
    );

    assert.equal(hex(load(scan), "color.accent.default"), "#3b82f6");
    assert.equal(scan.draft.modes.acme !== undefined, true, "a mode for the brand");
    assert.equal(
        JSON.stringify(scan.draft.modes.acme).includes("#e11d48"),
        true,
        "the brand changes the accent",
    );
});

test("the configs of a script: the globs, the modes, and what cannot be read", () => {
    const configs = (text: string, file = "build.js") =>
        sdConfigsIn("", file, text).map((each) => [each.mode, each.source]);

    assert.deepEqual(
        configs(
            `module.exports = [{ theme: "dark", source: ["a/*.json"], platforms: {} }, { source: ["b/*.json"], platforms: {} }]`,
        ),
        [
            ["dark", ["a/*.json"]],
            [undefined, ["b/*.json"]],
        ],
    );
    assert.deepEqual(
        configs(
            `const modes = ["light", "dark"]; const f = (mode) => ({ source: [\`t/\${mode}/*.json\`], platforms: {} }); modes.map(f);`,
        ),
        [
            ["light", ["t/light/*.json"]],
            ["dark", ["t/dark/*.json"]],
        ],
    );
    assert.deepEqual(
        configs(
            `const f = (platform) => ({ source: [\`t/\${platform}/*.json\`], platforms: {} }); f("web"); f("ios");`,
        ),
        [[undefined, ["t/${platform}/*.json"]]],
        "a platform is not a mode: the template is left",
    );
    assert.deepEqual(configs(`config.source = getSources(); const p = { platforms: {} }`), []);
    assert.deepEqual(
        configs(`const c = { source: ["a/*.json"] }`),
        [],
        "no platforms: not a config",
    );
    assert.equal(modeOfConfigFile("sd.config.dark.js"), "dark");
    assert.equal(modeOfConfigFile("config/dark.config.mjs"), "dark");
    assert.equal(modeOfConfigFile("themes/acme/config.json"), "acme");
    assert.equal(modeOfConfigFile("config.json"), undefined);
    assert.equal(modeOfConfigFile("config.web.json"), undefined);
    assert.equal(modeOfConfigFile("build.js"), undefined);
});

test("hostile configs run in bounded time: thousands of `source: [`, templates with `$`, and a list that does not close", () => {
    const started = Date.now();

    for (const text of [
        `const platforms = {};\n${"x = { source: [".repeat(8000)}`,
        `${"{ source: ['a'], platforms: {} },".repeat(3000)}`,
        `const f = ($t) => ({ source: [\`tokens/\${$t}/*.json\`], platforms: {} }); f("dark"); f("light");`,
        `const f = (theme) => ({ source: [\`\${theme}/\${theme}/\${theme}\`], platforms: {} });\n${'["a","b"].map((theme) => f(theme));'.repeat(500)}`,
        `{ "source": [${'"a",'.repeat(50_000)}`,
        `({ source: ['a'], platforms: ${"{".repeat(30_000)}`,
    ]) {
        assert.doesNotThrow(() => sdConfigsIn("", "build.js", text), text.slice(0, 50));
    }

    assert.deepEqual(
        sdConfigsIn(
            "",
            "b.js",
            `const f = ($t) => ({ source: [\`tokens/\${$t}/*.json\`], platforms: {} }); f("dark"); f("light");`,
        ).map((each) => each.mode),
        ["dark", "light"],
    );
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});

test("a config's source glob does not lead out of the project: not by `../`, not by a folder link", () => {
    const outside = project({
        "private.json": { font: { family: { $type: "fontFamily", $value: "OUTSIDE_SENTINEL" } } },
    });

    for (const glob of ["../out/*.json", "external/*.json"]) {
        const dir = project({ "app/config.json": { source: [glob], platforms: { css: {} } } });

        symlinkSync(outside, join(dir, "out"));
        symlinkSync(outside, join(dir, "app", "external"));
        assert.ok(!scanReport(scanTokens(join(dir, "app"))).includes("OUTSIDE_SENTINEL"), glob);
    }
});
