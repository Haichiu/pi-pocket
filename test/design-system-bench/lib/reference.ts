import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
    CompiledFiles,
    ComponentSpec,
    DesignSystem,
    SystemChange,
} from "../../../src/server/design/system-types.ts";
import { BenchBrowser } from "./chromium.ts";
import { toHex, colorOf } from "./color.ts";
import type { Draft, Modules } from "./modules.ts";
import { BENCH } from "./phase-scan.ts";
import { referenceCheck } from "./reference-lint.ts";
import type { Expected } from "./score.ts";
import { cssVar, goldenCss, readFlat, systemFromFlat } from "./system.ts";

const read = (path: string) => readFileSync(path, "utf8");

export function parseComponent(slug: string, html: string): ComponentSpec {
    const meta = /<script[^>]*id="pocket-component"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    const info = meta === null ? {} : (JSON.parse(meta[1]!) as Record<string, unknown>);
    const markup: Record<string, string> = {};

    for (const match of html.matchAll(/<template data-state="([^"]+)">([\s\S]*?)<\/template>/g)) {
        markup[match[1]!] = match[2]!;
    }

    return {
        slug,
        name: String(info.name ?? slug),
        description: String(info.description ?? ""),
        states: Object.keys(markup),
        markup,
        css: [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
            .map((match) => match[1]!.trim())
            .join("\n"),
        ...(info.usage === undefined ? {} : { usage: info.usage as ComponentSpec["usage"] }),
        tokens: Array.isArray(info.tokens) ? info.tokens.map(String) : [],
    };
}

function compile(system: Omit<DesignSystem, "compiled">, css: string): CompiledFiles {
    const colors = system.tokens
        .map((token) => `    ${token.cssVar}: var(${token.cssVar});`)
        .join("\n");

    return {
        css,
        tailwind: `@theme inline {\n${colors}\n}\n`,
        json: JSON.stringify(
            {
                modes: system.modes,
                tokens: system.tokens.map((token) => ({
                    name: token.name,
                    type: token.type,
                    modes: token.modes,
                })),
            },
            null,
            2,
        ),
        components: system.components.map((component) => component.css).join("\n\n"),
    };
}

export function referenceLoad(cwd: string): DesignSystem | undefined {
    const dir = join(cwd, ".pi", "design");

    if (!existsSync(join(dir, "tokens.json"))) {
        return undefined;
    }

    const flat = readFlat(dir);
    const base = systemFromFlat(flat, "");
    const tree = JSON.parse(read(join(dir, "tokens.json"))) as {
        $extensions?: Record<string, { name?: string }>;
    };
    const components: ComponentSpec[] = [];

    if (existsSync(join(dir, "components"))) {
        for (const file of readdirSync(join(dir, "components")).sort()) {
            if (file.endsWith(".html")) {
                components.push(
                    parseComponent(file.slice(0, -5), read(join(dir, "components", file))),
                );
            }
        }
    }

    const system = {
        ...base,
        name: tree.$extensions?.["com.pi-pocket"]?.name ?? basename(cwd),
        components,
        guidelines: existsSync(join(dir, "guidelines.md")) ? read(join(dir, "guidelines.md")) : "",
        problems: flat.problems.map((message) => ({ level: "error" as const, message })),
    };

    return { ...system, compiled: compile(system, goldenCss(flat)) };
}

export function referenceWrite(cwd: string, change: SystemChange): DesignSystem {
    const dir = join(cwd, ".pi", "design");
    const json = (value: unknown) => `${JSON.stringify(value, null, 4)}\n`;

    mkdirSync(join(dir, "components"), { recursive: true });

    if (change.tokens !== undefined) {
        writeFileSync(join(dir, "tokens.json"), json(change.tokens));
    }

    for (const [mode, tree] of Object.entries(change.modes ?? {})) {
        if (tree === null) {
            rmSync(join(dir, `tokens.${mode}.json`), { force: true });
        } else {
            writeFileSync(join(dir, `tokens.${mode}.json`), json(tree));
        }
    }

    for (const [slug, html] of Object.entries(change.components ?? {})) {
        if (!/^[a-z0-9-]+$/.test(slug)) {
            throw new Error(
                `The component name "${slug}" must be lowercase letters, digits, and hyphens.`,
            );
        }

        if (html === null) {
            rmSync(join(dir, "components", `${slug}.html`), { force: true });
        } else {
            writeFileSync(join(dir, "components", `${slug}.html`), html);
        }
    }

    if (change.guidelines !== undefined) {
        writeFileSync(join(dir, "guidelines.md"), change.guidelines);
    }

    const system = referenceLoad(cwd);

    if (system === undefined) {
        throw new Error("There is no tokens.json.");
    }

    if (system.problems.length > 0) {
        throw new Error(system.problems[0]!.message);
    }

    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "tokens.css"), system.compiled.css);
    writeFileSync(join(dir, "dist", "tailwind.css"), system.compiled.tailwind);
    writeFileSync(join(dir, "dist", "tokens.resolved.json"), system.compiled.json);
    writeFileSync(join(dir, "dist", "components.css"), system.compiled.components);

    return system;
}

export function draftFromExpected(expected: Expected): Draft {
    const value = (entry: string | { value: string }) =>
        typeof entry === "string" ? entry : entry.value;
    const size = (entry: number | { value: number }) =>
        `${typeof entry === "number" ? entry : entry.value}px`;
    const tree = {
        color: {
            $type: "color",
            palette: Object.fromEntries(
                expected.colors.map((entry, index) => [`c${index + 1}`, { $value: value(entry) }]),
            ),
            // A mode file only changes tokens that exist, so each dark color is the dark side of a placeholder.
            shade: Object.fromEntries(
                (expected.darkColors ?? []).map((_, index) => [
                    `k${index + 1}`,
                    { $value: value(expected.colors[0]!) },
                ]),
            ),
            ...Object.fromEntries(
                Object.entries(expected.roles).map(([role, item]) => [
                    role,
                    { default: { $value: Array.isArray(item.light) ? item.light[0] : item.light } },
                ]),
            ),
        },
        font: {
            size: {
                $type: "dimension",
                ...Object.fromEntries(
                    expected.typeScale.map((entry, index) => [
                        `s${index + 1}`,
                        { $value: size(entry) },
                    ]),
                ),
            },
            family: {
                $type: "fontFamily",
                ...Object.fromEntries(
                    expected.fonts.map((name, index) => [
                        `f${index + 1}`,
                        { $value: [name, "sans-serif"] },
                    ]),
                ),
            },
        },
        space: {
            $type: "dimension",
            ...(expected.spacingBase === undefined
                ? {}
                : { base: { $value: size(expected.spacingBase) } }),
            ...Object.fromEntries(
                expected.spacing.map((entry, index) => [`s${index + 1}`, { $value: size(entry) }]),
            ),
        },
        radius: {
            $type: "dimension",
            ...Object.fromEntries(
                expected.radii.map((entry, index) => [`r${index + 1}`, { $value: size(entry) }]),
            ),
        },
        shadow: {
            $type: "shadow",
            ...Object.fromEntries(
                expected.shadows.map((entry, index) => [`s${index + 1}`, { $value: entry }]),
            ),
        },
    };
    const dark: Record<string, unknown> = {};

    if (expected.dark.present) {
        const roles: Record<string, unknown> = {};

        for (const [role, item] of Object.entries(expected.roles)) {
            if (item.dark !== undefined) {
                roles[role] = {
                    default: { $value: Array.isArray(item.dark) ? item.dark[0] : item.dark },
                };
            }
        }

        Object.assign(dark, {
            color: {
                ...roles,
                shade: Object.fromEntries(
                    (expected.darkColors ?? []).map((entry, index) => [
                        `k${index + 1}`,
                        { $value: value(entry) },
                    ]),
                ),
            },
        });
    }

    return { tokens: tree, modes: expected.dark.present ? { dark } : {} };
}

function componentStage(component: ComponentSpec): string {
    const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
    const spec = JSON.stringify({
        css: component.css,
        cells: component.states.map((state) => ({ state, html: component.markup[state] ?? "" })),
    }).replace(/</g, "\\u003c");

    return `<article><h3>${escape(component.name)}</h3><div class="comp-stage"><script type="application/json" class="spec">${spec}</script></div></article>`;
}

const STAGE_SCRIPT = `(function () {
    document.querySelectorAll(".comp-stage").forEach(function (stage) {
        var spec = JSON.parse(stage.querySelector(".spec").textContent);
        var host = document.createElement("div");
        host.className = "comp-host";
        stage.appendChild(host);
        var shadow = host.attachShadow({ mode: "open" });
        var style = document.createElement("style");
        style.textContent = "*{box-sizing:border-box}.__c{display:inline-block;padding:16px 18px;margin:0 8px 8px 0;background:var(--color-bg-surface,#fff);color:var(--color-text-primary,#111);font:14px system-ui}.__l{margin:0 0 10px;font:11px monospace;text-transform:uppercase;opacity:.7}" + spec.css;
        var wrap = document.createElement("div");
        spec.cells.forEach(function (cell) {
            var box = document.createElement("div");
            var label = document.createElement("p");
            box.className = "__c";
            label.className = "__l";
            label.textContent = cell.state;
            box.appendChild(label);
            box.insertAdjacentHTML("beforeend", cell.html);
            wrap.appendChild(box);
        });
        shadow.appendChild(style);
        shadow.appendChild(wrap);
        stage.setAttribute("data-ready", "");
    });
    document.documentElement.setAttribute("data-docs-ready", "");
})();`;

export function referenceDoc(system: DesignSystem): {
    html: string;
    assets: { name: string; content: string }[];
} {
    const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
    const section = (id: string, title: string, body: string) =>
        `<section id="${id}"><h2>${title}</h2>${body}</section>`;
    const swatches = system.tokens
        .filter((token) => token.type === "color")
        .map((token) => {
            const color = colorOf(token.modes[system.modes[0]!]?.value);

            return `<div class="sw"><i style="background:var(${token.cssVar})"></i><b>${escape(token.name)}</b><code>${escape(token.cssVar)}</code><small>${color === undefined ? "" : toHex(color)}</small></div>`;
        })
        .join("");
    const list = (prefix: string, render: (token: DesignSystem["tokens"][number]) => string) =>
        system.tokens
            .filter((token) => token.name.startsWith(prefix))
            .map(
                (token) =>
                    `<div class="row"><code>${escape(cssVar(token.name))}</code>${render(token)}</div>`,
            )
            .join("");
    const body = [
        section("colors", "Colors", `<div class="grid">${swatches}</div>`),
        section(
            "typography",
            "Typography",
            list(
                "font.size.",
                (token) =>
                    `<span style="font-size:var(${token.cssVar})">The quick brown fox</span>`,
            ),
        ),
        section(
            "spacing",
            "Spacing",
            list("space.", (token) => `<i class="bar" style="width:var(${token.cssVar})"></i>`),
        ),
        section(
            "radii",
            "Radii",
            list(
                "radius.",
                (token) => `<i class="box" style="border-radius:var(${token.cssVar})"></i>`,
            ),
        ),
        section(
            "shadows",
            "Shadows",
            list(
                "shadow.",
                (token) => `<i class="box" style="box-shadow:var(${token.cssVar})"></i>`,
            ),
        ),
        section(
            "motion",
            "Motion",
            list(
                "motion.",
                (token) => `<small>${escape(String(token.modes[system.modes[0]!]?.css))}</small>`,
            ),
        ),
        section(
            "components",
            "Components",
            system.components.map((component) => componentStage(component)).join("") ||
                "<p>No components yet.</p>",
        ),
    ].join("\n");
    const html = `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(system.name)} design system</title>
<style>${system.compiled.css}
body{margin:0;background:var(--color-bg-default,#fff);color:var(--color-text-primary,#111);font:16px/1.5 system-ui,sans-serif}
nav{position:sticky;top:0;display:flex;gap:12px;flex-wrap:wrap;padding:12px 16px;background:var(--color-bg-surface,#fff);border-bottom:1px solid var(--color-border-default,#ddd)}
main{max-width:960px;margin:0 auto;padding:24px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.sw{display:grid;gap:4px}.sw i{height:48px;border-radius:8px;border:1px solid var(--color-border-default,#ddd)}
.row{display:flex;gap:16px;align-items:center;padding:6px 0}.bar{height:12px;background:var(--color-accent-default,#36c)}.box{width:48px;height:48px;background:var(--color-bg-surface,#fff);border:1px solid var(--color-border-default,#ddd)}
code{font-size:12px;overflow-wrap:anywhere}</style></head><body>
<nav aria-label="Sections"><a href="#colors">Colors</a><a href="#typography">Typography</a><a href="#spacing">Spacing</a><a href="#radii">Radii</a><a href="#shadows">Shadows</a><a href="#motion">Motion</a><a href="#components">Components</a></nav>
<main><h1>${escape(system.name)}</h1><p>${escape(system.description ?? "A design system.")} ${system.tokens.length} tokens in ${system.modes.length} modes.</p>${body}
<p>${"This page lists every token with its variable name and value, so a person can copy one into code. ".repeat(12)}</p></main><script>${STAGE_SCRIPT}</script></body></html>`;

    return { html, assets: [] };
}

export function referenceModules(
    browser: BenchBrowser | undefined,
    fixturesRoot = join(BENCH, "fixtures"),
): Modules {
    return {
        load: referenceLoad,
        compile: (system) => system.compiled,
        write: referenceWrite,
        summary: (system) => system.tokens.map((token) => token.name).join("\n"),
        check:
            browser === undefined
                ? undefined
                : async (bundle: any, system, options: any) =>
                      referenceCheck(browser, bundle, system!, options),
        doc: referenceDoc,
        scan: {
            name: "oracle",
            // The scan reads a copy of the fixture without its answers: the oracle looks them up by the folder's name.
            run: (dir: string) =>
                draftFromExpected(
                    JSON.parse(
                        read(join(fixturesRoot, basename(dir), "expected.json")),
                    ) as Expected,
                ),
        },
        notes: [
            "The reference implementations are in use (--reference): these numbers are the bench's ceiling, not a stream's.",
        ],
        present: { tokens: true, lint: true, docsite: true, scan: true },
    };
}
