/**
 * The design system's documentation page (stream G of the design-system hill climb): one self-contained HTML document
 * for a `DesignSystem`, with navigation and search, an overview, color roles and the palette with contrast tables,
 * type specimens, spacing, radii, shadows, motion demos, every component as a grid of its states with its code, the
 * guidelines, a table of every token, and the code to use it. It has a switch for each of the system's modes.
 *
 * The page runs in the artifact sandbox, so it asks for nothing: no network, no app, no external font or image. All
 * project text (names, descriptions, values, Markdown, component markup and CSS) is data. Text is escaped; token values
 * that reach a style are checked first; component markup and CSS show in a shadow root of their own, after the page's
 * script has stripped every script, handler, and address from the markup, under a policy that blocks every request.
 */
import { type DesignSystem, type ResolvedToken } from "./system-types.ts";
import { contrastRatio, parseColor, readableOn, toHex } from "./docsite-color.ts";
import { escapeHtml as esc, plural, renderMarkdown } from "./docsite-markdown.ts";
import { randomBytes } from "node:crypto";
import { DOC_BOOT_JS, DOC_CSS, DOC_JS } from "./docsite-assets.ts";
import { pairRows, colorSection } from "./docsite-color-section.ts";
import { componentsSection } from "./docsite-components.ts";
import {
    type SystemDoc,
    MAX_TOKENS,
    MAX_COMPONENTS,
    MAX_PAGE,
    pageCsp,
    clip,
    modeLabel,
    safeCss,
    safeVar,
    varOf,
    idOf,
    type Ctx,
    valueIn,
    colorOf,
    BASE_GROUNDS,
    BASE_TEXTS,
    findToken,
    buildContext,
} from "./docsite-core.ts";
import { motionSection } from "./docsite-motion.ts";
import { referenceSection, problemsHtml, notesHtml, codeSection } from "./docsite-reference.ts";
import { shadowSection } from "./docsite-shadows.ts";
import { spacingSection, radiiSection, otherSection } from "./docsite-space.ts";
import { typographySection } from "./docsite-type.ts";

export type { SystemDoc } from "./docsite-core.ts";

// ── The page ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Block {
    id: string;
    title: string;
    group: "Overview" | "Foundations" | "Components" | "Reference";
    html: string;
    count?: number;
    searchable?: boolean;
}

/** Colors for the page's own accent: the system's accent when it reads on the page, else a calm blue. */
function chromeAccent(
    ctx: Ctx,
    theme: "light" | "dark",
): { accent: string; ink: string; soft: string } {
    const page = theme === "dark" ? "#0e0f15" : "#fafafc";
    const fallback = theme === "dark" ? "#8fb0ff" : "#3557a5";
    const mode = ctx.modes.find((m) => ctx.theme.get(m) === theme);
    const token =
        findToken(ctx, [
            "color.accent.default",
            "color.accent.primary",
            "color.accent.fill",
            "color.primary.default",
            "color.brand.default",
            "color.accent",
        ]) ??
        ctx.system.tokens.find(
            (t) =>
                t.type === "color" &&
                t.tier !== "primitive" &&
                /accent|primary|brand/i.test(t.path.join(".")),
        );
    const color = mode === undefined ? undefined : colorOf(token, mode);
    const ground = parseColor(page)!;
    const accent =
        color !== undefined && color.a >= 0.999 && contrastRatio(color, ground) >= 4.5
            ? toHex(color)
            : fallback;
    const parsed = parseColor(accent)!;

    return {
        accent,
        ink: readableOn(parsed),
        soft: toHex({ ...parsed, a: theme === "dark" ? 0.18 : 0.1 }),
    };
}

const ICON_MENU = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14"/></svg>`;
const ICON_SEARCH = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3.5 3.5"/></svg>`;

/**
 * The swatches of the hero, chosen by the role they play, in the order a person reads a system: the ground, the
 * surface, text, its quieter text, the line, the accent, and the status colors. Each has a short role word as its
 * label; its full token name is the tooltip and what a tap copies. A role the system does not name is left out, and
 * when too few are found, the first semantic colors fill the row.
 */
function sampler(ctx: Ctx): string {
    const ROLES: [string, string[], RegExp][] = [
        ["background", BASE_GROUNDS, /^color\.(bg|background)\.(base|default|canvas|page)$/],
        [
            "surface",
            [
                "color.bg.surface",
                "color.surface.default",
                "color.surface",
                "color.bg.card",
                "color.bg.raised",
            ],
            /^color\.(surface|card)\./,
        ],
        ["text", BASE_TEXTS, /^color\.(text|fg|foreground)\.(primary|default|base)$/],
        [
            "muted",
            ["color.text.muted", "color.text.secondary", "color.fg.muted"],
            /^color\.(text|fg)\.(muted|secondary|subtle)$/,
        ],
        [
            "border",
            ["color.border.default", "color.border.subtle", "color.border"],
            /^color\.border\./,
        ],
        [
            "accent",
            [
                "color.accent.default",
                "color.accent.primary",
                "color.accent.fill",
                "color.primary.default",
                "color.primary",
                "color.accent",
            ],
            /(accent|primary)/,
        ],
        [
            "danger",
            ["color.danger.default", "color.error.default", "color.danger", "color.error"],
            /(danger|error|negative)/,
        ],
        ["warning", ["color.warning.default", "color.warning"], /warning/],
        [
            "success",
            ["color.success.default", "color.success", "color.positive.default"],
            /(success|positive)/,
        ],
        ["info", ["color.info.default", "color.info"], /info/],
        ["brand", ["color.brand.default", "color.brand"], /brand/],
        ["code", ["color.code.bg"], /code\.bg/],
    ];
    const semantic = ctx.system.tokens.filter(
        (token) => token.type === "color" && token.tier === "semantic",
    );
    const chosen: { label: string; token: ResolvedToken }[] = [];

    for (const [label, names, pattern] of ROLES) {
        const token =
            findToken(ctx, names) ??
            semantic.find(
                (item) =>
                    pattern.test(item.name) &&
                    !/on-|inverse|hover|active|soft|line|scrim/.test(item.name),
            );

        if (token !== undefined && !chosen.some((item) => item.token === token)) {
            chosen.push({ label, token });
        }
    }

    // A system with few named roles still shows a row: more of its semantic colors, labelled by their last words.
    for (const token of semantic) {
        if (chosen.length >= 8) {
            break;
        }

        if (!chosen.some((item) => item.token === token)) {
            chosen.push({ label: token.path.slice(-2).join(" "), token });
        }
    }

    return chosen.length === 0
        ? ""
        : `<div class="strip">${chosen
              .slice(0, 12)
              .map(
                  ({ label, token }) =>
                      `<button type="button" class="sw" data-copy="${esc(token.name)}" title="${esc(token.name)}"><i style="background:${varOf(token)}"></i><span>${esc(clip(label, 12))}</span></button>`,
              )
              .join("")}</div>`;
}

/**
 * The documentation page for a design system. An artifact holds 2 MB at most, so a system so large that its page would
 * not fit shows fewer rows in the token table until it does.
 */
export function renderSystemDoc(system: DesignSystem): SystemDoc {
    let rows = MAX_TOKENS;
    let doc = build(system, rows);

    while (Buffer.byteLength(doc.html) > MAX_PAGE && rows > 25) {
        rows = Math.floor(rows / 2);
        doc = build(system, rows);
    }

    return doc;
}

function build(system: DesignSystem, referenceRows: number): SystemDoc {
    const ctx = buildContext(system);
    // The page's scripts carry this, and nothing in project text can know it: it is new for each page.
    const nonce = randomBytes(16).toString("base64url");
    const name = clip(system.name || "Design system", 80);
    const sections: Block[] = [];
    const color = colorSection(ctx);
    const type = typographySection(ctx);
    const spacing = spacingSection(ctx);
    const radii = radiiSection(ctx);
    const shadow = shadowSection(ctx);
    const motion = motionSection(ctx);
    const components = componentsSection(ctx);
    const other = otherSection(ctx);
    const guidelines =
        system.guidelines.trim() === "" ? undefined : renderMarkdown(system.guidelines);
    const reference = referenceSection(ctx, referenceRows);
    const code = codeSection(ctx);
    const pairs = pairRows(ctx);
    const roleCount = ctx.system.tokens.filter(
        (token) => token.type === "color" && token.tier === "semantic",
    ).length;

    const add = (block: Block | undefined) => block !== undefined && sections.push(block);

    if (color) {
        add({
            id: "color",
            title: "Color",
            group: "Foundations",
            html: color.html,
            count: color.count,
            searchable: true,
        });
    }

    if (type) {
        add({
            id: "typography",
            title: "Typography",
            group: "Foundations",
            html: type.html,
            count: type.count,
            searchable: true,
        });
    }

    if (spacing) {
        add({
            id: "spacing",
            title: "Spacing",
            group: "Foundations",
            html: spacing.html,
            count: spacing.count,
            searchable: true,
        });
    }

    if (radii) {
        add({
            id: "radii",
            title: "Radii",
            group: "Foundations",
            html: radii.html,
            count: radii.count,
            searchable: true,
        });
    }

    if (shadow) {
        add({
            id: "shadows",
            title: "Shadows",
            group: "Foundations",
            html: shadow.html,
            count: shadow.count,
            searchable: true,
        });
    }

    if (motion) {
        add({
            id: "motion",
            title: "Motion",
            group: "Foundations",
            html: motion.html,
            count: motion.count,
            searchable: true,
        });
    }

    if (other) {
        add({
            id: "other",
            title: "Other",
            group: "Foundations",
            html: other.html,
            count: other.count,
            searchable: true,
        });
    }

    if (components) {
        add({
            id: "components",
            title: "Components",
            group: "Components",
            html: components.html,
            count: components.count,
            searchable: true,
        });
    }

    if (guidelines !== undefined) {
        add({
            id: "guidelines",
            title: "Guidelines",
            group: "Reference",
            html: `<div class="prose">${guidelines}</div>`,
        });
    }

    add({
        id: "tokens",
        title: "All tokens",
        group: "Reference",
        html: reference.html,
        count: reference.count,
        searchable: true,
    });
    add({ id: "code", title: "Use in code", group: "Reference", html: code.html });

    const tiles = sections
        .filter((section) => section.group !== "Reference" || section.id === "guidelines")
        .map((section) => {
            const lines: Record<string, string> = {
                color: `${plural(roleCount, "role")} in ${plural(ctx.modes.length, "mode")}`,
                typography: "Faces, sizes, and text styles",
                spacing: "Steps and sizes",
                radii: "Corners by role",
                shadows: "Lifts that follow the mode",
                motion: "Durations, easing, transitions",
                components: `${plural(ctx.system.components.length, "component")} with every state`,
                guidelines: "How to use the system",
                other: "The rest of the tokens",
            };

            return `<a class="tile" href="#${section.id}"><b>${esc(section.title)}</b><span>${esc(lines[section.id] ?? "")}</span></a>`;
        })
        .join("");
    const statText = (value: string, label: string) =>
        `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    // The number, and its noun in the right number: "1 mode", "3 modes".
    const stat = (count: number, noun: string) =>
        statText(String(count), plural(count, noun).slice(String(count).length + 1));
    const overview = `<section class="block" id="overview" data-pid="overview" aria-labelledby="overview-title"><div class="hero"><p class="eyebrow">Design system</p><h1 id="overview-title">${esc(name)}</h1>${system.description === undefined ? "" : `<p class="lead">${esc(clip(system.description, 400))}</p>`}${sampler(ctx)}<div class="stats">${stat(ctx.system.tokens.length, "token")}${stat(roleCount, "color role")}${stat(ctx.modes.length, "mode")}${stat(ctx.system.components.length, "component")}${pairs.total > 0 ? statText(`${pairs.passing}/${pairs.total}`, pairs.total === 1 ? "contrast check passes" : "contrast checks pass") : ""}</div></div><div class="tiles">${tiles}</div>${problemsHtml(ctx)}${notesHtml(ctx)}${system.tokens.length > MAX_TOKENS ? `<p class="sub" style="margin-top:14px">This page shows the first ${MAX_TOKENS} of ${system.tokens.length} tokens.</p>` : ""}</section>`;
    const body = sections
        .map(
            (section) =>
                `<section class="block" id="${section.id}" data-pid="${section.id}" aria-labelledby="${section.id}-title"${section.searchable ? " data-searchable" : ""}><p class="eyebrow">${esc(section.group)}</p><h2 id="${section.id}-title">${esc(section.title)}</h2>${section.html}</section>`,
        )
        .join("");

    const navGroups = (["Foundations", "Components", "Reference"] as const)
        .map((group) => {
            const own = sections.filter((section) => section.group === group);

            if (own.length === 0) {
                return "";
            }

            const links = own.flatMap((section) => {
                const link = `<a href="#${section.id}">${esc(section.title)}${section.count === undefined ? "" : `<span class="count">${section.count}</span>`}</a>`;

                if (section.id !== "components") {
                    return [link];
                }

                return [
                    link,
                    ...ctx.system.components
                        .slice(0, MAX_COMPONENTS)
                        .map(
                            (spec) =>
                                `<a href="#comp-${idOf(spec.slug)}" style="padding-left:22px;min-height:30px;font-size:13.5px">${esc(spec.name)}</a>`,
                        ),
                ];
            });

            return `<div class="nav-group"><p class="nav-title">${group}</p>${links.join("")}</div>`;
        })
        .join("");
    const modeButtons = ctx.modes
        .map(
            (mode, index) =>
                `<button type="button" data-mode="${ctx.slug.get(mode)}" data-theme="${ctx.theme.get(mode)}" aria-pressed="${index === 0}">${esc(modeLabel(mode))}</button>`,
        )
        .join("");
    const light = chromeAccent(ctx, "light");
    const dark = chromeAccent(ctx, "dark");
    const darkMode = ctx.modes.find(
        (mode) => ctx.theme.get(mode) === "dark" && ctx.theme.get(ctx.modes[0]!) !== "dark",
    );
    const first = ctx.modes[0]!;
    const modeCss = ctx.modes
        .map(
            (mode) =>
                `html:not([data-mode="${ctx.slug.get(mode)}"]) .mv[data-m="${ctx.modes.indexOf(mode)}"]{display:none}`,
        )
        .join("\n");
    const tokenVars = (() => {
        const declare = (mode: string, only?: (token: ResolvedToken) => boolean) =>
            ctx.system.tokens
                .filter((token) => only === undefined || only(token))
                .map((token) => {
                    const css = safeCss(valueIn(token, mode)?.css);

                    return css === undefined || safeVar(token.cssVar) === undefined
                        ? ""
                        : `${token.cssVar}:${css};`;
                })
                .join("");
        const out = [`body.ds{${declare(first)}}`];

        for (const mode of ctx.modes.slice(1)) {
            const rules = declare(
                mode,
                (token) => valueIn(token, mode)?.css !== valueIn(token, first)?.css,
            );

            if (rules !== "") {
                out.push(`html[data-mode="${ctx.slug.get(mode)}"] body.ds{${rules}}`);
            }
        }

        return out.join("\n");
    })();
    const html = `<!doctype html>
<html lang="en" class="nojs" data-mode="${ctx.slug.get(first)}" data-theme="${ctx.theme.get(first)}"${darkMode === undefined ? "" : ` data-dark-mode="${ctx.slug.get(darkMode)}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${pageCsp(nonce)}">
<meta name="color-scheme" content="light dark">
<title>${esc(name)} · Design system</title>
<script nonce="${nonce}">${DOC_BOOT_JS}</script>
<style>${DOC_CSS}
html[data-theme="light"]{--dd-accent:${light.accent};--dd-accent-ink:${light.ink};--dd-accent-soft:${light.soft}}
html[data-theme="dark"]{--dd-accent:${dark.accent};--dd-accent-ink:${dark.ink};--dd-accent-soft:${dark.soft}}
${modeCss}
</style>
<style>${tokenVars}</style>
</head>
<body class="ds">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
<button class="icon-btn" type="button" aria-label="Menu" aria-controls="nav" aria-expanded="false">${ICON_MENU}</button>
<div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">${esc(name)}</span><span class="brand-sub">Design system</span></div>
<span class="spacer"></span>
${ctx.modes.length > 1 ? `<div class="seg" role="group" aria-label="Mode">${modeButtons}</div><select class="modesel" aria-label="Mode">${ctx.modes.map((mode, index) => `<option value="${ctx.slug.get(mode)}" data-theme="${ctx.theme.get(mode)}"${index === 0 ? " selected" : ""}>${esc(modeLabel(mode))}</option>`).join("")}</select>` : ""}
</header>
<div class="layout">
<aside class="side" id="nav">
<div class="search"><label class="sr" for="q" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Filter tokens and components</label>${ICON_SEARCH}<input id="q" type="search" placeholder="Filter tokens" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></div>
<nav class="nav" aria-label="Sections"><div class="nav-group"><a href="#overview" aria-current="true">Overview</a></div>${navGroups}</nav>
</aside>
<main id="main">
${overview}
${body}
<p class="empty" id="nomatch" hidden>No token or component matches that filter.</p>
<footer class="foot"><strong>${esc(name)}</strong> · ${plural(ctx.system.tokens.length, "token")} · ${plural(ctx.modes.length, "mode")} · ${plural(ctx.system.components.length, "component")} · generated ${new Date().toISOString().slice(0, 10)} by Pi Pocket</footer>
</main>
</div>
<div class="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">${DOC_JS}</script>
</body>
</html>
`;

    // The search reads each item's own text (the script does it once, on the first search), so no copy of it is kept.
    return { html: html.replace(/ data-q="[^"]*"/g, " data-s"), assets: [] };
}
