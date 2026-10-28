/**
 * How this browser shows an input a module presents. The default is one folded line. Nothing here is stored with the
 * entry, and the model still reads the message in full. The choice lives in this browser, under a `pocket.` key: Pi
 * Pocket does not write `x.` keys.
 */

/** Where this browser keeps each kind's mode. */
export const PRESENTATION_STORAGE_KEY = "pocket.entryPresentation";

/** Kinds this browser remembers. A module registers far fewer. */
const MODE_LIMIT = 256;

/** The last part of `x.<module>.<name>`. */
const PRESENTATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Told when a kind's mode changes: `(kind, mode) => void`. */
const listeners = new Set();

/** Entry ids Find has asked to show, newest last. */
const revealed = new Set();

/** Told when Find asks to show an entry. */
const revealListeners = new Set();

const REVEALED_LIMIT = 200;

/** `label`, or `label · summary`. */
export function presentationLine(label, summary) {
    return typeof summary === "string" && summary !== "" ? `${label} · ${summary}` : label;
}

/**
 * What a row draws. `open` is the message. A folded row is one line, and `opened` shows its text. Hidden is an anchor
 * until Find opens it.
 */
export function presentationDraw(mode, opened = false) {
    if (mode === "open") {
        return "message";
    }

    if (opened) {
        return "text";
    }

    return mode === "hidden" ? "anchor" : "chip";
}

function readMap(storage) {
    try {
        const parsed = JSON.parse(storage.getItem(PRESENTATION_STORAGE_KEY) ?? "{}");

        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch {
        return {};
    }
}

/** How this browser shows `kind`: `open`, `folded`, or `hidden`. Anything else, including nothing, is folded. */
export function presentationMode(kind, storage = globalThis.localStorage) {
    const value = readMap(storage)[kind];

    return value === "open" || value === "hidden" ? value : "folded";
}

/**
 * Remember how this browser shows `kind`. `kind` is `x.<module>.<name>` for the module that asks. The same mode again
 * changes nothing.
 */
export function setPresentationMode(kind, mode, { storage = globalThis.localStorage, module }) {
    const prefix = `x.${module}.`;

    if (
        typeof kind !== "string" ||
        !kind.startsWith(prefix) ||
        !PRESENTATION_NAME.test(kind.slice(prefix.length))
    ) {
        throw new Error(`pocket.entryPresentation: kind is ${prefix}<name>`);
    }

    if (mode !== "open" && mode !== "folded" && mode !== "hidden") {
        throw new Error("pocket.entryPresentation: mode is open, folded, or hidden");
    }

    const next = {};

    for (const [key, value] of Object.entries(readMap(storage))) {
        if (value === "open" || value === "folded" || value === "hidden") {
            next[key] = value;
        }
    }

    if (next[kind] === mode) {
        return;
    }

    if (next[kind] === undefined && Object.keys(next).length >= MODE_LIMIT) {
        throw new Error(
            `pocket.entryPresentation: this browser remembers ${MODE_LIMIT} kinds at most`,
        );
    }

    next[kind] = mode;
    storage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(next));

    for (const hear of listeners) {
        hear(kind, mode);
    }
}

/** Hear mode changes. Returns how to stop. */
export function onPresentationMode(hear) {
    listeners.add(hear);

    return () => listeners.delete(hear);
}

/** Find asked to show this entry. Hidden rows open; the id stays so a later draw can see it. */
export function noteRevealed(id) {
    if (typeof id !== "number") {
        return;
    }

    revealed.delete(id);
    revealed.add(id);

    if (revealed.size > REVEALED_LIMIT) {
        revealed.delete(revealed.values().next().value);
    }

    for (const hear of revealListeners) {
        hear(id);
    }
}

/** Whether Find has asked to show this entry since the page opened. */
export function wasRevealed(id) {
    return revealed.has(id);
}

/** Hear Find. Returns how to stop. */
export function onRevealed(hear) {
    revealListeners.add(hear);

    return () => revealListeners.delete(hear);
}
