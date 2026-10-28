// The unsaved edits to the design system, for the parts of the workspace that are always there (the picker, the note over a
// design, the save). What they change is the System view's to work out (`changeOf` in `system.js`, which loads with the
// System view): edits are only made in it, so with none, which is the case until it has been open, nothing of it is
// needed and nothing is loaded.
let changer = null;

/** The System view says how it works out the change, when it loads. */
export function changeWith(change) {
    changer = change;
}

const NONE = { set: [], count: 0 };

/** The change to save, `{ set, remove?, guidelines?, count }`. */
export function changeNow(data, history) {
    return !data || history.past.length === 0 || changer === null ? NONE : changer(data, history);
}

/** The number of unsaved changes. */
export const unsavedOf = (data, history) => changeNow(data, history).count;
