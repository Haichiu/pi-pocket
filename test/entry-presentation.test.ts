// A module's presentation exists only while that module is on. A failed load leaves the registry empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionWebs } from "../src/server/extension-web.ts";

test("presentEntry is on only while the module is", () => {
    let changes = 0;
    const webs = new ExtensionWebs({
        presentationsChanged: () => {
            changes++;
        },
    });
    const staged = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    assert.throws(
        () => staged.web.presentEntry({ kind: "pi.user", label: "Nope" }),
        /x\.quiet-input\./,
    );
    staged.web.presentEntry({
        kind: "x.quiet-input.note",
        label: "Note",
        userPrefix: "NOTE ",
    });
    assert.throws(
        () => staged.web.presentEntry({ kind: "x.quiet-input.note", label: "Again" }),
        /registered twice/,
    );
    assert.equal(webs.presentations().byKind.size, 0);
    webs.commit(staged.part);
    assert.equal(changes, 1);
    assert.equal(webs.presentations().byKind.get("x.quiet-input.note")?.label, "Note");
    assert.equal(webs.presentations().prefixes[0]?.userPrefix, "NOTE ");
    webs.remove("quiet-input.ts");
    assert.equal(changes, 2);
    assert.equal(webs.presentations().byKind.size, 0);
});

test("a failed load keeps the registry empty", () => {
    let changes = 0;
    const webs = new ExtensionWebs({
        presentationsChanged: () => {
            changes++;
        },
    });
    const staged = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    staged.web.presentEntry({ kind: "x.quiet-input.note", label: "Note" });
    webs.discard(staged.part);
    assert.equal(changes, 0);
    assert.equal(webs.presentations().byKind.size, 0);
});

test("another module cannot take the same prefix", () => {
    const webs = new ExtensionWebs();
    const first = webs.stage("quiet-input.ts", "/tmp", "Quiet input");

    first.web.presentEntry({
        kind: "x.quiet-input.note",
        label: "Note",
        userPrefix: "NOTE ",
    });
    webs.commit(first.part);

    const second = webs.stage("other-input.ts", "/tmp", "Other input");

    assert.throws(
        () =>
            second.web.presentEntry({
                kind: "x.other-input.note",
                label: "Other",
                userPrefix: "NOTE ",
            }),
        /already matches that userPrefix/,
    );
});
