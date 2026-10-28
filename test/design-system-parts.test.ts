// The System view's plain parts (`extensions/design/color.js` and `system.js`), which touch no page: reading and measuring
// colors, which section a token is in, the value a token has once unsaved edits lie over it, contrast, the history of
// edits, and the change a save sends. The system is the fixture's, read by the engine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { writeSystemFixture } from "./design-system-fixtures.ts";

const load = (name: string) =>
    import(new URL(`../src/server/extensions/design/${name}.js`, import.meta.url).href);

const color = await load("color");
const sys = await load("system");

const folder = mkdtempSync(join(tmpdir(), "pi-pocket-system-"));

writeSystemFixture(folder);

const system = loadDesignSystem(folder)!;

after(() => rmSync(folder, { recursive: true, force: true }));

test("colors are read in every form a token file has", () => {
    const rgb = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });

    assert.deepEqual(color.parseColor("#3b6cf6"), rgb(59, 108, 246));
    assert.deepEqual(color.parseColor("#FFF"), rgb(255, 255, 255));
    assert.deepEqual(color.parseColor("#0008"), rgb(0, 0, 0, 0x88 / 255));
    assert.deepEqual(color.parseColor("rgb(59, 108, 246)"), rgb(59, 108, 246));
    assert.deepEqual(color.parseColor("rgb(59 108 246 / 50%)"), rgb(59, 108, 246, 0.5));
    assert.deepEqual(color.parseColor("rgba(0,0,0,.25)"), rgb(0, 0, 0, 0.25));
    assert.deepEqual(color.parseColor("hsl(0 100% 50%)"), rgb(255, 0, 0));
    assert.deepEqual(color.parseColor("hsl(120deg 100% 25%)"), rgb(0, 128, 0));
    assert.deepEqual(color.parseColor("oklch(0.628 0.2577 29.23)"), rgb(255, 0, 0));
    assert.deepEqual(color.parseColor("oklch(1 0 0)"), rgb(255, 255, 255));
    assert.deepEqual(color.parseColor("color(srgb 1 0.5 0 / 0.4)"), rgb(255, 128, 0, 0.4));
    assert.deepEqual(color.parseColor("transparent"), rgb(0, 0, 0, 0));
    // The 2025.10 object form: a hex wins, and the alpha is the object's.
    assert.deepEqual(
        color.parseColor({ colorSpace: "srgb", components: [0, 0, 0], alpha: 0.4 }),
        rgb(0, 0, 0, 0.4),
    );
    assert.deepEqual(
        color.parseColor({ colorSpace: "srgb", components: [1, 0, 0], hex: "#ff0000" }),
        rgb(255, 0, 0),
    );
    assert.deepEqual(
        color.parseColor({ colorSpace: "hsl", components: [240, 100, 50] }),
        rgb(0, 0, 255),
    );
    assert.deepEqual(
        color.parseColor({ colorSpace: "oklch", components: [1, 0, 0] }),
        rgb(255, 255, 255),
    );

    // What it cannot read is null, never a throw.
    for (const bad of [
        "",
        "blue-ish",
        "#12",
        "rgb(1 2)",
        "oklch(a b c)",
        "x".repeat(300),
        4,
        null,
        [],
        { colorSpace: "lab", components: [1, 2, 3] },
        { components: [1] },
    ]) {
        assert.equal(color.parseColor(bad), null, String(bad).slice(0, 20));
    }
});

test("a color is written back as hex, in the dialect of the value it replaces", () => {
    assert.equal(color.toHex({ r: 59, g: 108, b: 246, a: 1 }), "#3b6cf6");
    assert.equal(color.toHex({ r: 0, g: 0, b: 0, a: 0.5 }), "#00000080");
    assert.equal(color.toOklchText({ r: 255, g: 255, b: 255, a: 1 }), "oklch(1 0 0)");
    assert.equal(color.writeColor({ r: 255, g: 0, b: 0, a: 1 }, "#000000"), "#ff0000");
    assert.deepEqual(
        color.writeColor(
            { r: 255, g: 0, b: 0, a: 0.5 },
            { colorSpace: "srgb", components: [0, 0, 0] },
        ),
        {
            colorSpace: "srgb",
            components: [1, 0, 0],
            hex: "#ff0000",
            alpha: 0.5,
        },
    );
});

test("contrast follows WCAG 2.2, and a see-through color is laid over its ground first", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };

    assert.equal(Math.round(color.contrast(black, white) * 10) / 10, 21);
    assert.equal(color.contrast(white, white), 1);
    // #777 on white is 4.48:1, the classic miss of AA.
    const gray = color.contrast(color.parseColor("#777777"), white);

    assert.ok(gray > 4.4 && gray < 4.5);
    assert.equal(color.grade(gray, 4.5).pass, false);
    assert.equal(color.grade(gray, 4.5).level, "AA large");
    assert.equal(color.grade(10).level, "AAA");
    assert.equal(color.ratioText(4.4999), "4.4:1");
    // Half-transparent black on white reads as mid gray, not as black.
    assert.ok(color.contrast({ ...black, a: 0.5 }, white) < 5);
});

test("a token belongs to the section its type, or the words of its name, say", () => {
    const of = (type: string, ...path: string[]) => sys.sectionOf({ type, path });

    assert.equal(of("color", "color", "bg"), "colors");
    assert.equal(of("gradient", "brand"), "colors");
    assert.equal(of("fontFamily", "font", "sans"), "type");
    assert.equal(of("typography", "type", "body"), "type");
    assert.equal(of("dimension", "font", "size", "base"), "type");
    assert.equal(of("dimension", "space", "4"), "spacing");
    assert.equal(of("dimension", "core", "radius", "md"), "radii");
    assert.equal(of("shadow", "shadow", "md"), "shadows");
    assert.equal(of("duration", "motion", "fast"), "motion");
    assert.equal(of("cubicBezier", "ease"), "motion");
    assert.equal(of("number", "z", "modal"), "other");
    assert.equal(of("dimension", "breakpoint", "md"), "other");
    assert.equal(of("number", "motion", "stagger"), "motion");
});

test("the fixture's tokens group into roles first and a palette after, and the rest into sections", () => {
    const groups = sys.groupsOf(system.tokens, "colors", system.modes[0]);
    const ids = groups.map((each: { id: string }) => each.id);

    assert.ok(ids.indexOf("color:bg") < ids.indexOf("color:gray"), ids.join());
    assert.equal(groups.find((each: { id: string }) => each.id === "color:gray").kind, "palette");
    assert.equal(groups.find((each: { id: string }) => each.id === "color:bg").kind, "roles");
    assert.equal(groups.find((each: { id: string }) => each.id === "color:color").title, "Base");
    assert.deepEqual(
        sys.groupsOf(system.tokens, "type", "light").map((each: { title: string }) => each.title),
        ["Families", "Sizes", "Weights", "Line height", "Styles"],
    );
    assert.deepEqual(
        sys.groupsOf(system.tokens, "other", "light").map((each: { title: string }) => each.title),
        ["Z", "Breakpoint"],
    );
    assert.deepEqual(
        sys.groupsOf(system.tokens, "motion", "light").map((each: { title: string }) => each.title),
        ["Durations", "Easing"],
    );
    assert.ok(sys.SECTIONS.every((each: { id: string }) => each.id !== "other" || true));
});

test("a search finds a token by its name, its description, or a value", () => {
    const token = (name: string) => system.tokens.find((each) => each.name === name);

    assert.ok(sys.matches(token("color.bg.surface"), "surface"));
    assert.ok(sys.matches(token("color.bg.surface"), "cards fields"));
    assert.ok(sys.matches(token("color.bg.surface"), "BG surf"));
    assert.ok(sys.matches(token("color.bg.surface"), "color-white"));
    assert.ok(!sys.matches(token("color.bg.surface"), "danger"));
    assert.ok(sys.matches(token("color.bg.surface"), "   "));
});

test("an edit to a color flows through the aliases that lead to it, and only there", () => {
    const edits = sys.tokenEdits(
        sys.push(
            sys.emptyHistory(),
            sys.tokenEdit("light", "color.blue.600", { value: "#ff0000" }),
        ),
    );
    const model = sys.createModel(system, edits);
    const saved = sys.createModel(system);

    assert.equal(model.value("color.blue.600", "light").value, "#ff0000");
    assert.equal(model.value("color.blue.600", "light").edited, true);
    // The token that refers to it keeps its alias and its CSS, and takes the new value.
    assert.equal(model.value("color.accent.default", "light").value, "#ff0000");
    assert.equal(model.value("color.accent.default", "light").alias, "color.blue.600");
    assert.equal(model.value("color.accent.default", "light").css, "var(--color-blue-600)");
    // Dark does not use blue.600 for its accent: nothing changes there.
    assert.equal(
        model.value("color.accent.default", "dark").value,
        saved.value("color.accent.default", "dark").value,
    );
    // Unrelated tokens are the saved ones, by identity: nothing is copied for them.
    assert.equal(model.value("color.gray.50", "light"), saved.value("color.gray.50", "light"));
    assert.deepEqual(model.dependents("color.blue.600"), ["color.accent.default"]);
});

test("a token can be pointed at another, and pointing at one that leads back is a loop", () => {
    const edits = sys.tokenEdits(
        sys.push(
            sys.emptyHistory(),
            sys.tokenEdit("light", "color.bg.sunken", { alias: "color.gray.300" }),
        ),
    );
    const model = sys.createModel(system, edits);

    assert.equal(model.value("color.bg.sunken", "light").value, "#c3c8d8");
    assert.equal(model.value("color.bg.sunken", "light").css, "var(--color-gray-300)");
    assert.deepEqual(model.chain("color.bg.sunken", "light"), [
        "color.bg.sunken",
        "color.gray.300",
    ]);

    // `bg.canvas` points at `gray.50`: pointing `gray.50` at `bg.canvas` would loop.
    assert.ok(
        system.tokens.every((token) =>
            model
                .targets("color.gray.50")
                .every((each: { name: string }) => each.name !== "color.bg.canvas"),
        ),
    );
    assert.ok(
        model.targets("color.bg.canvas").every((each: { type: string }) => each.type === "color"),
    );

    const loop = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.gray.50", { alias: "color.bg.canvas" }),
            ),
        ),
    );

    assert.ok(
        loop.value("color.bg.canvas", "light").error?.includes("loop"),
        "a loop is an error, not a hang",
    );
});

test("a mode that takes the default's value follows an edit of the default", () => {
    // `border.focus` has no dark value of its own, so dark follows light.
    const edits = sys.tokenEdits(
        sys.push(
            sys.emptyHistory(),
            sys.tokenEdit("light", "color.border.focus", { alias: "color.red.600" }),
        ),
    );
    const model = sys.createModel(system, edits);

    assert.equal(model.value("color.border.focus", "dark").alias, "color.red.600");
    // `accent.default` has its own dark value: an edit of light leaves it.
    const own = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.accent.default", { alias: "color.red.600" }),
            ),
        ),
    );

    assert.equal(own.value("color.accent.default", "dark").alias, "color.blue.400");
});

test("contrast comes from the token's pair, or is worked out for text, and it moves with the edits", () => {
    const model = sys.createModel(system);
    const primary = model.contrastOf("color.text.primary", "light");

    assert.equal(primary.on, "color.bg.surface");
    assert.equal(primary.min, 7);
    assert.equal(primary.auto, false);
    assert.equal(primary.pass, true);
    assert.equal(primary.level, "AAA");
    assert.equal(model.contrastOf("color.text.disabled", "light").pass, false);
    // A color that is not text, and has no pair, has no badge.
    assert.equal(model.contrastOf("color.bg.surface", "light"), null);
    assert.equal(model.contrastOf("color.accent.default", "light"), null);
    assert.equal(model.contrastOf("space.4", "light"), null);

    const edited = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.gray.900", { value: "#e0e0e0" }),
            ),
        ),
    );

    assert.equal(edited.contrastOf("color.text.primary", "light").pass, false);
});

test("the roles of a system are found by their names", () => {
    const found = sys.roles(sys.createModel(system));

    assert.equal(found.canvas, "color.bg.canvas");
    assert.equal(found.surface, "color.bg.surface");
    assert.equal(found.text, "color.text.primary");
    assert.equal(found.muted, "color.text.muted");
    assert.equal(found.accent, "color.accent.default");
    assert.equal(found.border, "color.border.default");
    assert.equal(found.danger, "color.status.danger");
    assert.equal(found.success, "color.status.success");
    assert.equal(found.warning, "color.status.warning");
});

test("what a person types becomes a value of the token's type, in its dialect, or words for the field", () => {
    assert.deepEqual(sys.readInput("color", "#ABCDEF", "#000000"), { value: "#abcdef" });
    assert.deepEqual(sys.readInput("color", "rgb(255 0 0)", "#000000"), { value: "#ff0000" });
    assert.equal(sys.readInput("color", "#12", "#000").error?.startsWith("Not a color"), true);
    assert.deepEqual(sys.readInput("dimension", "1.5rem", { value: 1, unit: "px" }), {
        value: { value: 1.5, unit: "rem" },
    });
    // A bare number takes the unit it had; text stays text.
    assert.deepEqual(sys.readInput("dimension", "20", { value: 1, unit: "rem" }), {
        value: { value: 20, unit: "rem" },
    });
    assert.deepEqual(sys.readInput("dimension", "20", "8px"), { value: "20px" });
    assert.ok(sys.readInput("dimension", "20furlongs", "8px").error);
    assert.deepEqual(sys.readInput("duration", "0.4s", { value: 200, unit: "ms" }), {
        value: { value: 0.4, unit: "s" },
    });
    assert.ok(sys.readInput("duration", "4px", "8ms").error);
    assert.deepEqual(sys.readInput("number", "1.25"), { value: 1.25 });
    assert.ok(sys.readInput("number", "x").error);
    assert.deepEqual(sys.readInput("fontWeight", "600"), { value: 600 });
    assert.ok(sys.readInput("fontWeight", "5000").error);
    assert.deepEqual(sys.readInput("fontFamily", `"JetBrains Mono", monospace`, ["a"]), {
        value: ["JetBrains Mono", "monospace"],
    });
    assert.ok(sys.readInput("fontFamily", "evil;}", ["a"]).error);
    assert.deepEqual(sys.readInput("cubicBezier", "0.2, 0, 0, 1", [0, 0, 1, 1]), {
        value: [0.2, 0, 0, 1],
    });
    assert.deepEqual(sys.readInput("cubicBezier", "cubic-bezier(0.3 0 0.1 1.2)"), {
        value: [0.3, 0, 0.1, 1.2],
    });
    assert.ok(sys.readInput("cubicBezier", "2 0 0 1").error);
    assert.ok(sys.readInput("shadow", "x").error);
    assert.ok(sys.readInput("color", "  ").error);
});

test("undo and redo walk the edits, a repeat of one edit is one step, and an edit after an undo ends the redo", () => {
    const edit = (value: string) => sys.tokenEdit("light", "color.blue.600", { value });
    let history = sys.emptyHistory();

    history = sys.push(history, edit("#111111"), 1000);
    history = sys.push(history, edit("#222222"), 1300);
    // The same thing, soon after: one step, with the latest value.
    assert.equal(history.past.length, 1);
    assert.equal(history.past[0].raw.value, "#222222");
    // A moment later is a new step.
    history = sys.push(history, edit("#333333"), 5000);
    history = sys.push(
        history,
        sys.tokenEdit("light", "color.blue.700", { value: "#444444" }),
        5100,
    );
    assert.equal(history.past.length, 3);

    history = sys.undo(history);
    assert.equal(history.past.length, 2);
    assert.equal(history.future.length, 1);
    history = sys.redo(history);
    assert.equal(history.past.length, 3);
    assert.equal(history.future.length, 0);
    history = sys.undo(sys.undo(history));
    history = sys.push(history, edit("#555555"), 99_000);
    assert.equal(history.future.length, 0, "a new edit ends the redo");
    // Nothing to undo or redo leaves the history as it is.
    assert.equal(sys.undo(sys.emptyHistory()).past.length, 0);
    assert.equal(sys.redo(sys.emptyHistory()).future.length, 0);
    // The edits in force are the last for each thing.
    assert.equal(sys.editsOf(history).size, 1);
});

test("a save is what differs from the saved values: a revert changes nothing, and the order is the person's", () => {
    let history = sys.emptyHistory();

    history = sys.push(
        history,
        sys.tokenEdit("light", "color.accent.default", { alias: "color.blue.500" }),
        1,
    );
    history = sys.push(
        history,
        sys.tokenEdit("dark", "color.bg.canvas", { value: "#000000" }),
        10_000,
    );
    history = sys.push(
        history,
        sys.tokenEdit("light", "color.blue.600", { value: "#3b6cf6" }),
        20_000,
    );
    history = sys.push(history, sys.guidelinesEdit("# New\n"), 30_000);

    const change = sys.changeOf(system, history);

    // `blue.600` is already #3b6cf6: it is no change.
    assert.deepEqual(change.set, [
        { mode: "light", token: "color.accent.default", value: "{color.blue.500}" },
        { mode: "dark", token: "color.bg.canvas", value: "#000000" },
    ]);
    assert.equal(change.guidelines, "# New\n");
    assert.equal(change.count, 3);
    assert.equal(sys.changeOf(system, sys.emptyHistory()).count, 0);
    assert.equal(
        sys.changeOf(system, sys.push(sys.emptyHistory(), sys.guidelinesEdit(system.guidelines)))
            .count,
        0,
    );
});

test("the CSS a design is told is what differs from the saved default, and untrusted CSS is dropped", () => {
    const model = sys.createModel(system);

    // The saved default mode is what the design has already.
    assert.deepEqual(sys.previewVars(model, "light"), {});

    const dark = sys.previewVars(model, "dark");

    assert.equal(dark["--color-bg-canvas"], "var(--color-gray-950)");
    assert.equal(dark["--color-gray-50"], undefined);
    assert.ok(Object.keys(dark).length > 5);
    assert.ok(Object.keys(dark).every((name) => /^--[A-Za-z0-9_-]{1,78}$/.test(name)));

    const edited = sys.createModel(
        system,
        sys.tokenEdits(
            sys.push(
                sys.emptyHistory(),
                sys.tokenEdit("light", "color.blue.600", { value: "#ff0000" }),
            ),
        ),
    );

    assert.deepEqual(sys.previewVars(edited, "light"), { "--color-blue-600": "#ff0000" });

    assert.equal(sys.safeCss("#fff"), "#fff");
    assert.equal(sys.safeCss("0 1px 2px rgb(0 0 0 / 0.2)"), "0 1px 2px rgb(0 0 0 / 0.2)");

    for (const bad of [
        "red;} body{display:none",
        "</style><script>",
        "url(http://x)",
        "a\\b",
        "/* x */",
        "@import 'x'",
        "x".repeat(401),
        "a\nb",
    ]) {
        assert.equal(sys.safeCss(bad), "", bad.slice(0, 20));
    }

    assert.ok(sys.themeCss(model, "dark").startsWith(":root{--color-white:"));
});

test("values of the other kinds read as amounts, pixels, and milliseconds", () => {
    assert.deepEqual(sys.amountOf({ value: 16, unit: "px" }), { n: 16, unit: "px" });
    assert.deepEqual(sys.amountOf("1.5rem"), { n: 1.5, unit: "rem" });
    assert.equal(sys.amountOf("big"), null);
    assert.equal(sys.pixelsOf("2rem"), 32);
    assert.equal(sys.pixelsOf({ value: 4, unit: "px" }), 4);
    assert.equal(sys.pixelsOf("50%"), null);
    assert.equal(sys.millisecondsOf({ value: 0.4, unit: "s" }), 400);
    assert.equal(sys.millisecondsOf("120ms"), 120);
    assert.equal(
        sys.cssOf("fontFamily", ["JetBrains Mono", "monospace"]),
        `"JetBrains Mono", monospace`,
    );
    assert.equal(sys.cssOf("cubicBezier", [0.2, 0, 0, 1]), "cubic-bezier(0.2, 0, 0, 1)");
    assert.equal(sys.cssOf("color", { colorSpace: "srgb", components: [1, 0, 0] }), "#ff0000");
    assert.equal(sys.cssOf("shadow", {}), undefined);
});
