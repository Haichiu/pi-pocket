// A presented input's chip is this browser's choice: folded unless a module sets another mode.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import * as presented from "../web/entry-presentation.js";

const {
    noteRevealed,
    onPresentationMode,
    onRevealed,
    PRESENTATION_STORAGE_KEY,
    presentationDraw,
    presentationLine,
    presentationMode,
    setPresentationMode,
    wasRevealed,
} = presented;

type Mode = "open" | "folded" | "hidden";

type Storage = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
};

const memory = (): Storage => {
    const data = new Map<string, string>();

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, String(value));
        },
    };
};

const options = (storage: Storage) => ({ storage, module: "quiet-input" });

test("the chip is folded until this browser asks otherwise", () => {
    const storage = memory();

    assert.equal(presentationMode("x.quiet-input.note", storage), "folded");
    assert.equal(presentationDraw("folded"), "chip");
    assert.equal(presentationDraw("folded", true), "text");
    assert.equal(presentationDraw("open"), "message");
    assert.equal(presentationDraw("hidden"), "anchor");
    assert.equal(presentationDraw("hidden", true), "text");
    assert.equal(presentationLine("Note", "saved"), "Note · saved");
    assert.equal(presentationLine("Note", ""), "Note");

    setPresentationMode("x.quiet-input.note", "hidden", options(storage));
    assert.equal(presentationMode("x.quiet-input.note", storage), "hidden");
    assert.equal(storage.getItem(PRESENTATION_STORAGE_KEY)?.startsWith("pocket."), false);
    assert.match(storage.getItem(PRESENTATION_STORAGE_KEY) ?? "", /x\.quiet-input\.note/);

    storage.setItem(PRESENTATION_STORAGE_KEY, "{");
    assert.equal(presentationMode("x.quiet-input.note", storage), "folded");
});

test("a module sets only its own kinds, and the same mode again is quiet", () => {
    const storage = memory();
    const seen: [string, Mode][] = [];
    const stop = onPresentationMode((kind: string, mode: Mode) => seen.push([kind, mode]));

    try {
        assert.throws(
            () => setPresentationMode("x.other-input.note", "open", options(storage)),
            /x\.quiet-input\.<name>/,
        );
        assert.throws(
            () => setPresentationMode("x.quiet-input.note", "away", options(storage)),
            /open, folded, or hidden/,
        );
        setPresentationMode("x.quiet-input.note", "open", options(storage));
        setPresentationMode("x.quiet-input.note", "open", options(storage));
        assert.equal(presentationMode("x.quiet-input.note", storage), "open");
        assert.deepEqual(seen, [["x.quiet-input.note", "open"]]);
    } finally {
        stop();
    }
});

test("Find opens a hidden row and leaves the id marked", () => {
    const id = 44001;
    let heard = 0;
    const stop = onRevealed((entryId: number) => {
        heard = entryId;
    });

    try {
        assert.equal(wasRevealed(id), false);
        noteRevealed(id);
        noteRevealed("nope");
        assert.equal(wasRevealed(id), true);
        assert.equal(heard, id);
        assert.equal(presentationDraw("hidden", wasRevealed(id)), "text");
    } finally {
        stop();
    }
});
