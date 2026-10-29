import { type ResolvedToken } from "./system-types.ts";
import { contrastRatio, rating, readableOn, toOklchText } from "./docsite-color.ts";
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    MAX_ROLES,
    MAX_PALETTE,
    modeLabel,
    titleOf,
    varOf,
    colorValueText,
    capped,
    type Ctx,
    nameOfRef,
    valueIn,
    variants,
    colorOf,
    aliasChain,
    GROUND_SEGMENTS,
    TEXT_SEGMENTS,
    hasSegment,
    tokensOf,
} from "./docsite-core.ts";

/** A contrast ratio with one decimal, cut and not rounded, so that 4.48 never shows as the 4.5 it does not reach. */
const fmtRatio = (ratio: number) => (Math.floor(ratio * 10 + 1e-9) / 10).toFixed(1);

function ratioPill(ratio: number, min: number | undefined, exempt?: string): string {
    const label = rating(ratio);
    const passes = min === undefined ? label !== "fail" : ratio >= min;

    if (!passes && exempt !== undefined) {
        return `<span class="ratio">${fmtRatio(ratio)}:1</span> <span class="pill">exempt (${esc(exempt)})</span>`;
    }

    return `<span class="ratio">${fmtRatio(ratio)}:1</span> <span class="pill ${passes ? "ok" : "bad"}">${passes ? label : "Fails"}</span>`;
}

function copyRow(ctx: Ctx, token: ResolvedToken): string {
    // The class comes from the variable that the compiled theme gives the token (`--color-surface`, so `bg-surface`).
    const tailwind = ctx.twVar.get(token.name) ?? token.cssVar;
    const rest = tailwind.startsWith("--color-") ? tailwind.slice("--color-".length) : undefined;
    const prefix = hasSegment(token, TEXT_SEGMENTS)
        ? "text"
        : /(^|\.)border(\.|$)/.test(token.name)
          ? "border"
          : "bg";

    return `<div class="copy-row" data-var="${esc(token.cssVar)}"${rest === undefined ? "" : ` data-tw="${esc(`${prefix}-${rest}`)}"`} data-json="${esc(`${token.name}.$value`)}"></div>`;
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

    return `<article class="card" data-q="${esc(query)}"><button class="sw-chip" data-copy="${esc(`var(${token.cssVar})`)}" aria-label="Copy var(${esc(token.cssVar)})">${chip}</button><div class="card-body"><div><button class="tk">${esc(token.name)}</button>${deprecated}</div>${token.description === undefined ? "" : `<p class="desc">${esc(token.description)}</p>`}<dl class="vals">${rows.join("")}</dl>${contrast}${copyRow(ctx, token)}</div></article>`;
}

function groupKey(token: ResolvedToken): string {
    const path = token.path.slice(0, -1);

    if (path.length > 1 && /^(colou?rs?|palette)$/i.test(path[0]!)) {
        path.shift();
    }

    return path.length === 0 ? "Colors" : path.map(titleOf).join(" / ");
}

export function grouped(
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

export function pairRows(ctx: Ctx): { total: number; passing: number; table: string } {
    const declared = ctx.system.tokens.filter((token) => token.contrast !== undefined);
    let total = 0;
    let passing = 0;
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

export function matrix(ctx: Ctx, roles: ResolvedToken[]): string {
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

export function colorSection(ctx: Ctx): { html: string; count: number } | undefined {
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
        html: `<p class="intro">${ctx.modes.length > 1 ? `Every role has a value in each of the ${ctx.modes.length} modes.` : "Every role has a value."}${checkSentence(pairs.passing, pairs.total)}</p>${parts.join("")}`,
        count: colors.length,
    };
}
