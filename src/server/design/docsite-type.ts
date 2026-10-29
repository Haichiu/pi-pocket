import { type ResolvedToken } from "./system-types.ts";
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    isObject,
    clip,
    safeCss,
    varOf,
    dimText,
    stackOf,
    plain,
    limiter,
    type Ctx,
    valueIn,
    variants,
    copyName,
    tokensOf,
    moreTokens,
} from "./docsite-core.ts";

export const FONT_ROOTS = /^(fonts?|type|typography|text)$/i;

export function typographySection(ctx: Ctx): { html: string; count: number } | undefined {
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
