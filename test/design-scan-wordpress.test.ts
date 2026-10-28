// WordPress `theme.json` (versions 2 and 3) in the scan: the palette and gradients, the font sizes (fluid or not) and
// families (also with only `fontFace`), spacing sizes and `spacingScale`, shadow presets, `settings.custom`, and style
// variations (`styles/*.json`: a dark one is the dark mode, any other look is left out).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-wp-"));

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

const SCHEMA = "https://schemas.wp.org/trunk/theme.json";
const slugs = (pairs: [string, string][]) =>
    pairs.map(([slug, color]) => ({ slug, color, name: slug }));
const LIGHT = slugs([
    ["background", "#fbfaf7"],
    ["foreground", "#1c1b19"],
    ["primary", "#b5451b"],
    ["surface", "#f0ece3"],
    ["muted", "#6e685d"],
    ["border", "#ddd5c6"],
]);
const DARK = slugs([
    ["background", "#14130f"],
    ["foreground", "#ece8df"],
    ["primary", "#e8825a"],
    ["surface", "#201e19"],
    ["muted", "#a8a193"],
    ["border", "#3a372f"],
]);

test("version 2: palette, gradients, fluid and plain font sizes, families with fontFace, spacing sizes, shadows, custom", () => {
    const scan = scanTokens(
        project({
            "theme.json": {
                $schema: SCHEMA,
                version: 2,
                settings: {
                    color: {
                        palette: LIGHT,
                        gradients: [
                            {
                                slug: "sunrise",
                                name: "Sunrise",
                                gradient: "linear-gradient(135deg,#f6d365 0%,#fda085 100%)",
                            },
                            {
                                slug: "bad",
                                name: "Bad",
                                gradient: "url(https://x.test/a.png); } body { display: none",
                            },
                        ],
                    },
                    typography: {
                        fluid: true,
                        fontSizes: [
                            { slug: "small", size: "0.8125rem" },
                            { slug: "base", size: "1rem" },
                            {
                                slug: "large",
                                size: "1.375rem",
                                fluid: { min: "1.125rem", max: "1.375rem" },
                            },
                            {
                                slug: "huge",
                                size: "3.5rem",
                                fluid: { min: "2.25rem", max: "3.5rem" },
                            },
                            { slug: "px", size: "15px", fluid: false },
                        ],
                        fontFamilies: [
                            {
                                slug: "serif",
                                name: "Serif",
                                fontFamily: '"Newsreader", Georgia, serif',
                                fontFace: [
                                    {
                                        fontFamily: "Newsreader",
                                        fontWeight: "400",
                                        src: ["file:./a.woff2"],
                                    },
                                ],
                            },
                            {
                                slug: "sans",
                                name: "Sans",
                                fontFamily: '"Public Sans", system-ui, sans-serif',
                            },
                        ],
                    },
                    spacing: {
                        spacingSizes: [
                            { slug: "30", size: "0.75rem", name: "XS" },
                            { slug: "40", size: "1rem", name: "S" },
                            { slug: "50", size: "1.5rem", name: "M" },
                        ],
                    },
                    shadow: {
                        presets: [
                            {
                                slug: "natural",
                                name: "Natural",
                                shadow: "6px 6px 9px rgba(0,0,0,0.2)",
                            },
                        ],
                    },
                    custom: { radius: { sm: "3px", md: "8px" }, lineHeight: { body: 1.65 } },
                },
                styles: {
                    color: {
                        background: "var(--wp--preset--color--background)",
                        text: "var(--wp--preset--color--foreground)",
                    },
                },
            },
        }),
    );
    const system = load(scan);

    assert.equal(hex(system, "color.bg.page"), "#fbfaf7");
    assert.equal(
        css(system, "gradient.sunrise"),
        "linear-gradient(135deg,#f6d365 0%,#fda085 100%)",
    );
    assert.equal(
        token(system, "gradient.bad"),
        undefined,
        "a value that is not a gradient is not written into the tokens",
    );
    assert.equal(css(system, "text.small"), "0.8125rem");
    assert.equal(css(system, "text.large"), "1.375rem", "`size` is the size at the widest screen");
    assert.equal(css(system, "text.huge"), "3.5rem");
    assert.equal(css(system, "text.px"), "15px");
    assert.equal(token(system, "font.serif")!.modes.light!.css, "Newsreader, Georgia, serif");
    assert.equal(token(system, "font.sans")!.type, "fontFamily");
    assert.equal(css(system, "space.40"), "1rem");
    assert.equal(token(system, "shadow.natural")!.type, "shadow");
    assert.equal(css(system, "radius.custom-radius-md"), "8px");
    assert.equal(scan.inferred.typeScale.sizes.length >= 4, true);
});

test("version 3: fluid min and max only, a family with only fontFace, and a size that has only fluid.max", () => {
    const system = load(
        scanTokens(
            project({
                "wp-content/themes/tidy/theme.json": {
                    $schema: SCHEMA,
                    version: 3,
                    settings: {
                        color: {
                            palette: slugs([
                                ["base", "#ffffff"],
                                ["contrast", "#000000"],
                                ["accent", "#ff5a36"],
                            ]),
                        },
                        typography: {
                            fluid: { minViewportWidth: "320px", maxViewportWidth: "1280px" },
                            fontSizes: [
                                {
                                    slug: "medium",
                                    size: "1.125rem",
                                    fluid: { min: "1rem", max: "1.125rem" },
                                },
                                { slug: "x-large", fluid: { min: "2rem", max: "3rem" } },
                            ],
                            fontFamilies: [
                                {
                                    slug: "body",
                                    name: "Body",
                                    fontFace: [
                                        {
                                            fontFamily: "Manrope",
                                            fontWeight: "200 800",
                                            src: ["file:./m.woff2"],
                                        },
                                    ],
                                },
                                { slug: "lora", name: "Lora", fontFamily: "Lora, serif" },
                            ],
                        },
                    },
                },
            }),
        ),
    );

    assert.equal(css(system, "text.medium"), "1.125rem");
    assert.equal(
        css(system, "text.x-large"),
        "3rem",
        "fluid.max says the size when `size` is missing",
    );
    assert.equal(css(system, "font.body"), "Manrope");
    assert.equal(css(system, "font.lora"), "Lora, serif");
});

test("spacingScale: sizes from mediumStep, with * and +, as WordPress makes them", () => {
    const sizes = (scale: Record<string, unknown>) => {
        const system = load(
            scanTokens(
                project({
                    "theme.json": {
                        $schema: SCHEMA,
                        version: 3,
                        settings: { color: { palette: LIGHT }, spacing: { spacingScale: scale } },
                    },
                }),
            ),
        );

        return system.tokens
            .filter((each) => each.name.startsWith("space."))
            .map((each) => `${each.name.slice(6)}=${css(system, each.name)}`);
    };

    assert.deepEqual(
        sizes({ operator: "*", increment: 1.5, steps: 7, mediumStep: 1.5, unit: "rem" }),
        [
            "20=0.44rem",
            "30=0.67rem",
            "40=1rem",
            "50=1.5rem",
            "60=2.25rem",
            "70=3.38rem",
            "80=5.06rem",
        ],
    );
    // `+`: 1 - 0.5 is 0.5, and 0.5 - 0.5 is not a size, so the scale starts at slug 40.
    assert.deepEqual(
        sizes({ operator: "+", increment: 0.5, steps: 5, mediumStep: 1, unit: "rem" }),
        ["40=0.5rem", "50=1rem", "60=1.5rem", "70=2rem"],
    );
    assert.deepEqual(
        sizes({ operator: "*", increment: 2, steps: 0, mediumStep: 1 }),
        [],
        "no steps, no scale",
    );
    assert.deepEqual(
        sizes({ operator: "*", increment: 0, steps: 5, mediumStep: 1 }),
        [],
        "no increment, no scale",
    );
});

test("style variations: a dark one (by its title, its file name, or its base color) is the dark mode; another look is left out", () => {
    const files = (variations: Record<string, unknown>) => ({
        "theme.json": {
            $schema: SCHEMA,
            version: 3,
            settings: { color: { palette: LIGHT } },
            styles: { color: { background: "var(--wp--preset--color--background)" } },
        },
        ...variations,
    });
    const other = slugs([
        ["background", "#e6f4f7"],
        ["foreground", "#0c3b4a"],
        ["primary", "#0e7490"],
    ]);

    // By title.
    let system = load(
        scanTokens(
            project(
                files({
                    "styles/night-owl.json": {
                        version: 3,
                        title: "Dark",
                        settings: { color: { palette: DARK } },
                    },
                }),
            ),
        ),
    );

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg.page", "dark"), "#14130f");
    assert.equal(hex(system, "color.accent.default", "dark"), "#e8825a");

    // By file name.
    system = load(
        scanTokens(
            project(
                files({
                    "styles/dark.json": { version: 3, settings: { color: { palette: DARK } } },
                }),
            ),
        ),
    );

    assert.equal(hex(system, "color.bg.page", "dark"), "#14130f");

    // By the base color alone: a title and a name that say nothing.
    system = load(
        scanTokens(
            project(
                files({
                    "styles/ink.json": {
                        version: 3,
                        title: "Ink",
                        settings: { color: { palette: DARK } },
                    },
                }),
            ),
        ),
    );

    assert.equal(
        hex(system, "color.bg.page", "dark"),
        "#14130f",
        "a dark base color makes it the dark mode",
    );

    // Another look is not the theme's default: the default stays what theme.json says.
    system = load(
        scanTokens(
            project(
                files({
                    "styles/ocean.json": {
                        version: 3,
                        title: "Ocean",
                        settings: { color: { palette: other } },
                    },
                    "styles/colors/sand.json": {
                        version: 3,
                        title: "Sand",
                        settings: { color: { palette: other } },
                    },
                }),
            ),
        ),
    );

    assert.deepEqual(system.modes, ["light"]);
    assert.equal(
        hex(system, "color.bg.page"),
        "#fbfaf7",
        "the ocean look did not replace the default",
    );
    assert.equal(hex(system, "color.accent.default"), "#b5451b");

    // A dark-first theme with a light variation.
    system = load(
        scanTokens(
            project({
                "theme.json": {
                    $schema: SCHEMA,
                    version: 3,
                    settings: { color: { palette: DARK } },
                    styles: { color: { background: "var(--wp--preset--color--background)" } },
                },
                "styles/light.json": {
                    version: 3,
                    title: "Light",
                    settings: { color: { palette: LIGHT } },
                },
            }),
        ),
    );

    assert.deepEqual(system.modes, ["dark", "light"], "the default mode is the dark one");
    assert.equal(hex(system, "color.bg.page", "dark"), "#14130f");
    assert.equal(hex(system, "color.bg.page", "light"), "#fbfaf7");
});

test("settings.custom: values are read by the first word of the path or by their syntax, and may refer to other custom values", () => {
    const system = load(
        scanTokens(
            project({
                "theme.json": {
                    $schema: SCHEMA,
                    version: 3,
                    settings: {
                        color: {
                            palette: slugs([
                                ["paper", "#faf9f6"],
                                ["ink", "#18181b"],
                                ["signal", "#e11d48"],
                            ]),
                        },
                        custom: {
                            font: {
                                body: '"Atkinson Hyperlegible", sans-serif',
                                display: '"DM Serif Display", serif',
                            },
                            fontSize: { base: "1.0625rem", display: "clamp(2.5rem, 5vw, 4rem)" },
                            radius: { card: "10px" },
                            lineHeight: { body: 1.6 },
                            gradient: { hero: "linear-gradient(180deg, #fff 0%, #eee 100%)" },
                        },
                        typography: {
                            fontSizes: [
                                { slug: "body", size: "var(--wp--custom--font-size--base)" },
                                {
                                    slug: "hero",
                                    size: "var(--wp--custom--font-size--display)",
                                    fluid: { min: "2.5rem", max: "4rem" },
                                },
                            ],
                            fontFamilies: [
                                {
                                    slug: "text",
                                    name: "Text",
                                    fontFamily: "var(--wp--custom--font--body)",
                                },
                                {
                                    slug: "title",
                                    name: "Title",
                                    fontFamily: "var(--wp--custom--font--display)",
                                },
                            ],
                        },
                    },
                },
            }),
        ),
    );

    assert.equal(css(system, "text.body"), "1.0625rem", "a size that refers to a custom value");
    assert.equal(css(system, "font.text"), '"Atkinson Hyperlegible", sans-serif');
    assert.equal(css(system, "font.title"), '"DM Serif Display", serif');
    assert.equal(css(system, "radius.custom-radius-card"), "10px");
    assert.equal(
        css(system, "gradient.custom-gradient-hero"),
        "linear-gradient(180deg, #fff 0%, #eee 100%)",
    );
    assert.equal(token(system, "leading.custom-line-height-body")?.type, "number");
});

test("the page and the text by WordPress's own names: base and contrast", () => {
    const scan = scanTokens(
        project({
            "theme.json": {
                $schema: SCHEMA,
                version: 3,
                settings: {
                    color: {
                        palette: slugs([
                            ["base", "#ffffff"],
                            ["contrast", "#111111"],
                            ["accent-1", "#d8613c"],
                            ["accent-2", "#b1c5a4"],
                        ]),
                    },
                },
            },
            "styles/dark.json": {
                version: 3,
                title: "Dark",
                settings: {
                    color: {
                        palette: slugs([
                            ["base", "#111111"],
                            ["contrast", "#ffffff"],
                            ["accent-1", "#e8825a"],
                            ["accent-2", "#3d4a35"],
                        ]),
                    },
                },
            },
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background?.value, "#ffffff");
    assert.equal(roles.background?.dark, "#111111");
    assert.equal(roles.text?.value, "#111111");
    assert.equal(roles.text?.dark, "#ffffff");
    assert.equal(roles.background?.basis, "name");

    // The same words in a project that is not WordPress are not read as roles.
    const plain = scanTokens(
        project({ "a.css": ":root { --base: #ffffff; --contrast: #111111; --accent-1: #d8613c }" }),
    );

    assert.equal(
        plain.inferred.roles.background?.basis === "name" &&
            plain.inferred.roles.background.source === "base",
        false,
    );
});

test("a gradient in a stylesheet variable is a gradient token, and its stops are not palette colors of their own", () => {
    const system = load(
        scanTokens(
            project({
                "a.css": `:root { --bg: #ffffff; --text: #111111; --hero: linear-gradient(135deg, #f6d365 0%, #fda085 100%); --fade: radial-gradient(circle at 50% 0%, rgba(255,255,255,.4), transparent 70%); --bad: linear-gradient(red, blue); }
.hero { background: var(--hero) } body { background: var(--bg); color: var(--text) }`,
            }),
        ),
    );

    assert.equal(token(system, "gradient.hero")?.type, "gradient");
    assert.equal(token(system, "gradient.fade")?.type, "gradient");
});

test("a stylesheet that is read before theme.json still has its WordPress names read", () => {
    const scan = scanTokens(
        project({
            "style.css":
                "body { background: var(--wp--preset--color--paper); color: var(--wp--preset--color--ink) } a { color: var(--wp--preset--color--signal) }",
            "wp-content/themes/deep/inc/config/theme.json": {
                $schema: SCHEMA,
                version: 3,
                settings: {
                    color: {
                        palette: slugs([
                            ["paper", "#faf9f6"],
                            ["ink", "#18181b"],
                            ["signal", "#e11d48"],
                        ]),
                    },
                },
            },
        }),
    );

    assert.equal(scan.inferred.roles.background?.value, "#faf9f6");
    assert.equal(scan.inferred.roles.text?.value, "#18181b");
    assert.equal(scan.inferred.roles.accent?.value, "#e11d48");
});
