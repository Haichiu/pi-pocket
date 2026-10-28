// Design's browser module: a canvas beside the chat for interactive designs. It adds a wide panel (a rail button, the
// places, the launcher, and the artifact viewer's "Open in Design" button open it), and keeps the workspace's state in one
// store made here, so going back to the chat on a phone and coming again leaves the canvas as it was.
//
// This file is all that the app loads when it starts, on every phone and for everyone, whether Design is ever opened: the
// store, what registers the panel, the rail button, the launcher and the command, and a short loading state. The workspace
// (`app.js`) loads when the panel first opens; the docks, the compare and variation views, and the System view load again
// when a person first needs them (`workspace.js`). `test/design-system-ui.test.ts` holds the budget.
import { DESIGN_PATH } from "./paths.js";
import { createStore, initialState, loadPick, savePrefs, sessionState } from "./state.js";

export const pocketApi = 1;

export default function setup(pocket) {
    if (typeof pocket.panel !== "function") {
        // An app from before panels (0.19.0): nothing to add.
        return undefined;
    }

    const store = createStore({
        ...initialState(),
        appDark: document.documentElement.dataset.mode !== "light",
    });

    // The app's theme changes the page in the canvas (it follows it): the store says so.
    const watchTheme = new MutationObserver(() => {
        const appDark = document.documentElement.dataset.mode !== "light";

        if (store.get().appDark !== appDark) {
            store.set({ appDark });
        }
    });

    watchTheme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-mode"],
    });

    /** A stylesheet of the module, loaded when it is first needed: it resolves once the rules apply (or after a moment). */
    const styled = new Map();

    const style = (name) => {
        if (!styled.has(name)) {
            const before = new Set(document.head.querySelectorAll("style[data-extension]"));

            pocket.style(name);

            const sheet = [...document.head.querySelectorAll("style[data-extension]")].find(
                (each) => !before.has(each),
            );

            styled.set(
                name,
                new Promise((resolve) => {
                    const until = performance.now() + 2500;

                    const look = () => {
                        // The `@import` of the sheet has its rules once its file is in.
                        const imported = sheet?.sheet?.cssRules?.[0]?.styleSheet;

                        if (!sheet || imported || performance.now() > until) {
                            resolve();
                        } else {
                            requestAnimationFrame(look);
                        }
                    };

                    look();
                }),
            );
        }

        return styled.get(name);
    };

    // The workspace, once the panel has been opened: a promise of `{ Workspace, data, systemData, stop }`.
    let loading = null;
    let ready = null;

    const load = () => {
        loading ??= Promise.all([import("./app.js"), style("style.css")]).then(([module]) => {
            ready = module.createApp(pocket, store, { style });

            // The session that the tab shows: its designs.
            if (store.get().conversation !== null) {
                void ready.data.list();
            }

            return ready;
        });

        return loading;
    };

    function Panel() {
        const { useEffect, useState, html } = pocket;
        const [workspace, setWorkspace] = useState(ready);
        const [failed, setFailed] = useState(null);

        useEffect(() => {
            if (workspace === null) {
                load().then(setWorkspace, (error) => {
                    loading = null;
                    setFailed(error);
                });
            }
        }, []);

        if (failed) {
            return html`<div class="dsn-load-failed">
                <p>Design did not load.</p>
                <p class="muted small">${String(failed?.message ?? failed)}</p>
                <button
                    type="button"
                    class="button"
                    onClick=${() => {
                        setFailed(null);
                        load().then(setWorkspace, (error) => {
                            loading = null;
                            setFailed(error);
                        });
                    }}
                >
                    Try again
                </button>
            </div>`;
        }

        return workspace
            ? html`<${workspace.Workspace} />`
            : html`<${pocket.Loader} label="Opening Design" />`;
    }

    // Focus mode is a mark on the page that the module's stylesheet reads: the conversation goes, the panel grows.
    let focused = false;
    const stopFocus = store.subscribe((s) => {
        if (s.focus !== focused) {
            focused = s.focus;
            document.documentElement.toggleAttribute("data-dsn-focus", focused);
        }
    });

    // How the canvas looks is kept in this browser.
    let looks = "";

    store.subscribe((s) => {
        const next = JSON.stringify([s.device, s.custom, s.zoom, s.backdrop]);

        if (next !== looks) {
            looks = next;
            savePrefs(s);
        }
    });

    // The session the tab shows: its designs, and the one this tab had open there.
    const stopConversation = pocket.onConversation((id) => {
        if (id === store.get().conversation) {
            return;
        }

        const pick = id === null ? null : loadPick(id);

        store.set({
            ...sessionState(),
            conversation: id,
            artifact: pick?.artifact ?? null,
            version: pick?.version ?? null,
        });

        // (until the panel has been opened, nobody asks for the designs)
        if (id !== null && ready !== null) {
            void ready.data.list();
        }
    });

    // Someone else commented: read the comments again.
    const stopComments = pocket.on("comments", (event) => {
        const s = store.get();

        if (
            ready !== null &&
            event?.conversation === s.conversation &&
            s.notes[event.artifact]?.loaded
        ) {
            void ready.data.notes(event.artifact);
        }
    });

    const ask = (artifact, version, system = false) => {
        store.set({
            wanted: { artifact: String(artifact ?? ""), version: version ?? null, system },
        });
        pocket.openPanel("design");
    };

    // `/design-open [artifact | system]`, run on the server, asks this tab to open the panel; `system` is the design system.
    const stopOpen = pocket.on("open", (event) => {
        if (event?.conversation === store.get().conversation) {
            const word = String(event.artifact ?? "")
                .trim()
                .toLowerCase();

            ask(event.artifact, null, word === "system");
        }
    });

    // Someone saved the design system (or Pi did, through a route): read it again if this tab has it.
    const stopSystem = pocket.on("system", (event) => {
        const s = store.get();

        if (
            ready !== null &&
            event?.conversation === s.conversation &&
            s.system.status !== "idle"
        ) {
            void ready.systemData.load({ quiet: true });
        }
    });

    // The artifact viewer's "Open in Design" button asks the same way (`web/sheets/viewers.js`).
    const onOpen = (event) => {
        store.set({
            wanted: {
                artifact: String(event.detail?.artifact ?? ""),
                version: event.detail?.version ?? null,
                system: false,
            },
        });
    };

    addEventListener("pocket:design-open", onOpen);

    pocket.panel({
        id: "design",
        title: "Design",
        iconPath: DESIGN_PATH,
        component: Panel,
        wide: true,
    });
    pocket.rail({ id: "design", title: "Design", iconPath: DESIGN_PATH, panel: "design" });
    pocket.launcher({
        id: "design",
        label: "Open Design",
        detail: "A canvas for prototypes, screens, and decks",
        iconPath: DESIGN_PATH,
        keywords: ["design", "canvas", "prototype", "mockup", "deck", "slides"],
        panel: "design",
    });
    pocket.launcher({
        id: "design-system",
        label: "Open the design system",
        detail: "Colors, type, spacing, and components of the project",
        icon: "palette",
        keywords: [
            "design",
            "system",
            "tokens",
            "colors",
            "type",
            "theme",
            "components",
            "palette",
        ],
        run: () => ask("", null, true),
    });

    return () => {
        removeEventListener("pocket:design-open", onOpen);
        document.documentElement.removeAttribute("data-dsn-focus");
        watchTheme.disconnect();
        ready?.stop();
        stopFocus();
        stopSystem();
        stopConversation();
        stopComments();
        stopOpen();
    };
}
