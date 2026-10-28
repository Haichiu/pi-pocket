// Material 3 exports in the scan: the Theme Builder's CSS (a file or a class for each scheme, with --md-sys-color-*) and its
// JSON ("schemes", "palettes"). M3 roles take this system's names; contrast schemes are modes; no warning or success is made up.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanReport, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-m3-"));

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
const hex = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.hex;

// The baseline schemes of Material 3 (seed #6750A4).
const LIGHT: Record<string, string> = {
    primary: "6750A4",
    onPrimary: "FFFFFF",
    primaryContainer: "EADDFF",
    onPrimaryContainer: "21005D",
    secondary: "625B71",
    onSecondary: "FFFFFF",
    secondaryContainer: "E8DEF8",
    onSecondaryContainer: "1D192B",
    tertiary: "7D5260",
    onTertiary: "FFFFFF",
    tertiaryContainer: "FFD8E4",
    onTertiaryContainer: "31111D",
    error: "B3261E",
    onError: "FFFFFF",
    errorContainer: "F9DEDC",
    onErrorContainer: "410E0B",
    background: "FEF7FF",
    onBackground: "1D1B20",
    surface: "FEF7FF",
    onSurface: "1D1B20",
    surfaceVariant: "E7E0EC",
    onSurfaceVariant: "49454F",
    outline: "79747E",
    outlineVariant: "CAC4D0",
    shadow: "000000",
    scrim: "000000",
    inverseSurface: "322F35",
    inverseOnSurface: "F5EFF7",
    inversePrimary: "D0BCFF",
    surfaceDim: "DED8E1",
    surfaceBright: "FEF7FF",
    surfaceContainerLowest: "FFFFFF",
    surfaceContainerLow: "F7F2FA",
    surfaceContainer: "F3EDF7",
    surfaceContainerHigh: "ECE6F0",
    surfaceContainerHighest: "E6E0E9",
    surfaceTint: "6750A4",
};
const DARK: Record<string, string> = {
    ...LIGHT,
    primary: "D0BCFF",
    onPrimary: "381E72",
    primaryContainer: "4F378B",
    onPrimaryContainer: "EADDFF",
    secondary: "CCC2DC",
    error: "F2B8B5",
    background: "141218",
    onBackground: "E6E0E9",
    surface: "141218",
    onSurface: "E6E0E9",
    surfaceVariant: "49454F",
    onSurfaceVariant: "CAC4D0",
    outline: "938F99",
    outlineVariant: "49454F",
    inverseSurface: "E6E0E9",
    surfaceContainer: "211F26",
    surfaceContainerHigh: "2B2930",
    surfaceTint: "D0BCFF",
};
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const rgb = (value: string) =>
    `rgb(${[0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16)).join(" ")})`;
const block = (
    selector: string,
    scheme: Record<string, string>,
    format: (value: string) => string = (value) => `#${value}`,
) =>
    `${selector} {\n${Object.entries(scheme)
        .map(([name, value]) => `  --md-sys-color-${kebab(name)}: ${format(value)};`)
        .join("\n")}\n}\n`;
const harder = (scheme: Record<string, string>, by: Record<string, string>) => ({
    ...scheme,
    ...by,
});

const PALETTES: Record<string, Record<string, string>> = {
    primary: {
        0: "000000",
        10: "21005D",
        20: "381E72",
        30: "4F378B",
        40: "6750A4",
        80: "D0BCFF",
        90: "EADDFF",
        100: "FFFFFF",
    },
    neutral: { 6: "141218", 10: "1D1B20", 20: "322F35", 90: "E6E0E9", 98: "FEF7FF", 100: "FFFFFF" },
    "neutral-variant": { 30: "49454F", 50: "79747E", 60: "938F99", 80: "CAC4D0", 90: "E7E0EC" },
    error: { 40: "B3261E", 80: "F2B8B5" },
};

const FILES = {
    "css/light.css": block(":root", LIGHT, rgb),
    "css/dark.css": block(":root", DARK, rgb),
    "css/light-mc.css": block(
        ":root",
        harder(LIGHT, { primary: "5B4398", outline: "5F5A64" }),
        rgb,
    ),
    "css/light-hc.css": block(
        ":root",
        harder(LIGHT, { primary: "3A1F7A", onSurface: "000000" }),
        rgb,
    ),
    "css/dark-mc.css": block(":root", harder(DARK, { primary: "E3D2FF" }), rgb),
    "css/dark-hc.css": block(
        ":root",
        harder(DARK, { primary: "F3EAFF", onSurface: "FFFFFF" }),
        rgb,
    ),
};

test("a file for each scheme: light and dark, and the medium and high contrast schemes are modes", () => {
    const scan = scanTokens(project(FILES));
    const system = load(scan);

    assert.deepEqual([...system.modes].sort(), [
        "dark",
        "dark-high-contrast",
        "dark-medium-contrast",
        "light",
        "light-high-contrast",
        "light-medium-contrast",
    ]);
    assert.equal(system.modes[0], "light", "the default is the standard light scheme");
    assert.equal(hex(system, "color.accent.default"), "#6750a4");
    assert.equal(hex(system, "color.accent.default", "dark"), "#d0bcff");
    assert.equal(hex(system, "color.accent.default", "light-medium-contrast"), "#5b4398");
    assert.equal(hex(system, "color.accent.default", "dark-high-contrast"), "#f3eaff");
    assert.equal(hex(system, "color.text.primary", "light-high-contrast"), "#000000");
    assert.equal(hex(system, "color.border.default", "light-medium-contrast"), "#5f5a64");
    assert.equal(
        hex(system, "color.border.default", "light-high-contrast"),
        "#79747e",
        "a mode keeps what it does not change",
    );
    assert.equal(system.schemes.dark, "dark");
    assert.equal(system.schemes["dark-high-contrast"], "dark");
    assert.equal(system.schemes["light-high-contrast"], "light");
});

test("the roles of Material 3 take this system's names; there is no warning or success, and no color named secondary", () => {
    const system = load(scanTokens(project(FILES)));
    const names = system.tokens.map((each) => each.name);

    for (const [name, m3] of Object.entries({
        "color.bg.page": "FEF7FF",
        "color.bg.surface": "FEF7FF",
        "color.bg.surface-container-lowest": "FFFFFF",
        "color.bg.surface-container": "F3EDF7",
        "color.bg.surface-container-highest": "E6E0E9",
        "color.text.primary": "1D1B20",
        "color.text.muted": "49454F",
        "color.text.inverse": "F5EFF7",
        "color.border.default": "79747E",
        "color.border.subtle": "CAC4D0",
        "color.accent.default": "6750A4",
        "color.text.on-accent": "FFFFFF",
        "color.accent.container": "EADDFF",
        "color.danger.default": "B3261E",
        "color.accent-2.default": "625B71",
        "color.accent-3.default": "7D5260",
        "color.bg.inverse": "322F35",
        "color.bg.scrim": "000000",
    })) {
        assert.equal(hex(system, name), `#${m3.toLowerCase()}`, name);
    }

    assert.ok(
        !names.some((name) => /warning|success/.test(name)),
        "Material 3 has none, and none is made up",
    );
    assert.ok(
        !names.some((name) => /\.(secondary|tertiary)\b|\.(secondary|tertiary)\./.test(name)),
        "secondary and tertiary name quiet text here",
    );
    assert.equal(token(system, "color.accent.default")!.description, "Material 3 primary");
});

test("one stylesheet with a class for each scheme, and the palettes: a role points at its palette step, named by hue", () => {
    const palettes = `:root {\n${Object.entries(PALETTES)
        .flatMap(([family, tones]) =>
            Object.entries(tones).map(
                ([tone, value]) => `  --md-ref-palette-${family}${tone}: #${value};`,
            ),
        )
        .join("\n")}\n}\n`;
    const scan = scanTokens(
        project({
            "theme.css": `${palettes}${block(".light", LIGHT)}${block(".dark", DARK)}${block(".light-medium-contrast", harder(LIGHT, { primary: "5B4398" }))}${block(".dark-high-contrast", harder(DARK, { primary: "F3EAFF" }))}`,
        }),
    );
    const system = load(scan);

    assert.deepEqual([...system.modes].sort(), [
        "dark",
        "dark-high-contrast",
        "light",
        "light-medium-contrast",
    ]);
    assert.equal(
        token(system, "color.accent.default")!.modes.light!.alias,
        "color.indigo.40",
        "a palette named for its hue",
    );
    assert.equal(token(system, "color.accent.default")!.modes.dark!.alias, "color.indigo.80");
    assert.equal(
        token(system, "color.text.primary")!.modes.light!.alias,
        "color.neutral.10",
        "the neutral palettes keep their names",
    );
    assert.equal(token(system, "color.text.muted")!.modes.light!.alias, "color.neutral-variant.30");
    assert.equal(hex(system, "color.indigo.40"), "#6750a4");
    assert.equal(
        hex(system, "color.accent.default", "light-medium-contrast"),
        "#5b4398",
        "a color that is on no step is written as it is",
    );
    assert.deepEqual(
        system.problems.filter((problem) => /ramp/.test(problem.message)),
        [],
        "a tonal palette is steady",
    );
});

test("the JSON export: schemes and palettes", () => {
    const system = load(
        scanTokens(
            project({
                "material-theme.json": {
                    description: "TYPE: CUSTOM",
                    seed: "#6750A4",
                    coreColors: { primary: "#6750A4" },
                    extendedColors: [],
                    schemes: {
                        light: Object.fromEntries(
                            Object.entries(LIGHT).map(([name, value]) => [name, `#${value}`]),
                        ),
                        "light-high-contrast": Object.fromEntries(
                            Object.entries(harder(LIGHT, { primary: "3A1F7A" })).map(
                                ([name, value]) => [name, `#${value}`],
                            ),
                        ),
                        dark: Object.fromEntries(
                            Object.entries(DARK).map(([name, value]) => [name, `#${value}`]),
                        ),
                    },
                    palettes: Object.fromEntries(
                        Object.entries(PALETTES).map(([family, tones]) => [
                            family,
                            Object.fromEntries(
                                Object.entries(tones).map(([tone, value]) => [tone, `#${value}`]),
                            ),
                        ]),
                    ),
                },
            }),
        ),
    );

    assert.deepEqual([...system.modes].sort(), ["dark", "light", "light-high-contrast"]);
    assert.equal(
        hex(system, "color.bg.surface-container-high"),
        "#ece6f0",
        "camelCase roles are read",
    );
    assert.equal(hex(system, "color.accent.default", "dark"), "#d0bcff");
    assert.equal(hex(system, "color.accent.default", "light-high-contrast"), "#3a1f7a");
    assert.equal(token(system, "color.accent.default")!.modes.light!.alias, "color.indigo.40");
});

test("a scheme named by the variable's suffix, with var() in the classes; and roles that point at palette steps with a media query for dark", () => {
    const suffixed = `:root {\n${Object.keys(LIGHT)
        .map(
            (name) =>
                `  --md-sys-color-${kebab(name)}-light: #${LIGHT[name]};\n  --md-sys-color-${kebab(name)}-dark: #${DARK[name]};`,
        )
        .join("\n")}\n}\n.light {\n${Object.keys(LIGHT)
        .map((name) => `  --md-sys-color-${kebab(name)}: var(--md-sys-color-${kebab(name)}-light);`)
        .join("\n")}\n}\n`;
    const a = load(scanTokens(project({ "styles/theme.css": suffixed })));

    assert.deepEqual(a.modes, ["light", "dark"]);
    assert.equal(hex(a, "color.accent.default", "dark"), "#d0bcff");

    const palettes = Object.entries(PALETTES)
        .flatMap(([family, tones]) =>
            Object.entries(tones).map(
                ([tone, value]) => `--md-ref-palette-${family}${tone}: #${value};`,
            ),
        )
        .join(" ");
    const b = load(
        scanTokens(
            project({
                "src/theme.css": `:root { ${palettes} }
:root { --md-sys-color-primary: var(--md-ref-palette-primary40); --md-sys-color-on-primary: var(--md-ref-palette-primary100); --md-sys-color-primary-container: var(--md-ref-palette-primary90); --md-sys-color-on-primary-container: var(--md-ref-palette-primary10); --md-sys-color-surface: var(--md-ref-palette-neutral98); --md-sys-color-background: var(--md-ref-palette-neutral98); --md-sys-color-on-surface: var(--md-ref-palette-neutral10); --md-sys-color-on-surface-variant: var(--md-ref-palette-neutral-variant30); --md-sys-color-outline: var(--md-ref-palette-neutral-variant50); --md-sys-color-error: var(--md-ref-palette-error40); }
@media (prefers-color-scheme: dark) { :root { --md-sys-color-primary: var(--md-ref-palette-primary80); --md-sys-color-surface: var(--md-ref-palette-neutral6); --md-sys-color-background: var(--md-ref-palette-neutral6); --md-sys-color-on-surface: var(--md-ref-palette-neutral90); } }
:root { --md-sys-shape-corner-small: 8px; --md-sys-shape-corner-full: 9999px; --md-sys-motion-duration-short2: 100ms; --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1); --md-ref-typeface-brand: Roboto; }`,
                "src/app.css":
                    "body { margin: 0; padding: 16px; background: var(--md-sys-color-background); color: var(--md-sys-color-on-surface) }",
            }),
        ),
    );

    assert.deepEqual(b.modes, ["light", "dark"]);
    assert.equal(token(b, "color.accent.default")!.modes.dark!.alias, "color.indigo.80");
    assert.equal(hex(b, "color.bg.page", "dark"), "#141218");
    assert.equal(css(b, "radius.small"), "8px");
    assert.equal(css(b, "duration.short2"), "100ms");
    assert.equal(token(b, "ease.standard")!.type, "cubicBezier");
    assert.equal(token(b, "font.brand")!.type, "fontFamily");
});

const css = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.literal;

test("a project with only a dark scheme has dark as its default mode, and the report names the source and what Material 3 lacks", () => {
    const scan = scanTokens(project({ "dark.css": block(":root", DARK) }));
    const system = load(scan);

    assert.equal(system.modes[0], "dark");
    assert.equal(hex(system, "color.bg.page", "dark"), "#141218");

    const text = scanReport(scanTokens(project(FILES)));

    assert.match(text, /Material 3: 37 color roles in light; modes: .*dark-high-contrast/);
    assert.match(text, /Material 3 has no warning or success color, so none was made up/);
    assert.match(text, /color\.bg\.page\s+#fef7ff\s+dark #141218\s+from --md-sys-color-background/);
    assert.match(text, /color\.accent\.default\s+#6750a4/);
});

test("fewer than eight roles are not a Material 3 export, and a stylesheet that has other custom properties is left to the scan", () => {
    const scan = scanTokens(
        project({
            "a.css":
                ":root { --md-sys-color-primary: #6750a4; --md-sys-color-surface: #fef7ff; --brand: #123456; --bg: #ffffff; --text: #111111 }",
        }),
    );

    assert.equal(scan.inferred.sources.length, 0);
    assert.equal(
        scan.inferred.roles.background?.value,
        "#ffffff",
        "the project's own roles are read as before",
    );
});

test("a hand-made export: no background means the surface is the page too; a font stack keeps its quotes; the project's own colors stay beside Material's", () => {
    const scan = scanTokens(
        project({
            "css/tokens.css": `:root {
  --md-ref-typeface-brand: 'Roboto Flex', Roboto, sans-serif;
  --md-sys-color-primary: #6750a4; --md-sys-color-on-primary: #ffffff; --md-sys-color-tertiary: #7d5260; --md-sys-color-error: #b3261e;
  --md-sys-color-surface: #fef7ff; --md-sys-color-surface-container: #f3edf7; --md-sys-color-on-surface: #1d1b20;
  --md-sys-color-on-surface-variant: #49454f; --md-sys-color-outline: #79747e; --md-sys-color-outline-variant: #cac4d0;
}
@media (prefers-color-scheme: dark) { :root:not(.light-scheme) { --md-sys-color-primary: #d0bcff; --md-sys-color-surface: #141218; --md-sys-color-on-surface: #e6e0e9; } }`,
            "css/app.css":
                ".badge { background: #e8def8; color: var(--md-sys-color-on-surface) } .chip { background: #e8def8 } .snack { background: #322f35; border-radius: 4px } .toast { background: #322f35 }",
        }),
    );
    const system = load(scan);

    assert.equal(hex(system, "color.bg.page"), "#fef7ff", "the surface is the page");
    assert.equal(hex(system, "color.bg.surface"), "#fef7ff");
    assert.equal(hex(system, "color.bg.page", "dark"), "#141218");
    assert.deepEqual(token(system, "font.brand")!.modes.light!.value, [
        "Roboto Flex",
        "Roboto",
        "sans-serif",
    ]);
    // Colors that the project's own styles use, and Material does not have, stay; the ones that Material has are not twice.
    const colors = system.tokens
        .filter((each) => each.type === "color" && each.modes.light!.alias === undefined)
        .map((each) => each.modes.light!.hex);

    assert.ok(
        colors.includes("#e8def8") && colors.includes("#322f35"),
        "the project's literals stay",
    );
    assert.equal(
        colors.filter((each) => each === "#6750a4").length,
        1,
        "a color of Material's is listed once",
    );
});
