// Background processes' browser module, for the owner: a status item in a session that left processes running, a menu
// row and a launcher action with how many there are in all, the sheet that lists them by session to stop, and a notice
// when an archived session leaves some running. It uses only `pocket`.
export const pocketApi = 1;

/** Lucide's server icon. */
const ICON = "M2 4h20v6H2z M2 14h20v6H2z M6 7h.01 M6 17h.01";

/** "3 days", "5 hours", "12 minutes", "a moment": how long since `at`. */
function age(at) {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));

    if (minutes < 1) {
        return "a moment";
    }

    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 48) {
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }

    return `${Math.round(hours / 24)} days`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "es"}`;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    let counts = { supported: true, bySession: {}, untracked: 0 };
    let shown = null;
    let status = null;
    let gone = false;

    const total = () =>
        Object.values(counts.bySession).reduce((sum, count) => sum + count, 0) + counts.untracked;

    const menu = pocket.menu({
        id: "processes",
        label: "Background processes",
        run: () => pocket.openSheet("processes", { session: shown }),
    });
    const launcher = pocket.launcher({
        id: "processes",
        label: "Background processes",
        detail: "What sessions started and left running",
        iconPath: ICON,
        keywords: ["process", "server", "running", "port", "kill", "stop", "background"],
        run: () => pocket.openSheet("processes", { session: shown }),
    });

    const publish = () => {
        if (gone) {
            return;
        }

        const all = total();

        menu.update({ hint: all > 0 ? String(all) : undefined });
        launcher.update({
            detail:
                all > 0
                    ? `${plural(all, "process")} left running`
                    : "What sessions started and left running",
        });

        const here = shown === null ? 0 : (counts.bySession[shown] ?? 0);

        if (here === 0 || typeof pocket.status !== "function") {
            status?.remove();
            status = null;

            return;
        }

        const item = {
            id: "processes",
            text: `${here} in background`,
            short: `${here} bg`,
            title: `This session left ${plural(here, "process")} running: tap to see ${here === 1 ? "it" : "them"}`,
            label: "Background processes",
            run: () => pocket.openSheet("processes", { session: shown }),
        };

        if (status === null) {
            status = pocket.status(item);
        } else {
            status.update(item);
        }
    };

    const refresh = () =>
        pocket.api("counts").then(
            (next) => {
                counts = next;
                publish();
            },
            () => {},
        );

    pocket.on("counts", (next) => {
        counts = next;
        publish();
    });
    pocket.on("left", ({ count }) =>
        pocket.notify(
            "warning",
            `The session you archived left ${plural(count, "process")} running: Menu → Background processes.`,
        ),
    );
    pocket.onDispose(() => {
        gone = true;
    });

    if (typeof pocket.onConversation === "function") {
        pocket.onConversation((id) => {
            shown = id;
            publish();
        });
    } else {
        shown = pocket.conversationId();
    }

    refresh();

    function JobCard({ job, onStopped }) {
        const [asking, setAsking] = useState(false);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);

        useEffect(() => {
            if (!asking) {
                return undefined;
            }

            const timer = setTimeout(() => setAsking(false), 4000);

            return () => clearTimeout(timer);
        }, [asking]);

        const stop = async () => {
            if (!asking) {
                setAsking(true);

                return;
            }

            setBusy(true);
            setError(null);

            try {
                const { left } = await pocket.api("stop", {
                    processes: job.processes.map(({ pid, startedAt }) => ({ pid, startedAt })),
                });

                if (left > 0) {
                    setError(`${plural(left, "process")} did not stop.`);
                }

                onStopped();
            } catch (failed) {
                setError(failed.message);
            } finally {
                setBusy(false);
                setAsking(false);
            }
        };

        const meta = [
            `running ${age(job.startedAt)}`,
            job.ports.length > 0 &&
                `port${job.ports.length === 1 ? "" : "s"} ${job.ports.join(", ")}`,
            job.processes.length > 1 && plural(job.processes.length, "process"),
        ].filter(Boolean);

        return html`<div class="bg-job">
            <div class="bg-command mono" title=${job.command}>
                ${job.command || "(no command line)"}
            </div>
            <div class="muted small">${meta.join(" · ")}</div>
            ${job.cwd && html`<div class="muted small mono bg-cwd" title=${job.cwd}>${job.cwd}</div>`}
            ${error && html`<div class="error-box">${error}</div>`}
            <div class="bg-actions">
                <button
                    class=${`button ${asking ? "bg-confirm" : ""}`}
                    disabled=${busy}
                    onClick=${stop}
                >
                    ${busy ? "Stopping…" : asking ? "Tap again to stop" : "Stop"}
                </button>
            </div>
        </div>`;
    }

    function Processes({ session, close }) {
        const [list, setList] = useState(null);
        const [error, setError] = useState(null);

        const load = () =>
            pocket.api("list").then(
                (next) => {
                    setList(next);
                    setError(null);
                    refresh();
                },
                (failed) => setError(failed.message),
            );

        useEffect(() => {
            load();
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>`;
        }

        if (list === null) {
            return html`<${pocket.Loader} label="Looking for processes" />`;
        }

        if (!list.supported) {
            return html`<p class="muted">
                Pi Pocket finds background processes on Linux only, for now.
            </p>`;
        }

        // By session: the one this sheet opened from first, then the others, and those from before the tag last.
        const groups = new Map();

        for (const job of list.jobs) {
            const key = job.session ?? "untracked";

            groups.set(key, [...(groups.get(key) ?? []), job]);
        }

        const order = [...groups.keys()].sort((a, b) =>
            a === session
                ? -1
                : b === session
                  ? 1
                  : a === "untracked"
                    ? 1
                    : b === "untracked"
                      ? -1
                      : groups.get(b).length - groups.get(a).length,
        );

        return html`<div class="bg-sheet">
            <p class="muted small">
                Programs that sessions' commands started and that still run after those commands
                ended: dev servers, watchers, anything sent to the background. Stop asks a process
                to end, and ends it by force a few seconds later if it does not.
            </p>
            ${
                order.length === 0 &&
                html`<div class="bg-empty">Nothing is running in the background.</div>`
            }
            ${order.map((key) => {
                const jobs = groups.get(key);
                const first = jobs[0];
                const name =
                    key === "untracked"
                        ? "Started before Pi Pocket kept track of sessions"
                        : first.title !== undefined
                          ? `${first.title || "New session"}${first.archived ? " (archived)" : ""}`
                          : "A session that is gone";

                return html`<section class="bg-group" key=${key}>
                    <div class="bg-head">
                        <div class="bg-title">${name}</div>
                        ${
                            key !== "untracked" &&
                            first.title !== undefined &&
                            key !== session &&
                            html`<button
                                class="button bg-open"
                                onClick=${() => {
                                    close();
                                    pocket.openConversation(key);
                                }}
                            >
                                Open
                            </button>`
                        }
                    </div>
                    ${jobs.map((job) => html`<${JobCard} key=${job.key} job=${job} onStopped=${load} />`)}
                </section>`;
            })}
            <div class="bg-actions">
                <button class="button" onClick=${load}>Look again</button>
            </div>
        </div>`;
    }

    pocket.sheet({ id: "processes", title: "Background processes", component: Processes });
    pocket.style("style.css");
}
