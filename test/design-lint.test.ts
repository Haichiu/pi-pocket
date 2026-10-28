// The design checks: color math and token sets without a browser, then each rule on small pages in the private Chromium,
// with a case that must report and a case that must stay quiet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import {
    colorCss,
    colorDistance,
    contrastRatio,
    dimensionCss,
    familyList,
    formatColor,
    lengthKind,
    tokenSet,
} from "../src/server/design/color.ts";
import { analyze, mergeFindings, modeFor, reportOf } from "../src/server/design/lint.ts";
import type { RawPage } from "../src/server/design/lint-page.ts";
import {
    bundleOf,
    check,
    host,
    ofRule,
    onPid,
    page,
    testSystem,
    token,
} from "./design-lint-fixtures.ts";
import { checkDesign } from "../src/server/design/lint.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };

test("colors: distance is perceptual, contrast follows WCAG, and values print as CSS", () => {
    assert.equal(colorDistance([122, 162, 247, 1], [122, 162, 247, 1]), 0);
    assert.ok(
        colorDistance([122, 162, 247, 1], [123, 163, 248, 1]) < 1.5,
        "one step is the same color",
    );
    assert.ok(
        colorDistance([122, 162, 247, 1], [226, 74, 74, 1]) > 20,
        "blue and red are far apart",
    );
    assert.ok(colorDistance([0, 0, 0, 1], [0, 0, 0, 0.5]) >= 50, "alpha counts");
    assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
    assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]), 1);
    assert.ok(Math.abs(contrastRatio([119, 119, 119], [255, 255, 255]) - 4.48) < 0.01);
    assert.equal(formatColor([122, 162, 247, 1]), "#7aa2f7");
    assert.equal(formatColor([255, 255, 255, 0.1]), "rgb(255 255 255 / 0.1)");
});

test("token values turn into CSS the browser can resolve", () => {
    assert.equal(colorCss("#7aa2f7"), "#7aa2f7");
    assert.equal(colorCss("{color.blue}"), undefined, "an unresolved reference is not a color");
    assert.equal(
        colorCss({ colorSpace: "srgb", components: [0.5, 0.25, 1], alpha: 0.5 }),
        "color(srgb 0.5 0.25 1 / 0.5)",
    );
    assert.equal(
        colorCss({ colorSpace: "oklch", components: [0.7, 0.1, 250] }),
        "oklch(0.7 0.1 250)",
    );
    assert.equal(colorCss({ colorSpace: "hsl", components: [210, 50, 40] }), "hsl(210 50% 40%)");
    assert.equal(
        colorCss({ colorSpace: "display-p3", components: [0.1, 0.2, 0.3] }),
        "color(display-p3 0.1 0.2 0.3)",
    );
    assert.equal(
        colorCss({ colorSpace: "weird", components: [1, 2, 3], hex: "#010203" }),
        "#010203",
    );
    assert.equal(colorCss(42), undefined);
    assert.equal(dimensionCss({ value: 1.5, unit: "rem" }), "1.5rem");
    assert.equal(dimensionCss("16px"), "16px");
    assert.equal(dimensionCss(8), "8px");
    assert.equal(dimensionCss({ value: 1, unit: "px; x" }), undefined);
    assert.equal(dimensionCss("1px}body{"), undefined);
    assert.deepEqual(familyList(`"JetBrains Mono", 'Fira Code', monospace`), [
        "jetbrains mono",
        "fira code",
        "monospace",
    ]);
});

test("a dimension token's scale comes from its name", () => {
    assert.equal(lengthKind(["space", "4"]), "space");
    assert.equal(lengthKind(["spacing", "md"]), "space");
    assert.equal(lengthKind(["radius", "md"]), "radius");
    assert.equal(lengthKind(["radii", "lg"]), "radius");
    assert.equal(lengthKind(["font", "size", "md"]), "font-size");
    assert.equal(lengthKind(["fontSize", "md"]), "font-size");
    assert.equal(lengthKind(["text", "md"]), "font-size");
    assert.equal(lengthKind(["font", "weight", "bold"]), undefined);
    assert.equal(lengthKind(["breakpoint", "md"]), undefined);
});

test("a token set holds one mode of the system, and modes pick by color scheme", () => {
    const system = testSystem();
    const light = tokenSet(system, "light");
    const dark = tokenSet(system, "dark");

    assert.equal(light.colors.find((item) => item.name === "color.bg.page")!.css, "#f6f7fb");
    assert.equal(dark.colors.find((item) => item.name === "color.bg.page")!.css, "#101218");
    assert.deepEqual(
        light.fonts.map((font) => font.families[0]),
        ["system-ui", "jetbrains mono"],
    );
    assert.deepEqual(
        light.lengths.map((item) => `${item.kind}:${item.name}`),
        [
            "font-size:font.size.sm",
            "font-size:font.size.md",
            "font-size:font.size.lg",
            "space:space.2",
            "space:space.3",
            "space:space.4",
            "space:space.6",
            "radius:radius.md",
        ],
    );
    assert.deepEqual(modeFor(system, "light"), { mode: "light" });
    assert.deepEqual(modeFor(system, "dark"), { mode: "dark", theme: "dark" });
    assert.deepEqual(modeFor(system, "dark", "light"), { mode: "light" });
    assert.throws(() => modeFor(system, "light", "sepia"), /no mode "sepia"/);
    // A reference keeps its resolved value; a component token is not on a scale.
    const aliased = token("color.alias", "color", { colorSpace: "srgb", components: [1, 0, 0] });

    aliased.modes.light!.css = "var(--color-red)";
    system.tokens.push(
        aliased,
        token("button.padding", "dimension", "10px", undefined, "component"),
    );
    const next = tokenSet(system, "light");

    assert.equal(next.colors.find((item) => item.name === "color.alias")!.css, "color(srgb 1 0 0)");
    assert.equal(
        next.lengths.some((item) => item.name === "button.padding"),
        false,
    );
});

test("analyze: a color near a token is off-system, with the right token to use", () => {
    const empty: RawPage = {
        elements: 3,
        viewport: { width: 390, height: 844 },
        hasViewportMeta: true,
        resolvedColors: [
            [28, 30, 38, 1],
            [90, 95, 115, 1],
            [138, 144, 166, 1],
        ],
        resolvedLengths: [],
        colors: [],
        fonts: [],
        sizes: [],
        contrast: [],
        targets: [],
        images: [],
        headings: [],
        fontFaces: [],
        focus: [],
        pids: [],
    };
    const system = testSystem();
    const set = tokenSet(system, "light");

    // Only three colors are resolved here, in the order of `set.colors`: the page's text, muted, and border colors.
    set.colors = set.colors.filter((item) => /text|border/.test(item.name)).slice(0, 3);
    const el = { selector: "p", pid: "x", rect: { x: 0, y: 0, width: 10, height: 10 } };
    const found = analyze(
        {
            ...empty,
            colors: [
                { rgba: [90, 95, 115, 1], roles: { text: 2 }, count: 2, el },
                { rgba: [107, 113, 128, 1], roles: { text: 1 }, count: 1, el },
                { rgba: [139, 145, 167, 1], roles: { border: 1 }, count: 1, el },
            ],
        },
        set,
    );

    assert.equal(found.length, 1, "an exact color is on the system, and so is one 8-bit step away");
    assert.equal(found[0]!.rule, "off-system-color");
    assert.equal(found[0]!.value, "#6b7180");
    assert.equal(found[0]!.suggestion, "var(--color-text-muted)");
    assert.match(found[0]!.message, /Use var\(--color-text-muted\) \(#5a5f73\)/);
});

test("analyze: reports carry counts, and findings merge once", () => {
    const finding = {
        rule: "contrast" as const,
        level: "error" as const,
        selector: "p",
        message: "m",
    };
    const report = reportOf(
        [finding, { ...finding, rule: "image-alt", level: "warning" }],
        { viewport: { width: 1, height: 1 }, colorScheme: "light" },
        9,
        true,
    );

    assert.deepEqual(report.summary, {
        errors: 1,
        warnings: 1,
        elements: 9,
        byRule: { contrast: 1, "image-alt": 1 },
    });
    assert.equal(report.withoutSystem, true);
    assert.equal(mergeFindings([report, report]).length, 2);
});

test(
    "off-system colors, fonts, and sizes: the page's values against the system's",
    browser,
    async () => {
        const report = await check(
            page(
                ".ok{background:#fff;padding:16px;margin:0 auto;max-width:300px;border-radius:8px;color:#1c1e26}" +
                    ".pill{border-radius:999px;padding:8px 16px;background:#f6f7fb}.round{width:40px;height:40px;border-radius:50%;background:#3b6cf6}",
                `<section class="ok" data-pid="ok-card"><h2 style="margin:0 0 8px;font-size:24px">Title</h2><p style="margin:0;color:#5a5f73;font-size:14px">Body</p><span class="pill">Pill</span><div class="round"></div></section>` +
                    `<p data-pid="off-color" style="margin:0;color:#7ba3f8;background:#fff">Close to the accent</p>` +
                    `<p data-pid="off-font" style="margin:0;font-family:Georgia,serif">Serif</p>` +
                    `<p data-pid="off-mono" style="margin:0;font-family:Menlo,monospace">Mono</p>` +
                    `<p data-pid="off-size" style="margin:0;font-size:15px;padding:14px;border-radius:12px;background:#fff">Sizes</p>`,
            ),
        );

        const color = onPid(report, "off-system-color", "off-color")!;

        assert.equal(color.level, "error");
        assert.equal(color.value, "#7ba3f8");
        assert.equal(
            color.suggestion,
            "var(--color-accent-default)",
            "a role, not the palette's blue.500",
        );
        assert.equal(color.selector, '[data-pid="off-color"]');
        assert.ok(color.rect!.width > 0);
        assert.equal(onPid(report, "off-system-font", "off-font")!.suggestion, "var(--font-body)");
        assert.equal(onPid(report, "off-system-font", "off-mono")!.suggestion, "var(--font-mono)");
        const sizes = ofRule(report, "off-system-size").filter((item) => item.pid === "off-size");

        assert.deepEqual(sizes.map((item) => item.value).sort(), ["12px", "14px", "15px"]);
        assert.equal(
            sizes.find((item) => item.value === "15px")!.suggestion,
            "var(--font-size-sm)",
            "a tie goes to the smaller step",
        );
        assert.equal(sizes.find((item) => item.value === "14px")!.suggestion, "var(--space-3)");
        assert.equal(sizes.find((item) => item.value === "12px")!.suggestion, "var(--radius-md)");
        // The card uses only system values: pills, circles, auto margins, and rem-based scale steps are not findings.
        assert.deepEqual(
            report.findings.filter((item) => item.pid === "ok-card"),
            [],
        );
        assert.equal(report.withoutSystem, false);
        assert.equal(report.colorScheme, "light");
        assert.deepEqual(report.viewport, { width: 390, height: 844 });
    },
);

test(
    "without a system the off-system rules stay quiet and the report says so",
    browser,
    async () => {
        const report = await check(
            page(
                "",
                `<p data-pid="a" style="color:#7ba3f8;font-family:Georgia;font-size:15px;padding:14px">x</p>`,
            ),
            {},
            null,
        );

        assert.equal(report.withoutSystem, true);
        assert.equal(ofRule(report, "off-system-color").length, 0);
        assert.equal(ofRule(report, "off-system-font").length, 0);
        assert.equal(ofRule(report, "off-system-size").length, 0);
    },
);

test("the same value on many elements is one finding with a count", browser, async () => {
    const items = Array.from(
        { length: 5 },
        (_, index) =>
            `<p data-pid="p${index}" style="margin:0;color:#7ba3f8;background:#fff">x</p>`,
    );
    const report = await check(page("", items.join("")));
    const found = ofRule(report, "off-system-color").filter((item) => item.value === "#7ba3f8");

    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /text on 5 elements/);
    assert.equal(found[0]!.pid, "p0");
});

test(
    "contrast uses the real background: layers, alpha, opacity, and large text",
    browser,
    async () => {
        const report = await check(
            page(
                ".t{margin:0;padding:8px}",
                // Fails: grey on white.
                `<p class="t" data-pid="low" style="color:#999">Low contrast</p>` +
                    // Passes: dark on white.
                    `<p class="t" data-pid="ok-dark" style="color:#1c1e26">Fine</p>` +
                    // The background comes from the parent, behind a transparent child.
                    `<div style="background:#1c1e26"><p class="t" data-pid="ok-parent" style="color:#fff">On dark</p><p class="t" data-pid="low-parent" style="color:#2b2f3a">Dark on dark</p></div>` +
                    // A translucent background mixes with what is below it: white at 10% on dark stays dark.
                    `<div style="background:#1c1e26"><div style="background:rgba(255,255,255,0.1)"><p class="t" data-pid="low-alpha" style="color:#444a5a">Alpha layer</p></div></div>` +
                    // A translucent text color mixes with its background: 40% black on white is light grey.
                    `<p class="t" data-pid="low-text-alpha" style="color:rgba(0,0,0,0.45);background:#fff">Alpha text</p>` +
                    // Opacity lowers the contrast of everything inside.
                    `<div style="opacity:0.4"><p class="t" data-pid="low-opacity" style="color:#1c1e26;background:#fff">Faded</p></div>` +
                    // Large text needs 3:1 only: #777 on white is 4.48:1 (fails 4.5, passes 3), #aaa is 2.3:1.
                    `<p class="t" data-pid="ok-large" style="font-size:24px;color:#8a8a8a;background:#fff">Large</p><p class="t" data-pid="low-large" style="font-size:24px;color:#aaa;background:#fff">Large low</p>` +
                    `<p class="t" data-pid="low-bold" style="font-size:19px;font-weight:700;color:#a0a0a0;background:#fff">Bold low</p><p class="t" data-pid="ok-bold" style="font-size:19px;font-weight:700;color:#8a8a8a;background:#fff">Bold</p>` +
                    // Not judged: a disabled control, hidden text, text over a gradient or an image.
                    `<button class="t" disabled data-pid="ok-disabled" style="color:#aaa;background:#fff">Off</button>` +
                    `<p class="t" data-pid="ok-hidden" style="color:#fff;visibility:hidden">Hidden</p>` +
                    `<div style="background:linear-gradient(#fff,#eee)"><p class="t" data-pid="ok-gradient" style="color:#bbb">Over gradient</p></div>` +
                    `<div style="position:relative;height:60px;background:#fff"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="position:absolute;inset:0;width:100%;height:60px"><p class="t" data-pid="ok-image" style="position:absolute;margin:0;color:#ccc">Over image</p></div>`,
            ),
            {},
            null,
        );
        const contrast = ofRule(report, "contrast");
        const pids = contrast.map((item) => item.pid).sort();

        assert.deepEqual(pids, [
            "low",
            "low-alpha",
            "low-bold",
            "low-large",
            "low-opacity",
            "low-parent",
            "low-text-alpha",
        ]);
        const low = onPid(report, "contrast", "low")!;

        assert.equal(low.level, "error");
        assert.equal(low.value, "2.84:1");
        assert.match(low.message, /#999999 on #ffffff is 2\.84:1; text needs 4\.5:1/);
        assert.match(onPid(report, "contrast", "low-large")!.message, /large text needs 3:1/);
    },
);

test("a contrast finding names the system color that passes", browser, async () => {
    const report = await check(
        page(
            "",
            `<p data-pid="low" style="margin:0;padding:8px;color:#8a90a6;background:#fff">Muted</p>`,
        ),
    );
    const finding = onPid(report, "contrast", "low")!;

    assert.equal(finding.suggestion, "var(--color-text-muted)");
    assert.match(finding.message, /Use var\(--color-text-muted\) \(#5a5f73, 6\.3\d:1\)/);
});

test("a form field's edge needs 3:1 against what it sits on (a warning)", browser, async () => {
    const report = await check(
        page(
            "input{display:block;box-sizing:border-box;width:200px;height:44px;margin:8px;padding:8px;border:1px solid;font:inherit}",
            `<input data-pid="low-edge" style="border-color:#ddd;background:#fff">` +
                `<input data-pid="ok-edge" style="border-color:#777;background:#fff">` +
                `<input data-pid="ok-bare" style="border:0;background:transparent;box-shadow:none">`,
        ),
        {},
        null,
    );
    const finding = onPid(report, "contrast", "low-edge")!;

    assert.equal(finding.level, "warning");
    assert.match(finding.message, /edge of a form field/);
    assert.equal(onPid(report, "contrast", "ok-edge"), undefined);
    assert.equal(onPid(report, "contrast", "ok-bare"), undefined);
});

test(
    "tap targets: under 24 px fail when crowded, under 44 px warn on a phone",
    browser,
    async () => {
        const css =
            "a,button{display:inline-block;margin:0;padding:0;color:#1c1e26}" +
            ".gap{margin-right:40px}";
        const body =
            // Two 16 px links side by side: their 24 px circles meet.
            `<div data-pid="crowded"><a href="#" style="width:16px;height:16px;background:#ccc"></a><a href="#" style="width:16px;height:16px;background:#ccc"></a></div>` +
            // One 16 px link far from the others: the spacing exception holds.
            `<div data-pid="ok-spaced" style="margin-top:80px"><a class="gap" href="#" style="width:16px;height:16px;background:#ccc"></a></div>` +
            // A link inside a sentence is exempt.
            `<p data-pid="ok-inline" style="margin-top:80px">Read the <a href="#" style="display:inline">full story</a> today.</p>` +
            // 36 px: warns on a phone.
            `<button data-pid="warn" style="margin-top:80px;width:120px;height:36px">Small</button>` +
            `<button data-pid="ok-big" style="margin-top:80px;width:120px;height:48px">Big</button>` +
            // A checkbox with a big label is a big target.
            `<label data-pid="ok-label" style="display:block;margin-top:80px;height:48px"><input type="checkbox"> Gift</label>` +
            `<input data-pid="bare-checkbox" type="checkbox" style="margin-top:80px;display:block">`;
        const phone = await check(page(css, body), {}, null);
        const crowded = onPid(phone, "tap-target", "crowded")!;

        assert.equal(crowded.level, "error");
        assert.equal(crowded.value, "16×16px");
        assert.match(crowded.message, /\(and 1 more element\)/, "equal targets are one finding");
        assert.equal(onPid(phone, "tap-target", "ok-spaced"), undefined);
        assert.equal(onPid(phone, "tap-target", "ok-inline"), undefined);
        assert.equal(onPid(phone, "tap-target", "warn")!.level, "warning");
        assert.equal(onPid(phone, "tap-target", "ok-big"), undefined);
        assert.equal(onPid(phone, "tap-target", "ok-label"), undefined);
        assert.equal(
            onPid(phone, "tap-target", "bare-checkbox"),
            undefined,
            "a native checkbox is the browser's",
        );
        // On a desktop viewport the 44 px advice is dropped; the 24 px floor stays.
        const desktop = await check(page(css, body), { viewport: "desktop" }, null);

        assert.equal(onPid(desktop, "tap-target", "warn"), undefined);
        assert.equal(onPid(desktop, "tap-target", "crowded")!.level, "error");
    },
);

test("overflow: a page that scrolls sideways, or hides what does not fit", browser, async () => {
    const wide = await check(
        page("", `<div data-pid="wide" style="width:600px;height:20px;background:#ccc"></div>`),
        {},
        null,
    );
    const finding = ofRule(wide, "overflow")[0]!;

    assert.equal(finding.level, "error");
    assert.equal(finding.pid, "wide");
    assert.match(finding.value!, /^6\d\dpx in 390px$/);
    const fits = await check(
        page(
            "",
            `<div data-pid="scroller" style="width:100%;overflow-x:auto"><div style="width:900px;height:20px;background:#ccc"></div></div><div style="position:fixed;left:0;top:0;width:900px;height:2px;background:#ccc"></div>`,
        ),
        {},
        null,
    );

    assert.equal(
        ofRule(fits, "overflow").length,
        0,
        "a box that scrolls itself, or a fixed bar, is fine",
    );
    const clipped = await check(
        page(
            "body{overflow-x:hidden}",
            `<div data-pid="cut" style="width:600px;height:20px;background:#ccc"></div>`,
        ),
        {},
        null,
    );

    assert.equal(ofRule(clipped, "overflow")[0]!.level, "warning");
    assert.match(ofRule(clipped, "overflow")[0]!.message, /cut off/);
});

test("images need alt text; headings keep their order", browser, async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const report = await check(
        page(
            "",
            `<img data-pid="no-alt" src="${gif}" width="10" height="10">` +
                `<img data-pid="ok-alt" src="${gif}" alt="A dot" width="10" height="10">` +
                `<img data-pid="ok-decor" src="${gif}" alt="" width="10" height="10">` +
                `<svg data-pid="no-name" role="img" width="10" height="10"></svg>` +
                `<svg data-pid="ok-name" role="img" aria-label="Logo" width="10" height="10"></svg>` +
                `<h1 data-pid="h1">One</h1><h2 data-pid="h2">Two</h2><h4 data-pid="h4">Four</h4><h3 data-pid="h3">Three</h3><h2 data-pid="h2b">Two again</h2>`,
        ),
        {},
        null,
    );

    assert.deepEqual(
        ofRule(report, "image-alt")
            .map((item) => item.pid)
            .sort(),
        ["no-alt", "no-name"],
    );
    assert.equal(ofRule(report, "image-alt")[0]!.level, "error");
    const jumps = ofRule(report, "heading-order");

    assert.deepEqual(
        jumps.map((item) => [item.pid, item.value]),
        [["h4", "h4 after h2"]],
    );
    assert.equal(jumps[0]!.level, "warning");
});

test(
    "fonts: one that is declared but not loaded is reported, system and installed ones are not",
    browser,
    async () => {
        const missing = await check(
            page(
                "",
                `<p data-pid="gone" style="font-family:'Zzyzx Display',sans-serif">Missing</p>` +
                    `<p data-pid="ok-system" style="font-family:system-ui,sans-serif">System</p>` +
                    `<p data-pid="ok-arial" style="font-family:Arial,sans-serif">Arial</p>` +
                    `<p data-pid="ok-mono" style="font-family:monospace">Mono</p>`,
            ),
            {},
            null,
        );
        const found = ofRule(missing, "font-fallback");

        assert.deepEqual(
            found.map((item) => item.pid),
            ["gone"],
        );
        assert.equal(found[0]!.level, "warning");
        assert.equal(found[0]!.value, "Zzyzx Display");
        // A face that is declared and fails to load is an error. One that loads is quiet.
        const face = (name: string, url: string) =>
            `@font-face{font-family:'${name}';src:url(${url}) format('woff2')}`;
        const loaded = await check(
            page(
                face("Broken Face", "fonts/none.woff2") +
                    face("Real Face", "fonts/real.ttf") +
                    ".a{font-family:'Broken Face',sans-serif}.b{font-family:'Real Face',sans-serif}",
                `<p class="a" data-pid="broken">Broken</p><p class="b" data-pid="ok-real">Real</p>`,
            ),
            {},
            null,
            [{ name: "fonts/real.ttf", type: "font/ttf", bytes: await realFont() }],
        );
        const broken = ofRule(loaded, "font-fallback");

        assert.deepEqual(
            broken.map((item) => item.pid),
            ["broken"],
        );
        assert.equal(broken[0]!.level, "error");
        assert.match(broken[0]!.message, /@font-face did not load/);
    },
);

/** Any real font file on this machine, so a face can load. A skip is not possible here: the test needs one. */
async function realFont(): Promise<Buffer> {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const path = execFileSync("fc-match", ["-f", "%{file}", "sans-serif:fontformat=TrueType"])
        .toString()
        .trim();

    return readFileSync(path);
}

test(
    "the viewport meta tag and data-pid are checked (a deck needs no viewport)",
    browser,
    async () => {
        const bare = await check(
            `<!doctype html><title>x</title><h1>Hi</h1><button>Go</button>`,
            {},
            null,
        );
        const viewport = ofRule(bare, "missing-viewport");

        assert.equal(viewport.length, 1);
        assert.equal(viewport[0]!.level, "error");
        assert.equal(viewport[0]!.selector, "");
        const pid = ofRule(bare, "missing-pid");

        assert.equal(pid.length, 1, "one finding names every tag");
        assert.equal(pid[0]!.level, "warning");
        assert.match(pid[0]!.message, /2 elements.*<h1>.*<button>/);
        const tagged = await check(
            page("", `<main data-pid="main"><h1>Hi</h1><button>Go</button></main>`),
            {},
            null,
        );

        assert.equal(
            ofRule(tagged, "missing-pid").length,
            0,
            "a parent's data-pid covers its children",
        );
        assert.equal(ofRule(tagged, "missing-viewport").length, 0);
        const deck = await check(
            `<!doctype html><meta name="pocket-kind" content="deck"><section class="slide" data-pid="s1"><h1>Hi</h1></section>`,
            {},
            null,
        );

        assert.equal(ofRule(deck, "missing-viewport").length, 0);
    },
);

test(
    "focus: an element with no visible focus style is reported; rings, shadows, and sibling styles count",
    browser,
    async () => {
        const report = await check(
            page(
                "a,button{display:inline-block;min-height:48px;min-width:48px;margin:8px}" +
                    ".none{outline:none}" +
                    ".ring:focus-visible{outline:2px solid #3b6cf6}" +
                    ".shadow{outline:none}.shadow:focus-visible{box-shadow:0 0 0 3px #3b6cf6}" +
                    ".bg{outline:none}.bg:focus-visible{background:#3b6cf6;color:#fff}" +
                    ".box{display:inline-block;width:24px;height:24px;border:2px solid #777}" +
                    "input.sr,input.sr2{position:absolute;opacity:0;width:24px;height:24px}input.sr2{outline:none}input.sr:focus-visible + .box{outline:2px solid #3b6cf6}",
                `<a class="none" href="#" data-pid="no-focus">None</a>` +
                    `<a class="ring" href="#" data-pid="ok-ring">Ring</a>` +
                    `<button class="shadow" data-pid="ok-shadow">Shadow</button>` +
                    `<button class="bg" data-pid="ok-bg">Fill</button>` +
                    `<a href="#" data-pid="ok-default">Default ring</a>` +
                    `<label data-pid="ok-sibling"><input class="sr" type="checkbox"><span class="box"></span></label>` +
                    `<label data-pid="no-sibling"><input class="sr2" type="radio"><span class="box" style="margin-left:40px"></span></label>`,
            ),
            {},
            null,
        );
        const found = ofRule(report, "focus-visible");

        assert.deepEqual(found.map((item) => item.pid).sort(), ["no-focus", "no-sibling"]);
        assert.equal(found[0]!.level, "warning");
        assert.match(found.find((item) => item.pid === "no-focus")!.message, /outline is removed/);
    },
);

test("a dark color scheme compares with the dark mode of the system", browser, async () => {
    const content = page(
        "@media (prefers-color-scheme: dark){body{background:#101218;color:#e6e8f0}}",
        `<p data-pid="text" style="margin:0;padding:8px;color:#e6e8f0;background:#101218">Dark text</p>`,
    );
    const light = await check(content, { colorScheme: "light" });
    const dark = await check(content, { colorScheme: "dark" });

    assert.equal(dark.colorScheme, "dark");
    assert.ok(onPid(light, "off-system-color", "text"), "dark values are off the light mode");
    assert.equal(onPid(dark, "off-system-color", "text"), undefined, "and on the dark mode");
    assert.equal(ofRule(dark, "contrast").length, 0);
    // An explicit mode wins over the scheme.
    const forced = await check(content, { colorScheme: "dark", mode: "light" });

    assert.ok(onPid(forced, "off-system-color", "text"));
    await assert.rejects(check(content, { mode: "sepia" }), /no mode "sepia"/);
});

test(
    "tweaks, another page of the bundle, and actions apply before the checks",
    browser,
    async () => {
        const manifest = `<script type="application/json" id="pocket-tweaks">[{"name":"--pad","type":"range","value":16,"unit":"px"}]</script>`;
        const content = page(
            ":root{--pad:16px}a.btn{display:inline-block;padding:var(--pad);color:#1c1e26;background:#fff}a.btn:hover{color:#bbb}",
            `<a class="btn" href="#" data-pid="btn">Go</a><a href="about.html" data-pid="about">About</a>${manifest}`,
        );
        const plain = await check(content);

        assert.equal(onPid(plain, "off-system-size", "btn"), undefined);
        const tweaked = await check(content, { tweaks: { "--pad": 15 } });

        assert.equal(
            onPid(tweaked, "off-system-size", "btn")!.value,
            "15px",
            "a number takes the knob's unit",
        );
        // An action runs first: after a hover the button's text is too light.
        const hovered = await check(content, { actions: [{ type: "hover", selector: "a.btn" }] });

        assert.ok(onPid(hovered, "contrast", "btn"));
        assert.equal(onPid(plain, "contrast", "btn"), undefined);
        // Another page of the bundle is the page that is checked.
        const about = bundleOf(content, [
            {
                name: "about.html",
                type: "text/html; charset=utf-8",
                bytes: Buffer.from(
                    page(
                        "",
                        `<p data-pid="about-text" style="margin:0;color:#999;background:#fff">Hi</p>`,
                    ),
                ),
            },
        ]);
        const other = await checkDesign(
            about,
            undefined,
            { viewport: "mobile", page: "about.html" },
            host,
        );

        assert.ok(onPid(other, "contrast", "about-text"));
        assert.equal(onPid(other, "contrast", "btn"), undefined);
    },
);

test("a deck is checked one slide at a time, or all of them", browser, async () => {
    const content =
        `<!doctype html><meta name="pocket-kind" content="deck"><meta name="viewport" content="width=device-width"><style>body{margin:0}.slide{width:1280px;height:720px;background:#fff;padding:16px}</style>` +
        `<section class="slide" data-pid="s1"><p style="margin:0;color:#1c1e26">Fine</p></section>` +
        `<section class="slide" data-pid="s2"><p style="margin:0;color:#ccc">Pale</p></section>`;
    const first = await check(content, { viewport: "desktop" }, null);
    const second = await check(content, { viewport: "desktop", slide: 2 }, null);
    const all = await check(content, { viewport: "desktop", slide: "all" }, null);

    assert.equal(ofRule(first, "contrast").length, 0);
    assert.equal(ofRule(second, "contrast")[0]!.pid, "s2");
    assert.equal(ofRule(all, "contrast")[0]!.pid, "s2");
    assert.equal(
        ofRule(first, "overflow").length,
        0,
        "a deck is scaled, so it has no overflow rule",
    );
});

test("a page cannot change the objects the check uses", browser, async () => {
    const hostile = `<script>
        Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 });
        window.getComputedStyle = () => { throw new Error("tampered"); };
        Element.prototype.querySelectorAll = () => { throw new Error("tampered"); };
        Array.from = () => { throw new Error("tampered"); };
        JSON.stringify = () => "{}";
        CSS.escape = () => "x";
    </script>`;
    const report = await check(
        page(
            "",
            `${hostile}<p data-pid="low" style="margin:0;padding:8px;color:#999;background:#fff">Low</p>`,
        ),
        {},
        null,
    );

    assert.equal(onPid(report, "contrast", "low")!.value, "2.84:1");
    assert.equal(
        onPid(report, "contrast", "low")!.rect!.height > 20,
        true,
        "real geometry, not the page's",
    );
});

test("a page made only of system values has no findings at all", browser, async () => {
    const report = await check(
        page(
            "main{padding:16px;display:grid;gap:8px;max-width:420px;margin:0 auto}h1{margin:0;font-size:24px}p{margin:0;font-size:14px;color:#5a5f73}" +
                "a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;border-radius:8px;background:#3b6cf6;color:#fff;text-decoration:none}" +
                "a.btn:focus-visible{outline:2px solid #1c1e26;outline-offset:2px}",
            `<main data-pid="main"><h1>Welcome</h1><p>Small batches, roasted weekly.</p><a class="btn" href="#">Start</a><img alt="" width="8" height="8" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>`,
        ),
    );

    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.summary.byRule, {});
    assert.ok(report.summary.elements >= 5);
});

test("the page script's answer is untrusted: strings are cut and malformed groups skipped", () => {
    const el = {
        selector: "x".repeat(2000),
        pid: "p".repeat(2000),
        rect: { x: 1, y: 2, width: 3, height: 4 },
    };
    const raw = {
        elements: "many",
        viewport: { width: 1, height: 1 },
        hasViewportMeta: true,
        resolvedColors: [],
        resolvedLengths: [],
        colors: [{ rgba: "red", roles: {}, count: 1, el }],
        fonts: [],
        sizes: [],
        contrast: [{ fg: [0, 0, 0], bg: [1, 1], size: 1, large: false, ui: false, count: "x", el }],
        targets: [{ level: "error", width: "wide", height: 5, tag: "a".repeat(500), count: 1, el }],
        images: [{ tag: "img", why: "w".repeat(500), count: 1, el }],
        headings: [],
        fontFaces: [],
        focus: [],
        pids: [],
    } as unknown as RawPage;
    const found = analyze(raw, tokenSet(testSystem(), "light"));

    assert.equal(found.length, 2);
    assert.ok(found.every((item) => item.selector.length <= 500 && (item.pid?.length ?? 0) <= 200));
    assert.ok(found.every((item) => item.message.length < 400));
    assert.equal(found.find((item) => item.rule === "tap-target")!.value, "0×5px");
});
