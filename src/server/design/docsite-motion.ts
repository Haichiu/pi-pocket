/**
 * The Motion section of the documentation page: durations, easings, and transitions that play. (Split from `docsite.ts`; see it for how the page is built and kept safe.)
 */
import { type ResolvedToken } from "./system-types.ts";
import { escapeHtml as esc } from "./docsite-markdown.ts";
import {
    isObject,
    safeCss,
    varOf,
    dimText,
    plain,
    limiter,
    type Ctx,
    valueIn,
    variants,
    copyName,
    tokensOf,
    moreTokens,
} from "./docsite-core.ts";

export function curvePath(value: unknown): string | undefined {
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

export function motionSection(ctx: Ctx): { html: string; count: number } | undefined {
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
