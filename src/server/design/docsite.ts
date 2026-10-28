/**
 * The design system's documentation page (stream G of the design-system hill climb): one self-contained HTML document
 * for a `DesignSystem`, with navigation and search, an overview, color roles and the palette with contrast tables,
 * type specimens, spacing, radii, shadows, motion demos, every component as a grid of its states with its code, the
 * guidelines, a table of every token, and the code to use it. It has a switch for each of the system's modes.
 *
 * The page runs in the artifact sandbox, so it asks for nothing: no network, no app, no external font or image. All
 * project text (names, descriptions, values, Markdown, component markup and CSS) is data. Text is escaped; token values
 * that reach a style are checked first; component markup and CSS run only in an `iframe` that has no script and a
 * policy that blocks every request.
 */
import { randomBytes } from "node:crypto";
import type {
    ComponentSpec,
    DesignSystem,
    ModeValue,
    ResolvedToken,
    TokenType,
} from "./system-types.ts";
import {
    contrastRatio,
    parseColor,
    rating,
    readableOn,
    toHex,
    toOklchText,
    type Rgba,
} from "./docsite-color.ts";
import { DOC_BOOT_JS, DOC_CSS, DOC_JS, FRAME_JS } from "./docsite-assets.ts";
import { escapeHtml as esc, plural, renderMarkdown, slugify } from "./docsite-markdown.ts";

/** What `renderSystemDoc` returns: the page, and files that sit beside it in the bundle (none today). */
export interface SystemDoc {
    html: string;
    assets: { name: string; content: string }[];
}

/** The most tokens, components, and states the page draws; a system over a limit shows its first part and says so. */
const MAX_TOKENS = 3000;
const MAX_COMPONENTS = 60;
/** The most color cards, palette steps, and rows of one specimen list: a bigger list goes on in the token table. */
const MAX_ROLES = 240;
const MAX_PALETTE = 480;
const MAX_SPECIMENS = 120;
const MAX_STATES = 16;
/** The most bytes of page: an artifact holds 2 MB, and the page keeps room under that. */
const MAX_PAGE = 1_800_000;

/** The longest piece of code the page prints for a component or for the compiled files. */
const MAX_CODE = 60_000;

const PAGE_CSP =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:";
const frameCsp = (nonce: string) =>
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'`;

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A name for a mode, for people: `high-contrast` is "High contrast". */
function modeLabel(mode: string): string {
    const text = mode.replace(/[-_]+/g, " ").trim() || mode;

    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Words for a path segment; a few short names are spelled out. */
const SEGMENT_TITLES: Record<string, string> = {
    bg: "Background",
    fg: "Foreground",
    bgcolor: "Background",
    sh: "Shadow",
    z: "Layers",
};

function titleOf(segment: string): string {
    const known = SEGMENT_TITLES[segment.toLowerCase()];

    if (known !== undefined) {
        return known;
    }

    const text = segment.replace(/[-_]+/g, " ").trim() || segment;

    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A CSS value from the project is used in a style only when it cannot end the declaration or the block. */
function safeCss(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 600) {
        return undefined;
    }

    if (/[{}<>;\\\u0000-\u001f]|\/\*|@import|url\s*\(|expression\s*\(|javascript:/i.test(value)) {
        return undefined;
    }

    return value;
}

const safeVar = (name: string) => (/^--[A-Za-z0-9_-]{1,120}$/.test(name) ? name : undefined);

/** `var(--name)` for a token, or the fallback when the name is not a safe custom property. */
const varOf = (token: ResolvedToken, fallback = "transparent") =>
    safeVar(token.cssVar) === undefined ? fallback : `var(${token.cssVar})`;

/** An id that is safe in an attribute and a selector. */
const idOf = (text: string) => slugify(text) || "x";

/** A dimension value as CSS text (`16px`), from the string and object forms. */
function dimText(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number") {
        return `${value}px`;
    }

    if (isObject(value) && typeof value.value === "number" && typeof value.unit === "string") {
        return `${value.value}${value.unit}`;
    }

    return undefined;
}

/** A dimension in pixels (one rem is 16). */
function pxOf(value: unknown): number | undefined {
    const match = /^(-?\d*\.?\d+)\s*(px|rem|em)?$/.exec(dimText(value) ?? "");

    if (match === null) {
        return undefined;
    }

    return Number.parseFloat(match[1]!) * (match[2] === "px" || match[2] === undefined ? 1 : 16);
}

function stackOf(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        return value
            .map((family) => String(family))
            .map((family) => (/^[\w-]+$/.test(family) ? family : `"${family.replace(/"/g, "")}"`))
            .join(", ");
    }

    return typeof value === "string" ? value : undefined;
}

function colorValueText(value: unknown): string | undefined {
    const color = parseColor(value);

    return color === undefined ? undefined : toHex(color);
}

function shadowText(value: unknown): string {
    const layers = Array.isArray(value) ? value : [value];

    return layers
        .map((layer) => {
            if (!isObject(layer)) {
                return String(layer);
            }

            const parts = [layer.offsetX, layer.offsetY, layer.blur, layer.spread]
                .map((part) => dimText(part) ?? "0")
                .join(" ");

            return `${layer.inset === true ? "inset " : ""}${parts} ${colorValueText(layer.color) ?? String(layer.color)}`;
        })
        .join(", ");
}

/** A resolved value as short, readable text. */
function plain(type: TokenType, value: unknown): string {
    switch (type) {
        case "color":
            return colorValueText(value) ?? clip(JSON.stringify(value) ?? "", 80);
        case "dimension":
            return dimText(value) ?? String(value);
        case "fontFamily":
            return stackOf(value) ?? String(value);
        case "cubicBezier":
            return Array.isArray(value) ? `cubic-bezier(${value.join(", ")})` : String(value);
        case "shadow":
            return shadowText(value);
        case "typography":
            if (isObject(value)) {
                return `${stackOf(value.fontFamily)?.split(",")[0]?.replace(/"/g, "") ?? ""} ${dimText(value.fontSize) ?? ""}/${String(value.lineHeight ?? "")} ${String(value.fontWeight ?? "")}`.trim();
            }

            return String(value);
        case "transition":
            return isObject(value)
                ? `${dimText(value.duration) ?? ""} ${plain("cubicBezier", value.timingFunction)}`.trim()
                : String(value);
        default:
            return typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
                ? String(value)
                : clip(JSON.stringify(value) ?? "", 120);
    }
}

/** The first `max` of a list, and a note for the page when some are left out. */
function capped<T>(list: T[], max: number): [T[], string] {
    return list.length <= max
        ? [list, ""]
        : [
              list.slice(0, max),
              `<p class="sub">Showing the first ${max} of ${list.length}. The table of all tokens has the rest.</p>`,
          ];
}

/** Lists cut to the specimen limit, and whether any was cut, for one section. */
function limiter(): { limit: <T>(list: T[]) => T[]; note: () => string } {
    let cut = false;

    return {
        limit: (list) => {
            cut ||= list.length > MAX_SPECIMENS;

            return list.slice(0, MAX_SPECIMENS);
        },
        note: () =>
            cut
                ? `<p class="sub">Some lists show only their first ${MAX_SPECIMENS}. The table of all tokens has the rest.</p>`
                : "",
    };
}

// ── The page's model ───────────────────────────────────────────────────────────────────────────────────────────────

/** The sections that count tokens. A token is in exactly one; their counts add up to the system's token count. */
type SectionId = "color" | "typography" | "spacing" | "radii" | "shadows" | "motion" | "other";

const SECTION_HINTS: [SectionId, RegExp][] = [
    ["typography", /^(font|type|text|typography|line|leading|letter|tracking)$/],
    ["spacing", /^(space|spacing|gap|size|sizes|padding|margin|inset|stack|layout)$/],
    ["radii", /^(radius|radii|round|rounded|corner|corners)$/],
    ["motion", /^(motion|duration|delay|ease|easing|transition|timing)$/],
];

/**
 * The section of a token, by its type, and for dimensions and plain numbers by the words of its path. The same rule as
 * the System view's (`sectionOf` in extensions/design/system.js), so that both count alike: every token once, in one
 * section, whatever its tier (a component's tokens count too).
 */
function sectionOf(token: ResolvedToken): SectionId {
    switch (token.type) {
        case "color":
        case "gradient":
            return "color";
        case "fontFamily":
        case "fontWeight":
        case "typography":
            return "typography";
        case "shadow":
            return "shadows";
        case "duration":
        case "cubicBezier":
        case "transition":
            return "motion";
        case "dimension":
        case "number":
            for (const part of token.path) {
                const hint = SECTION_HINTS.find(([, pattern]) => pattern.test(part.toLowerCase()));

                if (hint !== undefined) {
                    return hint[0];
                }
            }

            return "other";
        default:
            return "other";
    }
}

interface Ctx {
    system: DesignSystem;
    modes: string[];
    /** A mode's name as an attribute value. */
    slug: Map<string, string>;
    theme: Map<string, "light" | "dark">;
    byName: Map<string, ResolvedToken>;
    byVar: Map<string, ResolvedToken>;
    /** The tokens of each section (see `sectionOf`). */
    sections: Map<SectionId, ResolvedToken[]>;
    /** The tokens that a specimen has drawn: the rest of a section go to its table of more tokens. */
    claimed: Set<ResolvedToken>;
}

/** A token's name from the text of a reference: `{color.bg.base}` or `color.bg.base`. */
const nameOfRef = (text: string) => text.replace(/^\{|\}$/g, "").trim();

const valueIn = (token: ResolvedToken, mode: string): ModeValue | undefined => token.modes[mode];

/**
 * The same content for every mode. A text that does not change is written once; texts that differ are written once for
 * each mode and shown by the mode in force, in CSS alone.
 */
function variants(ctx: Ctx, make: (mode: string) => string, tag = "span"): string {
    const texts = ctx.modes.map((mode) => make(mode));

    if (texts.every((text) => text === texts[0])) {
        return texts[0] ?? "";
    }

    return ctx.modes
        .map(
            (mode, index) =>
                `<${tag} class="mv" data-m="${ctx.slug.get(mode)}">${texts[index]}</${tag}>`,
        )
        .join("");
}

const colorOf = (token: ResolvedToken | undefined, mode: string): Rgba | undefined =>
    token === undefined ? undefined : parseColor(valueIn(token, mode)?.value);

function aliasChain(ctx: Ctx, token: ResolvedToken, mode: string): string[] {
    const chain: string[] = [];
    let at: ResolvedToken | undefined = token;

    for (let step = 0; step < 6 && at !== undefined; step++) {
        const alias: string | undefined = valueIn(at, mode)?.alias;

        if (alias === undefined) {
            break;
        }

        chain.push(alias);
        at = ctx.byName.get(alias);
    }

    return chain;
}

const GROUND_SEGMENTS = new Set(["bg", "background", "surface", "canvas", "ground"]);
const TEXT_SEGMENTS = new Set(["text", "fg", "foreground", "content", "ink"]);

const hasSegment = (token: ResolvedToken, set: Set<string>) =>
    token.path.slice(0, -1).some((segment) => set.has(segment.toLowerCase()));

function findToken(ctx: Ctx, names: string[]): ResolvedToken | undefined {
    for (const name of names) {
        const token = ctx.byName.get(name);

        if (token !== undefined) {
            return token;
        }
    }

    return undefined;
}

const BASE_GROUNDS = [
    "color.bg.base",
    "color.bg.default",
    "color.background.default",
    "color.background.base",
    "color.background",
    "color.bg.canvas",
    "color.bg",
    "color.surface.default",
];

const BASE_TEXTS = [
    "color.text.primary",
    "color.text.default",
    "color.text.base",
    "color.text",
    "color.foreground.default",
    "color.foreground",
    "color.fg.default",
];

function groundToken(ctx: Ctx): ResolvedToken | undefined {
    return (
        findToken(ctx, BASE_GROUNDS) ??
        ctx.system.tokens.find(
            (token) =>
                token.type === "color" &&
                token.tier !== "primitive" &&
                hasSegment(token, GROUND_SEGMENTS),
        )
    );
}

function textToken(ctx: Ctx): ResolvedToken | undefined {
    return (
        findToken(ctx, BASE_TEXTS) ??
        ctx.system.tokens.find(
            (token) =>
                token.type === "color" &&
                token.tier !== "primitive" &&
                hasSegment(token, TEXT_SEGMENTS),
        )
    );
}

/** Whether a mode is dark: by its ground color when the system has one, else by its name. */
function themeOfMode(ctx: Ctx, mode: string): "light" | "dark" {
    const ground = colorOf(groundToken(ctx), mode);

    if (ground !== undefined) {
        return ground.a < 1 ||
            (0.2126 * ground.r + 0.7152 * ground.g + 0.0722 * ground.b) / 255 > 0.45
            ? "light"
            : "dark";
    }

    return /dark|night|black|contrast/i.test(mode) ? "dark" : "light";
}

function buildContext(system: DesignSystem): Ctx {
    // A custom property name goes into styles: one that is not plain gets a safe name made from the token's.
    const tokens = system.tokens
        .slice(0, MAX_TOKENS)
        .map((token) =>
            safeVar(token.cssVar) === undefined
                ? { ...token, cssVar: `--${idOf(token.name)}` }
                : token,
        );
    const modes = system.modes.length > 0 ? system.modes : ["default"];
    const slug = new Map<string, string>();
    const used = new Set<string>();

    for (const mode of modes) {
        let candidate = mode.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "mode";

        while (used.has(candidate)) {
            candidate += "-x";
        }

        used.add(candidate);
        slug.set(mode, candidate);
    }

    const ctx: Ctx = {
        system: { ...system, tokens },
        modes,
        slug,
        theme: new Map(),
        byName: new Map(tokens.map((token) => [token.name, token])),
        byVar: new Map(tokens.map((token) => [token.cssVar, token])),
        sections: new Map(),
        claimed: new Set(),
    };

    for (const token of tokens) {
        const id = sectionOf(token);

        ctx.sections.set(id, [...(ctx.sections.get(id) ?? []), token]);
    }

    for (const mode of modes) {
        ctx.theme.set(mode, themeOfMode(ctx, mode));
    }

    return ctx;
}

// ── Color cards ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A contrast ratio with one decimal, cut and not rounded, so that 4.48 never shows as the 4.5 it does not reach. */
const fmtRatio = (ratio: number) => (Math.floor(ratio * 10 + 1e-9) / 10).toFixed(1);

function ratioPill(ratio: number, min: number | undefined, exempt?: string): string {
    const label = rating(ratio);
    const passes = min === undefined ? label !== "fail" : ratio >= min;

    // An exempt pair (disabled or decorative text) is not a failure: it says why it is left out.
    if (!passes && exempt !== undefined) {
        return `<span class="ratio">${fmtRatio(ratio)}:1</span> <span class="pill">exempt (${esc(exempt)})</span>`;
    }

    return `<span class="ratio">${fmtRatio(ratio)}:1</span> <span class="pill ${passes ? "ok" : "bad"}">${passes ? label : "Fails"}</span>`;
}

/** Three ways to copy a token: as a CSS variable, as a Tailwind class (the compiled `@theme` maps `--color-*` to utilities), and as its JSON path. */
function copyRow(token: ResolvedToken): string {
    const button = (label: string, text: string, title: string) =>
        `<button class="mini" type="button" data-copy="${esc(text)}" title="${esc(title)}">${label}</button>`;
    const buttons = [button("CSS var", `var(${token.cssVar})`, `Copy var(${token.cssVar})`)];

    if (token.cssVar.startsWith("--color-")) {
        const rest = token.cssVar.slice("--color-".length);
        const prefix = hasSegment(token, TEXT_SEGMENTS)
            ? "text"
            : /(^|\.)border(\.|$)/.test(token.name)
              ? "border"
              : "bg";

        buttons.push(
            button("Tailwind", `${prefix}-${rest}`, `Copy the Tailwind class ${prefix}-${rest}`),
        );
    }

    buttons.push(button("JSON", `${token.name}.$value`, `Copy the JSON path ${token.name}.$value`));

    return `<div class="copy-row">${buttons.join("")}</div>`;
}

function swatchCard(ctx: Ctx, token: ResolvedToken): string {
    const pair =
        token.contrast === undefined ? undefined : ctx.byName.get(nameOfRef(token.contrast.on));
    const translucent = ctx.modes.some((mode) => (colorOf(token, mode)?.a ?? 1) < 0.999);
    const query = `${token.name} ${token.description ?? ""} ${token.cssVar}`.toLowerCase();
    let chip: string;

    if (pair !== undefined) {
        chip = `<span class="sw-fill" style="background:${varOf(pair)}"></span><span class="aa" style="color:${varOf(token, "inherit")}">Aa</span><span class="aa-sm" style="color:${varOf(token, "inherit")}">on ${esc(pair.name)}</span>`;
    } else {
        const ink = variants(ctx, (mode) => {
            const color = colorOf(token, mode);

            return `<span class="aa" style="color:${translucent || color === undefined ? "var(--dd-text)" : readableOn(color)}">Aa</span>`;
        });

        chip = `<span class="sw-fill" style="background:${varOf(token)}"></span>${ink}`;
    }

    const hex = variants(ctx, (mode) => esc(colorValueText(valueIn(token, mode)?.value) ?? "—"));
    const oklch = variants(ctx, (mode) => {
        const color = colorOf(token, mode);

        return color === undefined ? "—" : esc(toOklchText(color));
    });
    const chain = variants(ctx, (mode) => {
        const links = aliasChain(ctx, token, mode);

        return links.length === 0 ? "—" : links.map(esc).join(" → ");
    });
    const rows = [
        `<div><dt>hex</dt><dd>${hex}</dd></div>`,
        `<div><dt>oklch</dt><dd>${oklch}</dd></div>`,
    ];

    if (ctx.modes.some((mode) => aliasChain(ctx, token, mode).length > 0)) {
        rows.push(`<div><dt>alias</dt><dd class="chain">${chain}</dd></div>`);
    }

    let contrast = "";

    if (pair !== undefined && token.contrast !== undefined) {
        const min = token.contrast.min;

        contrast = `<div class="cr">${variants(ctx, (mode) => {
            const fg = colorOf(token, mode);
            const bg = colorOf(pair, mode);

            return fg === undefined || bg === undefined
                ? "—"
                : ratioPill(contrastRatio(fg, bg), min, token.contrast?.exempt);
        })} <span class="desc">${token.contrast.exempt === undefined ? "needs" : `exempt (${esc(token.contrast.exempt)}); would need`} ${min}:1 on ${esc(pair.name)}</span></div>`;
    }

    const deprecated =
        token.deprecated === undefined || token.deprecated === false
            ? ""
            : ` <span class="pill warn">Deprecated</span>`;

    return `<article class="card" data-q="${esc(query)}"><button class="sw-chip" data-copy="${esc(`var(${token.cssVar})`)}" title="Copy var(${esc(token.cssVar)})" aria-label="Copy var(${esc(token.cssVar)})">${chip}</button><div class="card-body"><div><button class="tk" data-copy="${esc(token.name)}" title="Copy the token name">${esc(token.name)}</button>${deprecated}</div>${token.description === undefined ? "" : `<p class="desc">${esc(token.description)}</p>`}<dl class="vals">${rows.join("")}</dl>${contrast}${copyRow(token)}</div></article>`;
}

/** The title of the group a color token sits in: its path without the first segment (`color`) and the name. */
function groupKey(token: ResolvedToken): string {
    const path = token.path.slice(0, -1);

    if (path.length > 1 && /^(colou?rs?|palette)$/i.test(path[0]!)) {
        path.shift();
    }

    return path.length === 0 ? "Colors" : path.map(titleOf).join(" / ");
}

function grouped(
    tokens: ResolvedToken[],
    keyOf: (token: ResolvedToken) => string,
): [string, ResolvedToken[]][] {
    const groups = new Map<string, ResolvedToken[]>();

    for (const token of tokens) {
        const key = keyOf(token);

        groups.set(key, [...(groups.get(key) ?? []), token]);
    }

    return [...groups];
}

function rampStep(ctx: Ctx, token: ResolvedToken): string {
    const label = token.path[token.path.length - 1]!;
    const ink = variants(ctx, (mode) => {
        const color = colorOf(token, mode);
        const hex = colorValueText(valueIn(token, mode)?.value) ?? "—";
        const text = color === undefined || color.a < 0.999 ? "var(--dd-text)" : readableOn(color);

        return `<span style="color:${text}"><b>${esc(label)}</b><small>${esc(hex)}</small></span>`;
    });
    const query = `${token.name} ${token.cssVar}`.toLowerCase();

    return `<button class="step" data-q="${esc(query)}" data-copy="${esc(token.name)}" style="background:${varOf(token)}" title="Copy ${esc(token.name)}">${ink}</button>`;
}

/** Contrast pairs that the system declares, with the ratio in each mode. */
function pairRows(ctx: Ctx): { total: number; passing: number; table: string } {
    const declared = ctx.system.tokens.filter((token) => token.contrast !== undefined);
    let total = 0;
    let passing = 0;
    // A token may declare several pairs: a row for each. An exempt pair is shown, and counted in neither number.
    const rows = declared.flatMap((token) =>
        (token.contrasts ?? [token.contrast!]).map((pairOf) => {
            const pair = ctx.byName.get(nameOfRef(pairOf.on));
            const cells = ctx.modes.map((mode) => {
                const fg = colorOf(token, mode);
                const bg = colorOf(pair, mode);

                if (fg === undefined || bg === undefined) {
                    return `<td class="num">—</td>`;
                }

                const ratio = contrastRatio(fg, bg);

                if (pairOf.exempt === undefined) {
                    total++;

                    if (ratio >= pairOf.min) {
                        passing++;
                    }
                }

                return `<td class="num">${ratioPill(ratio, pairOf.min, pairOf.exempt)}</td>`;
            });

            return `<tr data-q="${esc(`${token.name} ${pairOf.on}`.toLowerCase())}"><td><span class="mini-sw" style="background:${varOf(token)}"></span><button class="tk" data-copy="${esc(token.name)}">${esc(token.name)}</button></td><td><button class="tk" data-copy="${esc(nameOfRef(pairOf.on))}">${esc(nameOfRef(pairOf.on))}</button></td><td class="num">${pairOf.exempt === undefined ? `${pairOf.min}:1` : `exempt (${esc(pairOf.exempt)})`}</td>${cells.join("")}</tr>`;
        }),
    );

    return {
        total,
        passing,
        table:
            declared.length === 0
                ? ""
                : `<div class="table-wrap"><table><thead><tr><th>Text</th><th>On</th><th>Needs</th>${ctx.modes.map((mode) => `<th>${esc(modeLabel(mode))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
    };
}

/** Every text color on every ground, in each mode. */
function matrix(ctx: Ctx, roles: ResolvedToken[]): string {
    // Text for reading: not placeholders, disabled text, or text that goes on a fill.
    const reads = (token: ResolvedToken) =>
        !/faint|disabled|placeholder|inverse|(^|[.-])on-|-on-/i.test(token.name);
    const opaque = (token: ResolvedToken) =>
        ctx.modes.every((mode) => (colorOf(token, mode)?.a ?? 1) >= 0.999);
    const texts = roles
        .filter((token) => hasSegment(token, TEXT_SEGMENTS) && reads(token))
        .slice(0, 14);
    const status = roles.filter(
        (token) =>
            !hasSegment(token, TEXT_SEGMENTS) &&
            !hasSegment(token, GROUND_SEGMENTS) &&
            /^(default|primary)$/i.test(token.path[token.path.length - 1]!) &&
            /accent|danger|error|warning|success|info|brand|link/i.test(token.path.join(".")),
    );
    const foregrounds = [...texts, ...status].slice(0, 20);
    const grounds = roles
        .filter((token) => hasSegment(token, GROUND_SEGMENTS) && opaque(token))
        .slice(0, 8);

    if (foregrounds.length === 0 || grounds.length === 0) {
        return "";
    }

    const head = grounds
        .map(
            (ground) =>
                `<th><span class="mini-sw" style="background:${varOf(ground)}"></span>${esc(ground.path.slice(-2).join("."))}</th>`,
        )
        .join("");
    const rows = foregrounds.map((fg) => {
        const cells = grounds.map((ground) => {
            const inner = variants(ctx, (mode) => {
                const a = colorOf(fg, mode);
                const b = colorOf(ground, mode);

                if (a === undefined || b === undefined) {
                    return "—";
                }

                const ratio = contrastRatio(a, b);
                const level = rating(ratio);

                return `<em>${fmtRatio(ratio)} ${level === "fail" ? "✕" : level}</em>`;
            });

            return `<td><span class="cell" style="background:${varOf(ground)};color:${varOf(fg, "inherit")}"><b>Aa</b>${inner}</span></td>`;
        });

        return `<tr data-q="${esc(fg.name.toLowerCase())}"><td><span class="mini-sw" style="background:${varOf(fg)}"></span><button class="tk" data-copy="${esc(fg.name)}">${esc(fg.name)}</button></td>${cells.join("")}</tr>`;
    });

    return `<h3 id="color-matrix">Text on grounds</h3><p class="sub">Every text color on every ground, in the mode you chose. AA text needs 4.5:1 and AAA text 7:1; ✕ is below 3:1.</p><div class="table-wrap"><table class="matrix"><thead><tr><th>Text</th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/** One sentence on how many contrast checks meet their minimum; none when there is no check. */
function checkSentence(passing: number, total: number): string {
    if (total === 0) {
        return "";
    }

    if (total === 1) {
        return ` The contrast check ${passing === 1 ? "meets" : "does not meet"} its minimum.`;
    }

    return passing === total
        ? ` All ${total} contrast checks meet their minimum.`
        : ` ${passing} of ${total} contrast checks meet their minimum.`;
}

function colorSection(ctx: Ctx): { html: string; count: number } | undefined {
    const colors = tokensOf(ctx, "color");
    const allPalette = colors.filter((token) => token.tier === "primitive");
    const allRoles = colors.filter((token) => token.tier === "semantic");
    const components = colors.filter((token) => token.tier === "component");
    const [palette, paletteNote] = capped(allPalette, MAX_PALETTE);
    const [roles, rolesNote] = capped(allRoles, MAX_ROLES);

    if (colors.length === 0) {
        return undefined;
    }

    for (const token of colors) {
        ctx.claimed.add(token);
    }

    const parts: string[] = [];
    const pairs = pairRows(ctx);

    if (roles.length > 0) {
        parts.push(
            `<h3 id="color-roles">Roles</h3><p class="sub">Roles say what a color is for. Use a role, never a palette step, so the color follows the mode.</p>${rolesNote}`,
        );

        // A group of one or two cards would leave a row empty: small groups share one grid.
        const groups = grouped(roles, groupKey);
        const small = groups.filter(([, tokens]) => tokens.length <= 2);
        const shown = [
            ...groups.filter(([, tokens]) => tokens.length > 2),
            ...(small.length === 0
                ? []
                : [
                      [
                          small.map(([key]) => key).join(" · "),
                          small.flatMap(([, tokens]) => tokens),
                      ] as [string, ResolvedToken[]],
                  ]),
        ];

        for (const [key, tokens] of shown) {
            parts.push(
                `<div data-group><h4 style="margin-top:28px">${esc(key)}</h4><div class="cards">${tokens.map((token) => swatchCard(ctx, token)).join("")}</div></div>`,
            );
        }
    }

    if (palette.length > 0) {
        parts.push(
            `<h3 id="color-palette">Palette</h3><p class="sub">The raw colors that roles point at. Click a step to copy its name.</p>${paletteNote}`,
        );

        for (const [key, tokens] of grouped(palette, groupKey)) {
            parts.push(
                `<div data-group><h4 style="margin-top:22px">${esc(key)}</h4><div class="ramp">${tokens.map((token) => rampStep(ctx, token)).join("")}</div></div>`,
            );
        }
    }

    if (components.length > 0) {
        parts.push(
            `<details class="code" data-group><summary>Component colors<span class="pill" style="margin-left:10px">${components.length}</span></summary><div class="code-body">${grouped(
                components,
                groupKey,
            )
                .map(
                    ([key, tokens]) =>
                        `<h4 style="margin-top:14px">${esc(key)}</h4><div class="ramp">${tokens.map((token) => rampStep(ctx, token)).join("")}</div>`,
                )
                .join("")}</div></details>`,
        );
    }

    if (roles.length > 0) {
        parts.push(matrix(ctx, roles));
    }

    if (pairs.table !== "") {
        parts.push(
            `<h3 id="color-pairs">Contrast pairs</h3><p class="sub">The system checks these pairs in every mode: ${pairs.passing} of ${plural(pairs.total, "check")} ${pairs.passing === 1 ? "passes" : "pass"}.</p>${pairs.table}`,
        );
    }

    return {
        html: `<p class="intro">${plural(allRoles.length, "role")}${allPalette.length > 0 ? ` over ${plural(allPalette.length, "palette color")}` : ""}${components.length > 0 ? ` and ${plural(components.length, "component color")}` : ""}${ctx.modes.length > 1 ? `, in ${ctx.modes.length} modes` : ""}.${checkSentence(pairs.passing, pairs.total)}</p>${parts.join("")}`,
        count: colors.length,
    };
}

// ── Typography ─────────────────────────────────────────────────────────────────────────────────────────────────────

const FONT_ROOTS = /^(fonts?|type|typography|text)$/i;

function copyName(token: ResolvedToken): string {
    return `<button class="tk" data-copy="${esc(token.name)}" title="Copy the token name">${esc(token.name)}</button>`;
}

function typographySection(ctx: Ctx): { html: string; count: number } | undefined {
    const { limit, note } = limiter();
    const mine = tokensOf(ctx, "typography");
    const tokens = mine.filter((token) => token.tier !== "component");
    const families = limit(tokens.filter((token) => token.type === "fontFamily"));
    const weights = limit(tokens.filter((token) => token.type === "fontWeight"));
    const composites = limit(tokens.filter((token) => token.type === "typography"));
    const sizes = limit(
        tokens.filter(
            (token) =>
                token.type === "dimension" &&
                FONT_ROOTS.test(token.path[0]!) &&
                token.path.some((segment) => /size/i.test(segment)),
        ),
    );
    const leading = limit(
        tokens.filter(
            (token) =>
                token.type === "number" &&
                FONT_ROOTS.test(token.path[0]!) &&
                token.path.some((segment) => /leading|line-?height/i.test(segment)),
        ),
    );
    const tracking = limit(
        tokens.filter(
            (token) =>
                token.type === "dimension" &&
                FONT_ROOTS.test(token.path[0]!) &&
                token.path.some((segment) => /tracking|letter/i.test(segment)),
        ),
    );
    const all = [...families, ...weights, ...composites, ...sizes, ...leading, ...tracking];

    if (mine.length === 0) {
        return undefined;
    }

    for (const token of all) {
        ctx.claimed.add(token);
    }

    const base = families[0] === undefined ? "system-ui" : `var(${families[0].cssVar}, system-ui)`;
    const parts: string[] = [];
    const q = (token: ResolvedToken) =>
        esc(`${token.name} ${token.description ?? ""}`.toLowerCase());

    if (families.length > 0) {
        parts.push(
            `<h3>Typefaces</h3><div class="cards">${families
                .map((token) => {
                    const stack = plain("fontFamily", token.modes[ctx.modes[0]!]?.value);

                    return `<article class="family" data-q="${q(token)}"><div style="margin-bottom:14px">${copyName(token)}</div><div class="big" style="font-family:var(${esc(token.cssVar)}, system-ui)" aria-hidden="true">Aa</div><p class="abc" style="font-family:var(${esc(token.cssVar)}, system-ui)">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 &amp;?!@#</p><p class="stack">${esc(clip(stack, 200))}</p>${token.description === undefined ? "" : `<p class="desc" style="margin-top:8px">${esc(token.description)}</p>`}</article>`;
                })
                .join("")}</div>`,
        );
    }

    if (weights.length > 0) {
        parts.push(
            `<h3>Weights</h3><div class="spec">${weights
                .map((token) => {
                    const weight = variants(ctx, (mode) =>
                        esc(String(valueIn(token, mode)?.value ?? "")),
                    );

                    return `<div class="spec-row" data-q="${q(token)}"><div class="spec-meta">${copyName(token)}<span class="val">${weight}</span></div><div class="sample" style="font-family:${base};font-weight:var(${esc(token.cssVar)})">Pi writes the design down, then checks it.</div></div>`;
                })
                .join("")}</div>`,
        );
    }

    if (composites.length > 0) {
        parts.push(
            `<h3>Text styles</h3><p class="sub">A style fixes the family, size, weight, line height, and tracking together.</p><div class="spec">${composites
                .map((token) => {
                    const value = token.modes[ctx.modes[0]!]?.value;
                    const style = isObject(value)
                        ? [
                              ["font-family", stackOf(value.fontFamily)],
                              ["font-size", dimText(value.fontSize)],
                              [
                                  "font-weight",
                                  value.fontWeight === undefined
                                      ? undefined
                                      : String(value.fontWeight),
                              ],
                              [
                                  "line-height",
                                  value.lineHeight === undefined
                                      ? undefined
                                      : String(value.lineHeight),
                              ],
                              ["letter-spacing", dimText(value.letterSpacing)],
                          ]
                              .filter(
                                  (entry): entry is [string, string] =>
                                      safeCss(entry[1]) !== undefined,
                              )
                              .map(([property, text]) => `${property}:${text}`)
                              .join(";")
                        : "";

                    return `<div class="spec-row" data-q="${q(token)}"><div class="spec-meta">${copyName(token)}<span class="val">${esc(plain("typography", value))}</span></div><div class="sample wrap" style="${esc(style)}">${esc(token.description ?? "The quick brown fox jumps over the lazy dog")}</div></div>`;
                })
                .join("")}</div>`,
        );
    }

    if (sizes.length > 0) {
        parts.push(
            `<h3>Size scale</h3><div class="spec">${sizes
                .map((token) => {
                    const px = variants(ctx, (mode) =>
                        esc(dimText(valueIn(token, mode)?.value) ?? ""),
                    );

                    return `<div class="spec-row" data-q="${q(token)}"><div class="spec-meta">${copyName(token)}<span class="val">${px}</span></div><div class="sample" style="font-family:${base};font-size:${varOf(token, "inherit")};line-height:1.3">The quick brown fox jumps over the lazy dog</div></div>`;
                })
                .join("")}</div>`,
        );
    }

    const rest = [...leading, ...tracking];

    if (rest.length > 0) {
        parts.push(
            `<h3>Line height and tracking</h3><div class="table-wrap"><table><thead><tr><th>Token</th><th>Value</th></tr></thead><tbody>${rest
                .map(
                    (token) =>
                        `<tr data-q="${q(token)}"><td>${copyName(token)}</td><td class="num">${variants(ctx, (mode) => esc(plain(token.type, valueIn(token, mode)?.value)))}</td></tr>`,
                )
                .join("")}</tbody></table></div>`,
        );
    }

    return {
        html: `<p class="intro">${plural(families.length, "typeface")}, ${plural(sizes.length, "size")}${composites.length > 0 ? `, and ${plural(composites.length, "text style")}` : ""}.</p>${parts.join("")}${note()}${moreTokens(ctx, "typography")}`,
        count: mine.length,
    };
}

// ── Space, size, radius, borders, layers ───────────────────────────────────────────────────────────────────────────

function rowOf(ctx: Ctx, token: ResolvedToken, sample: string): string {
    const value = variants(ctx, (mode) => esc(plain(token.type, valueIn(token, mode)?.value)));

    return `<div class="spec-row c" data-q="${esc(`${token.name} ${token.description ?? ""}`.toLowerCase())}"><div class="spec-meta">${copyName(token)}${token.description === undefined ? "" : `<span class="desc">${esc(token.description)}</span>`}</div><div class="val">${value}</div><div class="sample">${sample}</div></div>`;
}

type Built = { html: string; count: number } | undefined;

const tokensOf = (ctx: Ctx, id: SectionId) => ctx.sections.get(id) ?? [];

/** The tokens of a section that no specimen drew (most are a component's), as a table: so every token is on the page. */
function moreTokens(ctx: Ctx, id: SectionId): string {
    const [left, note] = capped(
        tokensOf(ctx, id).filter((token) => !ctx.claimed.has(token)),
        MAX_SPECIMENS,
    );

    for (const token of left) {
        ctx.claimed.add(token);
    }

    return left.length === 0
        ? ""
        : `<h3>More tokens</h3><p class="sub">Tokens of this section with no specimen of their own, most of them a component's.</p>${note}<div class="table-wrap ref"><table><thead><tr><th>Token</th><th>Type</th><th>Value</th></tr></thead><tbody>${tableRows(ctx, left)}</tbody></table></div>`;
}

const rootOf = (token: ResolvedToken) => token.path[0]!.toLowerCase();

function spacingSection(ctx: Ctx): Built {
    const { limit, note } = limiter();
    const mine = tokensOf(ctx, "spacing");

    if (mine.length === 0) {
        return undefined;
    }

    const plainOnes = mine.filter(
        (token) => token.tier !== "component" && token.type === "dimension",
    );
    const space = limit(
        plainOnes.filter((token) => /^(space|spacing|gap|gaps|sp|spaces)$/.test(rootOf(token))),
    );
    const sizes = limit(plainOnes.filter((token) => /^(size|sizes|sizing)$/.test(rootOf(token))));

    for (const token of [...space, ...sizes]) {
        ctx.claimed.add(token);
    }

    const parts: string[] = [];

    if (space.length > 0) {
        parts.push(
            `<h3 id="spacing-steps">Steps</h3><p class="sub">The steps that padding, margins, and gaps move in.</p><div class="spec">${space
                .map((token) =>
                    rowOf(ctx, token, `<div class="bar" style="width:${varOf(token, "0")}"></div>`),
                )
                .join("")}</div>`,
        );
    }

    if (sizes.length > 0) {
        parts.push(
            `<h3 id="sizes">Sizes</h3><p class="sub">Heights and widths for controls, icons, and marks.</p><div class="spec">${sizes
                .map((token) =>
                    rowOf(
                        ctx,
                        token,
                        `<div class="box" style="width:${varOf(token, "0")};height:${varOf(token, "0")}"></div>`,
                    ),
                )
                .join("")}</div>`,
        );
    }

    return {
        html: `<p class="intro">The steps and sizes that the layout is built of.</p>${parts.join("")}${note()}${moreTokens(ctx, "spacing")}`,
        count: mine.length,
    };
}

function radiiSection(ctx: Ctx): Built {
    const { limit, note } = limiter();
    const mine = tokensOf(ctx, "radii");

    if (mine.length === 0) {
        return undefined;
    }

    const radii = limit(
        mine.filter(
            (token) =>
                token.tier !== "component" &&
                token.type === "dimension" &&
                /^(radius|radii|rounded|corners?|round)$/.test(rootOf(token)),
        ),
    );

    for (const token of radii) {
        ctx.claimed.add(token);
    }

    const cards =
        radii.length === 0
            ? ""
            : `<div class="radii">${radii
                  .map((token) => {
                      const value = variants(ctx, (mode) =>
                          esc(plain(token.type, valueIn(token, mode)?.value)),
                      );

                      return `<div class="radius" data-q="${esc(`${token.name} ${token.description ?? ""}`.toLowerCase())}"><div class="shape" style="border-radius:${varOf(token, "0")}"></div>${copyName(token)}<span class="desc mono">${value}</span>${token.description === undefined ? "" : `<span class="desc">${esc(token.description)}</span>`}</div>`;
                  })
                  .join("")}</div>`;

    return {
        html: `<p class="intro">Corners follow what they round.</p>${cards}${note()}${moreTokens(ctx, "radii")}`,
        count: mine.length,
    };
}

function otherSection(ctx: Ctx): Built {
    const { limit, note } = limiter();
    const mine = tokensOf(ctx, "other");

    if (mine.length === 0) {
        return undefined;
    }

    const free = mine.filter((token) => token.tier !== "component");
    const breakpoints = limit(
        free.filter(
            (token) =>
                token.type === "dimension" &&
                /^(breakpoints?|screens?|bp|media)$/.test(rootOf(token)),
        ),
    );
    const borders = limit(
        free.filter(
            (token) =>
                token.type === "dimension" && /^(border|borders|stroke)$/.test(rootOf(token)),
        ),
    );
    const layers = limit(
        free.filter(
            (token) =>
                token.type === "number" && /^(z|zindex|z-index|layers?)$/.test(rootOf(token)),
        ),
    );

    for (const token of [...breakpoints, ...borders, ...layers]) {
        ctx.claimed.add(token);
    }

    const parts: string[] = [];

    if (breakpoints.length > 0) {
        const max = Math.max(
            ...breakpoints.map((token) => pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0),
            1,
        );

        parts.push(
            `<h3 id="breakpoints">Breakpoints</h3><p class="sub">The widths where the layout changes.</p><div class="spec">${breakpoints
                .map((token) => {
                    const px = pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0;

                    return rowOf(
                        ctx,
                        token,
                        `<div class="bar" style="width:${Math.max(2, Math.round((px / max) * 100))}%"></div>`,
                    );
                })
                .join("")}</div>`,
        );
    }

    if (borders.length > 0) {
        parts.push(
            `<h3 id="borders">Borders</h3><div class="spec">${borders
                .map((token) =>
                    rowOf(
                        ctx,
                        token,
                        `<div style="border-top:${varOf(token, "1px")} solid var(--dd-accent);max-width:100%"></div>`,
                    ),
                )
                .join("")}</div>`,
        );
    }

    if (layers.length > 0) {
        const sorted = [...layers].sort(
            (a, b) =>
                Number(valueIn(b, ctx.modes[0]!)?.value ?? 0) -
                Number(valueIn(a, ctx.modes[0]!)?.value ?? 0),
        );

        parts.push(
            `<h3 id="layers">Layers</h3><p class="sub">Stacking order, top first. Use a layer token instead of a new z-index.</p><div class="layers">${sorted
                .map(
                    (token) =>
                        `<div class="layer" data-q="${esc(token.name.toLowerCase())}">${copyName(token)}<span class="mono">${variants(ctx, (mode) => esc(String(valueIn(token, mode)?.value ?? "")))}</span></div>`,
                )
                .join("")}</div>`,
        );
    }

    return {
        html: `<p class="intro">Breakpoints, borders, layers, and the tokens that fit no other section.</p>${parts.join("")}${note()}${moreTokens(ctx, "other")}`,
        count: mine.length,
    };
}

// ── Shadows and motion ─────────────────────────────────────────────────────────────────────────────────────────────

function shadowSection(ctx: Ctx): { html: string; count: number } | undefined {
    const { limit, note } = limiter();
    const mine = tokensOf(ctx, "shadows");
    const shadows = limit(
        mine.filter((token) => token.type === "shadow" && token.tier !== "component"),
    );

    if (mine.length === 0) {
        return undefined;
    }

    for (const token of shadows) {
        ctx.claimed.add(token);
    }

    return {
        html: `<p class="intro">Shadows lift a surface off the page. The shadow color follows the mode.</p><div class="shadows">${shadows
            .map(
                (token) =>
                    `<div class="shadow-tile" data-q="${esc(`${token.name} ${token.description ?? ""}`.toLowerCase())}" style="box-shadow:${varOf(token, "none")}">${copyName(token)}<span class="desc">${esc(token.description ?? "")}</span><span class="desc mono">${variants(ctx, (mode) => esc(clip(plain("shadow", valueIn(token, mode)?.value), 90)))}</span></div>`,
            )
            .join("")}</div>${note()}${moreTokens(ctx, "shadows")}`,
        count: mine.length,
    };
}

/** The cubic Bézier of a value as an SVG path in a 100 by 100 box, with the y axis up. */
function curvePath(value: unknown): string | undefined {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value.some((n) => typeof n !== "number" || !Number.isFinite(n))
    ) {
        return undefined;
    }

    const [x1, y1, x2, y2] = value as number[];
    const p = (n: number) => (100 - n * 100 * 0.76 - 12).toFixed(1);
    const px = (n: number) => (n * 100 * 0.76 + 12).toFixed(1);

    return `M${px(0)},${p(0)} C${px(x1!)},${p(y1!)} ${px(x2!)},${p(y2!)} ${px(1)},${p(1)}`;
}

function motionSection(ctx: Ctx): { html: string; count: number } | undefined {
    const { limit, note } = limiter();
    const mine = tokensOf(ctx, "motion");
    const tokens = mine;
    const durations = limit(
        tokens.filter((token) => token.type === "duration" && token.tier !== "component"),
    );
    const easings = limit(
        tokens.filter((token) => token.type === "cubicBezier" && token.tier !== "component"),
    );
    const transitions = limit(
        tokens.filter((token) => token.type === "transition" && token.tier !== "component"),
    );
    const all = [...durations, ...easings, ...transitions];

    if (mine.length === 0) {
        return undefined;
    }

    for (const token of all) {
        ctx.claimed.add(token);
    }

    const defaultEase = easings[0] === undefined ? "ease" : `var(${easings[0].cssVar}, ease)`;
    const parts: string[] = [];
    const q = (token: ResolvedToken) =>
        esc(`${token.name} ${token.description ?? ""}`.toLowerCase());

    if (durations.length > 0) {
        parts.push(
            `<h3>Durations</h3><p class="sub">Press Play to run each duration with the first easing.</p><div class="motion-grid">${durations
                .map(
                    (token) =>
                        `<div class="demo" data-q="${q(token)}" style="--dur:${varOf(token, "400ms")};--ease:${defaultEase}"><div class="demo-head">${copyName(token)}<span class="pill">${variants(ctx, (mode) => esc(dimText(valueIn(token, mode)?.value) ?? String(valueIn(token, mode)?.value ?? "")))}</span><span class="spacer"></span><button class="play" type="button">Play</button></div><div class="track"><div class="dot"></div></div></div>`,
                )
                .join("")}</div>`,
        );
    }

    if (easings.length > 0) {
        parts.push(
            `<h3>Easing</h3><p class="sub">The curve shows progress over time. Press Play to see it move.</p><div class="motion-grid">${easings
                .map((token) => {
                    const path = curvePath(valueIn(token, ctx.modes[0]!)?.value);

                    return `<div class="demo" data-q="${q(token)}" style="--dur:900ms;--ease:${varOf(token, "ease")}"><div class="demo-head">${path === undefined ? "" : `<svg class="curve" viewBox="0 0 100 100" aria-hidden="true"><line x1="12" y1="88" x2="88" y2="12"/><path d="${path}"/></svg>`}<div style="min-width:0">${copyName(token)}<div class="desc mono">${esc(plain("cubicBezier", valueIn(token, ctx.modes[0]!)?.value))}</div></div><span class="spacer"></span><button class="play" type="button">Play</button></div><div class="track"><div class="dot"></div></div></div>`;
                })
                .join("")}</div>`,
        );
    }

    if (transitions.length > 0) {
        parts.push(
            `<h3>Transitions</h3><p class="sub">A duration, a delay, and an easing together. Hover or focus the button.</p><div class="motion-grid">${transitions
                .map((token) => {
                    const value = valueIn(token, ctx.modes[0]!)?.value;
                    const css = isObject(value)
                        ? safeCss(
                              `${dimText(value.duration) ?? "200ms"} ${plain("cubicBezier", value.timingFunction)}`,
                          )
                        : undefined;
                    const delay = isObject(value) ? safeCss(dimText(value.delay)) : undefined;

                    return `<div class="demo" data-q="${q(token)}" style="--dur:${esc((css ?? "200ms").split(" ")[0]!)};--ease:${esc((css ?? "ease").split(" ").slice(1).join(" ") || "ease")}"><div class="demo-head">${copyName(token)}<span class="pill">${esc(plain("transition", value))}${delay === undefined || delay === "0ms" ? "" : ` +${esc(delay)}`}</span></div><button class="hover-demo" type="button">Hover me</button></div>`;
                })
                .join("")}</div>`,
        );
    }

    return {
        html: `<p class="intro">Motion should explain a change, never decorate. Things leave faster than they arrive.</p><p class="sub" data-reduce-note hidden>Reduced motion is on in this browser, so the demos jump instead of move.</p>${parts.join("")}${note()}${moreTokens(ctx, "motion")}`,
        count: mine.length,
    };
}

// ── Components ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The custom properties a piece of CSS or markup reads: `var(--name)`. */
function varsIn(text: string): Set<string> {
    return new Set([...text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1]!));
}

/** A token's values for the frame's CSS: the default mode in `:root`, and the modes' differences after it. */
function frameVars(ctx: Ctx, names: Set<string>): string {
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
const styleSafe = (css: string) => css.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

function componentFrame(ctx: Ctx, spec: ComponentSpec, index: number): string {
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

function codeBlock(id: string, label: string, code: string): string {
    return `<div class="snip-wrap" data-panel="${esc(label)}"><button class="copy" type="button" data-copy-from="${esc(id)}" data-copy="">Copy</button><pre class="snip" id="${esc(id)}"><code>${esc(code)}</code></pre></div>`;
}

function componentArticle(ctx: Ctx, spec: ComponentSpec, index: number): string {
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

function componentsSection(ctx: Ctx): { html: string; count: number } | undefined {
    const components = ctx.system.components.slice(0, MAX_COMPONENTS);

    if (components.length === 0) {
        return undefined;
    }

    return {
        html: `<p class="intro">${plural(components.length, "component")}, each shown in every state and in the mode you chose. Copy the markup to reuse it.</p>${components.map((spec, index) => componentArticle(ctx, spec, index)).join("")}`,
        count: components.length,
    };
}

// ── Other tokens, the reference table, and the code ───────────────────────────────────────────────────────────────

function valueCell(ctx: Ctx, token: ResolvedToken): string {
    const text = variants(ctx, (mode) =>
        esc(clip(plain(token.type, valueIn(token, mode)?.value), 160)),
    );

    // The swatch reads the token's own variable, so it follows the mode with no text of its own.
    return token.type === "color"
        ? `<span class="mini-sw" style="background:${varOf(token)}"></span>${text}`
        : text;
}

function tableRows(ctx: Ctx, tokens: ResolvedToken[]): string {
    return tokens
        .map((token) => {
            const deprecated =
                token.deprecated === undefined || token.deprecated === false
                    ? ""
                    : ` <span class="pill warn">Deprecated${typeof token.deprecated === "string" ? `: ${esc(clip(token.deprecated, 80))}` : ""}</span>`;

            return `<tr data-q="${esc(`${token.name} ${token.cssVar} ${token.type} ${token.tier} ${token.description ?? ""}`.toLowerCase())}"><td data-label="Token"><span class="${deprecated === "" ? "" : "dep"}">${copyName(token)}</span><button class="tk" data-copy="${esc(token.cssVar)}" title="Copy the CSS variable">${esc(token.cssVar)}</button>${deprecated}${token.description === undefined ? "" : `<div class="desc">${esc(token.description)}</div>`}</td><td data-label="Type">${esc(token.type)} <span class="pill">${esc(token.tier)}</span></td><td data-label="Value" class="num" style="white-space:normal">${valueCell(ctx, token)}</td></tr>`;
        })
        .join("");
}

function referenceSection(ctx: Ctx, max: number): { html: string; count: number } {
    const all = ctx.system.tokens;
    const tokens = all.slice(0, max);
    const cut =
        tokens.length < all.length
            ? `<p class="sub">This table shows the first ${tokens.length} of ${all.length} tokens, to keep the page small. The sections above show the rest.</p>`
            : "";

    return {
        html: `<p class="intro">Every token with its CSS variable and its value in the mode you chose. Click a name to copy it.</p>${cut}<div class="table-wrap ref"><table><thead><tr><th>Token</th><th>Type</th><th>Value</th></tr></thead><tbody>${tableRows(ctx, tokens)}</tbody></table></div>`,
        count: all.length,
    };
}

function problemsHtml(ctx: Ctx): string {
    const problems = ctx.system.problems;

    if (problems.length === 0) {
        return "";
    }

    const errors = problems.filter((problem) => problem.level === "error").length;

    return `<details class="notes"><summary>${errors > 0 ? `${errors} error${errors === 1 ? "" : "s"} and ` : ""}${problems.length - errors} warning${problems.length - errors === 1 ? "" : "s"} from the validator</summary><ul>${problems
        .slice(0, 50)
        .map(
            (problem) =>
                `<li><strong>${problem.level === "error" ? "Error" : "Warning"}</strong>${problem.file === undefined ? "" : ` in <code>${esc(problem.file)}</code>`}${problem.token === undefined ? "" : ` at <code>${esc(problem.token)}</code>`}: ${esc(clip(problem.message, 300))}</li>`,
        )
        .join("")}</ul></details>`;
}

/** Notes that need no action (an exempt contrast pair, for one): a small area of their own, apart from problems. */
function notesHtml(ctx: Ctx): string {
    const notes = ctx.system.notes ?? [];

    if (notes.length === 0) {
        return "";
    }

    return `<details class="notes"><summary>${plural(notes.length, "note")} from the validator</summary><ul>${notes
        .slice(0, 50)
        .map(
            (note) =>
                `<li>${note.file === undefined ? "" : `<code>${esc(note.file)}</code> `}${note.token === undefined ? "" : `<code>${esc(note.token)}</code>: `}${esc(clip(note.message, 300))}</li>`,
        )
        .join("")}</ul></details>`;
}

/** A snippet in a box with a Copy button; the text is project data, so it is escaped. */
function snippet(id: string, text: string): string {
    return `<div class="snip-wrap"><button class="copy" type="button" data-copy-from="${esc(id)}" data-copy="">Copy</button><pre class="snip" id="${esc(id)}"><code>${esc(text)}</code></pre></div>`;
}

/** What the generated files are and how to use each: CSS, Tailwind v4, and JSON for Style Dictionary or Tokens Studio. */
function codeSection(ctx: Ctx): { html: string; count: number } {
    const { compiled } = ctx.system;
    const first = ctx.modes[0]!;
    const sample =
        findToken(ctx, BASE_GROUNDS) ??
        ctx.system.tokens.find((token) => token.type === "color" && token.tier === "semantic") ??
        ctx.system.tokens[0];
    // A middle step of the spacing scale reads better than step zero.
    const steps = ctx.system.tokens.filter(
        (token) =>
            sectionOf(token) === "spacing" &&
            token.tier !== "component" &&
            (pxOf(valueIn(token, first)?.value) ?? 0) > 0,
    );
    const spacing =
        steps.find((token) => pxOf(valueIn(token, first)?.value) === 16) ??
        steps[Math.floor(steps.length / 2)];
    const dark = ctx.modes.find((mode) => ctx.theme.get(mode) === "dark" && mode !== first);
    const cssVar = sample?.cssVar ?? "--color-bg-surface";
    const css = `<link rel="stylesheet" href="tokens.css">\n\n.card {\n    background: var(${cssVar});\n    padding: var(${spacing?.cssVar ?? "--space-4"});\n}${dark === undefined ? "" : `\n\n<!-- ${modeLabel(dark)} mode -->\n<html data-theme="${dark}">`}`;
    const utility = cssVar.startsWith("--color-")
        ? `bg-${cssVar.slice("--color-".length)}`
        : "bg-surface";
    const tailwind = `@import "tailwindcss";\n@import "./tailwind.css";\n\n<div class="${utility} p-4">…</div>`;
    const modeFiles = Object.entries(compiled.modes ?? {});
    const jsonName =
        modeFiles[0] === undefined
            ? "tokens.resolved.json"
            : `tokens.${modeFiles[0][0]}.resolved.json`;
    const json = `// Style Dictionary (v4 reads DTCG as it is)\n{\n    "source": ["${jsonName}"],\n    "platforms": {\n        "css": {\n            "transformGroup": "css",\n            "buildPath": "build/",\n            "files": [{ "destination": "variables.css", "format": "css/variables" }]\n        }\n    }\n}\n\n// Tokens Studio: Tools, Load from file or URL, then pick ${jsonName}.`;
    const files = [
        {
            id: "code-css",
            title: "tokens.css",
            note: "Variables for every mode. Link it from every page.",
            text: compiled.css,
        },
        {
            id: "code-tailwind",
            title: "tailwind.css",
            note: "A Tailwind v4 @theme block, one variable for each token.",
            text: compiled.tailwind,
        },
        {
            id: "code-components",
            title: "components.css",
            note: "The CSS of every component.",
            text: compiled.components,
        },
        {
            id: "code-json",
            title: "tokens.resolved.json",
            note: "Every token and its value in each mode, compact.",
            text: compiled.json,
        },
        ...modeFiles.map(([mode, text], index) => ({
            id: `code-mode-${index}`,
            title: `tokens.${mode}.resolved.json`,
            note: `The ${modeLabel(mode).toLowerCase()} mode as a DTCG file (with $value and $type).`,
            text,
        })),
    ].filter((file) => file.text.trim() !== "");
    const use = (title: string, note: string, id: string, text: string) =>
        `<div class="use"><h4>${esc(title)}</h4><p class="sub">${note}</p>${snippet(id, text)}</div>`;

    return {
        html: `<p class="intro">The files that the system generates in <code>.pi/design/dist/</code>. Read tokens as variables, classes, or JSON. Never copy a value by hand.</p><div class="uses">${use("CSS", "Link tokens.css, then read a token with var(). Set data-theme for a mode.", "code-use-css", css)}${use("Tailwind v4", "Import Tailwind, then tailwind.css. Each token is a variable, so the utilities follow it.", "code-use-tailwind", tailwind)}${use("JSON", "For Style Dictionary or Tokens Studio. One DTCG file for each mode, and one compact file for all.", "code-use-json", json)}</div><h3>The files</h3>${files
            .map(
                (file) =>
                    `<details class="code"><summary>${esc(file.title)}<span class="desc" style="margin-left:10px;font-weight:400">${esc(file.note)}</span></summary><div class="code-body">${file.id.startsWith("code-mode") && file.text.length > 6_000 ? `<p class="sub">The first 6 KB of ${Math.round(file.text.length / 1024)} KB.</p>${snippet(file.id, clip(file.text, 6_000))}` : snippet(file.id, clip(file.text, MAX_CODE))}</div></details>`,
            )
            .join("")}`,
        count: files.length,
    };
}

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

function sampler(ctx: Ctx): string {
    const order = (token: ResolvedToken) => {
        const text = token.path.join(".");

        if (/accent|primary|brand/i.test(text)) {
            return 0;
        }

        if (/danger|error|warning|success|info|spark/i.test(text)) {
            return 1;
        }

        return hasSegment(token, GROUND_SEGMENTS) ? 2 : hasSegment(token, TEXT_SEGMENTS) ? 3 : 4;
    };

    const roles = ctx.system.tokens
        .filter(
            (token) =>
                token.type === "color" && token.tier !== "primitive" && token.tier !== "component",
        )
        .sort((a, b) => order(a) - order(b));
    const seen = new Set<string>();
    const chosen: ResolvedToken[] = [];

    const take = (token: ResolvedToken) => {
        const hex = colorValueText(valueIn(token, ctx.modes[0]!)?.value);

        if (hex !== undefined && !seen.has(hex) && chosen.length < 12) {
            seen.add(hex);
            chosen.push(token);
        }
    };

    const firsts = new Set<string>();

    // One color of each group first, so that the strip shows the range; then more of the same.
    for (const token of roles) {
        const key = groupKey(token);

        if (!firsts.has(key)) {
            firsts.add(key);
            take(token);
        }
    }

    roles.forEach(take);

    return chosen.length === 0
        ? ""
        : `<div class="strip">${chosen
              .map((token) => {
                  const last = token.path[token.path.length - 1]!;
                  const short =
                      last === "default"
                          ? (token.path[token.path.length - 2] ?? last)
                          : token.path.slice(-2).join(" ");

                  return `<button type="button" class="sw" data-copy="${esc(token.name)}" title="${esc(token.name)}"><i style="background:${varOf(token)}"></i><span>${esc(clip(short, 24))}</span></button>`;
              })
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
                `html:not([data-mode="${ctx.slug.get(mode)}"]) .mv[data-m="${ctx.slug.get(mode)}"]{display:none}`,
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
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="color-scheme" content="light dark">
<title>${esc(name)} · Design system</title>
<script>${DOC_BOOT_JS}</script>
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
<script>${DOC_JS}</script>
</body>
</html>
`;

    return { html, assets: [] };
}
