// The sections of the System view: Colors, Type, Spacing, Radii, Shadows, Motion, Other, Components, and Guidelines. Each
// draws the tokens of its kind as what they are (a swatch, a specimen, a bar, a corner, a shadow, a motion), and opens the
// editor of one token under its row. They read the model (`system.js`) and change nothing but through `env`.
import { parseColor, swatchCss, toHex } from "./color.js";
import { specimenDocument } from "./specimen.js";
import {
    amountOf,
    cssOf,
    groupsOf,
    matches,
    millisecondsOf,
    pixelsOf,
    roles,
    safeCss,
    shadowOf,
    showValue,
    themeCss,
    typographyStyle,
} from "./system.js";

const SAMPLE = "Sphinx of black quartz, judge my vow";

const hexOf = (value) => {
    const color = parseColor(value);

    return color === null ? "" : toHex(color);
};

/** The line under a typography style's name: `20px / 1.15 · 600 · Geist`. */
function styleMeta(value) {
    if (typeof value !== "object" || value === null) {
        return "";
    }

    const size = cssOf("dimension", value.fontSize);
    const height =
        typeof value.lineHeight === "number"
            ? `/ ${value.lineHeight}`
            : value.lineHeight
              ? `/ ${cssOf("dimension", value.lineHeight)}`
              : "";
    const family = Array.isArray(value.fontFamily) ? value.fontFamily[0] : value.fontFamily;

    return [[size, height].filter(Boolean).join(" "), value.fontWeight, family]
        .filter((part) => part !== undefined && part !== "")
        .join(" · ");
}

export function createSystemSections(env, widgets) {
    const { pocket, store } = env;
    const { html, useEffect, useRef, useState, Markdown } = pocket;
    const { Ico } = env.parts;
    const { Swatch, CopyName, ContrastBadge, TokenEditor, Curve } = widgets;

    // ─── Rows and groups ─────────────────────────────────────────────────────

    /** One token: a visual, its name (which copies), a line under it, its value; a tap opens its editor under it. */
    function TokenRow({ ctx, token, visual, sub, value, stacked = false, children }) {
        const open = ctx.s.sysOpen === token.name;
        const edited = ctx.modes.some((mode) => ctx.model.edited(token.name, mode));

        return html`<li
            class=${`dsy-row ${open ? "open" : ""} ${edited ? "edited" : ""} ${stacked ? "stacked" : ""}`}
            data-token=${token.name}
        >
            <div class="dsy-row-main" onClick=${() => env.toggleToken(token.name)}>
                ${visual && html`<span class="dsy-row-visual">${visual}</span>`}
                <span class="dsy-row-text">
                    <span class="dsy-row-title">
                        <${CopyName} name=${token.name} />
                        ${token.deprecated && html`<span class="dsy-tag warn">deprecated</span>`}
                        ${edited && html`<span class="dsy-tag edit">edited</span>`}
                    </span>
                    ${sub && html`<span class="dsy-row-sub">${sub}</span>`}
                </span>
                ${value && html`<span class="dsy-row-value">${value}</span>`}
                <button
                    type="button"
                    class="dsy-row-open"
                    aria-expanded=${open}
                    aria-label=${`${open ? "Close" : "Open"} ${token.name}`}
                    onClick=${(event) => {
                        event.stopPropagation();
                        env.toggleToken(token.name);
                    }}
                >
                    <${Ico} name="down" size=${15} />
                </button>
            </div>
            ${children}
            ${
                open &&
                html`<${TokenEditor}
                    model=${ctx.model}
                    token=${token}
                    modes=${ctx.modes}
                    canEdit=${ctx.canEdit}
                    narrow=${ctx.narrow}
                />`
            }
        </li>`;
    }

    /** A group of tokens in a card, with a head that folds it. A search keeps every group with a match open. */
    function Group({ ctx, group, strip, children, bare = false }) {
        const folded = ctx.s.sysFolded[group.id] === true && ctx.query === "";

        const more =
            group.hidden > 0 &&
            html`<button
                type="button"
                class="dsn-link dsy-more"
                onClick=${() => env.showAll(group.id)}
            >
                Show ${group.hidden} more
            </button>`;

        if (bare) {
            return html`<section class="dsy-group bare">${children}${more}</section>`;
        }

        return html`<section class="dsy-group" data-folded=${folded} aria-label=${group.title}>
            <button
                type="button"
                class="dsy-group-head"
                aria-expanded=${!folded}
                onClick=${() => env.toggleGroup(group.id)}
            >
                <span class="dsy-group-title">${group.title}</span>
                <span class="dsy-group-count">${group.total ?? group.tokens.length}</span>
                ${strip}
                <${Ico} name="down" size=${15} class="dsy-group-chev" />
            </button>
            ${!folded && html`<div class="dsy-group-body">${children}${more}</div>`}
        </section>`;
    }

    const Empty = ({ text }) => html`<p class="dsy-empty muted">${text}</p>`;

    /** A group shows this many tokens until its "Show more" is tapped: a big system stays quick to draw. */
    const SHOWN = 120;

    /** The groups of a section, filtered by the search; a long one is cut, with `hidden` the number it leaves out. */
    function groupsFor(ctx, section) {
        return groupsOf(ctx.model.tokens, section, ctx.model.defaultMode)
            .map((group) => {
                const found = group.tokens.filter((token) => matches(token, ctx.query));
                const cut = ctx.query === "" && !ctx.s.sysAll[group.id] && found.length > SHOWN;

                return {
                    ...group,
                    total: found.length,
                    tokens: cut ? found.slice(0, SHOWN) : found,
                    hidden: cut ? found.length - SHOWN : 0,
                };
            })
            .filter((group) => group.tokens.length > 0);
    }

    // ─── Colors ──────────────────────────────────────────────────────────────

    /** The system's look in one small card for each mode: a page, a card on it, text, an accent, the statuses. */
    function Overview({ ctx }) {
        const found = roles(ctx.model);

        if (found.canvas === undefined || found.surface === undefined || found.text === undefined) {
            return null;
        }

        return html`<div class="dsy-overview" data-count=${ctx.modes.length}>
            ${ctx.modes.map((mode) => {
                const color = (role, fallback = "") => {
                    const name = found[role];

                    return name === undefined
                        ? fallback
                        : swatchCss(ctx.model.value(name, mode).value) || fallback;
                };

                return html`<figure
                    class="dsy-look"
                    key=${mode}
                    style=${`background:${color("canvas")}`}
                    aria-label=${`How ${mode} looks`}
                >
                    <div
                        class="dsy-look-card"
                        style=${`background:${color("surface")};box-shadow:0 0 0 1px ${color("border", "rgb(127 127 127 / .3)")}`}
                    >
                        <strong style=${`color:${color("text")}`}>Booking</strong>
                        <span style=${`color:${color("muted", color("text"))}`}
                            >The 9:15 ferry is on time.</span
                        >
                        <span class="dsy-look-row">
                            <span
                                class="dsy-look-button"
                                style=${`background:${color("accent", color("text"))};color:${color("onAccent", color("surface"))}`}
                                >Book</span
                            >
                            <span class="dsy-look-dots">
                                <i style=${`background:${color("danger", "transparent")}`}></i>
                                <i style=${`background:${color("warning", "transparent")}`}></i>
                                <i style=${`background:${color("success", "transparent")}`}></i>
                            </span>
                        </span>
                    </div>
                    ${ctx.modes.length > 1 && html`<figcaption style=${`color:${color("muted", color("text"))}`}>${mode}</figcaption>`}
                </figure>`;
            })}
        </div>`;
    }

    function ColorRow({ ctx, token }) {
        const { model, modes } = ctx;
        const values = modes.map((mode) => model.value(token.name, mode));
        const aliases = [...new Set(values.map((each) => each.alias).filter(Boolean))];
        const sub =
            aliases.length > 0
                ? html`<span class="mono">${aliases.map((name) => `→ ${name}`).join("  ")}</span>`
                : (token.description ?? "");

        return html`<${TokenRow}
            ctx=${ctx}
            token=${token}
            visual=${html`<${Swatch} values=${values.map((each) => each.value)} size=${40} />`}
            sub=${sub}
            value=${html`<span class="dsy-values">
                ${modes.map(
                    (mode, index) =>
                        html`<span class="dsy-value-line" key=${mode}>
                            <span class="dsy-hex mono">${hexOf(values[index].value) || "—"}</span>
                            <${ContrastBadge}
                                info=${model.contrastOf(token.name, mode)}
                                mode=${mode}
                                modes=${modes.length}
                            />
                        </span>`,
                )}
            </span>`}
        />`;
    }

    /** A ramp of raw colors as tiles: a tap opens the editor of the tile under the ramp. */
    function Ramp({ ctx, group }) {
        const open = group.tokens.find((token) => token.name === ctx.s.sysOpen);

        return html`<div class="dsy-ramp-wrap">
            <div class="dsy-ramp">
                ${group.tokens.map((token) => {
                    const values = ctx.modes.map((mode) => ctx.model.value(token.name, mode));
                    const edited = ctx.modes.some((mode) => ctx.model.edited(token.name, mode));

                    return html`<button
                        type="button"
                        key=${token.name}
                        data-token=${token.name}
                        class=${`dsy-tile ${token.name === ctx.s.sysOpen ? "on" : ""} ${edited ? "edited" : ""}`}
                        aria-pressed=${token.name === ctx.s.sysOpen}
                        aria-label=${`${token.name}, ${hexOf(values[0].value)}`}
                        title=${token.name}
                        onClick=${() => env.toggleToken(token.name)}
                    >
                        <${Swatch} values=${values.map((each) => each.value)} size=${44} />
                        <span class="dsy-tile-name mono">${token.path.at(-1)}</span>
                        <span class="dsy-tile-hex mono">${hexOf(values[0].value)}</span>
                    </button>`;
                })}
            </div>
            ${
                open &&
                html`<div class="dsy-ramp-editor">
                    <div class="dsy-ramp-editor-head">
                        <${CopyName} name=${open.name} />
                        <span class="grow"></span>
                        <button
                            type="button"
                            class="icon-button"
                            aria-label="Close"
                            onClick=${() => env.toggleToken(open.name)}
                        >
                            <${Ico} name="close" size=${15} />
                        </button>
                    </div>
                    <${TokenEditor}
                        model=${ctx.model}
                        token=${open}
                        modes=${ctx.modes}
                        canEdit=${ctx.canEdit}
                        narrow=${ctx.narrow}
                    />
                </div>`
            }
        </div>`;
    }

    function Colors({ ctx }) {
        const groups = groupsFor(ctx, "colors");

        if (groups.length === 0) {
            return html`<${Empty}
                text=${ctx.query ? "No color matches." : "This system has no colors yet."}
            />`;
        }

        return html`${ctx.query === "" && html`<${Overview} ctx=${ctx} />`}
        ${groups.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${group}
                    strip=${html`<span class="dsy-strip" aria-hidden="true">
                        ${group.tokens
                            .slice(0, 9)
                            .map(
                                (token) =>
                                    html`<i
                                        key=${token.name}
                                        style=${`background:${swatchCss(ctx.model.value(token.name, ctx.modes[0]).value)}`}
                                    ></i>`,
                            )}
                    </span>`}
                >
                    ${
                        group.kind === "roles"
                            ? html`<ul class="dsy-rows">
                                  ${group.tokens.map((token) => html`<${ColorRow} key=${token.name} ctx=${ctx} token=${token} />`)}
                              </ul>`
                            : html`<${Ramp} ctx=${ctx} group=${group} />`
                    }
                <//>`,
        )}`;
    }

    // ─── Type ────────────────────────────────────────────────────────────────

    function Type({ ctx }) {
        const groups = groupsFor(ctx, "type");
        const mode = ctx.modes[0];

        if (groups.length === 0) {
            return html`<${Empty}
                text=${ctx.query ? "No type token matches." : "This system has no type tokens yet."}
            />`;
        }

        const row = (token, group) => {
            const now = ctx.model.value(token.name, mode);

            if (token.type === "typography") {
                return html`<${TokenRow}
                    key=${token.name}
                    ctx=${ctx}
                    token=${token}
                    stacked=${true}
                    sub=${html`<span class="mono">${styleMeta(now.value)}</span>`}
                >
                    <p class="dsy-specimen" style=${typographyStyle(now.value)}>${SAMPLE}</p>
                <//>`;
            }

            if (token.type === "fontFamily") {
                const css = cssOf("fontFamily", now.value) ?? "";
                const style = typographyStyle({ fontFamily: now.value });

                return html`<${TokenRow}
                    key=${token.name}
                    ctx=${ctx}
                    token=${token}
                    visual=${html`<span class="dsy-glyph" style=${style}>Ag</span>`}
                    sub=${html`<span class="mono">${css}</span>`}
                    value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
                />`;
            }

            if (token.type === "fontWeight") {
                return html`<${TokenRow}
                    key=${token.name}
                    ctx=${ctx}
                    token=${token}
                    visual=${html`<span class="dsy-glyph" style=${`font-weight:${safeCss(now.value) || 400}`}>Aa</span>`}
                    value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
                />`;
            }

            if (token.type === "number") {
                return html`<${TokenRow}
                    key=${token.name}
                    ctx=${ctx}
                    token=${token}
                    visual=${html`<span class="dsy-leading" style=${`line-height:${safeCss(now.value) || 1.4}`}>Aa<br />Aa</span>`}
                    value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
                />`;
            }

            const px = pixelsOf(now.value);

            return html`<${TokenRow}
                key=${token.name}
                ctx=${ctx}
                token=${token}
                visual=${html`<span class="dsy-glyph" style=${px === null ? "" : `font-size:${Math.min(px, 30)}px`}>Aa</span>`}
                sub=${px === null ? null : html`<span class="mono">${px}px${px % 16 === 0 ? ` · ${px / 16}rem` : ""}</span>`}
                value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
            />`;
        };

        return html`${groups.map(
            (group) =>
                html`<${Group} key=${group.id} ctx=${ctx} group=${group}>
                    <ul class="dsy-rows">
                        ${group.tokens.map((token) => row(token, group))}
                    </ul>
                <//>`,
        )}`;
    }

    // ─── Spacing, radii, shadows ─────────────────────────────────────────────

    function Spacing({ ctx }) {
        const groups = groupsFor(ctx, "spacing");
        const mode = ctx.modes[0];

        if (groups.length === 0) {
            return html`<${Empty}
                text=${ctx.query ? "No spacing token matches." : "This system has no spacing yet."}
            />`;
        }

        const widest = Math.max(
            1,
            ...groups.flatMap((group) =>
                group.tokens.map((token) => pixelsOf(ctx.model.value(token.name, mode).value) ?? 0),
            ),
        );

        return html`${groups.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${{ ...group, title: group.title || "Scale" }}
                    bare=${group.title === ""}
                >
                    <ul class="dsy-rows">
                        ${group.tokens.map((token) => {
                            const now = ctx.model.value(token.name, mode);
                            const px = pixelsOf(now.value);

                            return html`<${TokenRow}
                                key=${token.name}
                                ctx=${ctx}
                                token=${token}
                                visual=${html`<span class="dsy-space"><i style=${`width:${px === null ? 0 : Math.max(2, Math.min(100, (px / widest) * 100))}%`}></i></span>`}
                                sub=${px === null ? null : html`<span class="mono">${`${Math.round((px / 16) * 1000) / 1000}rem at 16px`}</span>`}
                                value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
                            />`;
                        })}
                    </ul>
                <//>`,
        )}`;
    }

    /** Tiles that open the editor of one token under the grid (radii, shadows). */
    function Tiles({ ctx, group, tile, wide = false }) {
        const open = group.tokens.find((token) => token.name === ctx.s.sysOpen);

        return html`<div class="dsy-ramp-wrap">
            <div class=${`dsy-tiles ${wide ? "wide" : ""}`}>
                ${group.tokens.map((token) => {
                    const edited = ctx.modes.some((mode) => ctx.model.edited(token.name, mode));

                    return html`<button
                        type="button"
                        key=${token.name}
                        data-token=${token.name}
                        class=${`dsy-card-tile ${token.name === ctx.s.sysOpen ? "on" : ""} ${edited ? "edited" : ""}`}
                        aria-pressed=${token.name === ctx.s.sysOpen}
                        aria-label=${token.name}
                        onClick=${() => env.toggleToken(token.name)}
                    >
                        ${tile(token)}
                    </button>`;
                })}
            </div>
            ${
                open &&
                html`<div class="dsy-ramp-editor">
                    <div class="dsy-ramp-editor-head">
                        <${CopyName} name=${open.name} />
                        <span class="grow"></span>
                        <button
                            type="button"
                            class="icon-button"
                            aria-label="Close"
                            onClick=${() => env.toggleToken(open.name)}
                        >
                            <${Ico} name="close" size=${15} />
                        </button>
                    </div>
                    <${TokenEditor}
                        model=${ctx.model}
                        token=${open}
                        modes=${ctx.modes}
                        canEdit=${ctx.canEdit}
                        narrow=${ctx.narrow}
                    />
                </div>`
            }
        </div>`;
    }

    function Radii({ ctx }) {
        const groups = groupsFor(ctx, "radii");
        const mode = ctx.modes[0];

        if (groups.length === 0) {
            return html`<${Empty}
                text=${ctx.query ? "No radius matches." : "This system has no corner radii yet."}
            />`;
        }

        return html`${groups.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${{ ...group, title: group.title || "Corners" }}
                    bare=${group.title === ""}
                >
                    <${Tiles}
                        ctx=${ctx}
                        group=${group}
                        tile=${(token) => {
                            const now = ctx.model.value(token.name, mode);
                            const px = pixelsOf(now.value);

                            return html`<span
                                    class="dsy-corner"
                                    style=${`border-radius:${px === null ? 0 : Math.min(px, 36)}px`}
                                ></span>
                                <span class="dsy-tile-name mono">${token.path.at(-1)}</span>
                                <span class="dsy-tile-hex mono">${showValue(token, now)}</span>`;
                        }}
                    />
                <//>`,
        )}`;
    }

    function Shadows({ ctx }) {
        const groups = groupsFor(ctx, "shadows");
        const found = roles(ctx.model);

        if (groups.length === 0) {
            return html`<${Empty}
                text=${ctx.query ? "No shadow matches." : "This system has no shadows yet."}
            />`;
        }

        return html`${groups.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${{ ...group, title: group.title || "Elevation" }}
                    bare=${group.title === ""}
                >
                    <${Tiles}
                        ctx=${ctx}
                        group=${group}
                        wide=${true}
                        tile=${(token) =>
                            html`<span class="dsy-stages">
                                    ${ctx.modes.map((mode) => {
                                        const now = ctx.model.value(token.name, mode);
                                        const ground = found.canvas
                                            ? swatchCss(ctx.model.value(found.canvas, mode).value)
                                            : "";
                                        const card = found.surface
                                            ? swatchCss(ctx.model.value(found.surface, mode).value)
                                            : "";

                                        return html`<span
                                            class="dsy-stage"
                                            key=${mode}
                                            style=${ground ? `background:${ground}` : ""}
                                        >
                                            <i
                                                style=${`${card ? `background:${card};` : ""}box-shadow:${shadowOf(now.value) || "none"}`}
                                            ></i>
                                        </span>`;
                                    })}
                                </span>
                                <span class="dsy-tile-name mono">${token.path.at(-1)}</span>`}
                    />
                <//>`,
        )}`;
    }

    // ─── Motion ──────────────────────────────────────────────────────────────

    /** A dot that runs along a track once, there and back, for `ms` with `easing`. */
    function useRun() {
        const dot = useRef(null);
        const track = useRef(null);

        return {
            dot,
            track,
            run(ms, easing) {
                const element = dot.current;
                const room = track.current;

                if (!element || !room || typeof element.animate !== "function") {
                    return;
                }

                for (const animation of element.getAnimations()) {
                    animation.cancel();
                }

                const distance = Math.max(0, room.clientWidth - element.clientWidth);

                element.animate(
                    [{ transform: "translateX(0)" }, { transform: `translateX(${distance}px)` }],
                    {
                        duration: Math.max(1, Math.min(5000, ms)),
                        easing,
                        direction: "alternate",
                        iterations: 2,
                        delay: 0,
                        endDelay: 120,
                    },
                );
            },
        };
    }

    function Track({ motion }) {
        return html`<span class="dsy-track" ref=${motion.track}><i ref=${motion.dot}></i></span>`;
    }

    function DurationRow({ ctx, token, easing }) {
        const motion = useRun();
        const now = ctx.model.value(token.name, ctx.modes[0]);
        const ms = millisecondsOf(now.value);

        return html`<${TokenRow}
            ctx=${ctx}
            token=${token}
            visual=${html`<button
                type="button"
                class="dsy-play"
                aria-label=${`Play ${token.name}`}
                disabled=${ms === null}
                onClick=${(event) => {
                    event.stopPropagation();
                    motion.run(ms ?? 0, easing);
                }}
            >
                <${Ico} name="play" size=${14} />
            </button>`}
            sub=${html`<${Track} motion=${motion} />`}
            value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
        />`;
    }

    function EasingRow({ ctx, token }) {
        const motion = useRun();
        const now = ctx.model.value(token.name, ctx.modes[0]);
        const curve = Array.isArray(now.value) && now.value.length === 4 ? now.value : null;
        const css = cssOf("cubicBezier", now.value);

        return html`<${TokenRow}
            ctx=${ctx}
            token=${token}
            visual=${curve ? html`<${Curve} value=${curve} size=${56} />` : null}
            sub=${html`<span class="dsy-motion-sub"><span class="mono">${showValue(token, now)}</span><${Track} motion=${motion} /></span>`}
            value=${html`<button
                type="button"
                class="dsy-play"
                aria-label=${`Play ${token.name}`}
                disabled=${css === undefined}
                onClick=${(event) => {
                    event.stopPropagation();
                    motion.run(900, css);
                }}
            >
                <${Ico} name="play" size=${14} />
            </button>`}
        />`;
    }

    function Motion({ ctx }) {
        const groups = groupsFor(ctx, "motion");

        if (groups.length === 0) {
            return html`<${Empty}
                text=${ctx.query ? "No motion token matches." : "This system has no motion yet."}
            />`;
        }

        // Durations play on the first easing the system has.
        const first = ctx.model.tokens.find((token) => token.type === "cubicBezier");
        const easing =
            (first && cssOf("cubicBezier", ctx.model.value(first.name, ctx.modes[0]).value)) ||
            "ease";

        return html`${groups.map(
            (group) =>
                html`<${Group} key=${group.id} ctx=${ctx} group=${group}>
                    <ul class="dsy-rows">
                        ${group.tokens.map((token) =>
                            token.type === "duration"
                                ? html`<${DurationRow}
                                      key=${token.name}
                                      ctx=${ctx}
                                      token=${token}
                                      easing=${easing}
                                  />`
                                : token.type === "cubicBezier"
                                  ? html`<${EasingRow}
                                        key=${token.name}
                                        ctx=${ctx}
                                        token=${token}
                                    />`
                                  : html`<${TokenRow}
                                        key=${token.name}
                                        ctx=${ctx}
                                        token=${token}
                                        value=${html`<span class="dsy-hex mono">${showValue(token, ctx.model.value(token.name, ctx.modes[0]))}</span>`}
                                    />`,
                        )}
                    </ul>
                <//>`,
        )}`;
    }

    function Other({ ctx }) {
        const groups = groupsFor(ctx, "other");

        return html`${groups.map(
            (group) =>
                html`<${Group} key=${group.id} ctx=${ctx} group=${group}>
                    <ul class="dsy-rows">
                        ${group.tokens.map((token) => {
                            const now = ctx.model.value(token.name, ctx.modes[0]);

                            return html`<${TokenRow}
                                key=${token.name}
                                ctx=${ctx}
                                token=${token}
                                sub=${token.description ?? ""}
                                value=${html`<span class="dsy-hex mono">${showValue(token, now)}</span>`}
                            />`;
                        })}
                    </ul>
                <//>`,
        )}`;
    }

    // ─── Components ──────────────────────────────────────────────────────────

    /** One component in one mode: its states in a frame with no scripts and no network. The frame grows to fit them. */
    function Specimen({ ctx, component, mode }) {
        const frame = useRef(null);
        const found = roles(ctx.model);
        const color = (role, fallback) =>
            (found[role] ? swatchCss(ctx.model.value(found[role], mode).value) : "") || fallback;
        const dark = /dark/i.test(mode);
        const doc = specimenDocument({
            component,
            mode,
            theme: themeCss(ctx.model, mode),
            colors: {
                canvas: color("canvas", dark ? "#12131a" : "#f6f7fb"),
                surface: color("surface", dark ? "#1c1e26" : "#ffffff"),
                text: color("text", dark ? "#f6f7fb" : "#1c1e26"),
            },
        });

        // No scripts and no network (a policy in the document, and no `allow-scripts`). `allow-same-origin` is only so that the
        // page can read the frame's height once it loads: nothing in the frame can run to use it.
        return html`<iframe
            ref=${frame}
            class="dsy-specimen-frame"
            title=${`${component.name}, ${mode}`}
            sandbox="allow-same-origin"
            referrerpolicy="no-referrer"
            srcdoc=${doc}
            loading="lazy"
            onLoad=${() => {
                const body = frame.current?.contentDocument?.body;

                if (body && frame.current) {
                    frame.current.style.height = `${Math.min(900, Math.max(60, Math.ceil(body.getBoundingClientRect().height)))}px`;
                }
            }}
        ></iframe>`;
    }

    function Components({ ctx }) {
        const list = ctx.model.system.components.filter((component) => {
            const words = ctx.query.trim().toLowerCase();

            return (
                words === "" ||
                `${component.name} ${component.description} ${component.slug}`
                    .toLowerCase()
                    .includes(words)
            );
        });

        if (list.length === 0) {
            return html`<div class="dsy-blank">
                <${Ico} name="box" size=${28} />
                <h3>${ctx.query ? "No component matches." : "No components yet"}</h3>
                ${
                    !ctx.query &&
                    html`<p class="muted">
                        A component is a button, a field, or a card, written once with the system's
                        tokens, with each of its states (default, hover, focus, disabled, error). Pi
                        reuses their markup in designs.
                    </p>`
                }
                ${
                    !ctx.query &&
                    ctx.canEdit &&
                    html`<button
                        type="button"
                        class="button primary"
                        onClick=${() => env.askPi("components")}
                    >
                        <${Ico} name="sparkle" size=${15} /> Ask Pi for the core components
                    </button>`
                }
            </div>`;
        }

        return html`${list.map(
            (component) =>
                html`<article class="dsy-component" key=${component.slug}>
                    <header>
                        <h3>${component.name}</h3>
                        <span class="dsy-chip-static mono"
                            >${`${component.states.length} state${component.states.length === 1 ? "" : "s"}`}</span
                        >
                        <span class="grow"></span>
                        <${CopyName} name=${component.slug} copy=${component.slug} />
                    </header>
                    ${component.description && html`<p class="muted dsy-component-note">${component.description}</p>`}
                    <div class="dsy-specimens" data-count=${ctx.modes.length}>
                        ${ctx.modes.map(
                            (mode) =>
                                html`<div class="dsy-specimen-box" key=${mode}>
                                    ${ctx.modes.length > 1 && html`<span class="dsy-specimen-mode mono">${mode}</span>`}
                                    <${Specimen} ctx=${ctx} component=${component} mode=${mode} />
                                </div>`,
                        )}
                    </div>
                    ${
                        component.usage &&
                        (component.usage.do.length > 0 || component.usage.dont.length > 0) &&
                        html`<div class="dsy-usage">
                            ${
                                component.usage.do.length > 0 &&
                                html`<ul class="do">
                                    ${component.usage.do.slice(0, 6).map((line) => html`<li>${line}</li>`)}
                                </ul>`
                            }
                            ${
                                component.usage.dont.length > 0 &&
                                html`<ul class="dont">
                                    ${component.usage.dont.slice(0, 6).map((line) => html`<li>${line}</li>`)}
                                </ul>`
                            }
                        </div>`
                    }
                    ${
                        component.tokens.length > 0 &&
                        html`<div class="dsy-used">
                            ${component.tokens
                                .slice(0, 16)
                                .map(
                                    (name) =>
                                        html`<button
                                            type="button"
                                            class="dsy-chip"
                                            key=${name}
                                            disabled=${!ctx.model.has(name)}
                                            onClick=${() => env.openToken(name)}
                                        >
                                            ${name}
                                        </button>`,
                                )}
                        </div>`
                    }
                </article>`,
        )}
        ${
            ctx.canEdit &&
            ctx.query === "" &&
            html`<button
                type="button"
                class="dsn-link dsy-more"
                onClick=${() => env.askPi("component")}
            >
                <${Ico} name="sparkle" size=${14} /> Ask Pi for another component
            </button>`
        }`;
    }

    // ─── Guidelines ──────────────────────────────────────────────────────────

    function Guidelines({ ctx }) {
        const text = ctx.guidelines;
        const writing = ctx.s.sysWriting;
        const [draft, setDraft] = useState(null);
        const area = useRef(null);

        useEffect(() => {
            if (writing) {
                area.current?.focus({ preventScroll: true });
            }
        }, [writing]);

        if (writing && ctx.canEdit) {
            return html`<div class="dsy-write">
                <textarea
                    ref=${area}
                    class="mono"
                    value=${draft ?? text}
                    maxlength="16000"
                    spellcheck="true"
                    aria-label="Guidelines, in Markdown"
                    onInput=${(event) => {
                        setDraft(event.currentTarget.value);
                        env.editGuidelines(event.currentTarget.value);
                    }}
                ></textarea>
                <div class="dsy-write-foot">
                    <span class="muted small"
                        >${(draft ?? text).length.toLocaleString()} of 16,000 characters.
                        Markdown.</span
                    >
                    <span class="grow"></span>
                    <button
                        type="button"
                        class="button small"
                        onClick=${() => store.set({ sysWriting: false })}
                    >
                        Done
                    </button>
                </div>
            </div>`;
        }

        if (text.trim() === "") {
            return html`<div class="dsy-blank">
                <${Ico} name="book" size=${28} />
                <h3>No guidelines yet</h3>
                <p class="muted">
                    Guidelines are the rules in words: the voice, the layout, what to do and what
                    not to do. Pi reads them before it designs.
                </p>
                ${
                    ctx.canEdit &&
                    html`<div class="dsy-blank-actions">
                        <button
                            type="button"
                            class="button primary"
                            onClick=${() => store.set({ sysWriting: true })}
                        >
                            <${Ico} name="pen" size=${15} /> Write them
                        </button>
                        <button
                            type="button"
                            class="button"
                            onClick=${() => env.askPi("guidelines")}
                        >
                            <${Ico} name="sparkle" size=${15} /> Ask Pi
                        </button>
                    </div>`
                }
            </div>`;
        }

        return html`<article class="dsy-prose">
            ${
                ctx.canEdit &&
                html`<button
                    type="button"
                    class="dsn-link dsy-edit-guidelines"
                    onClick=${() => store.set({ sysWriting: true })}
                >
                    <${Ico} name="pen" size=${13} /> Edit
                </button>`
            }
            <${Markdown} text=${text} />
        </article>`;
    }

    return { Colors, Type, Spacing, Radii, Shadows, Motion, Other, Components, Guidelines };
}
