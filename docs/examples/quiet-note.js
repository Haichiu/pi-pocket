// Quiet note's browser module: this browser hides the module's notes until Find. The model still reads each one.
// The app loads it and calls its default export with `pocket` (docs/extensions.md).

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 1;

export default function setup(pocket) {
    // `open` is the message, `folded` is one line (the default), and `hidden` keeps the turn until Find.
    if (typeof pocket.entryPresentation === "function") {
        pocket.entryPresentation("x.quiet-note.note", "hidden");
    }
}
