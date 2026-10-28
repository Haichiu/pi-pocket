// The System view: the project's design system as a place to work in. The bar (the pinned picker item, the mode in view, undo
// and redo), the sections, the unsaved edits and the bar that saves them, and, when there is room, the open design beside it
// that shows every edit live. A person who cannot steer sees all of it and changes none of it.
import { DEVICES } from "./devices.js";
import { modeTitle } from "./system-widgets.js";
import {
    changeOf,
    createModel,
    editsOf,
    SECTIONS,
    sectionOf,
    tokenEdits,
    unsavedCount,
} from "./system.js";

/** How often the open view asks whether Pi (or someone else) changed the system on disk. */
const REFRESH_MS = 20_000;

const MODE_ICONS = { light: "sun", dark: "moon" };

/** Whether the keys go to a field: undo and save then belong to it. */
const typing = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function createSystemView(env, canvas, sections) {
    const { pocket, store, parts, systemData } = env;
    const { html, useEffect, useMemo, useRef, useState } = pocket;
    const { Ico, Popover } = parts;

    // ─── The bar ─────────────────────────────────────────────────────────────

    /** Which mode is in view: each mode, and the modes side by side. */
    function ModeSwitch({ s, modes, narrow }) {
        if (modes.length < 2) {
            return null;
        }

        const current =
            s.sysMode === "both" ? "both" : modes.includes(s.sysMode) ? s.sysMode : modes[0];

        if (modes.length > 3) {
            return html`<select
                class="dsy-modeselect"
                aria-label="Mode"
                value=${current}
                onChange=${(event) => env.setSysMode(event.currentTarget.value)}
            >
                ${modes.map((mode) => html`<option value=${mode}>${modeTitle(mode)}</option>`)}
                <option value="both">Side by side</option>
            </select>`;
        }

        const options = [
            ...modes.map((mode) => ({
                value: mode,
                label: modeTitle(mode),
                icon: MODE_ICONS[mode],
            })),
            { value: "both", label: modes.length === 2 ? "Both" : "All", icon: "compare" },
        ];

        return html`<div class="dsn-seg dsy-modes" role="group" aria-label="Mode">
            ${options.map(
                (option) =>
                    html`<button
                        type="button"
                        key=${option.value}
                        class=${current === option.value ? "on" : ""}
                        aria-pressed=${current === option.value}
                        title=${option.value === "both" ? "Show the modes side by side" : `Show ${option.label}`}
                        aria-label=${option.label}
                        onClick=${() => env.setSysMode(option.value)}
                    >
                        ${option.icon && html`<${Ico} name=${option.icon} size=${15} />`}
                        ${(!narrow || !option.icon) && html`<span>${option.label}</span>`}
                    </button>`,
            )}
        </div>`;
    }

    /** What the system's menu offers: publish, export, modes, reload, and the conversation's room. */
    function SystemMenu({ s, data, canEdit, onClose, onModes }) {
        const [busy, setBusy] = useState(null);
        const errors = data?.problems.some((problem) => problem.level === "error") ?? false;

        const run = async (what, job) => {
            setBusy(what);
            await job();
            setBusy(null);
            onClose();
        };

        const item = (icon, label, hint, props) =>
            html`<button type="button" class="dsn-menu-item" ...${props}>
                <${Ico} name=${icon} size=${16} /><span class="grow">${label}</span
                >${hint && html`<span class="muted small">${hint}</span>`}
            </button>`;

        return html`<${Popover}
            label="Design system menu"
            onClose=${onClose}
            align="end"
            sheet=${env.sizeClass(s) === "narrow"}
        >
            <div class="dsn-menu">
                ${data && html`<div class="dsn-menu-label">${data.name}</div>`}
                ${
                    data &&
                    canEdit &&
                    item(
                        "book",
                        busy === "docs" ? "Publishing…" : "Publish documentation",
                        "a design",
                        {
                            disabled: busy !== null || errors,
                            title: errors
                                ? "Fix the errors first"
                                : "Make the system's documentation page a design",
                            onClick: () =>
                                run("docs", async () => {
                                    const made = await systemData.publishDocs();

                                    if (made) {
                                        env.open(made.id);
                                        pocket.notify(
                                            "info",
                                            `Published as ${made.id}, version ${made.version}. Share it from the menu.`,
                                        );
                                    }
                                }),
                        },
                    )
                }
                ${
                    data &&
                    canEdit &&
                    item(
                        "box",
                        busy === "export" ? "Making the files…" : "Export for code",
                        "CSS, Tailwind, JSON",
                        {
                            disabled: busy !== null || errors,
                            title: errors
                                ? "Fix the errors first"
                                : "Download the generated files as a zip",
                            onClick: () => run("export", () => systemData.exportCode()),
                        },
                    )
                }
                ${
                    data &&
                    canEdit &&
                    item("layers", "Modes…", `${data.modes.length}`, {
                        onClick: () => {
                            onClose();
                            onModes();
                        },
                    })
                }
                ${item("reload", "Read it again", null, { onClick: () => run("reload", () => systemData.load()) })}
                ${
                    env.beside() &&
                    item(
                        s.focus ? "unfocus" : "focus",
                        s.focus ? "Show the conversation" : "Hide the conversation",
                        null,
                        {
                            onClick: () => {
                                env.toggleFocus();
                                onClose();
                            },
                        },
                    )
                }
            </div>
        <//>`;
    }

    /** Add a mode, or remove one. A removed mode loses its file. */
    function ModesPopover({ data, onClose, narrow }) {
        const [name, setName] = useState("");
        const [busy, setBusy] = useState(false);
        const [asking, setAsking] = useState(null);
        const slug = name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        const taken = data.modes.includes(slug);
        const valid = /^[a-z][a-z0-9-]{0,31}$/.test(slug) && !taken && data.modes.length < 8;

        return html`<${Popover} label="Modes" onClose=${onClose} sheet=${narrow}>
            <div class="dsn-menu dsy-modes-pop">
                <div class="dsn-menu-label">Modes</div>
                ${data.modes.map(
                    (mode, index) =>
                        html`<div class="dsy-mode-row" key=${mode}>
                            <span class="dsy-mode-name">${modeTitle(mode)}</span>
                            <span class="muted small"
                                >${index === 0 ? "the default: tokens.json" : `tokens.${mode}.json`}</span
                            >
                            <span class="grow"></span>
                            ${
                                index > 0 &&
                                asking !== mode &&
                                html`<button
                                    type="button"
                                    class="dsn-link"
                                    onClick=${() => setAsking(mode)}
                                >
                                    Remove
                                </button>`
                            }
                            ${
                                asking === mode &&
                                html`<button
                                    type="button"
                                    class="button small danger"
                                    disabled=${busy}
                                    onClick=${async () => {
                                        setBusy(true);
                                        await systemData.changeModes(mode, null);
                                        setBusy(false);
                                        setAsking(null);
                                    }}
                                >
                                    Delete its file
                                </button>`
                            }
                        </div>`,
                )}
                <form
                    class="dsy-addmode"
                    onSubmit=${async (event) => {
                        event.preventDefault();

                        if (valid && !busy) {
                            setBusy(true);

                            const ok = await systemData.changeModes(slug, {});

                            setBusy(false);

                            if (ok) {
                                setName("");
                                onClose();
                            }
                        }
                    }}
                >
                    <input
                        type="text"
                        class="dsy-text"
                        placeholder="Add a mode: dark, high-contrast…"
                        value=${name}
                        maxlength="32"
                        autocapitalize="none"
                        spellcheck="false"
                        aria-label="Name of the new mode"
                        onInput=${(event) => setName(event.currentTarget.value)}
                    />
                    <button type="submit" class="button small primary" disabled=${!valid || busy}>
                        Add
                    </button>
                </form>
                ${slug !== "" && taken && html`<p class="dsy-problem">There is a mode by that name.</p>`}
                <p class="muted small dsy-note">
                    A new mode starts with the default's values. Change the tokens that differ, and
                    Save.
                </p>
            </div>
        <//>`;
    }

    /** The section tabs: only the sections that have something in them, and Components and Guidelines. */
    function SectionTabs({ s, data, split, hasDesign }) {
        const unsaved = unsavedCount(data, s.history);
        const bar = useRef(null);
        const counts = useMemo(() => {
            const out = {};

            for (const token of data?.tokens ?? []) {
                const id = sectionOf(token);

                out[id] = (out[id] ?? 0) + 1;
            }

            return out;
        }, [data]);
        const list = SECTIONS.filter(
            (section) =>
                section.id === "components" ||
                section.id === "guidelines" ||
                (data !== null && (counts[section.id] ?? 0) > 0),
        );
        const current = list.some((section) => section.id === s.sysSection)
            ? s.sysSection
            : list[0]?.id;

        // The tab that is on comes into view in a bar that scrolls (a phone's).
        useEffect(() => {
            const box = bar.current;
            const tab = box?.querySelector('[aria-selected="true"]');

            if (box && tab) {
                box.scrollTo({
                    left: Math.max(0, tab.offsetLeft - (box.clientWidth - tab.offsetWidth) / 2),
                    behavior: "smooth",
                });
            }
        }, [current]);

        // With no system there are no sections to go between.
        if (data === null) {
            return null;
        }

        return html`<div class="dsn-tabs dsy-tabs" role="tablist" aria-label="Sections" ref=${bar}>
            ${list.map((section) => {
                const count =
                    section.id === "components"
                        ? (data?.components.length ?? 0)
                        : (counts[section.id] ?? 0);

                return html`<button
                    type="button"
                    role="tab"
                    key=${section.id}
                    class=${`dsn-tab ${current === section.id ? "on" : ""}`}
                    aria-selected=${current === section.id}
                    onClick=${() => env.setSection(section.id)}
                >
                    <span>${section.label}</span>
                    ${count > 0 && html`<span class="dsn-count">${count}</span>`}
                </button>`;
            })}
            <span class="grow"></span>
            <span class="dsy-tabs-end">
                ${
                    data &&
                    !split &&
                    hasDesign &&
                    html`<button
                        type="button"
                        class=${`icon-button dsy-eye ${s.sysPane === "preview" ? "on" : ""}`}
                        title=${s.sysPane === "preview" ? "Back to the system" : "See the open design"}
                        aria-label=${s.sysPane === "preview" ? "Back to the system" : "See the open design"}
                        aria-pressed=${s.sysPane === "preview"}
                        onClick=${() => store.set({ sysPane: s.sysPane === "preview" ? "system" : "preview" })}
                    >
                        <${Ico} name="eye" size=${16} />
                        ${unsaved > 0 && html`<i class="dsy-eye-dot"></i>`}
                    </button>`
                }
                ${
                    data &&
                    html`<button
                        type="button"
                        class=${`icon-button ${s.sysSearch ? "on" : ""}`}
                        title="Find a token"
                        aria-label="Find a token"
                        aria-pressed=${s.sysSearch}
                        onClick=${() => store.set({ sysSearch: !s.sysSearch, sysQuery: s.sysSearch ? "" : s.sysQuery })}
                    >
                        <${Ico} name="search" size=${16} />
                    </button>`
                }</span
            >
        </div>`;
    }

    /** The bar of the System view: the picker, the mode in view, undo and redo, and the menu. */
    function SystemBar({ s, designs, design, shown, room, canEdit, Picker }) {
        const [open, setOpen] = useState(null);
        const data = s.system.data;
        const narrow = env.sizeClass(s) === "narrow";
        const split = room >= 900;
        const edits = s.history.past.length > 0;

        return html`<div class="dsn-bars dsy-bars">
            <div class="dsn-bar">
                <button
                    type="button"
                    class="dsn-picker"
                    aria-haspopup="dialog"
                    onClick=${() => setOpen("designs")}
                >
                    <${Ico} name="palette" size=${16} />
                    <span class="dsn-picker-title">Design system</span>
                    ${data && !narrow && html`<span class="dsn-version-tag mono">${data.name}</span>`}
                    <${Ico} name="down" size=${14} />
                </button>
                ${data && html`<${ModeSwitch} s=${s} modes=${data.modes} narrow=${narrow || !split} />`}
                ${
                    canEdit &&
                    data &&
                    (edits || s.history.future.length > 0) &&
                    html`<span class="dsy-history">
                        <button
                            type="button"
                            class="icon-button"
                            title="Undo (Ctrl+Z)"
                            aria-label="Undo"
                            disabled=${!edits}
                            onClick=${env.undo}
                        >
                            <${Ico} name="undo" size=${16} />
                        </button>
                        <button
                            type="button"
                            class="icon-button"
                            title="Redo (Ctrl+Shift+Z)"
                            aria-label="Redo"
                            disabled=${s.history.future.length === 0}
                            onClick=${env.redo}
                        >
                            <${Ico} name="redo" size=${16} />
                        </button>
                    </span>`
                }
                ${
                    env.beside() &&
                    html`<button
                        type="button"
                        class=${`icon-button ${s.focus ? "on" : ""}`}
                        title=${s.focus ? "Show the conversation" : "Hide the conversation"}
                        aria-label=${s.focus ? "Show the conversation" : "Hide the conversation"}
                        aria-pressed=${s.focus}
                        onClick=${env.toggleFocus}
                    >
                        <${Ico} name=${s.focus ? "unfocus" : "focus"} size=${17} />
                    </button>`
                }
                <button
                    type="button"
                    class="icon-button"
                    title="More"
                    aria-label="More"
                    aria-haspopup="dialog"
                    onClick=${() => setOpen("more")}
                >
                    <${Ico} name="more" size=${18} />
                </button>
            </div>
            <${SectionTabs} s=${s} data=${data} split=${split} hasDesign=${design !== null} />
            ${
                open === "designs" &&
                html`<${Picker}
                    s=${s}
                    designs=${designs}
                    design=${design}
                    onClose=${() => setOpen(null)}
                />`
            }
            ${
                open === "more" &&
                html`<${SystemMenu}
                    s=${s}
                    data=${data}
                    canEdit=${canEdit}
                    onClose=${() => setOpen(null)}
                    onModes=${() => setOpen("modes")}
                />`
            }
            ${open === "modes" && data && html`<${ModesPopover} data=${data} narrow=${narrow} onClose=${() => setOpen(null)} />`}
        </div>`;
    }

    // ─── Under the bar ───────────────────────────────────────────────────────

    /** What the validator found: errors stop a save, warnings do not. A tap on one with a token goes to the token. */
    function Problems({ problems }) {
        const [all, setAll] = useState(false);

        if (problems.length === 0) {
            return null;
        }

        const errors = problems.filter((problem) => problem.level === "error").length;
        const list = all ? problems : problems.slice(0, 3);

        return html`<div class=${`dsy-problems ${errors > 0 ? "error" : "warn"}`} role="status">
            <div class="dsy-problems-head">
                <${Ico} name="alert" size=${15} />
                <strong
                    >${errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : `${problems.length} warning${problems.length === 1 ? "" : "s"}`}</strong
                >
                ${errors > 0 && problems.length > errors && html`<span class="muted">and ${problems.length - errors} more</span>`}
            </div>
            <ul>
                ${list.map(
                    (problem, index) =>
                        html`<li key=${index} class=${problem.level}>
                            ${
                                problem.token
                                    ? html`<button
                                          type="button"
                                          class="dsy-chip"
                                          onClick=${() => env.openToken(problem.token)}
                                      >
                                          ${problem.token}
                                      </button>`
                                    : problem.file &&
                                      html`<span class="dsy-chip-static mono"
                                          >${problem.file}</span
                                      >`
                            }
                            <span>${problem.message}</span>
                        </li>`,
                )}
            </ul>
            ${
                problems.length > 3 &&
                html`<button type="button" class="dsn-link" onClick=${() => setAll(!all)}>
                    ${all ? "Show fewer" : `Show all ${problems.length}`}
                </button>`
            }
        </div>`;
    }

    /** Unsaved edits and the save: how many, undo, give up, and Save. */
    function SaveBar({ s, count, data, canEdit }) {
        if (!canEdit || !data) {
            return null;
        }

        const { status, error, problems, note } = s.save;

        if (count === 0 && status !== "saved" && status !== "conflict" && status !== "failed") {
            return null;
        }

        return html`<footer
            class=${`dsy-savebar ${status}`}
            role="region"
            aria-label="Unsaved changes"
        >
            ${
                status === "failed" &&
                html`<div class="dsy-save-error" role="alert">
                    <${Ico} name="alert" size=${14} />
                    <span>${error}</span>
                    ${problems.slice(0, 3).map((problem) => html`<span class="muted">${problem.message}</span>`)}
                </div>`
            }
            ${
                status === "conflict" &&
                html`<div class="dsy-save-error" role="alert">
                    <${Ico} name="alert" size=${14} />
                    <span
                        >The design system changed on disk after you opened it. Your edits are
                        kept.</span
                    >
                    <button type="button" class="dsn-link" onClick=${() => systemData.reload()}>
                        Load the new version
                    </button>
                </div>`
            }
            <div class="dsy-save-row">
                ${
                    status === "saved" && count === 0
                        ? html`<span class="dsy-saved"
                              ><${Ico} name="check" size=${15} /> ${note}</span
                          >`
                        : html`<span class="dsy-count-note"
                              ><i></i>${count} unsaved change${count === 1 ? "" : "s"}</span
                          >`
                }
                <span class="grow"></span>
                ${
                    count > 0 &&
                    html`<button
                            type="button"
                            class="button small"
                            disabled=${status === "saving"}
                            onClick=${env.discard}
                        >
                            Discard
                        </button>
                        <button
                            type="button"
                            class="button small primary"
                            disabled=${status === "saving" || status === "conflict"}
                            onClick=${() => systemData.save()}
                        >
                            ${status === "saving" ? "Saving…" : status === "failed" ? "Try again" : "Save"}
                        </button>`
                }
            </div>
        </footer>`;
    }

    /** What shows when the project has no tokens yet. */
    function Blank({ s, canEdit }) {
        const legacy = s.system.legacy;

        return html`<div class="dsy-blank big">
            <span class="dsy-blank-mark"><${Ico} name="palette" size=${30} /></span>
            <h3>No design system yet</h3>
            <p class="muted">
                A design system is the colors, type, spacing, and components of a product, kept in
                the project. Pi reads it before it designs, and checks each design against it. Here
                you see it, change it, and publish it.
            </p>
            ${
                legacy !== null &&
                html`<p class="dsy-legacy">
                    <${Ico} name="book" size=${15} />
                    <span>
                        This project has a Markdown design system
                        (<code>.pi/design-system.md</code>${`, ${legacy < 1024 ? `${legacy} bytes` : `${(legacy / 1024).toFixed(1)} KB`}). `}Pi
                        still reads it for its designs. Turn it into tokens to see and edit it here.
                    </span>
                </p>`
            }
            ${
                canEdit
                    ? html`<div class="dsy-blank-actions">
                          <button
                              type="button"
                              class="button primary"
                              onClick=${() => env.askPi(legacy === null ? "create" : "convert")}
                          >
                              <${Ico} name="sparkle" size=${15} />
                              ${legacy === null ? "Ask Pi to scan this project" : "Ask Pi to convert it"}
                          </button>
                          ${
                              legacy !== null &&
                              html`<button
                                  type="button"
                                  class="button"
                                  onClick=${() => env.askPi("create")}
                              >
                                  Scan the project instead
                              </button>`
                          }
                      </div>`
                    : html`<p class="muted small">
                          People who can steer the session can ask Pi to make one.
                      </p>`
            }
        </div>`;
    }

    // ─── The open design beside the view ─────────────────────────────────────

    /** The open design, live with the edits: a choice of design and size, and the page. */
    function Preview({ s, designs, design, shown, size, canEdit, pane }) {
        const narrowHead = pane === "page";
        const edits = unsavedCount(s.system.data, s.history);

        if (!design) {
            return html`<div class="dsy-preview">
                <div class="dsy-preview-empty">
                    <${Ico} name="design" size=${28} />
                    <p class="muted">
                        Open a design to see the system's changes on it as you make them. Designs
                        that link
                        <code>ds/tokens.css</code> follow the system.
                    </p>
                </div>
            </div>`;
        }

        return html`<div class="dsy-preview">
            <div class="dsy-preview-head">
                ${
                    narrowHead &&
                    html`<button
                        type="button"
                        class="button small"
                        onClick=${() => store.set({ sysPane: "system" })}
                    >
                        <${Ico} name="left" size=${14} /> System
                    </button>`
                }
                <select
                    class="dsy-preview-select"
                    aria-label="The design to preview"
                    value=${design.id}
                    onChange=${(event) => env.previewDesign(event.currentTarget.value)}
                >
                    ${designs.map((each) => html`<option value=${each.id}>${each.title}</option>`)}
                </select>
                <div class="dsn-seg" role="group" aria-label="Size">
                    ${["mobile", "tablet", "desktop"].map(
                        (device) =>
                            html`<button
                                type="button"
                                key=${device}
                                class=${s.device === device || (s.device === "auto" && device === "mobile" && narrowHead) ? "on" : ""}
                                aria-pressed=${s.device === device}
                                title=${`${DEVICES[device].label}, ${DEVICES[device].w} × ${DEVICES[device].h}`}
                                aria-label=${DEVICES[device].label}
                                onClick=${() => env.setDevice(device)}
                            >
                                <${Ico} name=${DEVICES[device].icon} size=${15} />
                            </button>`,
                    )}
                </div>
                ${
                    canEdit &&
                    html`<button
                        type="button"
                        class="button small"
                        title="Check this design against the system"
                        aria-label="Check this design"
                        onClick=${() => env.openCheck()}
                    >
                        <${Ico} name="shield" size=${14} />
                        <span class="dsy-check-label">Check</span>
                    </button>`
                }
            </div>
            ${
                edits > 0 &&
                html`<div class="dsy-preview-note">
                    <i></i> Showing ${edits} unsaved change${edits === 1 ? "" : "s"}. Designs that
                    use the system's variables follow it.
                </div>`
            }
            <div class="dsy-preview-canvas">
                <${canvas.CanvasView}
                    s=${s}
                    design=${design}
                    version=${shown}
                    size=${size}
                    readOnly=${true}
                />
            </div>
        </div>`;
    }

    // ─── The whole ───────────────────────────────────────────────────────────

    function SystemView({ s, designs, design, shown, size, room, canEdit }) {
        const system = s.system;
        const data = system.data;
        const scroll = useRef(null);
        const narrow = env.sizeClass(s) === "narrow";
        const split = room >= 900;
        const edits = useMemo(() => tokenEdits(s.history), [s.history]);
        const model = useMemo(() => (data ? createModel(data, edits) : null), [data, edits]);
        const names = data?.modes ?? [];
        const modes =
            s.sysMode === "both"
                ? names.slice(0, 3)
                : [names.includes(s.sysMode) ? s.sysMode : names[0]].filter(Boolean);
        const guidelines = editsOf(s.history).get("guidelines")?.text ?? data?.guidelines ?? "";
        const count = useMemo(
            () => (data ? changeOf(data, s.history).count : 0),
            [data, s.history],
        );
        const available = SECTIONS.filter(
            (section) =>
                section.id === "components" ||
                section.id === "guidelines" ||
                (model?.tokens ?? []).some((token) => sectionOf(token) === section.id),
        );
        const current = available.some((section) => section.id === s.sysSection)
            ? s.sysSection
            : (available[0]?.id ?? "colors");
        const ctx = {
            s,
            model,
            modes,
            canEdit,
            narrow,
            guidelines,
            query: s.sysSearch ? s.sysQuery.trim() : "",
        };

        // The first read, and then a quiet look every so often: Pi changes the files too.
        useEffect(() => {
            if (system.status === "idle") {
                void systemData.load();
            }

            const timer = setInterval(() => {
                if (!document.hidden) {
                    void systemData.load({ quiet: true });
                }
            }, REFRESH_MS);

            return () => clearInterval(timer);
        }, []);

        // Undo, redo, and save, as the keys that do them elsewhere (a field keeps its own).
        useEffect(() => {
            const onKey = (event) => {
                if (
                    !(event.metaKey || event.ctrlKey) ||
                    event.altKey ||
                    typing(event.target) ||
                    !canEdit
                ) {
                    return;
                }

                const key = event.key.toLowerCase();

                if (key === "z") {
                    event.preventDefault();
                    (event.shiftKey ? env.redo : env.undo)();
                } else if (key === "y") {
                    event.preventDefault();
                    env.redo();
                } else if (key === "s") {
                    event.preventDefault();
                    void systemData.save();
                }
            };

            document.addEventListener("keydown", onKey);

            return () => document.removeEventListener("keydown", onKey);
        }, [canEdit]);

        // A section starts at its top.
        useEffect(() => scroll.current?.scrollTo({ top: 0 }), [current]);

        let body;

        if (system.status === "loading" || system.status === "idle") {
            body = html`<${pocket.Loader} label="Reading the design system" />`;
        } else if (system.status === "failed" && !data) {
            body = html`<div class="dsy-blank">
                <${Ico} name="alert" size=${26} />
                <h3>The design system could not be read</h3>
                <p class="muted">${system.error}</p>
                <button type="button" class="button" onClick=${() => systemData.load()}>
                    Try again
                </button>
            </div>`;
        } else if (!data) {
            body = html`<${Blank} s=${s} canEdit=${canEdit} />`;
        } else {
            const Section = {
                colors: sections.Colors,
                type: sections.Type,
                spacing: sections.Spacing,
                radii: sections.Radii,
                shadows: sections.Shadows,
                motion: sections.Motion,
                other: sections.Other,
                components: sections.Components,
                guidelines: sections.Guidelines,
            }[current];

            body = html`${
                    s.sysSearch &&
                    html`<div class="dsy-search">
                        <${Ico} name="search" size=${15} />
                        <input
                            type="search"
                            value=${s.sysQuery}
                            placeholder=${`Find in ${available.find((section) => section.id === current)?.label ?? "the system"}: a name, a value, a word`}
                            aria-label="Find a token"
                            autofocus
                            onInput=${(event) => store.set({ sysQuery: event.currentTarget.value })}
                        />
                        ${
                            s.sysQuery !== "" &&
                            html`<button
                                type="button"
                                class="icon-button"
                                aria-label="Clear"
                                onClick=${() => store.set({ sysQuery: "" })}
                            >
                                <${Ico} name="close" size=${14} />
                            </button>`
                        }
                    </div>`
                }
                <${Problems} problems=${data.problems} />
                ${!canEdit && html`<p class="dsy-readonly muted small"><${Ico} name="eye" size=${13} /> You can look at the system here. Only people who can steer the session change it.</p>`}
                <${Section} ctx=${ctx} />`;
        }

        const column = html`<div class="dsy-column">
            <div class="dsy-scroll" ref=${scroll} data-no-swipe>${body}</div>
            <${SaveBar} s=${s} count=${count} data=${data} canEdit=${canEdit} />
        </div>`;

        const preview = html`<${Preview}
            s=${s}
            designs=${designs}
            design=${design}
            shown=${shown}
            size=${size}
            canEdit=${canEdit}
            pane=${split ? "side" : "page"}
        />`;

        return html`<div class="dsy-main" data-split=${split} data-pane=${s.sysPane}>
            ${split ? html`${column}${preview}` : s.sysPane === "preview" ? preview : column}
        </div>`;
    }

    return { SystemBar, SystemView };
}
