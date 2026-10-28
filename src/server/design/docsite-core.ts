/**
 * The shared parts of the documentation page: its limits, the safe-style helpers, value text, and the page model (`Ctx`) that every section reads. (Split from `docsite.ts`; see it for how the page is built and kept safe.)
 */
import {
    type DesignSystem,
    type ModeValue,
    type ResolvedToken,
    type TokenType,
} from "./system-types.ts";
import { parseColor, toHex, type Rgba } from "./docsite-color.ts";
import { escapeHtml as esc, slugify } from "./docsite-markdown.ts";

export interface SystemDoc {
    html: string;
    assets: { name: string; content: string }[];
}

/** The most tokens, components, and states the page draws; a system over a limit shows its first part and says so. */
export const MAX_TOKENS = 3000;
export const MAX_COMPONENTS = 60;
/** The most color cards, palette steps, and rows of one specimen list: a bigger list goes on in the token table. */
export const MAX_ROLES = 240;
export const MAX_PALETTE = 480;
export const MAX_SPECIMENS = 120;
export const MAX_STATES = 16;
/** The most bytes of page: an artifact holds 2 MB, and the page keeps room under that. */
export const MAX_PAGE = 1_800_000;

/** The longest piece of code the page prints for a component or for the compiled files. */
export const MAX_CODE = 60_000;

/**
 * The page's policy. Nothing loads from outside, no frame or form or `<base>` is allowed, and an image or a font only as
 * data. Script runs only with the page's own nonce, which a component's markup cannot carry (and a `javascript:` address
 * is no script of the page, so it is blocked too). The artifact viewer's bridge script is the first thing in the page,
 * before this policy, so it has run by then and is not touched. The page's script also builds a component's markup
 * from an allowlist, so the policy is the second guard and not the only one.
 */
export const pageCsp = (nonce: string) =>
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`;

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

export const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A name for a mode, for people: `high-contrast` is "High contrast". */
export function modeLabel(mode: string): string {
    const text = mode.replace(/[-_]+/g, " ").trim() || mode;

    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Words for a path segment; a few short names are spelled out. */
export const SEGMENT_TITLES: Record<string, string> = {
    bg: "Background",
    fg: "Foreground",
    bgcolor: "Background",
    sh: "Shadow",
    z: "Layers",
};

export function titleOf(segment: string): string {
    const known = SEGMENT_TITLES[segment.toLowerCase()];

    if (known !== undefined) {
        return known;
    }

    const text = segment.replace(/[-_]+/g, " ").trim() || segment;

    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A CSS value from the project is used in a style only when it cannot end the declaration or the block. */
export function safeCss(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 600) {
        return undefined;
    }

    if (/[{}<>;\\\u0000-\u001f]|\/\*|@import|url\s*\(|expression\s*\(|javascript:/i.test(value)) {
        return undefined;
    }

    return value;
}

export const safeVar = (name: string) => (/^--[A-Za-z0-9_-]{1,120}$/.test(name) ? name : undefined);

/** `var(--name)` for a token, or the fallback when the name is not a safe custom property. */
export const varOf = (token: ResolvedToken, fallback = "transparent") =>
    safeVar(token.cssVar) === undefined ? fallback : `var(${token.cssVar})`;

/** An id that is safe in an attribute and a selector. */
export const idOf = (text: string) => slugify(text) || "x";

/** A dimension value as CSS text (`16px`), from the string and object forms. */
export function dimText(value: unknown): string | undefined {
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
export function pxOf(value: unknown): number | undefined {
    const match = /^(-?\d*\.?\d+)\s*(px|rem|em)?$/.exec(dimText(value) ?? "");

    if (match === null) {
        return undefined;
    }

    return Number.parseFloat(match[1]!) * (match[2] === "px" || match[2] === undefined ? 1 : 16);
}

export function stackOf(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        return value
            .map((family) => String(family))
            .map((family) => (/^[\w-]+$/.test(family) ? family : `"${family.replace(/"/g, "")}"`))
            .join(", ");
    }

    return typeof value === "string" ? value : undefined;
}

export function colorValueText(value: unknown): string | undefined {
    const color = parseColor(value);

    return color === undefined ? undefined : toHex(color);
}

export function shadowText(value: unknown): string {
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
export function plain(type: TokenType, value: unknown): string {
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
export function capped<T>(list: T[], max: number): [T[], string] {
    return list.length <= max
        ? [list, ""]
        : [
              list.slice(0, max),
              `<p class="sub">Showing the first ${max} of ${list.length}. The table of all tokens has the rest.</p>`,
          ];
}

/** Lists cut to the specimen limit, and whether any was cut, for one section. */
export function limiter(): { limit: <T>(list: T[]) => T[]; note: () => string } {
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
export type SectionId =
    "color" | "typography" | "spacing" | "radii" | "shadows" | "motion" | "other";

export const SECTION_HINTS: [SectionId, RegExp][] = [
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
export function sectionOf(token: ResolvedToken): SectionId {
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

export interface Ctx {
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
export const nameOfRef = (text: string) => text.replace(/^\{|\}$/g, "").trim();

export const valueIn = (token: ResolvedToken, mode: string): ModeValue | undefined =>
    token.modes[mode];

/**
 * The same content for every mode. A text that does not change is written once; texts that differ are written once for
 * each mode and shown by the mode in force, in CSS alone.
 */
export function variants(ctx: Ctx, make: (mode: string) => string, tag = "span"): string {
    const texts = ctx.modes.map((mode) => make(mode));

    if (texts.every((text) => text === texts[0])) {
        return texts[0] ?? "";
    }

    return ctx.modes
        .map(
            (mode, index) =>
                `<${tag} class="mv" data-m="${ctx.modes.indexOf(mode)}">${texts[index]}</${tag}>`,
        )
        .join("");
}

export const colorOf = (token: ResolvedToken | undefined, mode: string): Rgba | undefined =>
    token === undefined ? undefined : parseColor(valueIn(token, mode)?.value);

export function aliasChain(ctx: Ctx, token: ResolvedToken, mode: string): string[] {
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

export const GROUND_SEGMENTS = new Set(["bg", "background", "surface", "canvas", "ground"]);
export const TEXT_SEGMENTS = new Set(["text", "fg", "foreground", "content", "ink"]);

export const hasSegment = (token: ResolvedToken, set: Set<string>) =>
    token.path.slice(0, -1).some((segment) => set.has(segment.toLowerCase()));

export function findToken(ctx: Ctx, names: string[]): ResolvedToken | undefined {
    for (const name of names) {
        const token = ctx.byName.get(name);

        if (token !== undefined) {
            return token;
        }
    }

    return undefined;
}

export const BASE_GROUNDS = [
    "color.bg.base",
    "color.bg.default",
    "color.background.default",
    "color.background.base",
    "color.background",
    "color.bg.canvas",
    "color.bg",
    "color.surface.default",
];

export const BASE_TEXTS = [
    "color.text.primary",
    "color.text.default",
    "color.text.base",
    "color.text",
    "color.foreground.default",
    "color.foreground",
    "color.fg.default",
];

export function groundToken(ctx: Ctx): ResolvedToken | undefined {
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

export function textToken(ctx: Ctx): ResolvedToken | undefined {
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
export function themeOfMode(ctx: Ctx, mode: string): "light" | "dark" {
    const ground = colorOf(groundToken(ctx), mode);

    if (ground !== undefined) {
        return ground.a < 1 ||
            (0.2126 * ground.r + 0.7152 * ground.g + 0.0722 * ground.b) / 255 > 0.45
            ? "light"
            : "dark";
    }

    return /dark|night|black|contrast/i.test(mode) ? "dark" : "light";
}

export function buildContext(system: DesignSystem): Ctx {
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

export function copyName(token: ResolvedToken): string {
    return `<button class="tk">${esc(token.name)}</button>`;
}

export function rowOf(ctx: Ctx, token: ResolvedToken, sample: string): string {
    const value = variants(ctx, (mode) => esc(plain(token.type, valueIn(token, mode)?.value)));

    return `<div class="spec-row c" data-q="${esc(`${token.name} ${token.description ?? ""}`.toLowerCase())}"><div class="spec-meta">${copyName(token)}${token.description === undefined ? "" : `<span class="desc">${esc(token.description)}</span>`}</div><div class="val">${value}</div><div class="sample">${sample}</div></div>`;
}

export type Built = { html: string; count: number } | undefined;

export const tokensOf = (ctx: Ctx, id: SectionId) => ctx.sections.get(id) ?? [];

/** The tokens of a section that no specimen drew (most are a component's), as a table: so every token is on the page. */
export function moreTokens(ctx: Ctx, id: SectionId): string {
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

export const rootOf = (token: ResolvedToken) => token.path[0]!.toLowerCase();

// ── Other tokens, the reference table, and the code ───────────────────────────────────────────────────────────────

export function valueCell(ctx: Ctx, token: ResolvedToken): string {
    const text = variants(ctx, (mode) =>
        esc(clip(plain(token.type, valueIn(token, mode)?.value), 160)),
    );

    // The swatch reads the token's own variable, so it follows the mode with no text of its own.
    return token.type === "color"
        ? `<span class="mini-sw" style="background:${varOf(token)}"></span>${text}`
        : text;
}

export function tableRows(ctx: Ctx, tokens: ResolvedToken[]): string {
    return tokens
        .map((token) => {
            const deprecated =
                token.deprecated === undefined || token.deprecated === false
                    ? ""
                    : ` <span class="pill warn">Deprecated${typeof token.deprecated === "string" ? `: ${esc(clip(token.deprecated, 80))}` : ""}</span>`;

            return `<tr data-q="${esc(`${token.name} ${token.cssVar} ${token.type} ${token.tier} ${token.description ?? ""}`.toLowerCase())}"><td data-label="Token"><span class="${deprecated === "" ? "" : "dep"}">${copyName(token)}</span><button class="tk">${esc(token.cssVar)}</button>${deprecated}${token.description === undefined ? "" : `<div class="desc">${esc(token.description)}</div>`}</td><td data-label="Type">${esc(token.type)} <span class="pill">${esc(token.tier)}</span></td><td data-label="Value" class="num wrap">${valueCell(ctx, token)}</td></tr>`;
        })
        .join("");
}
