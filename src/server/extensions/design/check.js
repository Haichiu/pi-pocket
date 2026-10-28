// The Check dock: a design checked against the design system (and the page's own basics: contrast, tap targets, overflow,
// alt text, headings). The server renders the page and walks it; this lists what it found, pins each finding to its element
// on the canvas, and puts one message with all of them in the message box for Pi.
import { exportViewport, sizeOf } from "./devices.js";
import { checkMessage } from "./messages.js";
import { resolveDevice } from "./state.js";
import { checkKey } from "./system-data.js";

/**
 * The modes a check can be made in: those of the design system (a system has as many as its files say: light, dark,
 * high-contrast…), or light and dark when there is no system to say.
 */
const modesOf = (s) => {
    const modes = s.system.data?.modes;

    return Array.isArray(modes) && modes.length > 0 ? modes : ["light", "dark"];
};

/** The color scheme of a mode: what the system says of it, else its name. */
const schemeOf = (s, mode) =>
    s.system.data?.schemes?.[mode] ?? (mode === "dark" ? "dark" : "light");

/**
 * The mode that the canvas shows: the one that goes with the color scheme of the page in it (`dark`: whether that is dark;
 * the canvas follows the app's theme, or the backdrop a person chose). The mode named for the scheme, else the first of that
 * scheme, else the default.
 */
export function canvasMode(s, dark) {
    const modes = modesOf(s);
    const want = dark ? "dark" : "light";

    return (
        modes.find((mode) => mode === want) ??
        modes.find((mode) => schemeOf(s, mode) === want) ??
        modes[0]
    );
}

/**
 * The options of a check as they are now: what the person chose, else what the canvas shows. `dark` is whether the app
 * is in a dark scheme (the page in the canvas follows it). `seen` is the mode of the canvas, `mode` the one checked (a
 * mode of the system), `scheme` its color scheme; `modes` are the choices, and `following` says that none was chosen.
 */
export function checkOptions(s, dark) {
    const device = resolveDevice(s.device, s.width);
    const modes = modesOf(s);
    const seen = canvasMode(s, dark);
    const chosen = s.checkWith.mode;
    const following = chosen === null || !modes.includes(chosen);
    const mode = following ? seen : chosen;

    return {
        mode,
        scheme: schemeOf(s, mode),
        size: s.checkWith.size ?? exportViewport(device, sizeOf(device, s.custom)),
        seen,
        modes,
        following,
        // A system names its modes; with none, the server has none to check against.
        named: s.system.data !== null && s.system.data !== undefined,
    };
}

/** An icon for the modes that have one: the others are told by their names. */
const MODE_ICONS = { light: "sun", dark: "moon" };

const titleOf = (mode) => mode[0].toUpperCase() + mode.slice(1).replace(/[-_]+/g, " ");

/** What each rule is called, and in what order the groups of findings go. */
export const RULES = {
    "off-system-color": "Off-system color",
    "off-system-font": "Off-system font",
    "off-system-size": "Off-scale size",
    contrast: "Contrast",
    "tap-target": "Tap target",
    overflow: "Overflow",
    "image-alt": "Image text",
    "heading-order": "Headings",
    "font-fallback": "Font fallback",
    "missing-viewport": "Viewport",
    "missing-pid": "Missing data-pid",
    "focus-visible": "Focus style",
    "reduced-motion": "Reduced motion",
    "missing-lang": "Page language",
    "missing-main": "Main landmark",
    "missing-label": "Missing label",
    "input-zoom": "Input zoom on phones",
};

/** The pins of a report: a finding that names an element (a `data-pid` or a selector), numbered by its place in the list. */
export function pinsOfReport(report, focus = null) {
    return (report?.findings ?? []).flatMap((finding, index) =>
        finding.pid || finding.selector
            ? [
                  {
                      ...(finding.pid ? { pid: finding.pid } : {}),
                      selector: finding.selector || `[data-pid="${finding.pid}"]`,
                      label: index + 1,
                      // The one that a person tapped in the list comes into view in the page.
                      ...(focus !== null && focus.number === index + 1 ? { reveal: true } : {}),
                  },
              ]
            : [],
    );
}

export function createCheck(env, DockHead) {
    const { pocket, store, systemData } = env;
    const { html, useEffect, useRef, useState } = pocket;
    const { Ico, Segmented } = env.parts;

    function Finding({ finding, number, focused }) {
        const [copied, setCopied] = useState(false);
        const placed = Boolean(finding.pid || finding.selector);

        const show = () => {
            if (placed) {
                env.focusFinding(number);
            }
        };

        return html`<li
            class=${`dsy-finding ${finding.level} ${focused ? "on" : ""} ${placed ? "placed" : ""}`}
            onClick=${show}
        >
            ${
                placed
                    ? html`<button
                          type="button"
                          class="dsn-pin dsy-pin-button"
                          aria-label=${`Show finding ${number} on the page`}
                          aria-pressed=${focused}
                          onClick=${(event) => {
                              event.stopPropagation();
                              show();
                          }}
                      >
                          ${number}
                      </button>`
                    : html`<span class="dsn-pin off" aria-hidden="true">·</span>`
            }
            <div class="dsy-finding-body">
                <div class="dsy-finding-head">
                    <strong>${RULES[finding.rule] ?? finding.rule}</strong>
                    <span class=${`dsy-tag ${finding.level === "error" ? "bad" : "warn"}`}
                        >${finding.level}</span
                    >
                </div>
                <p>${finding.message}</p>
                ${
                    (finding.value || finding.suggestion) &&
                    html`<p class="dsy-fix mono">
                        ${finding.value && html`<span class="dsy-from">${finding.value}</span>`}
                        ${finding.value && finding.suggestion && html`<span class="dsy-arrow">→</span>`}
                        ${
                            finding.suggestion &&
                            html`<button
                                type="button"
                                class="dsy-chip"
                                title="Copy"
                                onClick=${async (event) => {
                                    event.stopPropagation();

                                    try {
                                        await navigator.clipboard.writeText(finding.suggestion);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1200);
                                    } catch {
                                        // The clipboard is not there: the text is still on the screen.
                                    }
                                }}
                            >
                                ${copied ? "copied" : finding.suggestion}
                            </button>`
                        }
                    </p>`
                }
                ${
                    (finding.selector || finding.pid) &&
                    html`<div class="muted small mono dsy-finding-target">
                        ${finding.pid ? `data-pid="${finding.pid}"` : finding.selector}
                    </div>`
                }
            </div>
        </li>`;
    }

    function CheckDock({ s, design, shown, canEdit, shut = false }) {
        const options = checkOptions(s, env.canvasDark(s));
        const key = checkKey(design.id, shown, options.mode, options.size);
        const entry = s.checks[key];
        const report = entry?.report;
        const [filter, setFilter] = useState("all");
        const findings = (report?.findings ?? []).map((finding, index) => ({
            finding,
            number: index + 1,
        }));
        const shownFindings = findings.filter(
            ({ finding }) => filter === "all" || finding.level === filter,
        );
        const running = entry?.status === "running";
        const name = s.system.data?.name;

        // The design system is read for the line that says what was checked against.
        useEffect(() => {
            if (s.system.status === "idle") {
                void systemData.load({ quiet: true });
            }
        }, []);

        // The findings that one tap can fix: a value that is exactly a token's (`fixable`, from the server).
        const exact = findings.filter(({ finding }) => finding.fixable === true).length;
        const [fixing, setFixing] = useState(false);

        // A new version with each of them written as the token, then the check of that version.
        const fix = async () => {
            setFixing(true);

            const made = await systemData.fix({
                artifact: design.id,
                version: shown,
                mode: options.named ? options.mode : undefined,
                scheme: options.scheme,
                size: options.size,
            });

            setFixing(false);

            if (made) {
                env.showVersion(null);
                void systemData.check({
                    artifact: design.id,
                    version: made.version,
                    mode: options.named ? options.mode : undefined,
                    scheme: options.scheme,
                    size: options.size,
                });
            }
        };

        const run = (now = options) =>
            void systemData.check({
                artifact: design.id,
                version: shown,
                mode: now.named ? now.mode : undefined,
                scheme: now.scheme,
                size: now.size,
            });

        // The mode on the canvas changes while the dock is open (the app's scheme, or the mode in the System view): a check
        // that was made is made again for the new mode, unless the person chose a mode of their own, or it is already there.
        const before = useRef(options.seen);

        useEffect(() => {
            const was = before.current;

            before.current = options.seen;

            if (was === options.seen || !options.following || !canEdit || running) {
                return;
            }

            const made = Object.keys(s.checks).some((each) =>
                each.startsWith(`${design.id}@${shown}:`),
            );

            if (made && s.checks[key] === undefined) {
                run();
            }
        }, [options.seen]);

        const send = () => {
            env.sendToBox(
                checkMessage({
                    title: design.title,
                    id: design.id,
                    version: shown,
                    mode: options.mode,
                    size: options.size,
                    findings: shownFindings.map((each) => each.finding),
                }),
            );
        };

        // The finding that a tap on its pin opens comes into view in the list.
        useEffect(() => {
            if (!shut && s.checkFocus !== null) {
                requestAnimationFrame(() =>
                    document
                        .querySelector(".dsn-dock .dsy-finding.on")
                        ?.scrollIntoView({ block: "nearest" }),
                );
            }
        }, [s.checkFocus?.at, shut]);

        // On a phone the findings start as a bar at the foot, so that the page keeps the room: the count of findings (by level),
        // and the one tap that can fix some. A tap on the bar opens the sheet.
        if (shut) {
            const errors = report?.summary.errors ?? 0;
            const warnings = report?.summary.warnings ?? 0;
            const words = running
                ? "Checking…"
                : entry?.status === "failed"
                  ? "The check failed"
                  : report
                    ? findings.length === 0
                        ? "Nothing to fix"
                        : `${findings.length} finding${findings.length === 1 ? "" : "s"}`
                    : "Not checked yet";

            return html`<div class="dsy-check-bar">
                <button
                    type="button"
                    class="dsy-check-bar-main"
                    aria-label=${`${words}. Open the findings.`}
                    onClick=${() => store.set({ checkSheet: 1 })}
                >
                    <${Ico} name="shield" size=${16} />
                    <strong>${words}</strong>
                    ${errors > 0 && html`<span class="dsy-tag bad">${errors} error${errors === 1 ? "" : "s"}</span>`}
                    ${warnings > 0 && html`<span class="dsy-tag warn">${warnings} warning${warnings === 1 ? "" : "s"}</span>`}
                    <span class="grow"></span>
                    <span class="dsy-check-bar-up"><${Ico} name="down" size=${16} /></span>
                </button>
                ${
                    canEdit &&
                    report &&
                    exact > 0 &&
                    html`<button
                        type="button"
                        class="button small"
                        disabled=${fixing || running}
                        title=${`Fix ${exact} exact match${exact === 1 ? "" : "es"}: a value that is exactly a token's becomes the token`}
                        onClick=${fix}
                    >
                        ${fixing ? "Fixing…" : `Fix ${exact}`}
                    </button>`
                }
                ${
                    canEdit &&
                    !report &&
                    entry?.status !== "running" &&
                    html`<button type="button" class="button small" onClick=${() => run()}>
                        Run the check
                    </button>`
                }
            </div>`;
        }

        return html`<${DockHead}
                title="Check"
                count=${report ? report.summary.errors + report.summary.warnings : 0}
            />
            <div class="dsn-dock-body">
                <div class="dsy-sr" role="status" aria-live="polite" aria-atomic="true">
                    ${
                        running
                            ? `Checking version ${shown}`
                            : report
                              ? `Checked version ${shown}: ${report.summary.errors} errors and ${report.summary.warnings} warnings.`
                              : entry?.status === "failed"
                                ? entry.error
                                : ""
                    }
                </div>
                <div class="dsy-check-options">
                    ${
                        options.modes.length > 4
                            ? html`<select
                                  class="dsy-modeselect dsy-check-mode"
                                  aria-label="Mode"
                                  value=${options.mode}
                                  onChange=${(event) =>
                                      store.set({
                                          checkWith: {
                                              ...s.checkWith,
                                              mode: event.currentTarget.value,
                                          },
                                      })}
                              >
                                  ${options.modes.map((mode) => html`<option value=${mode}>${titleOf(mode)}</option>`)}
                              </select>`
                            : html`<${Segmented}
                                  label="Mode"
                                  value=${options.mode}
                                  iconOnly=${env.sizeClass(s) === "narrow"}
                                  onChange=${(mode) =>
                                      store.set({ checkWith: { ...s.checkWith, mode } })}
                                  options=${options.modes.map((mode) => ({
                                      value: mode,
                                      label: titleOf(mode),
                                      icon: MODE_ICONS[mode] ?? "contrast",
                                  }))}
                              />`
                    }
                    <${Segmented}
                        label="Size"
                        value=${options.size}
                        onChange=${(size) => store.set({ checkWith: { ...s.checkWith, size } })}
                        options=${[
                            { value: "mobile", label: "Phone", icon: "phone" },
                            { value: "tablet", label: "Tablet", icon: "tablet" },
                            { value: "desktop", label: "Desktop", icon: "monitor" },
                        ]}
                    />
                </div>
                ${
                    options.mode !== options.seen &&
                    html`<p class="dsn-note muted small">
                        ${`The canvas shows this page in ${options.seen} mode. The pins are for the ${options.mode} check, so some sit on colors you cannot see here.`}
                        <button
                            type="button"
                            class="dsn-link"
                            onClick=${() => store.set({ checkWith: { ...s.checkWith, mode: null } })}
                        >
                            Follow the canvas
                        </button>
                    </p>`
                }
                ${
                    entry === undefined &&
                    html`<div class="dsn-empty">
                        <p class="muted small">
                            ${name ? `Check this version against ${name}: ` : "Check this version: "}colors,
                            fonts, and sizes that are not in the system, contrast, tap targets,
                            overflow, alt text, and headings. The page is drawn on the server, and
                            each finding gets a pin on the canvas.
                        </p>
                    </div>`
                }
                ${
                    running &&
                    html`<div class="dsy-checking">
                        <${pocket.Spinner} label="Checking" />
                        <span>Checking version ${shown}…</span>
                    </div>`
                }
                ${entry?.status === "failed" && html`<p class="dsy-problem" role="alert">${entry.error}</p>`}
                ${
                    report &&
                    html`<div class="dsy-check-summary">
                            ${
                                findings.length > 0
                                    ? html`<div
                                          class="dsy-check-filter"
                                          role="group"
                                          aria-label="Show"
                                      >
                                          ${["all", "error", "warning"].map(
                                              (each) =>
                                                  html`<button
                                                      type="button"
                                                      key=${each}
                                                      class=${`${filter === each ? "on" : ""} ${each}`}
                                                      aria-pressed=${filter === each}
                                                      onClick=${() => setFilter(each)}
                                                  >
                                                      ${each === "all" ? "All" : each === "error" ? "Errors" : "Warnings"}
                                                      <span
                                                          >${each === "all" ? findings.length : findings.filter(({ finding }) => finding.level === each).length}</span
                                                      >
                                                  </button>`,
                                          )}
                                      </div>`
                                    : html`<span class="dsy-stat ok">0 errors, 0 warnings</span>`
                            }
                            <span class="grow"></span>
                            <span class="muted small"
                                >${`${report.summary.elements} elements`}</span
                            >
                        </div>
                        ${
                            report.withoutSystem &&
                            html`<p class="dsn-note muted small">
                                There is no design system, so only the page's own checks ran. With
                                one, colors, fonts, and sizes that are not its tokens are found too.
                            </p>`
                        }
                        ${
                            canEdit &&
                            exact > 0 &&
                            html`<div class="dsy-fixbar">
                                <span class="muted small"
                                    >${`${exact === 1 ? "One finding is" : `${exact} findings are`} a value that is exactly a token's: it can be the token itself.`}</span
                                >
                                <button
                                    type="button"
                                    class="button small"
                                    disabled=${fixing || running}
                                    onClick=${fix}
                                >
                                    <${Ico} name="sparkle" size=${14} />
                                    ${fixing ? "Fixing…" : `Fix ${exact} exact match${exact === 1 ? "" : "es"}`}
                                </button>
                            </div>`
                        }
                        ${
                            findings.length === 0 &&
                            html`<div class="dsy-clean">
                                <${Ico} name="check" size=${18} /> Nothing to fix in this version.
                            </div>`
                        }
                        <ul class="dsy-findings">
                            ${shownFindings.map(
                                ({ finding, number }) =>
                                    html`<${Finding}
                                        key=${number}
                                        finding=${finding}
                                        number=${number}
                                        focused=${s.checkFocus?.number === number}
                                    />`,
                            )}
                        </ul>`
                }
            </div>
            ${
                canEdit &&
                html`<footer class="dsn-dock-foot dsy-check-foot">
                    ${
                        report &&
                        shownFindings.length > 0 &&
                        html`<button type="button" class="button primary" onClick=${send}>
                            <${Ico} name="send" size=${15} /> Send ${shownFindings.length} to Pi
                        </button>`
                    }
                    <button type="button" class="button" disabled=${running} onClick=${() => run()}>
                        <${Ico} name="shield" size=${15} />
                        ${report ? "Check again" : "Run the check"}
                    </button>
                </footer>`
            }`;
    }

    return { CheckDock };
}
