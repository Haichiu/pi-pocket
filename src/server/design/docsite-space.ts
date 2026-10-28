/**
 * The Spacing, Radii, and Other sections of the documentation page. (Split from `docsite.ts`; see it for how the page is built and kept safe.)
 */
import { escapeHtml as esc } from "./docsite-markdown.ts";
import {
    varOf,
    pxOf,
    plain,
    limiter,
    type Ctx,
    valueIn,
    variants,
    copyName,
    rowOf,
    type Built,
    tokensOf,
    moreTokens,
    rootOf,
} from "./docsite-core.ts";

export function spacingSection(ctx: Ctx): Built {
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

export function radiiSection(ctx: Ctx): Built {
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

export function otherSection(ctx: Ctx): Built {
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
