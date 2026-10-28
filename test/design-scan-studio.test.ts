// Tokens Studio files (the Figma plugin's JSON) in the scan: token sets, `$themes`, references across sets, math, and
// color modifiers, in the older (`value`, `type`) and newer (`$value`, `$type`) forms, in one file and in a folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-studio-"));

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

/** A token in the older form. */
const old = (value: unknown, type: string, extra: Record<string, unknown> = {}) => ({
    value,
    type,
    ...extra,
});
/** A token in the newer form. */
const next = (value: unknown, type?: string, extra: Record<string, unknown> = {}) => ({
    $value: value,
    ...(type === undefined ? {} : { $type: type }),
    ...extra,
});

const GLOBAL = {
    color: {
        gray: {
            50: old("#f8fafc", "color"),
            200: old("#e2e8f0", "color"),
            500: old("#64748b", "color"),
            900: old("#0f172a", "color"),
            950: old("#020617", "color"),
        },
        indigo: { 400: old("#818cf8", "color"), 600: old("#4f46e5", "color") },
        red: { 400: old("#f87171", "color"), 500: old("#ef4444", "color") },
        white: old("#ffffff", "color"),
    },
    spacing: {
        base: old("4", "spacing"),
        sm: old("{spacing.base} * 2", "spacing"),
        md: old("{spacing.base}*4", "spacing"),
        lg: old("{spacing.md} + {spacing.sm}", "spacing"),
    },
    fontFamilies: { sans: old("Inter", "fontFamilies") },
    fontWeights: { regular: old("Regular", "fontWeights"), bold: old("Semi Bold", "fontWeights") },
    fontSizes: {
        base: old("16", "fontSizes"),
        lg: old("{fontSizes.base} * 1.25", "fontSizes"),
        xl: old("round({fontSizes.base} * 1.6)", "fontSizes"),
    },
    lineHeights: { body: old("150%", "lineHeights") },
    letterSpacing: { tight: old("-2%", "letterSpacing") },
    typography: {
        body: old(
            {
                fontFamily: "{fontFamilies.sans}",
                fontWeight: "{fontWeights.regular}",
                lineHeight: "{lineHeights.body}",
                fontSize: "{fontSizes.base}",
                letterSpacing: "{letterSpacing.tight}",
                textCase: "none",
                paragraphSpacing: "0",
            },
            "typography",
        ),
    },
};
const LIGHT = {
    color: {
        bg: { page: old("{color.gray.50}", "color"), surface: old("{color.white}", "color") },
        text: { primary: old("{color.gray.900}", "color") },
        accent: { default: old("{color.indigo.600}", "color") },
        danger: { default: old("{color.red.500}", "color") },
        overlay: old("rgba({color.gray.950}, 0.5)", "color"),
        soft: old("{color.indigo.600}", "color", {
            $extensions: {
                "studio.tokens": { modify: { type: "alpha", value: "0.2", space: "srgb" } },
            },
        }),
    },
};
const DARK = {
    color: {
        bg: { page: old("{color.gray.950}", "color"), surface: old("{color.gray.900}", "color") },
        text: { primary: old("{color.gray.50}", "color") },
        accent: { default: old("{color.indigo.400}", "color") },
        danger: { default: old("{color.red.400}", "color") },
        glow: old("{color.indigo.400}", "color"),
    },
};
const THEMES = [
    {
        id: "a",
        name: "Light",
        selectedTokenSets: { global: "source", light: "enabled", dark: "disabled" },
    },
    {
        id: "b",
        name: "Dark",
        selectedTokenSets: { global: "source", light: "disabled", dark: "enabled" },
    },
];

test("one file, the older form: every set is read, the themes make the modes, and a reference crosses sets", () => {
    const scan = scanTokens(
        project({
            "tokens.json": {
                global: GLOBAL,
                light: LIGHT,
                dark: DARK,
                $themes: THEMES,
                $metadata: { tokenSetOrder: ["global", "light", "dark"] },
            },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(
        token(system, "color.bg.page")!.modes.light!.alias,
        "color.gray.50",
        "a reference stays one",
    );
    assert.equal(hex(system, "color.bg.page"), "#f8fafc");
    assert.equal(
        hex(system, "color.bg.page", "dark"),
        "#020617",
        "the dark theme turns on the dark set",
    );
    assert.equal(hex(system, "color.accent.default", "dark"), "#818cf8");
    assert.equal(hex(system, "color.text.primary", "dark"), "#f8fafc");
    // The set's name is not part of a path; a set that no mode turns on is not read.
    assert.equal(token(system, "global.color.gray.50"), undefined);
    assert.equal(token(system, "dark.color.bg.page"), undefined);
    // The default set's tokens are all there once, and the dark set's token that the default lacks is left out.
    assert.equal(token(system, "color.glow"), undefined);
    assert.ok(
        scan.inferred.notes.some((note) =>
            /1 tokens that only the dark mode has were left out/.test(note),
        ),
    );
    assert.ok(
        scan.inferred.notes.some((note) =>
            /default mode is global \+ light; the dark mode is global \+ dark/.test(note),
        ),
    );
    assert.equal(scan.inferred.imported, system.tokens.length);
});

test("math is evaluated, with units, functions, and references: {a} * 2, {a}*4, {a} + {b}, round()", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global"] },
                },
            }),
        ),
    );

    assert.equal(css(system, "spacing.base"), "4px", "a bare number in a spacing token is px");
    assert.equal(css(system, "spacing.sm"), "8px");
    assert.equal(css(system, "spacing.md"), "16px");
    assert.equal(css(system, "spacing.lg"), "24px", "two references added");
    assert.equal(css(system, "fontSizes.lg"), "20px");
    assert.equal(css(system, "fontSizes.xl"), "26px", "round(16 * 1.6)");
});

test("values of Figma's forms: weights by name, line height in percent, letter spacing in percent, and a type style", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global"] },
                },
            }),
        ),
    );

    assert.equal(token(system, "fontWeights.regular")!.modes.light!.value, 400);
    assert.equal(token(system, "fontWeights.bold")!.modes.light!.value, 600, "Semi Bold");
    assert.equal(css(system, "lineHeights.body"), "1.5");
    assert.equal(css(system, "letterSpacing.tight"), "-0.02em");

    const style = token(system, "typography.body")!.modes.light!.parts!;

    assert.equal(style["font-size"], "16px", "a member that is a reference is followed");
    assert.equal(style["font-weight"], "400");
    assert.equal(style["line-height"], "1.5");
    assert.equal(style["letter-spacing"], "-0.02em");
    assert.match(style["font-family"]!, /Inter/);
});

test("a color: rgba() of a reference, and a modifier (alpha, lighten, darken, mix)", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    light: {
                        color: {
                            ...LIGHT.color,
                            lighter: old("#2563eb", "color", {
                                $extensions: {
                                    "studio.tokens": { modify: { type: "lighten", value: "0.5" } },
                                },
                            }),
                            darker: old("#2563eb", "color", {
                                $extensions: {
                                    "studio.tokens": { modify: { type: "darken", value: "0.5" } },
                                },
                            }),
                            mixed: old("#ff0000", "color", {
                                $extensions: {
                                    "studio.tokens": {
                                        modify: {
                                            type: "mix",
                                            value: "0.5",
                                            color: "{color.white}",
                                        },
                                    },
                                },
                            }),
                        },
                    },
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global", "light"] },
                },
            }),
        ),
    );

    assert.equal(hex(system, "color.overlay"), "#02061780");
    assert.equal(hex(system, "color.soft"), "#4f46e533", "alpha 0.2");
    assert.equal(hex(system, "color.lighter"), "#92b1f5", "half way to white");
    assert.equal(hex(system, "color.darker"), "#133276", "half way to black");
    assert.equal(hex(system, "color.mixed"), "#ff8080", "half red, half white");
});

test("one file, the newer form: group types, `$value`, sets with a slash, and a theme named for night", () => {
    const system = load(
        scanTokens(
            project({
                "design/tokens.json": {
                    core: {
                        $type: "color",
                        slate: { 50: next("#f6f7f9"), 900: next("#101828"), 950: next("#0b1220") },
                        teal: { 400: next("#2dd4bf"), 700: next("#0f766e") },
                        size: {
                            $type: "dimension",
                            unit: next("8px"),
                            2: next("{size.unit} * 2"),
                            4: next("{size.unit} * 4"),
                        },
                    },
                    "brand/acme": { color: { $type: "color", brand: next("{slate.900}") } },
                    "mode/light": {
                        color: { $type: "color", bg: next("{slate.50}"), link: next("{teal.700}") },
                    },
                    "mode/dark": {
                        color: {
                            $type: "color",
                            bg: next("{slate.950}"),
                            link: next("{teal.400}"),
                        },
                    },
                    $themes: [
                        {
                            id: "1",
                            name: "Day",
                            selectedTokenSets: {
                                core: "source",
                                "brand/acme": "enabled",
                                "mode/light": "enabled",
                            },
                            $figmaStyleReferences: {},
                        },
                        {
                            id: "2",
                            name: "Night",
                            selectedTokenSets: {
                                core: "source",
                                "brand/acme": "enabled",
                                "mode/dark": "enabled",
                            },
                            $figmaStyleReferences: {},
                        },
                    ],
                    $metadata: { tokenSetOrder: ["core", "brand/acme", "mode/light", "mode/dark"] },
                },
            }),
        ),
    );

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg"), "#f6f7f9");
    assert.equal(hex(system, "color.bg", "dark"), "#0b1220");
    assert.equal(hex(system, "color.link", "dark"), "#2dd4bf");
    assert.ok(
        token(system, "color.brand"),
        "a set that both themes turn on is in the default mode",
    );
    assert.equal(css(system, "size.4"), "32px");
});

test("a folder of Tokens Studio files: $metadata.json, $themes.json, and a file for each set, in folders", () => {
    const scan = scanTokens(
        project({
            "tokens/$metadata.json": {
                tokenSetOrder: ["global", "semantic/light", "semantic/dark", "brand/b2c"],
            },
            "tokens/$themes.json": [
                {
                    id: "x1",
                    name: "light",
                    selectedTokenSets: {
                        global: "source",
                        "semantic/light": "enabled",
                        "brand/b2c": "enabled",
                    },
                },
                {
                    id: "x2",
                    name: "dark",
                    selectedTokenSets: {
                        global: "source",
                        "semantic/dark": "enabled",
                        "brand/b2c": "enabled",
                    },
                },
            ],
            "tokens/global.json": GLOBAL,
            "tokens/semantic/light.json": LIGHT,
            "tokens/semantic/dark.json": DARK,
            "tokens/brand/b2c.json": { color: { brand: old("{color.indigo.600}", "color") } },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg.page", "dark"), "#020617");
    assert.equal(hex(system, "color.brand"), "#4f46e5");
    assert.equal(css(system, "spacing.lg"), "24px");
    assert.equal(token(system, "global.color.gray.50"), undefined);
    assert.equal(scan.files.length, 6);
});

test("a folder whose name is not tokens: the files beside $themes.json are the sets", () => {
    const system = load(
        scanTokens(
            project({
                "figma/$themes.json": [
                    {
                        id: "1",
                        name: "Light",
                        selectedTokenSets: { base: "source", day: "enabled" },
                    },
                    {
                        id: "2",
                        name: "Dark",
                        selectedTokenSets: { base: "source", night: "enabled" },
                    },
                ],
                "figma/$metadata.json": { tokenSetOrder: ["base", "day", "night"] },
                "figma/base.json": GLOBAL,
                "figma/day.json": LIGHT,
                "figma/night.json": DARK,
            }),
        ),
    );

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg.page", "dark"), "#020617");
});

test("no themes: sets named for dark are the dark mode, the others are the default", () => {
    for (const [base, lightName, darkName] of [
        ["global", "light", "dark"],
        ["core", "Mode/Light", "Mode/Dark"],
        ["base", "theme-light", "theme-dark"],
        ["Primitives", "LightMode", "DarkMode"],
    ] as const) {
        const system = load(
            scanTokens(
                project({
                    "tokens.json": { [base]: GLOBAL, [lightName]: LIGHT, [darkName]: DARK },
                }),
            ),
        );
        const label = [base, lightName, darkName].join(", ");

        assert.deepEqual(system.modes, ["light", "dark"], label);
        assert.equal(hex(system, "color.bg.page"), "#f8fafc", label);
        assert.equal(hex(system, "color.bg.page", "dark"), "#020617", label);
        assert.equal(css(system, "spacing.lg"), "24px", label);
    }
});

test("themes in groups apply together: a mode group and a brand group; extra themes of the mode group are modes", () => {
    const scan = scanTokens(
        project({
            "tokens.json": {
                core: GLOBAL,
                light: LIGHT,
                dark: DARK,
                contrast: {
                    color: {
                        bg: { page: old("#000000", "color") },
                        text: { primary: old("#ffffff", "color") },
                    },
                },
                "brand-a": { color: { brand: old("{color.indigo.600}", "color") } },
                "brand-b": { color: { brand: old("{color.red.500}", "color") } },
                $themes: [
                    {
                        id: "1",
                        name: "Light",
                        group: "Mode",
                        selectedTokenSets: { core: "source", light: "enabled" },
                    },
                    {
                        id: "2",
                        name: "Dark",
                        group: "Mode",
                        selectedTokenSets: { core: "source", dark: "enabled" },
                    },
                    {
                        id: "3",
                        name: "High contrast",
                        group: "Mode",
                        selectedTokenSets: { core: "source", contrast: "enabled" },
                    },
                    {
                        id: "4",
                        name: "Brand A",
                        group: "Brand",
                        selectedTokenSets: { "brand-a": "enabled" },
                    },
                    {
                        id: "5",
                        name: "Brand B",
                        group: "Brand",
                        selectedTokenSets: { "brand-b": "enabled" },
                    },
                ],
                $metadata: {
                    tokenSetOrder: ["core", "light", "dark", "contrast", "brand-a", "brand-b"],
                },
            },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark", "high-contrast"]);
    assert.equal(hex(system, "color.brand"), "#4f46e5", "the first brand theme");
    assert.equal(hex(system, "color.brand", "dark"), "#4f46e5", "the brand is in every mode");
    assert.equal(hex(system, "color.bg.page", "high-contrast"), "#000000");
    assert.equal(hex(system, "color.text.primary", "high-contrast"), "#ffffff");
    assert.ok(scan.inferred.notes.some((note) => /Brand B/.test(note) && /scan reads/.test(note)));
});

test("a theme that is only dark is the default mode; a theme that is not dark and has no dark set has one mode", () => {
    const onlyDark = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    dark: DARK,
                    $themes: [
                        {
                            id: "1",
                            name: "Dark",
                            selectedTokenSets: { global: "source", dark: "enabled" },
                        },
                    ],
                    $metadata: { tokenSetOrder: ["global", "dark"] },
                },
            }),
        ),
    );

    assert.equal(hex(onlyDark, "color.bg.page"), "#020617", "the dark theme is the default");
    assert.equal(onlyDark.modes.length, 1);

    const one = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    light: LIGHT,
                    $themes: [
                        {
                            id: "1",
                            name: "Default",
                            selectedTokenSets: { global: "enabled", light: "enabled" },
                        },
                    ],
                    $metadata: { tokenSetOrder: ["global", "light"] },
                },
            }),
        ),
    );

    assert.equal(one.modes.length, 1);
    assert.equal(hex(one, "color.accent.default"), "#4f46e5");
});

test("the oldest forms: `$color.primary` references, spaces in names, and a legacy file with one set", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    "Core Tokens": {
                        color: {
                            "Gray 900": old("#111827", "color"),
                            "Blue 600": old("#2563eb", "color"),
                            link: old("{color.Blue 600}", "color"),
                        },
                        space: {
                            unit: old("4", "spacing"),
                            two: old("$space.unit * 2", "spacing"),
                        },
                        text: { label: old("Label", "text") },
                    },
                    $themes: [],
                    $metadata: { tokenSetOrder: ["Core Tokens"] },
                },
            }),
        ),
    );

    assert.equal(hex(system, "color.Gray-900"), "#111827");
    assert.equal(token(system, "color.link")!.modes.light!.alias, "color.Blue-600");
    assert.equal(css(system, "space.two"), "8px");
    assert.equal(token(system, "text.label"), undefined, "a text token is left out");
});

test("a reference that loops or points nowhere drops that token, not the scan; set names that are unsafe are only names", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: {
                        color: {
                            a: old("{color.b}", "color"),
                            b: old("{color.a}", "color"),
                            c: old("{color.nowhere}", "color"),
                            fine: old("#123456", "color"),
                            d: old("#abcdef", "color"),
                            e: old("#fedcba", "color"),
                        },
                        space: {
                            1: old("1", "spacing"),
                            2: old("2", "spacing"),
                            3: old("3 * ", "spacing"),
                            4: old("1 / 0", "spacing"),
                        },
                    },
                    __proto__: { color: { x: old("#000000", "color") } },
                    constructor: { color: { y: old("#000000", "color") } },
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global", "__proto__"] },
                },
            }),
        ),
    );

    assert.ok(token(system, "color.fine"));
    assert.equal(token(system, "color.a"), undefined);
    assert.equal(token(system, "color.b"), undefined);
    assert.equal(token(system, "color.c"), undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined, "nothing reached Object.prototype");
});

test("a round trip: the Tokens Studio file that Pi Pocket exports reads back as the same system, in every mode", () => {
    const flagship = join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket");
    const original = loadDesignSystem(flagship)!;
    const dir = project({ "tokens.json": original.compiled.studio! });
    const scan = scanTokens(dir);
    const back = load(scan);

    assert.deepEqual(back.modes, original.modes);
    assert.equal(back.tokens.length, original.tokens.length);

    const byName = new Map(back.tokens.map((each) => [each.name, each]));
    const wrong: string[] = [];

    for (const each of original.tokens) {
        const found = byName.get(each.name);

        for (const mode of original.modes) {
            const a = each.modes[mode]?.literal;
            const b = found?.modes[mode]?.literal;

            if (found === undefined || a !== b) {
                wrong.push(`${each.name} ${mode}: ${a} / ${b}`);
            }
        }
    }

    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} tokens differ`);
    assert.ok(readFileSync(join(dir, "tokens.json"), "utf8").includes("$themes"));
});
