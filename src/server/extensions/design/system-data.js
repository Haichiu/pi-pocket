// What the System view asks of the server, and keeps in the store: the design system, a save of the person's edits, a
// check of a design against it, the documentation page, and the files for code.
import { downloadFile } from "./data.js";
import { changeOf } from "./system.js";
import { emptyHistory } from "./system.js";

/** The key a check is kept under: the design's version, and the color scheme and size it ran at. */
export const checkKey = (artifact, version, scheme, size) =>
    `${artifact}@${version}:${scheme}:${size}`;

export function createSystemData(pocket, store, data) {
    const conversationOf = () => store.get().conversation;
    const current = (conversation) => store.get().conversation === conversation;
    const fail = (error) => pocket.notify("error", `Design system: ${error?.message ?? error}`);
    let reading = 0;
    let noteTimer = 0;

    const note = (text) => {
        clearTimeout(noteTimer);
        store.set({ save: { status: "saved", error: "", problems: [], note: text } });
        noteTimer = setTimeout(() => {
            if (store.get().save.status === "saved") {
                store.set({ save: { status: "idle", error: "", problems: [], note: "" } });
            }
        }, 4000);
    };

    /** The system the server sent: shown, with the unsaved edits kept. */
    const took = (result, extra = {}) =>
        store.set({
            system: {
                status: "ready",
                data: result.system ?? null,
                legacy: result.legacy ?? null,
                error: "",
            },
            ...extra,
        });

    const api = {
        /**
         * Read the system. `quiet` asks only whether it changed (the server answers `unchanged` for the revision this tab has),
         * and shows nothing while it waits: for the timer and for events.
         */
        async load({ quiet = false } = {}) {
            const conversation = conversationOf();

            if (conversation === null) {
                return;
            }

            const mine = ++reading;
            const have = store.get().system;
            const revision = have.data?.revision;

            if (!quiet || have.status === "idle") {
                store.set({
                    system: { ...have, status: have.data ? "ready" : "loading", error: "" },
                });
            }

            try {
                const result = await pocket.api(
                    `c/${conversation}/system${quiet && revision ? `?revision=${encodeURIComponent(revision)}` : ""}`,
                );

                if (!current(conversation) || mine !== reading) {
                    return;
                }

                if (result.unchanged) {
                    if (have.status !== "ready") {
                        store.set({ system: { ...store.get().system, status: "ready" } });
                    }

                    return;
                }

                took(result);
            } catch (error) {
                if (current(conversation) && mine === reading) {
                    store.set({
                        system: {
                            ...store.get().system,
                            status: store.get().system.data ? "ready" : "failed",
                            error: error?.message ?? "The design system could not be read.",
                        },
                    });
                }
            }
        },

        /** Save the unsaved edits. Resolves to whether they were saved. */
        async save() {
            const state = store.get();
            const conversation = state.conversation;
            const system = state.system.data;

            if (!system || state.save.status === "saving") {
                return false;
            }

            const { set, guidelines, count } = changeOf(system, state.history);

            if (count === 0) {
                store.set({ history: emptyHistory() });

                return true;
            }

            store.set({ save: { status: "saving", error: "", problems: [], note: "" } });

            try {
                const result = await pocket.api(`c/${conversation}/system`, {
                    ...(set.length > 0 ? { set } : {}),
                    ...(guidelines === undefined ? {} : { guidelines }),
                    baseRevision: system.revision,
                });

                if (!current(conversation)) {
                    return false;
                }

                if (!result.ok) {
                    store.set({
                        save: {
                            status: "failed",
                            error: result.error ?? "The save failed.",
                            problems: result.problems ?? [],
                            note: "",
                        },
                    });

                    return false;
                }

                took(result, { history: emptyHistory(), sysWriting: false });
                note(`Saved ${count} change${count === 1 ? "" : "s"}`);

                return true;
            } catch (error) {
                if (current(conversation)) {
                    store.set({
                        save: {
                            status: error?.status === 409 ? "conflict" : "failed",
                            error: error?.message ?? "The save failed.",
                            problems: [],
                            note: "",
                        },
                    });
                }

                return false;
            }
        },

        /** After a conflict: read the system again, and keep the edits. */
        async reload() {
            store.set({ save: { status: "idle", error: "", problems: [], note: "" } });
            await api.load();
        },

        /** Add a mode (`{}`), or remove one (`null`): the edits to a removed mode go with it. */
        async changeModes(name, value) {
            const conversation = conversationOf();
            const system = store.get().system.data;

            try {
                const result = await pocket.api(`c/${conversation}/system`, {
                    modes: { [name]: value },
                    baseRevision: system?.revision,
                });

                if (!current(conversation)) {
                    return false;
                }

                if (!result.ok) {
                    fail(new Error(result.error));

                    return false;
                }

                took(result, {
                    history:
                        value === null
                            ? {
                                  past: store.get().history.past.filter((op) => op.mode !== name),
                                  future: [],
                              }
                            : store.get().history,
                    sysMode: store.get().sysMode === name ? null : store.get().sysMode,
                });
                note(value === null ? `Removed ${name}` : `Added the ${name} mode`);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },

        /** Check a design against the system (it renders the page on the server). */
        async check({ artifact, version, scheme, size }) {
            const conversation = conversationOf();
            const key = checkKey(artifact, version, scheme, size);
            const put = (value) => store.set((s) => ({ checks: { ...s.checks, [key]: value } }));

            put({ status: "running" });

            try {
                const result = await pocket.api(`c/${conversation}/system/check`, {
                    id: artifact,
                    version,
                    colorScheme: scheme,
                    viewport: size,
                });

                if (current(conversation)) {
                    put({ status: "done", report: result.report, at: Date.now() });
                }
            } catch (error) {
                if (current(conversation)) {
                    put({ status: "failed", error: error?.message ?? "The check failed." });
                }
            }
        },

        /** Publish the documentation page as a design. Resolves to `{ id, version }`, or null. */
        async publishDocs() {
            const conversation = conversationOf();

            try {
                const made = await pocket.api(`c/${conversation}/system/docs`, {
                    key: crypto.randomUUID(),
                });

                await data.list();

                return made;
            } catch (error) {
                fail(error);

                return null;
            }
        },

        /** Make the zip of the generated files, and save it. */
        async exportCode() {
            const conversation = conversationOf();

            try {
                const made = await pocket.api(`c/${conversation}/system/export`, {});

                downloadFile(conversation, made);
                pocket.notify("info", `Saved ${made.name}. It is also at ${made.path}`);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },
    };

    return api;
}
