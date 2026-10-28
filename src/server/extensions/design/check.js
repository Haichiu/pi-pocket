// The Check dock: a design checked against the design system (and the page's own basics: contrast, tap targets, overflow,
// alt text, headings). The server renders the page and walks it; this lists what it found, pins each finding to its element
// on the canvas, and puts one message with all of them in the message box for Pi.
import { checkMessage } from "./messages.js";
import { checkKey } from "./system-data.js";

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
export function pinsOfReport(report) {
    return (report?.findings ?? []).flatMap((finding, index) =>
        finding.pid || finding.selector
            ? [
                  {
                      ...(finding.pid ? { pid: finding.pid } : {}),
                      selector: finding.selector || `[data-pid="${finding.pid}"]`,
                      label: index + 1,
                  },
              ]
            : [],
    );
}

export function createCheck(env, DockHead) {
    const { pocket, store, systemData } = env;
    const { html, useEffect, useState } = pocket;
    const { Ico, Segmented } = env.parts;

    function Finding({ finding, number }) {
        const [copied, setCopied] = useState(false);

        return html`<li class=${`dsy-finding ${finding.level}`}>
            <span
                class=${`dsn-pin ${finding.pid || finding.selector ? "" : "off"}`}
                aria-hidden="true"
                >${finding.pid || finding.selector ? number : "·"}</span
            >
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
                                onClick=${async () => {
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
        const options = s.checkWith;
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
            void systemData.check({ artifact: design.id, version: shown, ...options });

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
                <div class="dsy-check-options">
                    <${Segmented}
                        label="Color scheme"
                        value=${options.scheme}
                        onChange=${(scheme) => store.set({ checkWith: { ...options, scheme } })}
                        options=${[
                            { value: "light", label: "Light", icon: "sun" },
                            { value: "dark", label: "Dark", icon: "moon" },
                        ]}
                    />
                    <${Segmented}
                        label="Size"
                        value=${options.size}
                        onChange=${(size) => store.set({ checkWith: { ...options, size } })}
                        options=${[
                            { value: "mobile", label: "Phone", icon: "phone" },
                            { value: "tablet", label: "Tablet", icon: "tablet" },
                            { value: "desktop", label: "Desktop", icon: "monitor" },
                        ]}
                    />
                </div>
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
                            <span class=${`dsy-stat ${report.summary.errors > 0 ? "bad" : "ok"}`}>
                                <strong>${report.summary.errors}</strong
                                >${` error${report.summary.errors === 1 ? "" : "s"}`}
                            </span>
                            <span
                                class=${`dsy-stat ${report.summary.warnings > 0 ? "warn" : "ok"}`}
                            >
                                <strong>${report.summary.warnings}</strong
                                >${` warning${report.summary.warnings === 1 ? "" : "s"}`}
                            </span>
                            <span class="muted small">${report.summary.elements} elements</span>
                        </div>
                        ${
                            report.withoutSystem &&
                            html`<p class="dsn-note muted small">
                                There is no design system, so only the page's own checks ran. With
                                one, colors, fonts, and sizes that are not its tokens are found too.
                            </p>`
                        }
                        ${
                            findings.length > 0 &&
                            html`<div class="dsy-check-filter" role="group" aria-label="Show">
                                ${["all", "error", "warning"].map(
                                    (each) =>
                                        html`<button
                                            type="button"
                                            key=${each}
                                            class=${filter === each ? "on" : ""}
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
                        }
                        ${
                            findings.length === 0 &&
                            html`<div class="dsy-clean">
                                <${Ico} name="check" size=${18} /> Nothing to fix in this version.
                            </div>`
                        }
                        <ul class="dsy-findings">
                            ${shownFindings.map(({ finding, number }) => html`<${Finding} key=${number} finding=${finding} number=${number} />`)}
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
