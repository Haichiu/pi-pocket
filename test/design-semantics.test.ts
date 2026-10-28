// Round 5 of the checks: only what the author set is judged (never the browser's own defaults), suggestions that prefer
// the role's tokens and say when they change the value, page semantics (language, labels, names, main), input zoom.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { check, ofRule, onPid, page, testSystem, token } from "./design-lint-fixtures.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };
const plain = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plain</title></head><body>
<main data-pid="m"><h1 data-pid="h1">Plain controls</h1><h2 data-pid="h2">A subtitle</h2><p data-pid="p">Words, with a <a href="#" data-pid="a">link</a> and <code data-pid="code">code</code>.</p>
<button data-pid="b">Go</button> <input data-pid="i" aria-label="Name" type="text"> <select data-pid="s" aria-label="Pick"><option>A</option></select> <textarea data-pid="t" aria-label="Notes"></textarea>
<fieldset data-pid="f"><legend>Group</legend>x</fieldset><hr data-pid="hr"><details data-pid="d"><summary data-pid="sum">More</summary>text</details></main></body></html>`;

test(
    "the browser's own defaults are not the page's: plain controls and headings give no finding",
    browser,
    async () => {
        for (const scheme of ["light", "dark"] as const) {
            const report = await check(plain, { viewport: "desktop", colorScheme: scheme });

            assert.deepEqual(
                report.findings.map((item) => `${item.rule}:${item.pid ?? item.selector}`),
                [],
                scheme,
            );
        }

        // The same without a system: nothing that is a default is judged either.
        const none = await check(plain, { viewport: "desktop" }, null);

        assert.deepEqual(none.findings, []);
    },
);

test("what the author sets on those controls is judged", browser, async () => {
    const styled = plain
        .replace("<style>", "<style>")
        .replace(
            "</head>",
            "<style>button{border:1px solid #123456;padding:14px;border-radius:12px}h1{font-size:30px}hr{border-color:#abcdef}</style></head>",
        );
    const report = await check(styled, { viewport: "desktop" });
    const values = (pid: string) =>
        report.findings
            .filter((item) => item.pid === pid)
            .map((item) => `${item.rule}:${item.value}`)
            .sort();

    assert.deepEqual(values("b"), [
        "off-system-color:#123456",
        "off-system-size:12px",
        "off-system-size:14px",
    ]);
    assert.deepEqual(values("h1"), ["off-system-size:30px"]);
    assert.deepEqual(values("hr"), ["off-system-color:#abcdef"]);
    // A text color that the author sets is judged, in a dark page too: the default white of a dark page is not.
    const dark = await check(
        plain.replace("</head>", "<style>html{color-scheme:dark}</style></head>"),
        { viewport: "desktop", colorScheme: "dark" },
    );

    assert.deepEqual(dark.findings, []);
    const authored = await check(
        plain.replace("</head>", "<style>body{color:#7ba3f8}</style></head>"),
        { viewport: "desktop" },
    );

    assert.ok(ofRule(authored, "off-system-color").some((item) => item.value === "#7ba3f8"));
});

test(
    "a suggestion prefers the role's token to a palette step, and says when it changes the value",
    browser,
    async () => {
        const system = testSystem();

        // A palette step that is nearer to the color than the border token is (but within 12 of it).
        system.tokens.push(token("color.gray.400", "color", "#8f95ab", "#8f95ab", "primitive"));
        const body =
            `<div data-pid="edge" style="border:1px solid #9399b0;padding:var(--space-4);background:var(--color-bg-surface)">x</div>` +
            `<p data-pid="words" style="margin:0;padding:var(--space-2);color:#6b7180;background:var(--color-bg-surface)">Words</p>` +
            `<p data-pid="size" style="margin:0;padding:15px;background:var(--color-bg-surface)">x</p>`;
        const report = await check(page("", body), { viewport: "desktop" }, system);
        const edge = onPid(report, "off-system-color", "edge")!;
        const words = onPid(report, "off-system-color", "words")!;

        assert.equal(
            edge.suggestion,
            "var(--color-border-default)",
            "a border color gets the border token, not gray.400",
        );
        assert.match(edge.message, /Set `border-color: var\(--color-border-default\)`/);
        assert.match(words.message, /The closest token is #5a5f73, which is darker\./);
        assert.match(edge.message, /The closest token is #8a90a6, which is slightly darker\./);
        const size = report.findings.find(
            (item) => item.rule === "off-system-size" && item.value === "15px",
        )!;

        assert.match(size.message, /The closest step is 1px (smaller|larger)\./);
    },
);

test("page semantics: language, labels, names, and a main landmark", browser, async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const body =
        `<input data-pid="n1" type="email">` +
        `<input data-pid="n2" type="text" placeholder="Name">` +
        `<label>Wrapped <input data-pid="n3"></label><label for="x">Linked</label><input id="x" data-pid="n4">` +
        `<input data-pid="n5" aria-label="Q"><select data-pid="n6"><option>a</option></select><textarea data-pid="n7" title="Notes"></textarea>` +
        `<input type="checkbox" data-pid="n8"><input type="hidden" name="h"><input type="submit" data-pid="n9"><input type="range" data-pid="n10">` +
        `<button data-pid="b1"><svg width="16" height="16" aria-hidden="true"><path d="M0 0h16v16z"/></svg></button>` +
        `<button data-pid="b2" aria-label="Close"><svg width="16" height="16"></svg></button><button data-pid="b3">Text</button>` +
        `<a href="#" data-pid="a1"><img src="${gif}" alt="" width="10" height="10"></a><a href="#" data-pid="a2"><img src="${gif}" alt="Home" width="10" height="10"></a>` +
        `<a href="#" data-pid="a3"><svg width="10" height="10"><title>Home</title></svg></a><a data-pid="a4">no href</a>` +
        `<button data-pid="b4" aria-labelledby="lbl"></button><span id="lbl">Named by id</span>` +
        `<label>Switch <button role="switch" aria-checked="false" data-pid="b5"></button></label>` +
        `<label for="b6">Pointed at</label><button id="b6" data-pid="b6"></button>`;
    const bare = page("", body)
        .replace('<html lang="en">', "<html>")
        .replace('<main data-pid="page">', "<div>")
        .replace("</main>", "</div>");
    const report = await check(bare, { viewport: "desktop" }, null);
    const pids = (rule: string) =>
        ofRule(report, rule)
            .map((item) => item.pid)
            .sort();

    assert.deepEqual(pids("form-label"), ["n1", "n10", "n6", "n8"]);
    assert.deepEqual(pids("accessible-name"), ["a1", "b1"]);
    assert.equal(ofRule(report, "form-label")[0]!.level, "error");
    assert.match(
        ofRule(report, "form-label").find((item) => item.pid === "n1")!.message,
        /^A <input type=email> has no label/,
    );
    assert.match(
        ofRule(report, "accessible-name")[0]!.message,
        /Add `aria-label="what it does"`\./,
    );
    const lang = ofRule(report, "missing-lang");

    assert.equal(lang.length, 1);
    assert.equal(lang[0]!.level, "error");
    assert.equal(lang[0]!.selector, "html");
    assert.match(lang[0]!.message, /Set `<html lang="en">`/);
    assert.equal(ofRule(report, "missing-main").length, 1);
    assert.equal(ofRule(report, "missing-main")[0]!.level, "warning");
    // With a lang and a main, those two are gone; the labels and names stay.
    const fine = await check(page("", body), { viewport: "desktop" }, null);

    assert.equal(ofRule(fine, "missing-lang").length, 0);
    assert.equal(ofRule(fine, "missing-main").length, 0);
    assert.equal(ofRule(fine, "form-label").length, 4);
    // `role=main` counts, and a deck needs no main.
    const role = await check(
        bare.replace("<div>", '<div role="main">'),
        { viewport: "desktop" },
        null,
    );

    assert.equal(ofRule(role, "missing-main").length, 0);
    const deck = await check(
        `<!doctype html><html lang="en"><meta name="pocket-kind" content="deck"><section class="slide" data-pid="s"><h1>Hi</h1></section>`,
        { viewport: "desktop" },
        null,
    );

    assert.equal(ofRule(deck, "missing-main").length, 0);
});

test("a field under 16px is a warning on a phone, with the token to use", browser, async () => {
    const body =
        `<input data-pid="small" aria-label="a" style="font-size:14px">` +
        `<input data-pid="plain" aria-label="b">` +
        `<input data-pid="ok" aria-label="c" style="font-size:16px">` +
        `<select data-pid="sel" aria-label="d" style="font-size:15px"><option>a</option></select>` +
        `<textarea data-pid="area" aria-label="e" style="font-size:13px"></textarea>` +
        `<input type="checkbox" data-pid="box" aria-label="f"><input type="range" data-pid="range" aria-label="g">`;
    const phone = await check(page("", body), { viewport: "mobile" });
    const zoom = ofRule(phone, "input-zoom");

    assert.deepEqual(zoom.map((item) => item.pid).sort(), ["area", "plain", "sel", "small"]);
    assert.equal(zoom[0]!.level, "warning");
    assert.match(
        onPid(phone, "input-zoom", "small")!.message,
        /iOS Safari zooms the page in when a field under 16px gets the focus\. Set `font-size: var\(--font-size-md\)` \(16px\)\./,
    );
    assert.equal(onPid(phone, "input-zoom", "small")!.value, "14px");
    // Not on a desktop viewport, and the plain text without a system names 16px.
    assert.equal(
        ofRule(await check(page("", body), { viewport: "desktop" }), "input-zoom").length,
        0,
    );
    const none = await check(page("", body), { viewport: "mobile" }, null);

    assert.match(onPid(none, "input-zoom", "small")!.message, /Set `font-size: 16px`\./);
});
