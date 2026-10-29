import { escapeHtml as esc } from "./docsite-markdown.ts";
import {
    varOf,
    shadowLayers,
    limiter,
    type Ctx,
    valueIn,
    variants,
    copyName,
    tokensOf,
    moreTokens,
} from "./docsite-core.ts";

export function shadowSection(ctx: Ctx): { html: string; count: number } | undefined {
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
                    `<div class="shadow-tile" data-q="${esc(`${token.name} ${token.description ?? ""}`.toLowerCase())}" style="box-shadow:${varOf(token, "none")}">${copyName(token)}<span class="desc">${esc(token.description ?? "")}</span><span class="desc mono layered">${variants(ctx, (mode) => shadowLayers(valueIn(token, mode)?.value))}</span></div>`,
            )
            .join("")}</div>${note()}${moreTokens(ctx, "shadows")}`,
        count: mine.length,
    };
}
