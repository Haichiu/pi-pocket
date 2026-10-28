/**
 * The Components section of the documentation page: every component as a grid of its states, with its code. (Split from `docsite.ts`; see it for how the page is built and kept safe.)
 */
import { type ComponentSpec, type ResolvedToken } from "./system-types.ts";
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import { FRAME_JS } from "./docsite-assets.ts";
import { randomBytes } from "node:crypto";
import {
    MAX_COMPONENTS,
    MAX_STATES,
    MAX_CODE,
    frameCsp,
    clip,
    safeCss,
    safeVar,
    idOf,
    type Ctx,
    valueIn,
    groundToken,
    textToken,
} from "./docsite-core.ts";

// ── Components ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The custom properties a piece of CSS or markup reads: `var(--name)`. */
export function varsIn(text: string): Set<string> {
    return new Set([...text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1]!));
}

/** A token's values for the frame's CSS: the default mode in `:root`, and the modes' differences after it. */
export function frameVars(ctx: Ctx, names: Set<string>): string {
    const wanted = new Set<string>();
    const queue = [...names];

    while (queue.length > 0 && wanted.size < 2000) {
        const name = queue.pop()!;
        const token = ctx.byVar.get(name);

        if (token === undefined || wanted.has(name)) {
            continue;
        }

        wanted.add(name);

        for (const mode of ctx.modes) {
            for (const inner of varsIn(valueIn(token, mode)?.css ?? "")) {
                queue.push(inner);
            }
        }
    }

    const declare = (mode: string, only?: (token: ResolvedToken) => boolean) =>
        [...wanted]
            .map((name) => ctx.byVar.get(name)!)
            .filter((token) => only === undefined || only(token))
            .map((token) => {
                const css = safeCss(valueIn(token, mode)?.css);

                return css === undefined || safeVar(token.cssVar) === undefined
                    ? ""
                    : `${token.cssVar}:${css};`;
            })
            .join("");
    const first = ctx.modes[0]!;
    const out = [`:root{${declare(first)}}`];

    for (const mode of ctx.modes.slice(1)) {
        const rules = declare(
            mode,
            (token) => valueIn(token, mode)?.css !== valueIn(token, first)?.css,
        );

        if (rules !== "") {
            out.push(`html[data-mode="${ctx.slug.get(mode)}"]{${rules}}`);
        }
    }

    return out.join("\n");
}

/** CSS from the project goes into a `<style>` element: it must not be able to close it. */
export const styleSafe = (css: string) =>
    css.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

export function componentFrame(ctx: Ctx, spec: ComponentSpec, index: number): string {
    // Only the frame's own script has this nonce: the component's markup cannot guess it, so none of its scripts run.
    const nonce = randomBytes(12).toString("base64url");
    const states = spec.states.slice(0, MAX_STATES);
    const css = clip(spec.css, MAX_CODE);
    const markups = states.map((state) => clip(spec.markup[state] ?? "", MAX_CODE));
    const ground = groundToken(ctx);
    const text = textToken(ctx);
    const family = ctx.system.tokens.find(
        (token) => token.type === "fontFamily" && token.tier !== "component",
    );
    const names = varsIn(`${css}${markups.join("")}`);

    for (const token of [ground, text, family]) {
        if (token !== undefined) {
            names.add(token.cssVar);
        }
    }

    const theme = (mode: string) => ctx.theme.get(mode)!;
    const vars = frameVars(ctx, names);
    const stage = [
        ground === undefined ? "" : `--__ground:var(${ground.cssVar});`,
        text === undefined ? "" : `--__text:var(${text.cssVar});`,
        family === undefined ? "" : `--__font:var(${family.cssVar});`,
    ].join("");
    const cells = states
        .map(
            (state, index) =>
                `<div class="__c"><p class="__l">${esc(state)}</p>${markups[index]!}</div>`,
        )
        .join("");
    const doc = `<!doctype html><html lang="en" data-frame="${index}" data-mode="${ctx.slug.get(ctx.modes[0]!)}" data-theme="${theme(ctx.modes[0]!)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${frameCsp(nonce)}"><style>
${styleSafe(vars)}
html[data-theme="dark"]{color-scheme:dark;--__fallback-bg:#161822;--__fallback-text:#eceef7}
html[data-theme="light"]{color-scheme:light;--__fallback-bg:#fff;--__fallback-text:#14161f}
*{box-sizing:border-box}
body{${stage}margin:0;background:var(--__ground,var(--__fallback-bg));color:var(--__text,var(--__fallback-text));font:14px/1.5 var(--__font,system-ui,sans-serif)}
.__w{overflow:hidden}
.__g{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));margin:0 -1px -1px 0}
.__c{min-width:0;padding:16px 18px 20px;box-shadow:inset -1px -1px 0 rgb(128 128 128/.28)}
.__l{margin:0 0 14px;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.62}
${styleSafe(css)}
</style></head><body><div class="__w"><div class="__g">${cells}</div></div><script nonce="${nonce}">${FRAME_JS}</script></body></html>`;
    const rows = Math.ceil(states.length / 2);
    const lines = Math.max(1, (markups[0] ?? "").split("\n").length);
    const estimate = 24 + rows * Math.min(360, 70 + lines * 26);

    return `<iframe class="comp-frame" title="${esc(spec.name)}, all states" sandbox="allow-scripts" srcdoc="${esc(doc)}" style="height:${estimate}px"></iframe>`;
}

export function codeBlock(id: string, label: string, code: string): string {
    return `<div class="snip-wrap" data-panel="${esc(label)}"><button class="copy" type="button" data-copy-from="${esc(id)}" data-copy="">Copy</button><pre class="snip" id="${esc(id)}"><code>${esc(code)}</code></pre></div>`;
}

export function componentArticle(ctx: Ctx, spec: ComponentSpec, index: number): string {
    const id = `comp-${idOf(spec.slug)}`;
    const states = spec.states.slice(0, MAX_STATES);
    const usage = spec.usage;
    const list = (title: string, items: string[], css: string) =>
        `<div class="${css}"><h4>${title}</h4><ul>${items
            .slice(0, 12)
            .map((item) => `<li>${esc(clip(item, 300))}</li>`)
            .join("")}</ul></div>`;
    const tabs = [
        ...states.map((state) => ({ label: state, code: spec.markup[state] ?? "" })),
        { label: "css", code: spec.css },
    ];
    const tokenChips = spec.tokens
        .slice(0, 80)
        .map(
            (name) =>
                `<button class="tk" data-copy="${esc(name)}" title="Copy the token name">${esc(name)}</button>`,
        )
        .join("");

    return `<article class="comp" id="${id}" data-pid="${id}" data-q="${esc(`${spec.name} ${spec.description} ${spec.slug}`.toLowerCase())}"><div class="comp-head"><h3>${esc(spec.name)}</h3><span class="pill">${states.length} state${states.length === 1 ? "" : "s"}</span></div><p class="intro" style="margin-top:6px">${esc(spec.description)}</p>${componentFrame(ctx, spec, index)}${
        usage === undefined || (usage.do.length === 0 && usage.dont.length === 0)
            ? ""
            : `<div class="dos">${usage.do.length > 0 ? list("Do", usage.do, "do") : ""}${usage.dont.length > 0 ? list("Don’t", usage.dont, "dont") : ""}</div>`
    }${tokenChips === "" ? "" : `<details class="code"><summary>Tokens it uses<span class="pill" style="margin-left:10px">${Math.min(spec.tokens.length, 80)}</span></summary><div class="code-body"><div class="chips" style="margin-top:0">${tokenChips}</div></div></details>`}<details class="code"><summary>Markup and CSS</summary><div class="code-body"><div class="tabs" data-tabs>${tabs
        .map(
            (tab) =>
                `<button type="button" data-tab="${esc(tab.label)}" aria-pressed="false">${esc(tab.label)}</button>`,
        )
        .join(
            "",
        )}</div>${tabs.map((tab, at) => codeBlock(`code-${index}-${at}`, tab.label, clip(tab.code, MAX_CODE))).join("")}</div></details></article>`;
}

export function componentsSection(ctx: Ctx): { html: string; count: number } | undefined {
    const components = ctx.system.components.slice(0, MAX_COMPONENTS);

    if (components.length === 0) {
        return undefined;
    }

    return {
        html: `<p class="intro">${plural(components.length, "component")}, each shown in every state and in the mode you chose. Copy the markup to reuse it.</p>${components.map((spec, index) => componentArticle(ctx, spec, index)).join("")}`,
        count: components.length,
    };
}
