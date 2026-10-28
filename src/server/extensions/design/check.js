// The Check dock: a design checked against the design system (and the page's own basics: contrast, tap targets, overflow,
// alt text, headings). The server renders the page and walks it; this lists what it found, pins each finding to its element
// on the canvas, and puts one message with all of them in the message box for Pi.
import { exportViewport, sizeOf } from "./devices.js";
import { checkMessage } from "./messages.js";
import { resolveDevice } from "./state.js";
import { checkKey } from "./system-data.js";

/**
 * The options of a check as they are now: what the person chose, else what the canvas shows. `dark` is whether the app
 * is in a dark scheme (the page in the canvas follows it); `seen` is the scheme of the canvas, `scheme` the one checked.
 */
export function checkOptions(s, dark) {
    const device = resolveDevice(s.device, s.width);
    const seen = dark ? "dark" : "light";

    return {
        scheme: s.checkWith.scheme ?? seen,
        size: s.checkWith.size ?? exportViewport(device, sizeOf(device, s.custom)),
        seen,
    };
}

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
    const { html, useEffect, useState } = pocket;
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

    function CheckDock({ s, design, shown, canEdit }) {
        const options = checkOptions(s, env.darkTheme());
        const key = checkKey(design.id, shown, options.scheme, options.size);
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

        const run = () =>
            void systemData.check({
                artifact: design.id,
                version: shown,
                scheme: options.scheme,
                size: options.size,
            });

        const send = () => {
            env.sendToBox(
                checkMessage({
                    title: design.title,
                    id: design.id,
                    version: shown,
                    scheme: options.scheme,
                    size: options.size,
                    findings: shownFindings.map((each) => each.finding),
                }),
            );
        };

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
                    <${Segmented}
                        label="Color scheme"
                        value=${options.scheme}
                        onChange=${(scheme) => store.set({ checkWith: { ...s.checkWith, scheme } })}
                        options=${[
                            { value: "light", label: "Light", icon: "sun" },
                            { value: "dark", label: "Dark", icon: "moon" },
                        ]}
                    />
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
                    options.scheme !== options.seen &&
                    html`<p class="dsn-note muted small">
                        ${`The canvas shows this page in ${options.seen} mode. The pins are for the ${options.scheme} check, so some sit on colors you cannot see here.`}
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
                    <button type="button" class="button" disabled=${running} onClick=${run}>
                        <${Ico} name="shield" size=${15} />
                        ${report ? "Check again" : "Run the check"}
                    </button>
                </footer>`
            }`;
    }

    return { CheckDock };
}
