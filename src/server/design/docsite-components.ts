import { type ComponentSpec } from "./system-types.ts";
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    MAX_COMPONENTS,
    MAX_STATES,
    MAX_CODE,
    clip,
    idOf,
    anchor,
    type Ctx,
    groundToken,
    textToken,
} from "./docsite-core.ts";

// Component markup is parsed in an inert document, stripped of what could run or load, and shown in a shadow root: its CSS cannot reach the page, and the page's cannot reach it.
export function componentStage(ctx: Ctx): string {
    const ground = groundToken(ctx);
    const text = textToken(ctx);
    const family = ctx.system.tokens.find(
        (token) => token.type === "fontFamily" && token.tier !== "component",
    );
    const style = [
        ground === undefined ? "" : `--g:var(${ground.cssVar});`,
        text === undefined ? "" : `--t:var(${text.cssVar});`,
        family === undefined ? "" : `--f:var(${family.cssVar});`,
    ].join("");

    return `<div class="comp-stage" role="group" aria-label="States"${style === "" ? "" : ` style="${esc(style)}"`}><p class="stage-note">The states show when script runs; the markup and CSS are below.</p></div>`;
}

export function codeBlock(id: string, label: string, code: string, kind: "state" | "css"): string {
    return `<div class="snip-wrap" data-panel="${esc(label)}" data-kind="${kind}"><button class="copy" type="button" data-copy-from="${esc(id)}" data-copy="">Copy</button><pre class="snip" id="${esc(id)}"><code>${esc(code)}</code></pre></div>`;
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
        .map((name) => `<button class="tk">${esc(name)}</button>`)
        .join("");

    return `<article class="comp" id="${id}" data-pid="${id}" data-q="${esc(`${spec.name} ${spec.description} ${spec.slug}`.toLowerCase())}"><div class="comp-head"><h3>${esc(spec.name)}${anchor(id, spec.name)}</h3><span class="pill">${states.length} state${states.length === 1 ? "" : "s"}</span></div><p class="intro" style="margin-top:6px">${esc(spec.description)}</p>${componentStage(ctx)}${
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
        )}</div>${tabs.map((tab, at) => codeBlock(`code-${index}-${at}`, tab.label, clip(tab.code, MAX_CODE), at === tabs.length - 1 ? "css" : "state")).join("")}</div></details></article>`;
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
