// The System view's browser code, loaded when it is first opened (`workspace.js`) and not before: the view, its sections, its
// editor parts, the actions on a token, the model (`system.js`) with the colors and specimens it draws, and the stylesheet.
// Nothing of it is in what the app loads when it starts.
import { watchPreview } from "./system-preview.js";
import { changeOf } from "./system.js";
import { createSystemActions } from "./system-actions.js";
import { createSystemSections } from "./system-sections.js";
import { createSystemView } from "./system-view.js";
import { createSystemWidgets } from "./system-widgets.js";
import { changeWith } from "./unsaved.js";

let stopPreview = null;

/** The System view's components, `{ SystemBar, SystemView }`, once its stylesheet applies. */
export async function createSystemUi(env, canvas) {
    await env.style("system.css");

    // What the rest of the workspace asks of the System view: how many edits are unsaved, and what a save sends.
    changeWith(changeOf);
    Object.assign(env, createSystemActions(env, env.systemData));

    // The unsaved edits, and the mode in view, shown on the open design (whether or not the view is on the screen).
    if (stopPreview === null) {
        stopPreview = watchPreview(env.store);
        // (it looks at what the store holds when it first sees a change: let it see this one)
        env.store.set({});
    }

    const widgets = createSystemWidgets(env);

    return createSystemView(env, canvas, createSystemSections(env, widgets), widgets);
}
