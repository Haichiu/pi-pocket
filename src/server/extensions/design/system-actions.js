// What a person does in the System view, as functions of the store: open it, edit a token, undo and redo, fold a group,
// jump to a token, and ask Pi for what the view does not edit. They are added to the workspace's `env`.
import { systemRequest, tokenRequest } from "./messages.js";
import {
    editsOf,
    emptyHistory,
    groupsOf,
    guidelinesEdit,
    push,
    redo,
    sectionOf,
    tokenEdit,
    undo,
} from "./system.js";

const IDLE = { status: "idle", error: "", problems: [], note: "" };

export function createSystemActions(env, systemData) {
    const { store } = env;
    /** After a failed or finished save, the next edit starts clean. */
    const fresh = (s) => (s.save.status === "saving" ? s.save : IDLE);

    return {
        /** Show the System view in place of the design. */
        openSystem() {
            store.set({
                view: "system",
                mode: "view",
                dock: null,
                draft: null,
                present: false,
                compare: null,
                sysPane: "system",
            });
            void systemData.load({ quiet: store.get().system.status === "ready" });
        },

        /** Change one token in one mode to `raw`: `{ alias: "color.blue.500" }` or `{ value }`. */
        editToken(name, mode, raw) {
            store.set((s) => ({
                history: push(s.history, tokenEdit(mode, name, raw)),
                save: fresh(s),
            }));
        },

        editGuidelines(text) {
            store.set((s) => ({ history: push(s.history, guidelinesEdit(text)), save: fresh(s) }));
        },

        /** Put a token back as it is saved, in every mode (a step that undo can take back). */
        resetToken(name) {
            const { system, history } = store.get();
            const token = system.data?.tokens.find((each) => each.name === name);

            if (token === undefined) {
                return;
            }

            let next = history;

            for (const [, op] of editsOf(history)) {
                if (op.kind === "token" && op.token === name) {
                    const saved = token.modes[op.mode];
                    const raw =
                        saved.alias === undefined ? { value: saved.value } : { alias: saved.alias };

                    next = push(next, tokenEdit(op.mode, name, raw), Date.now(), false);
                }
            }

            store.set({ history: next });
        },

        /** A mode takes the default mode's value of a token. */
        matchDefault(name, mode) {
            const token = store.get().system.data?.tokens.find((each) => each.name === name);
            const base = token?.modes[store.get().system.data.modes[0]];

            if (base !== undefined) {
                env.editToken(
                    name,
                    mode,
                    base.alias === undefined ? { value: base.value } : { alias: base.alias },
                );
            }
        },

        undo() {
            store.set((s) => ({ history: undo(s.history), save: fresh(s) }));
        },

        redo() {
            store.set((s) => ({ history: redo(s.history), save: fresh(s) }));
        },

        /** Give up the unsaved edits. */
        discard() {
            store.set((s) => ({ history: emptyHistory(), save: fresh(s), sysWriting: false }));
        },

        setSysMode(sysMode) {
            store.set({ sysMode });
        },

        setSection(sysSection) {
            store.set({ sysSection, sysOpen: null });
        },

        toggleToken(name) {
            store.set((s) => ({ sysOpen: s.sysOpen === name ? null : name }));
        },

        toggleGroup(id) {
            store.set((s) => ({ sysFolded: { ...s.sysFolded, [id]: !s.sysFolded[id] } }));
        },

        /** Go to a token: its section, its group unfolded, its editor open, in view. */
        openToken(name) {
            const system = store.get().system.data;
            const token = system?.tokens.find((each) => each.name === name);

            if (token === undefined) {
                return;
            }

            const section = sectionOf(token);
            const group = groupsOf(system.tokens, section, system.modes[0]).find((each) =>
                each.tokens.some((other) => other.name === name),
            );

            store.set((s) => ({
                view: "system",
                sysSection: section,
                sysOpen: name,
                sysQuery: "",
                sysPane: "system",
                sysFolded: group ? { ...s.sysFolded, [group.id]: false } : s.sysFolded,
            }));

            // After the section has drawn.
            requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                    document
                        .querySelector(`.dsy-scroll [data-token="${CSS.escape(name)}"]`)
                        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
                ),
            );
        },

        /** A request to Pi about the system as a whole, in the message box. */
        askPi(kind) {
            env.sendToBox(systemRequest(kind));
        },

        /** A request to Pi to change one token that the view does not edit. */
        askPiAbout(token) {
            env.sendToBox(
                tokenRequest({
                    token,
                    values: Object.fromEntries(
                        Object.entries(token.modes).map(([mode, each]) => [mode, each.value]),
                    ),
                }),
            );
        },
    };
}
