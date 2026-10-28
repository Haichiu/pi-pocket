// What the open design is told while the System view has edits or shows a mode: the custom properties that differ from what
// the design gets from the saved default mode. The store keeps it (`previewVars`), and the canvas sends it through the
// bridge, so the design shows the edits live whether or not the view is on the screen.
import { createModel, previewVars, tokenEdits } from "./system.js";

export function watchPreview(store) {
    let seen = {};
    let text = "{}";

    return store.subscribe((s) => {
        if (
            seen.data === s.system.data &&
            seen.history === s.history &&
            seen.view === s.view &&
            seen.mode === s.sysMode
        ) {
            return;
        }

        seen = { data: s.system.data, history: s.history, view: s.view, mode: s.sysMode };

        let vars = {};
        const data = s.system.data;

        // With the view on the screen: the mode in view (the default one for side by side). Without it: only the edits, in the
        // default mode, so a design that was left shows the unsaved changes until they are saved or given up.
        if (data && (s.view === "system" || s.history.past.length > 0)) {
            const mode =
                s.view === "system" && data.modes.includes(s.sysMode) ? s.sysMode : data.modes[0];

            vars = previewVars(createModel(data, tokenEdits(s.history)), mode);
        }

        const next = JSON.stringify(vars);

        if (next !== text) {
            text = next;
            store.set({ previewVars: vars });
        }
    });
}
