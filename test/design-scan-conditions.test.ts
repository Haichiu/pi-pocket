// Themes with a value for each condition, in the config of a library: Panda CSS and Chakra v3 `semanticTokens`
// (`{ value: { base: "{colors.gray.50}", _dark: "{colors.gray.950}" } }`, `_osDark`, nested conditions, `DEFAULT` in a group,
// conditions the config defines), and Ant Design's `ThemeConfig` (`token`, `components`, `algorithm`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanTokens, type TokenScan } from "../src/server/design/scan.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-cond-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

/** The light and dark color of each role the scan found. */
function roles(scan: TokenScan) {
    return Object.fromEntries(
        Object.entries(scan.inferred.roles).map(([role, info]) => [role, [info.value, info.dark]]),
    );
}

const GRAYS = `gray: { 50: { value: "#f9fafb" }, 100: { value: "#f3f4f6" }, 200: { value: "#e5e7eb" }, 500: { value: "#6b7280" }, 800: { value: "#1f2937" }, 900: { value: "#111827" }, 950: { value: "#030712" } },
          blue: { 400: { value: "#60a5fa" }, 600: { value: "#2563eb" } },
          red: { 400: { value: "#f87171" }, 600: { value: "#dc2626" } },
          green: { 600: { value: "#16a34a" } },
          white: { value: "#ffffff" }`;

test("Panda: semantic tokens by condition, `DEFAULT` in a group, `_osDark`, nested conditions, a plain value, and references into the tokens", () => {
    const scan = scanTokens(
        project({
            "panda.config.ts": `import { defineConfig } from "@pandacss/dev";
export default defineConfig({
  preflight: true,
  theme: {
    extend: {
      tokens: { colors: { ${GRAYS} } },
      semanticTokens: {
        colors: {
          bg: {
            DEFAULT: { value: { base: "{colors.gray.50}", _dark: "{colors.gray.950}" } },
            surface: { value: { base: "{colors.white}", _dark: "{colors.gray.900}" } },
          },
          text: {
            DEFAULT: { value: { base: "{colors.gray.900}", _dark: "{colors.gray.100}" } },
            muted: { value: { base: "{colors.gray.500}", _osDark: "{colors.gray.200}" } },
          },
          border: { value: { base: "{colors.gray.200}", _dark: "{colors.gray.800}" } },
          accent: { value: { base: "{colors.blue.600}", _dark: "{colors.blue.400}" } },
          danger: { value: { base: "{colors.red.600}", _dark: { base: "{colors.red.400}", _hover: "{colors.red.600}" } } },
          success: { value: "{colors.green.600}" },
        },
      },
    },
  },
});`,
        }),
    );

    assert.deepEqual(roles(scan), {
        background: ["#f9fafb", "#030712"],
        surface: ["#ffffff", "#111827"],
        text: ["#111827", "#f3f4f6"],
        muted: ["#6b7280", "#e5e7eb"],
        border: ["#e5e7eb", "#1f2937"],
        accent: ["#2563eb", "#60a5fa"],
        danger: ["#dc2626", "#f87171"],
        success: ["#16a34a", undefined],
    });
    assert.equal(scan.inferred.hasDark, true);
});

test("Panda: tokens and semantic tokens written with defineTokens and defineSemanticTokens, a color keyword, and a condition the config defines", () => {
    const scan = scanTokens(
        project({
            "panda.config.ts": `import { defineConfig, defineSemanticTokens, defineTokens } from "@pandacss/dev";
const colors = defineTokens.colors({
  neutral: { 50: { value: "#fafafa" }, 200: { value: "#e5e5e5" }, 500: { value: "#737373" }, 900: { value: "#171717" }, 950: { value: "#0a0a0a" } },
  indigo: { 500: { value: "#6366f1" }, 300: { value: "#a5b4fc" } },
  rose: { 600: { value: "#e11d48" } },
  emerald: { 600: { value: "#059669" } },
  amber: { 500: { value: "#f59e0b" } },
});
const semanticTokens = defineSemanticTokens({
  colors: {
    bg: { value: { base: "{colors.neutral.50}", _night: "{colors.neutral.950}" } },
    surface: { value: { base: "white", _night: "{colors.neutral.900}" } },
    text: { value: { base: "{colors.neutral.900}", _night: "{colors.neutral.50}" } },
    muted: { value: { base: "{colors.neutral.500}", _night: "{colors.neutral.200}" } },
    border: { value: { base: "{colors.neutral.200}", _night: "{colors.neutral.900}" } },
    primary: { DEFAULT: { value: { base: "{colors.indigo.500}", _night: "{colors.indigo.300}" } } },
    danger: { value: "{colors.rose.600}" },
    success: { value: "{colors.emerald.600}" },
    warning: { value: "{colors.amber.500}" },
  },
});
export default defineConfig({
  conditions: { extend: { night: "[data-theme=night] &, .night &" } },
  theme: { extend: { tokens: { colors }, semanticTokens } },
});`,
        }),
    );

    assert.deepEqual(roles(scan), {
        background: ["#fafafa", "#0a0a0a"],
        surface: ["#ffffff", "#171717"],
        text: ["#171717", "#fafafa"],
        muted: ["#737373", "#e5e5e5"],
        border: ["#e5e5e5", "#171717"],
        accent: ["#6366f1", "#a5b4fc"],
        danger: ["#e11d48", undefined],
        warning: ["#f59e0b", undefined],
        success: ["#059669", undefined],
    });
});

test("Chakra v3: createSystem with defineConfig, `_light` and `_dark`, `DEFAULT` in a group", () => {
    const scan = scanTokens(
        project({
            "src/theme.ts": `import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";
const config = defineConfig({
  theme: {
    tokens: {
      colors: {
        brand: { 300: { value: "#7dd3fc" }, 500: { value: "#0ea5e9" }, 600: { value: "#0284c7" } },
        slate: { 50: { value: "#f8fafc" }, 100: { value: "#f1f5f9" }, 200: { value: "#e2e8f0" }, 500: { value: "#64748b" }, 700: { value: "#334155" }, 800: { value: "#1e293b" }, 900: { value: "#0f172a" }, 950: { value: "#020617" } },
        red: { 300: { value: "#fca5a5" }, 500: { value: "#ef4444" } },
        white: { value: "#ffffff" },
      },
    },
    semanticTokens: {
      colors: {
        bg: {
          DEFAULT: { value: { _light: "{colors.white}", _dark: "{colors.slate.950}" } },
          subtle: { value: { _light: "{colors.slate.50}", _dark: "{colors.slate.900}" } },
          panel: { value: { _light: "{colors.white}", _dark: "{colors.slate.900}" } },
        },
        fg: {
          DEFAULT: { value: { _light: "{colors.slate.900}", _dark: "{colors.slate.50}" } },
          muted: { value: { _light: "{colors.slate.500}", _dark: "{colors.slate.200}" } },
        },
        border: { DEFAULT: { value: { _light: "{colors.slate.200}", _dark: "{colors.slate.700}" } } },
        brand: { solid: { value: { _light: "{colors.brand.600}", _dark: "{colors.brand.300}" } } },
        error: { value: { _light: "{colors.red.500}", _dark: "{colors.red.300}" } },
      },
    },
  },
});
export const system = createSystem(defaultConfig, config);`,
        }),
    );
    const found = roles(scan);

    assert.deepEqual(found.background, ["#ffffff", "#020617"]);
    assert.deepEqual(found.text, ["#0f172a", "#f8fafc"]);
    assert.deepEqual(found.muted, ["#64748b", "#e2e8f0"]);
    assert.deepEqual(found.border, ["#e2e8f0", "#334155"]);
    assert.deepEqual(found.accent, ["#0ea5e9", "#7dd3fc"]);
    assert.deepEqual(found.danger, ["#ef4444", "#fca5a5"]);
});

test("Chakra v2 semantic tokens (`default` and `_dark`) are read as before", () => {
    const scan = scanTokens(
        project({
            "theme.js": `export default extendTheme({
  colors: { gray: { 50: "#f7fafc", 900: "#171923" }, blue: { 500: "#3182ce", 200: "#90cdf4" } },
  semanticTokens: { colors: { "chakra-body-bg": { default: "gray.50", _dark: "gray.900" }, accent: { default: "blue.500", _dark: "blue.200" } } },
});`,
        }),
    );

    assert.deepEqual(roles(scan).accent, ["#3182ce", "#90cdf4"]);
});

const ANTD_TOKENS = `colorPrimary: "#13c2c2", colorSuccess: "#52c41a", colorWarning: "#faad14", colorError: "#f5222d", colorInfo: "#1677ff",
    colorBgLayout: "#f5f7f8", colorBgContainer: "#ffffff", colorText: "rgba(0, 0, 0, 0.88)", colorTextSecondary: "rgba(0, 0, 0, 0.65)", colorBorder: "#d9dde0",
    fontFamily: "'Source Sans 3', -apple-system, sans-serif", fontSize: 14, fontSizeSM: 12, fontSizeLG: 16, fontSizeXL: 20, fontSizeHeading1: 38, fontSizeHeading2: 30,
    lineHeight: 1.5, borderRadius: 6, borderRadiusSM: 4, borderRadiusLG: 8, sizeUnit: 4, sizeStep: 4,
    boxShadow: "0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12)",
    motionDurationFast: "0.1s", motionDurationMid: "0.2s", motionDurationSlow: "0.3s"`;

test("Ant Design: light.ts and dark.ts export a ThemeConfig each; the dark one has the dark algorithm and its own tokens", () => {
    const scan = scanTokens(
        project({
            "src/theme/light.ts": `import type { ThemeConfig } from "antd";
import { theme } from "antd";
export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: { ${ANTD_TOKENS} },
  components: { Button: { colorPrimary: "#08979c", algorithm: true, borderRadius: 3 }, Card: { colorBgContainer: "#fafafa" } },
};`,
            "src/theme/dark.ts": `import type { ThemeConfig } from "antd";
import { theme } from "antd";
import { lightTheme } from "./light";
export const darkTheme: ThemeConfig = {
  ...lightTheme,
  algorithm: theme.darkAlgorithm,
  token: {
    ...lightTheme.token,
    colorPrimary: "#36cfc9", colorBgLayout: "#0b0f12", colorBgContainer: "#141a1f",
    colorText: "rgba(255, 255, 255, 0.88)", colorTextSecondary: "rgba(255, 255, 255, 0.65)", colorBorder: "#2b343b",
  },
};`,
        }),
    );

    assert.deepEqual(roles(scan), {
        background: ["#f5f7f8", "#0b0f12"],
        surface: ["#ffffff", "#141a1f"],
        text: ["#000000e0", "#ffffffe0"],
        muted: ["#000000a6", "#ffffffa6"],
        border: ["#d9dde0", "#2b343b"],
        accent: ["#13c2c2", "#36cfc9"],
        danger: ["#f5222d", undefined],
        warning: ["#faad14", undefined],
        success: ["#52c41a", undefined],
    });
    assert.deepEqual(scan.inferred.typeScale.sizes, [
        "sm 12px",
        "base 14px",
        "lg 16px",
        "xl 20px",
        "heading2 30px",
        "heading1 38px",
    ]);
    assert.equal(scan.inferred.fonts["font.sans"], "Source Sans 3, -apple-system, sans-serif");
    assert.deepEqual(
        scan.inferred.radii,
        ["sm 4px", "md 6px", "lg 8px"],
        "a component's own radius is left out",
    );
    assert.equal(scan.inferred.spacing.base, 4);
    assert.deepEqual(
        Object.entries(scan.draft.tokens.duration as Record<string, { $value: string }>)
            .filter(([name]) => !name.startsWith("$"))
            .map(([name, node]) => [name, node.$value]),
        [
            ["fast", "0.1s"],
            ["mid", "0.2s"],
            ["slow", "0.3s"],
        ],
    );
    assert.equal(scan.inferred.shadows, 1);
});

test("Ant Design: a ConfigProvider theme, a dark config in a folder of its own, and an array of algorithms", () => {
    const provider = scanTokens(
        project({
            "src/App.tsx": `import { ConfigProvider, theme } from "antd";
export default function App({ dark }) {
  return (
    <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: { colorPrimary: "#722ed1", colorBgLayout: "#f0f2f5", colorBgContainer: "#ffffff", colorText: "#1f1f1f", colorBorder: "#d9d9d9", colorError: "#cf1322", borderRadius: 8, fontSize: 15 } }}>
      <main />
    </ConfigProvider>
  );
}`,
        }),
    );

    assert.equal(roles(provider).accent?.[0], "#722ed1");
    assert.equal(roles(provider).background?.[0], "#f0f2f5");
    assert.equal(
        provider.inferred.hasDark,
        false,
        "one object: its algorithm is chosen at run time, so it holds one mode",
    );

    const folders = scanTokens(
        project({
            "theme/light/index.ts": `import type { ThemeConfig } from "antd/es/config-provider/context";
const config: ThemeConfig = { token: { colorPrimary: "#2f54eb", colorBgLayout: "#f0f2f5", colorBgContainer: "#ffffff", colorText: "#141414", colorTextSecondary: "#8c8c8c", colorBorder: "#d9d9d9", colorError: "#ff4d4f" } };
export default config;`,
            "theme/dark/index.ts": `import { theme } from "antd";
import type { ThemeConfig } from "antd/es/config-provider/context";
const config: ThemeConfig = { algorithm: theme.darkAlgorithm, token: { colorPrimary: "#597ef7", colorBgLayout: "#000000", colorBgContainer: "#141414", colorText: "#f0f0f0", colorTextSecondary: "#8c8c8c", colorBorder: "#303030", colorError: "#ff7875" } };
export default config;`,
        }),
    );

    assert.deepEqual(roles(folders).accent, ["#2f54eb", "#597ef7"]);
    assert.deepEqual(roles(folders).background, ["#f0f2f5", "#000000"]);
    assert.deepEqual(
        roles(folders).muted,
        ["#8c8c8c", undefined],
        "a gray a little under 3:1 on its page is still the muted text",
    );

    const shared = scanTokens(
        project({
            "theme.ts": `import { theme, type ThemeConfig } from "antd";
const shared = { colorPrimary: "#fa541c", colorSuccess: "#389e0d", colorWarning: "#d48806", colorError: "#cf1322", borderRadius: 4, fontSize: 14 };
export const light: ThemeConfig = { token: { ...shared, colorBgLayout: "#fafafa", colorBgContainer: "#fff", colorText: "#262626", colorTextSecondary: "#595959", colorBorder: "#d9d9d9" } };
export const dark: ThemeConfig = {
  algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
  token: { ...shared, colorBgLayout: "#000", colorBgContainer: "#141414", colorText: "#f5f5f5", colorTextSecondary: "#a6a6a6", colorBorder: "#424242", colorPrimary: "#ff7a45" },
};`,
        }),
    );

    assert.deepEqual(roles(shared).accent, ["#fa541c", "#ff7a45"]);
    assert.deepEqual(roles(shared).success, ["#389e0d", undefined]);
    assert.deepEqual(roles(shared).surface, ["#ffffff", "#141414"]);
});

test("a file that is not Ant Design, with a `token` key and a `components` key, is not read as a theme", () => {
    const scan = scanTokens(
        project({
            "src/api.ts": `export const config = { token: { colorPrimary: "#ff0000", colorBgLayout: "#00ff00" }, components: { Button: { colorPrimary: "#0000ff" } } };`,
        }),
    );

    assert.equal(scan.inferred.roles.accent, undefined);
});

test("hostile theme files run in bounded time and never throw", () => {
    const started = Date.now();
    const cases = [
        `import { theme } from "antd";\n${"const c = { token: { colorPrimary: '#fff' ".repeat(3000)}`,
        `import { theme } from "antd";\n${"token: {".repeat(20_000)}`,
        `import { theme } from "antd";\nconst c = { token: { ${"colorX: '#fff', ".repeat(20_000)} } };`,
        `semanticTokens: { colors: ${"{ a: { value: { base: ".repeat(500)}"#fff"${" } } }".repeat(500)} }`,
        `semanticTokens: { colors: { a: { value: { ${"_x: { _y: { ".repeat(300)} base: "#fff" ${"} }".repeat(300)} } } } }`,
        `conditions: { extend: { ${"a: 'b', ".repeat(20_000)} } }\nsemanticTokens: { colors: { x: { value: { _a: "#fff" } } } }`,
        `const a = { ...a, ...b, ...a.b.c.d.e };\nconst c = { ${"...a, ".repeat(20_000)} };\nsemanticTokens: c`,
    ];

    for (const text of cases) {
        assert.doesNotThrow(() => scanTokens(project({ "theme.ts": text })), text.slice(0, 60));
    }

    assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
});

test("Ant Design: the theme editor's JSON, a file for each mode", () => {
    const scan = scanTokens(
        project({
            "theme.json": JSON.stringify({
                token: {
                    colorPrimary: "#00b96b",
                    colorBgLayout: "#f6f8f7",
                    colorBgContainer: "#ffffff",
                    colorText: "#1d2b26",
                    colorBorder: "#d4ded9",
                    colorError: "#e5484d",
                    fontSize: 16,
                    borderRadius: 10,
                },
                components: { Button: { colorPrimary: "#006d3f", borderRadius: 2 } },
            }),
            "theme.dark.json": JSON.stringify({
                token: {
                    colorPrimary: "#2ec27e",
                    colorBgLayout: "#0d1210",
                    colorBgContainer: "#161d1a",
                    colorText: "#e8f0ec",
                    colorBorder: "#2a3631",
                },
            }),
        }),
    );

    assert.deepEqual(roles(scan).accent, ["#00b96b", "#2ec27e"]);
    assert.deepEqual(roles(scan).background, ["#f6f8f7", "#0d1210"]);
    assert.deepEqual(roles(scan).danger, ["#e5484d", undefined]);
    assert.deepEqual(scan.inferred.radii, ["md 10px"], "the radius of a component is left out");
});
