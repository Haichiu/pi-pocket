// The small parts of the System view: a swatch, a token's name that copies, a contrast badge, number and color fields, the
// alias picker, and the editor of one token. They draw what `system.js` computes; they keep no state of the system's own.
import { parseColor, ratioText, swatchCss, toHex, toOklchText, toRgbText } from "./color.js";
import { amountOf, EDITABLE, readInput, showValue, writeAmount } from "./system.js";

/** Put `text` on the clipboard: the async API where the page may use it, else a hidden field and a copy command. */
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);

        return true;
    } catch {
        const field = document.createElement("textarea");

        field.value = text;
        field.setAttribute("readonly", "");
        field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.append(field);
        field.select();

        try {
            return document.execCommand("copy");
        } finally {
            field.remove();
        }
    }
}

/** The title-cased name of a mode (`high-contrast` → `High contrast`). */
export const modeTitle = (mode) =>
    mode === "" ? "" : mode[0].toUpperCase() + mode.slice(1).replace(/[-_]+/g, " ");

const UNITS = { dimension: ["px", "rem", "em"], duration: ["ms", "s"] };
const round = (value) => Math.round(value * 10000) / 10000;

export function createSystemWidgets(env) {
    const { pocket } = env;
    const { html, useState } = pocket;
    const { Ico, Popover } = env.parts;

    /** A color, or a pair of them (a split swatch: one half for each mode). */
    function Swatch({ values, size = 36 }) {
        return html`<span
            class="dsy-swatch"
            style=${`--size:${size}px`}
            data-parts=${values.length}
            aria-hidden="true"
        >
            ${values.map((value, index) => {
                const css = swatchCss(value);

                return html`<span
                    key=${index}
                    class="dsy-swatch-part"
                    data-empty=${css === ""}
                    style=${css === "" ? "" : `background:${css}`}
                ></span>`;
            })}
        </span>`;
    }

    /** A token's name, which copies on a tap: its last word strong, the rest of the path quiet. */
    function CopyName({ name, copy = name, size = "" }) {
        const [done, setDone] = useState(false);
        const parts = name.split(".");
        const leaf = parts.pop();

        return html`<button
            type="button"
            class=${`dsy-name ${size}`}
            title=${`Copy ${copy}`}
            aria-label=${`Copy ${copy}`}
            onClick=${async (event) => {
                event.stopPropagation();

                if (await copyText(copy)) {
                    setDone(true);
                    setTimeout(() => setDone(false), 1400);
                    pocket.notify("info", `Copied ${copy}`);
                }
            }}
        >
            <span class="dsy-name-path">${parts.map((part) => html`${part}.<wbr />`)}</span
            ><span class="dsy-name-leaf">${leaf}</span>
            <span class=${`dsy-name-icon ${done ? "done" : ""}`}
                ><${Ico} name=${done ? "check" : "copy"} size=${12}
            /></span>
        </button>`;
    }

    /** What a text color's contrast comes to on its pair: `7.1:1 AAA`. A token with no pair of its own shows dashed. */
    function ContrastBadge({ info, mode, modes = 1 }) {
        if (!info) {
            return null;
        }

        const verdict = info.pass ? info.level : info.level === "AA large" ? "Large only" : "Fail";

        return html`<span
            class=${`dsy-badge ${info.pass ? (info.level === "AAA" ? "aaa" : "aa") : "fail"} ${info.auto ? "auto" : ""}`}
            title=${`${mode ? `${modeTitle(mode)}: ` : ""}${ratioText(info.ratio)} on ${info.on}. It needs ${info.min}:1.${info.auto ? " Checked against the page background: this color has no pair of its own." : ""}`}
        >
            ${modes > 1 && html`<span class="dsy-badge-mode">${modeTitle(mode).slice(0, 1)}</span>`}
            <span class="dsy-badge-ratio">${ratioText(info.ratio)}</span>
            <span class="dsy-badge-level">${verdict}</span>
        </span>`;
    }

    /** A number with steppers and, for sizes and times, a unit. `onChange` gets `{ n, unit }`. */
    function AmountField({ amount, units, step = 1, label, onChange, disabled }) {
        const [text, setText] = useState(null);
        const shown = text ?? String(amount.n);
        const set = (n, unit = amount.unit) => onChange({ n: round(n), unit });

        // The unit changes by what it is worth: 16px is 1rem.
        const convert = (unit) => {
            const per = { px: 1, rem: 16, em: 16, ms: 1, s: 1000 };

            if (per[amount.unit] && per[unit] && amount.unit !== unit) {
                set((amount.n * per[amount.unit]) / per[unit], unit);
            } else {
                set(amount.n, unit);
            }
        };

        return html`<div class="dsy-amount">
            <button
                type="button"
                class="dsy-step"
                aria-label=${`Decrease ${label}`}
                disabled=${disabled}
                onClick=${() => set(amount.n - step)}
            >
                <${Ico} name="minus" size=${14} />
            </button>
            <input
                type="text"
                inputmode="decimal"
                class="mono"
                value=${shown}
                disabled=${disabled}
                aria-label=${label}
                spellcheck="false"
                onInput=${(event) => {
                    const value = event.currentTarget.value;
                    const next = amountOf(value);

                    setText(value);

                    if (next !== null && (units === undefined ? next.unit === "" : true)) {
                        set(next.n, next.unit === "" ? amount.unit : next.unit);
                    }
                }}
                onBlur=${() => setText(null)}
                onKeyDown=${(event) => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        set(
                            amount.n +
                                (event.key === "ArrowUp" ? step : -step) *
                                    (event.shiftKey ? 10 : 1),
                        );
                        setText(null);
                    }
                }}
            />
            <button
                type="button"
                class="dsy-step"
                aria-label=${`Increase ${label}`}
                disabled=${disabled}
                onClick=${() => set(amount.n + step)}
            >
                <${Ico} name="plus" size=${14} />
            </button>
            ${
                units &&
                html`<select
                    class="dsy-unit"
                    value=${amount.unit}
                    disabled=${disabled}
                    aria-label=${`${label}: unit`}
                    onChange=${(event) => convert(event.currentTarget.value)}
                >
                    ${(units.includes(amount.unit) ? units : [amount.unit, ...units]).map(
                        (unit) => html`<option value=${unit}>${unit}</option>`,
                    )}
                </select>`
            }
        </div>`;
    }

    const FORMATS = ["hex", "oklch", "rgb"];

    /** A color: the system's picker, and a field that takes any CSS color. `onChange` gets the new DTCG value. */
    function ColorField({ value, like, label, onChange, disabled }) {
        const [draft, setDraft] = useState(null);
        const [format, setFormat] = useState("hex");
        const color = parseColor(value);
        const text =
            color === null
                ? ""
                : format === "oklch"
                  ? toOklchText(color)
                  : format === "rgb"
                    ? toRgbText(color)
                    : toHex(color);
        const problem = draft === null ? "" : (readInput("color", draft, like).error ?? "");

        const take = (input) => {
            const result = readInput("color", input, like);

            if (result.value !== undefined) {
                onChange(result.value);
            }
        };

        return html`<div class="dsy-colorfield">
            <label class="dsy-well" style=${color ? `--well:${swatchCss(value)}` : ""}>
                <input
                    type="color"
                    value=${color ? toHex({ ...color, a: 1 }) : "#000000"}
                    disabled=${disabled}
                    aria-label=${`${label}: pick`}
                    onInput=${(event) => take(event.currentTarget.value)}
                />
            </label>
            <input
                type="text"
                class=${`mono ${problem ? "bad" : ""}`}
                value=${draft ?? text}
                disabled=${disabled}
                spellcheck="false"
                autocomplete="off"
                aria-label=${`${label}: color`}
                aria-invalid=${problem !== ""}
                onInput=${(event) => {
                    setDraft(event.currentTarget.value);
                    take(event.currentTarget.value);
                }}
                onBlur=${() => setDraft(null)}
            />
            <button
                type="button"
                class="dsy-format"
                title="Show it as hex, oklch, or rgb"
                aria-label=${`Shown as ${format}. Change.`}
                onClick=${() => {
                    setDraft(null);
                    setFormat(FORMATS[(FORMATS.indexOf(format) + 1) % FORMATS.length]);
                }}
            >
                ${format}
            </button>
            ${problem && html`<p class="dsy-problem" role="alert">${problem}</p>`}
        </div>`;
    }

    /** The cubic-bezier of an easing, drawn (the curve, its two handles) in a 64 px square. */
    function Curve({ value, size = 64, play = false }) {
        const [x1, y1, x2, y2] = value;
        const pad = 10;
        const span = size - pad * 2;
        const at = (x, y) => `${(pad + x * span).toFixed(1)} ${(size - pad - y * span).toFixed(1)}`;

        return html`<svg
            class="dsy-curve"
            width=${size}
            height=${size}
            viewBox=${`0 0 ${size} ${size}`}
            aria-hidden="true"
        >
            <path
                class="dsy-curve-axis"
                d=${`M${at(0, 0)} L${at(1, 0)} M${at(0, 0)} L${at(0, 1)}`}
            />
            <path
                class="dsy-curve-handle"
                d=${`M${at(0, 0)} L${at(x1, y1)} M${at(1, 1)} L${at(x2, y2)}`}
            />
            <path
                class="dsy-curve-line"
                d=${`M${at(0, 0)} C${at(x1, y1)} ${at(x2, y2)} ${at(1, 1)}`}
            />
            <circle
                class="dsy-curve-dot"
                cx=${at(x1, y1).split(" ")[0]}
                cy=${at(x1, y1).split(" ")[1]}
                r="2.5"
            />
            <circle
                class="dsy-curve-dot"
                cx=${at(x2, y2).split(" ")[0]}
                cy=${at(x2, y2).split(" ")[1]}
                r="2.5"
            />
            ${play && html`<circle class="dsy-curve-dot end" cx=${at(1, 1).split(" ")[0]} cy=${at(1, 1).split(" ")[1]} r="2.5" />`}
        </svg>`;
    }

    /** Four numbers of an easing, with its curve. */
    function BezierField({ value, label, onChange, disabled }) {
        const names = ["x1", "y1", "x2", "y2"];

        return html`<div class="dsy-bezier">
            <${Curve} value=${value} size=${72} />
            <div class="dsy-bezier-fields">
                ${names.map(
                    (name, index) =>
                        html`<label>
                            <span class="muted small mono">${name}</span>
                            <input
                                type="text"
                                inputmode="decimal"
                                class="mono"
                                value=${String(value[index])}
                                disabled=${disabled}
                                aria-label=${`${label}: ${name}`}
                                onChange=${(event) => {
                                    const next = [...value];

                                    next[index] = Number(event.currentTarget.value);

                                    const result = readInput("cubicBezier", next.join(" "), value);

                                    if (result.value !== undefined) {
                                        onChange(result.value);
                                    } else {
                                        pocket.notify("error", result.error);
                                        event.currentTarget.value = String(value[index]);
                                    }
                                }}
                            />
                        </label>`,
                )}
            </div>
        </div>`;
    }

    /** The tokens an alias may point to: those of the same type that do not lead back. Searchable, in a card over the view. */
    function AliasPicker({ model, token, mode, onPick, onClose, narrow }) {
        const [query, setQuery] = useState("");
        const words = query.trim().toLowerCase();
        const targets = model
            .targets(token.name)
            .filter((each) => words === "" || each.name.toLowerCase().includes(words));
        const current = model.value(token.name, mode).alias;

        return html`<${Popover}
            label="Link to a token"
            onClose=${onClose}
            wide=${true}
            sheet=${narrow}
        >
            <input
                class="dsn-search"
                type="search"
                placeholder=${`Find a ${token.type} token`}
                value=${query}
                autofocus
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
            <ul class="dsn-list dsy-targets" aria-label="Tokens">
                ${targets.slice(0, 120).map((each) => {
                    const value = model.value(each.name, mode);

                    return html`<li key=${each.name}>
                        <button
                            type="button"
                            class=${`dsn-list-item ${each.name === current ? "on" : ""}`}
                            onClick=${() => onPick(each.name)}
                        >
                            ${
                                each.type === "color"
                                    ? html`<${Swatch} values=${[value.value]} size=${28} />`
                                    : html`<span class="dsy-target-value mono"
                                          >${showValue(each, value).slice(0, 14)}</span
                                      >`
                            }
                            <span class="dsn-list-main">
                                <strong class="mono dsy-target-name">${each.name}</strong>
                                <span class="muted small"
                                    >${each.tier}${each.description ? ` · ${each.description}` : ""}</span
                                >
                            </span>
                            ${each.name === current && html`<${Ico} name="check" size=${15} />`}
                        </button>
                    </li>`;
                })}
                ${targets.length === 0 && html`<li class="muted small dsn-empty">No token of this kind${words ? " by that name" : ""}.</li>`}
                ${targets.length > 120 && html`<li class="muted small dsn-empty">Type to narrow ${targets.length} tokens.</li>`}
            </ul>
        <//>`;
    }

    /** The value of one token in one mode, as the field of its kind (or what to do when it has none). */
    function ValueField({ model, token, mode, canEdit, like }) {
        const now = model.value(token.name, mode);
        // A token that links to another can be edited too: a new value replaces the link (undo puts it back).
        const disabled = !canEdit;
        const label = `${token.name} in ${mode}`;
        const edit = (value) => env.editToken(token.name, mode, { value });

        switch (token.type) {
            case "color":
                return html`<${ColorField}
                    value=${now.value}
                    like=${like}
                    label=${label}
                    disabled=${disabled}
                    onChange=${edit}
                />`;
            case "dimension":

            case "duration": {
                const amount = amountOf(now.value);

                return amount
                    ? html`<${AmountField}
                          amount=${amount}
                          units=${UNITS[token.type]}
                          step=${token.type === "duration" ? 10 : amount.unit === "px" ? 1 : 0.25}
                          label=${label}
                          disabled=${disabled}
                          onChange=${(next) => edit(writeAmount(next, like))}
                      />`
                    : html`<p class="muted small">This value has no size to edit.</p>`;
            }

            case "number":
            case "fontWeight":
                return typeof now.value === "number"
                    ? html`<${AmountField}
                          amount=${{ n: now.value, unit: "" }}
                          step=${token.type === "fontWeight" ? 100 : 0.05}
                          label=${label}
                          disabled=${disabled}
                          onChange=${(next) => edit(token.type === "fontWeight" ? Math.max(1, Math.min(1000, Math.round(next.n))) : next.n)}
                      />`
                    : html`<p class="muted small mono">${String(now.value)}</p>`;
            case "fontFamily":
                return html`<input
                    type="text"
                    class="dsy-text mono"
                    value=${Array.isArray(now.value) ? now.value.join(", ") : String(now.value ?? "")}
                    disabled=${disabled}
                    spellcheck="false"
                    aria-label=${label}
                    onChange=${(event) => {
                        const result = readInput("fontFamily", event.currentTarget.value, like);

                        if (result.value === undefined) {
                            pocket.notify("error", result.error);
                        } else {
                            edit(result.value);
                        }
                    }}
                />`;
            case "cubicBezier":
                return Array.isArray(now.value) && now.value.length === 4
                    ? html`<${BezierField}
                          value=${now.value}
                          label=${label}
                          disabled=${disabled}
                          onChange=${edit}
                      />`
                    : null;
            default:
                return html`<p class="dsy-composite mono">${showValue(token, now)}</p>`;
        }
    }

    /**
     * One token's editor: for each mode in view, its alias (link, change, or use a value), and its value in the field of its
     * kind. A shadow or a typography style is shown, and changed with Pi: its parts are not separate in the saved value.
     */
    function TokenEditor({ model, token, modes, canEdit, narrow }) {
        const editable = EDITABLE.has(token.type);
        const dependents = model.dependents(token.name);
        const anyEdit = model.modes.some((mode) => model.edited(token.name, mode));

        return html`<div class="dsy-editor">
            ${token.description && html`<p class="dsy-editor-note">${token.description}</p>`}
            ${
                token.deprecated &&
                html`<p class="dsy-editor-warn">
                    <${Ico} name="alert" size=${13} />
                    Deprecated${typeof token.deprecated === "string" ? `: ${token.deprecated}` : ""}
                </p>`
            }
            ${modes.map((mode) => {
                const now = model.value(token.name, mode);
                const saved = token.modes[mode];
                // The dialect to write in: that of the saved value (or the default mode's, when this one only follows it).
                const like =
                    (saved?.alias === undefined
                        ? saved?.value
                        : model.value(token.name, mode).value) ??
                    token.modes[model.defaultMode]?.value;
                const chain = model.chain(token.name, mode);

                return html`<section class="dsy-mode" key=${mode} aria-label=${modeTitle(mode)}>
                    ${modes.length > 1 && html`<h4 class="dsy-mode-name">${modeTitle(mode)}</h4>`}
                    ${now.error && html`<p class="dsy-problem" role="alert">${now.error}</p>`}
                    ${
                        editable
                            ? html`<${ValueField}
                                  model=${model}
                                  token=${token}
                                  mode=${mode}
                                  canEdit=${canEdit}
                                  like=${like}
                              />`
                            : html`<${ValueField}
                                  model=${model}
                                  token=${token}
                                  mode=${mode}
                                  canEdit=${false}
                                  like=${like}
                              />`
                    }
                    <div class="dsy-alias">
                        <${Ico} name="link" size=${14} />
                        ${
                            now.alias
                                ? html`<span class="dsy-chain mono">
                                      ${chain
                                          .slice(1)
                                          .map(
                                              (name, index) =>
                                                  html`${index > 0 && html`<span class="dsy-arrow">→</span>`}<button
                                                          type="button"
                                                          class="dsy-chip"
                                                          onClick=${() => env.openToken(name)}
                                                      >
                                                          ${name}
                                                      </button>`,
                                          )}
                                  </span>`
                                : html`<span class="muted small">A value of its own</span>`
                        }
                        <span class="grow"></span>
                        ${
                            canEdit &&
                            html`<button
                                type="button"
                                class="dsn-link"
                                onClick=${() => env.pickAlias(token.name, mode)}
                            >
                                ${now.alias ? "Change" : "Link to a token"}
                            </button>`
                        }
                        ${
                            canEdit &&
                            now.alias &&
                            html`<button
                                type="button"
                                class="dsn-link"
                                onClick=${() => env.editToken(token.name, mode, { value: now.value })}
                            >
                                Use a value
                            </button>`
                        }
                    </div>
                    ${
                        canEdit &&
                        mode !== model.defaultMode &&
                        JSON.stringify(token.modes[mode]) !==
                            JSON.stringify(token.modes[model.defaultMode]) &&
                        html`<button
                            type="button"
                            class="dsn-link dsy-match"
                            onClick=${() => env.matchDefault(token.name, mode)}
                        >
                            Match ${modeTitle(model.defaultMode)}
                        </button>`
                    }
                </section>`;
            })}
            ${
                !editable &&
                html`<div class="dsy-askpi">
                    <span class="muted small">
                        This kind of token is made of parts that link to other tokens. Change the
                        tokens it uses, or ask Pi to change it.
                    </span>
                    ${
                        canEdit &&
                        html`<button
                            type="button"
                            class="button small"
                            onClick=${() => env.askPiAbout(token)}
                        >
                            <${Ico} name="sparkle" size=${14} /> Ask Pi
                        </button>`
                    }
                </div>`
            }
            <div class="dsy-editor-foot">
                <button
                    type="button"
                    class="dsn-link"
                    onClick=${async () => {
                        if (await copyText(`var(${token.cssVar})`)) {
                            pocket.notify("info", `Copied var(${token.cssVar})`);
                        }
                    }}
                >
                    <${Ico} name="copy" size=${13} /> var(${token.cssVar})
                </button>
                ${
                    dependents.length > 0 &&
                    html`<span class="muted small"
                        >${`Used by ${dependents.length} token${dependents.length === 1 ? "" : "s"}`}</span
                    >`
                }
                <span class="grow"></span>
                ${
                    canEdit &&
                    anyEdit &&
                    html`<button
                        type="button"
                        class="dsn-link"
                        onClick=${() => env.resetToken(token.name)}
                    >
                        <${Ico} name="undo" size=${13} /> Reset
                    </button>`
                }
            </div>
            ${
                dependents.length > 0 &&
                html`<div class="dsy-used">
                    ${dependents
                        .slice(0, 12)
                        .map(
                            (name) =>
                                html`<button
                                    type="button"
                                    class="dsy-chip"
                                    key=${name}
                                    onClick=${() => env.openToken(name)}
                                >
                                    ${name}
                                </button>`,
                        )}
                    ${dependents.length > 12 && html`<span class="muted small">and ${dependents.length - 12} more</span>`}
                </div>`
            }
        </div>`;
    }

    return {
        Swatch,
        CopyName,
        ContrastBadge,
        AmountField,
        ColorField,
        BezierField,
        Curve,
        AliasPicker,
        ValueField,
        TokenEditor,
    };
}
