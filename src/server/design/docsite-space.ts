import type { ResolvedToken } from "./system-types.ts";
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
    // The roles that use a step (the gaps of the layout): semantic tokens of the section that are neither the scale nor sizes.
    const layout = limit(
        plainOnes.filter(
            (token) =>
                token.tier === "semantic" &&
                !/^(space|spacing|gap|gaps|sp|spaces|size|sizes|sizing)$/.test(rootOf(token)),
        ),
    );

    for (const token of [...space, ...sizes, ...layout]) {
        ctx.claimed.add(token);
    }

    const parts: string[] = [];
    const spaceMax = Math.max(
        ...space.map((token) => pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0),
        1,
    );

    if (space.length > 0) {
        parts.push(
            `<h3 id="spacing-steps">Steps</h3><p class="sub">The steps that padding, margins, and gaps move in. Each bar is in proportion to the longest step.</p><div class="spec cols">${space
                .map((token) =>
                    rowOf(
                        ctx,
                        token,
                        `<div class="bar" style="width:${Math.max(1, Math.round(((pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0) / spaceMax) * 100))}%"></div>`,
                    ),
                )
                .join("")}</div>`,
        );
    }

    if (layout.length > 0) {
        parts.push(
            `<h3 id="spacing-roles">Roles</h3><p class="sub">Where the system uses a step.</p><div class="spec cols">${layout
                .map((token) =>
                    rowOf(
                        ctx,
                        token,
                        `<div class="bar" style="width:${Math.max(1, Math.round(((pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0) / spaceMax) * 100))}%"></div>`,
                    ),
                )
                .join("")}</div>`,
        );
    }

    if (sizes.length > 0) {
        parts.push(
            `<h3 id="sizes">Sizes</h3><p class="sub">Heights and widths for controls, icons, and marks.</p><div class="spec cols">${sizes
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

    const BANDS: { id: string; title: string; note: string; has: (px: number) => boolean }[] = [
        {
            id: "marks",
            title: "Marks and tags",
            note: "Up to 4 px: small things that sit inside text or a control.",
            has: (px) => px <= 4,
        },
        {
            id: "controls",
            title: "Controls",
            note: "5 to 7 px: buttons, fields, and rows, what a hand presses.",
            has: (px) => px > 4 && px < 8,
        },
        {
            id: "containers",
            title: "Containers",
            note: "8 px and more: cards, windows, sheets, and pop-ups, what holds other things.",
            has: (px) => px >= 8 && px < 100,
        },
        {
            id: "round",
            title: "Round",
            note: "Fully round: pills and avatars.",
            has: (px) => px >= 100,
        },
    ];
    const pxOfToken = (token: ResolvedToken) => pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0;

    const card = (token: ResolvedToken) => {
        const value = variants(ctx, (mode) => esc(plain(token.type, valueIn(token, mode)?.value)));

        return `<div class="radius" data-q="${esc(`${token.name} ${token.description ?? ""}`.toLowerCase())}"><div class="shape" style="border-radius:${varOf(token, "0")}"></div>${copyName(token)}<span class="desc mono">${value}</span>${token.description === undefined ? "" : `<span class="desc">${esc(token.description)}</span>`}</div>`;
    };

    const hasRoles = radii.some((token) => token.tier === "semantic");
    const bandTokens = hasRoles ? radii.filter((token) => token.tier === "semantic") : radii;
    const scaleTokens = hasRoles ? radii.filter((token) => token.tier === "primitive") : [];
    const banded = BANDS.map((band) => ({
        band,
        tokens: bandTokens
            .filter((token) => band.has(pxOfToken(token)))
            .sort((x, y) => pxOfToken(x) - pxOfToken(y)),
    })).filter((entry) => entry.tokens.length > 0);
    const scaleCards =
        scaleTokens.length === 0
            ? ""
            : `<div data-group><h4 style="margin-top:22px">Scale</h4><p class="sub" style="margin-bottom:0">The steps: every role above points at one, and the value comes from here.</p><div class="radii">${[
                  ...scaleTokens,
              ]
                  .sort((x, y) => pxOfToken(x) - pxOfToken(y))
                  .map(card)
                  .join("")}</div></div>`;
    const cards =
        radii.length === 0
            ? ""
            : banded.length === 1
              ? `<div class="radii">${banded[0]!.tokens.map(card).join("")}</div>`
              : banded
                    .map(
                        ({ band, tokens }) =>
                            `<div data-group><h4 style="margin-top:22px">${band.title}</h4><p class="sub" style="margin-bottom:0">${band.note}</p><div class="radii">${tokens.map(card).join("")}</div></div>`,
                    )
                    .join("");

    return {
        html: `<p class="intro">Corners follow what they round.</p>${cards}${scaleCards}${note()}${moreTokens(ctx, "radii")}`,
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
