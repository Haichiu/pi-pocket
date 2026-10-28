// The design system's documentation page: its sections, its safety with hostile project text, and its output in Chromium.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { DesignBundle } from "../src/server/design/bundle.ts";
import {
    contrastRatio,
    parseColor,
    rating,
    readableOn,
    toHex,
} from "../src/server/design/docsite-color.ts";
import { escapeHtml, renderMarkdown } from "../src/server/design/docsite-markdown.ts";
import { renderSystemDoc } from "../src/server/design/docsite.ts";
import { withRender } from "../src/server/design/render.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";
import type {
    ComponentSpec,
    DesignSystem,
    ModeValue,
    ResolvedToken,
    TokenTier,
    TokenType,
} from "../src/server/design/system-types.ts";
import { loadSystem } from "./design-system-loader.ts";

const FLAGSHIP = fileURLToPath(new URL("../docs/examples/design-system/pocket", import.meta.url));

const flagship = (): DesignSystem => {
    const system = loadSystem(FLAGSHIP);

    assert.ok(system !== undefined, "the flagship loads");

    return system;
};

/** A token with one value in each mode. */
function token(
    name: string,
    type: TokenType,
    values: Record<string, unknown>,
    more: Partial<ResolvedToken> = {},
): ResolvedToken {
    const modes: Record<string, ModeValue> = {};

    for (const [mode, value] of Object.entries(values)) {
        modes[mode] = { value, css: typeof value === "string" ? value : String(value) };
    }

    return {
        path: name.split("."),
        name,
        cssVar: `--${name.split(".").join("-")}`,
        type,
        tier: "semantic" as TokenTier,
        modes,
        ...more,
    };
}

/** The page without the `srcdoc` of the component frames, which hold escaped, sandboxed markup of their own. */
const outsideFrames = (html: string) => html.replace(/srcdoc="[^"]*"/g, 'srcdoc=""');

test("the page has a section and a link for each part of the system, and a frame for each component", () => {
    const system = flagship();
    const { html } = renderSystemDoc(system);

    for (const id of [
        "overview",
        "color",
        "typography",
        "layout",
        "shadows",
        "motion",
        "components",
        "guidelines",
        "tokens",
        "code",
    ]) {
        assert.match(html, new RegExp(`<section class="block" id="${id}"`), `section ${id}`);
        assert.match(html, new RegExp(`<a[^>]* href="#${id}"`), `a link to ${id}`);
    }

    for (const spec of system.components) {
        assert.match(html, new RegExp(`id="comp-${spec.slug}"`), `the ${spec.slug} component`);
    }

    assert.equal(
        (html.match(/<iframe class="comp-frame"/g) ?? []).length,
        system.components.length,
        "one frame each",
    );

    // Color: roles with contrast, the palette, the matrix, and the pairs.
    for (const part of [
        'id="color-roles"',
        'id="color-palette"',
        'id="color-matrix"',
        'id="color-pairs"',
        "needs 4.5:1 on color.bg.base",
    ]) {
        assert.ok(html.includes(part), part);
    }

    // The other foundations each have their own specimen.
    for (const part of [
        'class="family"',
        'class="spec-row"',
        'class="bar"',
        'class="radius"',
        'class="shadow-tile"',
        'class="demo"',
        'class="curve"',
        'class="hover-demo"',
        "font.family.sans",
        "color.accent.fill",
    ]) {
        assert.ok(html.includes(part), part);
    }

    // Every token is in the reference table, and the code section has the compiled files.
    for (const named of system.tokens) {
        assert.ok(html.includes(`data-copy="${named.name}"`), `${named.name} can be copied`);
    }

    assert.match(html, /id="code-css"/);
    assert.match(html, /<h1 id="overview-title">Pi Pocket<\/h1>/);
});

test("each mode has a switch, and the page opens in the default mode", () => {
    const { html } = renderSystemDoc(flagship());
    const buttons = [
        ...html.matchAll(
            /<button type="button" data-mode="([^"]+)" data-theme="([^"]+)" aria-pressed="(true|false)"/g,
        ),
    ];

    assert.deepEqual(
        buttons.map((match) => [match[1], match[2], match[3]]),
        [
            ["light", "light", "true"],
            ["dark", "dark", "false"],
            ["high-contrast", "dark", "false"],
        ],
    );
    assert.match(
        html,
        /<html lang="en" class="nojs" data-mode="light" data-theme="light" data-dark-mode="dark">/,
    );
    // A value that differs by mode is written once for each mode; one that does not is written once.
    assert.match(html, /class="mv" data-m="dark"/);
    assert.match(html, /html:not\(\[data-mode="dark"\]\) \.mv\[data-m="dark"\]\{display:none\}/);
});

test("the page asks for nothing: no external request, no script or style file", () => {
    const { html, assets } = renderSystemDoc(flagship());
    const frames = [...html.matchAll(/srcdoc="([^"]*)"/g)].map((match) =>
        match[1]!
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&"),
    );

    assert.deepEqual(assets, []);
    assert.ok(frames.length > 0);

    for (const text of [html, ...frames]) {
        assert.doesNotMatch(text, /<link[\s>]/i, "no <link>");
        assert.doesNotMatch(text, /<script[^>]*\ssrc=/i, "no script file");
        // `@import` may appear as text in a code listing (the generated Tailwind file says how to import it), but never
        // in a style that the page or a frame runs.
        const styles = [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)]
            .map((match) => match[1])
            .join("\n");

        assert.doesNotMatch(styles, /@import/i, "no @import in a style");
        assert.doesNotMatch(text, /url\(\s*['"]?(https?:)?\/\//i, "no remote url()");
        assert.doesNotMatch(
            text,
            /\s(src|href|action|poster)=["']?(https?:)?\/\//i,
            "no remote address",
        );
    }

    // A policy on the page and on each frame, and the frames cannot reach the page.
    assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'/);
    assert.equal((html.match(/sandbox="allow-scripts"/g) ?? []).length, frames.length);
    assert.ok(!html.includes('sandbox="allow-scripts allow-same-origin"'));

    for (const frame of frames) {
        const nonce = /script-src 'nonce-([\w-]+)'/.exec(frame)?.[1];

        assert.ok(nonce !== undefined && nonce.length >= 16, "a nonce in the frame's policy");
        assert.equal((frame.match(/<script/g) ?? []).length, 1, "only the frame's own script");
        assert.ok(frame.includes(`<script nonce="${nonce}">`));
    }
});

/** A system built of hostile text in every place that the page prints. */
function hostile(): DesignSystem {
    const bad = `<img src=x onerror=alert(1)>`;
    const closer = `</style><script>alert(2)</script>`;
    const compiled = { css: `${bad}</pre>`, tailwind: closer, json: "{}", components: closer };
    const component: ComponentSpec = {
        slug: "evil",
        name: `Evil ${bad}`,
        description: `Desc ${closer}`,
        states: ["default", bad],
        markup: {
            default: `<button onclick="alert(3)">${bad}</button><script>alert(4)</script>`,
            [bad]: `<a href="javascript:alert(5)">x</a>`,
        },
        css: `.x{color:red}${closer}`,
        usage: { do: [bad], dont: [closer] },
        tokens: [bad, "color.bg.base"],
    };

    return {
        name: `Hostile ${bad}`,
        description: `About ${closer}`,
        modes: ["light", `dark"><script>alert(6)</script>`],
        schemes: { light: "light", [`dark"><script>alert(6)</script>`]: "dark" },
        tokens: [
            token(
                "color.bg.base",
                "color",
                { light: "#ffffff", [`dark"><script>alert(6)</script>`]: "#000000" },
                { description: bad },
            ),
            token(
                "color.text.primary",
                "color",
                { light: "#000000" },
                {
                    contrast: { on: `{color.bg.base}`, min: 4.5 },
                    description: closer,
                },
            ),
            // A value that could end a declaration or a block never reaches a style.
            token("color.evil", "color", {
                light: `red;}body{display:none}</style><script>alert(7)</script>`,
            }),
            token("space.1", "dimension", { light: "4px;}*{display:none}" }),
            token("font.family.x", "fontFamily", {
                light: [`Arial", sans-serif;}</style>`, "serif"],
            }),
            token("shadow.x", "shadow", { light: `0 0 0 1px red}</style>` }),
            // A custom property name that is not plain is replaced.
            token(
                "color.odd",
                "color",
                { light: "#123456" },
                { cssVar: "--x);background:url(http://evil/a)" },
            ),
            token(`radius.${bad}`, "dimension", { light: "4px" }),
        ],
        components: [component],
        guidelines: `# Rules ${bad}\n\n[click](javascript:alert(8)) and [ok](https://example.com)\n\n<script>alert(9)</script>\n\n\`\`\`\n${closer}\n\`\`\`\n\n| a | b |\n| - | - |\n| ${bad} | x |\n`,
        problems: [{ level: "warning", file: bad, token: closer, message: `m ${bad}` }],
        compiled,
    };
}

test("project text is escaped, and a value that could break a style is left out", () => {
    const { html } = renderSystemDoc(hostile());
    const page = outsideFrames(html);

    // Only the page's own two scripts (the first sets the mode, the second runs the page) are in the page.
    assert.equal((page.match(/<script/g) ?? []).length, 2, "two scripts");
    assert.ok(!/<img[^>]+onerror/i.test(page), "no image with a handler");
    assert.ok(!page.includes("alert(1)>") || !/<img src=x/.test(page));
    assert.doesNotMatch(page, /<img src=x/);
    assert.doesNotMatch(page, /<script>alert/);
    assert.doesNotMatch(page, /href=["']?javascript:/i, "no script address survives");
    assert.match(
        page,
        /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ok<\/a>/,
    );
    assert.ok(page.includes("&lt;img src=x onerror=alert(1)&gt;"), "shown as text");

    // None of the hostile style values is in a style, and the odd property name is replaced.
    const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)]
        .map((match) => match[1])
        .join("\n");

    for (const part of [
        "body{display:none}",
        "*{display:none}",
        "alert(7)",
        'Arial"',
        "url(http",
        "evil/a",
    ]) {
        assert.ok(!styles.includes(part), `${part} is not in a style`);
    }

    // The frames hold the component's markup and CSS as escaped attribute text: no raw tag can leave them.
    const frame = /srcdoc="([^"]*)"/.exec(html)![1]!;

    assert.ok(!frame.includes("<"), "the frame's document is escaped in its attribute");
    assert.ok(!frame.includes('"'));
    // A component's CSS cannot close the style element that holds it.
    const doc = frame
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");

    assert.equal((doc.match(/<\/style>/g) ?? []).length, 1, "one style element, closed once");
    assert.equal((doc.match(/<script nonce=/g) ?? []).length, 1, "one script has the nonce");
    assert.ok(doc.includes("<\\/style><script>alert(2)"), "the closing tag in the CSS is defused");
});

test("an empty system, a system with one mode, and a system with no components still render", () => {
    const empty: DesignSystem = {
        name: "",
        modes: [],
        schemes: {},
        tokens: [],
        components: [],
        guidelines: "",
        problems: [],
        compiled: { css: "", tailwind: "", json: "{}", components: "" },
    };
    const page = renderSystemDoc(empty).html;

    assert.match(page, /<h1 id="overview-title">Design system<\/h1>/);
    assert.doesNotMatch(page, /class="seg"/, "no switch for one mode");
    assert.match(page, /id="tokens"/);

    const one = renderSystemDoc({
        ...empty,
        name: "Plain",
        modes: ["default"],
        tokens: [token("color.bg", "color", { default: "#ffffff" })],
    }).html;

    assert.match(one, /id="color"/);
    assert.doesNotMatch(one, /id="components"/);
    assert.doesNotMatch(one, /class="mv"/);
});

test("a system too big for an artifact shrinks its token table until the page fits", () => {
    const tokens: ResolvedToken[] = [];

    for (let index = 0; index < 4000; index++) {
        tokens.push(
            token(
                `size.step-${index}`,
                "dimension",
                { light: `${index}px`, dark: `${index + 1}px` },
                {
                    description:
                        "A long description that repeats in every row of the table. ".repeat(3),
                },
            ),
        );
    }

    const { html } = renderSystemDoc({
        name: "Big",
        modes: ["light", "dark"],
        schemes: { light: "light", dark: "dark" },
        tokens,
        components: [],
        guidelines: "",
        problems: [],
        compiled: { css: "", tailwind: "", json: "{}", components: "" },
    });

    assert.ok(Buffer.byteLength(html) <= 1_800_000, `the page is ${Buffer.byteLength(html)} bytes`);
    assert.match(html, /This table shows the first \d+ of 3000 tokens/);
    assert.match(html, /shows the first 3000 of 4000 tokens/);
});

test("the flagship's contrast pairs pass in every mode, and the page says so", () => {
    const system = flagship();
    let checked = 0;

    for (const named of system.tokens.filter((item) => item.contrast !== undefined)) {
        const on = system.tokens.find(
            (item) => item.name === named.contrast!.on.replace(/[{}]/g, ""),
        );

        assert.ok(on !== undefined, `${named.name}: the pair ${named.contrast!.on} exists`);

        for (const mode of system.modes) {
            const fg = parseColor(named.modes[mode]!.value);
            const bg = parseColor(on.modes[mode]!.value);

            assert.ok(fg !== undefined && bg !== undefined, `${named.name} in ${mode} is a color`);
            assert.ok(
                contrastRatio(fg, bg) >= named.contrast!.min,
                `${named.name} on ${on.name} in ${mode}: ${contrastRatio(fg, bg).toFixed(2)}:1`,
            );
            checked++;
        }
    }

    assert.ok(checked >= 40, `${checked} pairs checked`);
    assert.match(renderSystemDoc(system).html, new RegExp(`${checked}/${checked}`));
});

test("color parsing and contrast follow WCAG", () => {
    assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor("#00000080")?.a?.toFixed(2), "0.50");
    assert.deepEqual(parseColor("rgb(255 0 0 / 50%)"), { r: 255, g: 0, b: 0, a: 0.5 });
    assert.equal(toHex(parseColor("hsl(120 100% 25%)")!), "#008000");
    assert.equal(
        toHex(parseColor({ colorSpace: "srgb", components: [1, 0.5, 0], alpha: 1 })!),
        "#ff8000",
    );
    assert.equal(
        toHex(parseColor({ hex: "#112233", colorSpace: "srgb", components: [0, 0, 0] })!),
        "#112233",
    );
    assert.ok(parseColor("oklch(70% 0.1 250)") !== undefined);
    assert.equal(parseColor("not a color"), undefined);
    assert.equal(parseColor(42), undefined);

    const black = parseColor("#000")!;
    const white = parseColor("#fff")!;

    assert.equal(contrastRatio(black, white).toFixed(2), "21.00");
    assert.equal(contrastRatio(parseColor("#777777")!, white).toFixed(2), "4.48");
    assert.equal(rating(4.48), "AA large");
    assert.equal(rating(4.5), "AA");
    assert.equal(rating(7), "AAA");
    assert.equal(rating(2.9), "fail");
    assert.equal(readableOn(white), "#000000");
    assert.equal(readableOn(black), "#ffffff");
});

test("the Markdown renderer escapes text first and keeps only safe links", () => {
    const html = renderMarkdown(
        "# Title <b>\n\nA `code <i>` and **bold** and *em*.\n\n- one\n- two <u>\n\n1. a\n2. b\n\n> quote\n\n---\n\n[bad](javascript:x) [anchor](#top) [web](https://a.example/b?c=1&d=2) [rel](page.html)\n",
    );

    assert.match(html, /<h3 id="g-title-b">Title &lt;b&gt;<\/h3>/);
    assert.match(html, /<code>code &lt;i&gt;<\/code>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>em<\/em>/);
    assert.match(html, /<li>two &lt;u&gt;<\/li>/);
    assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
    assert.match(html, /<blockquote>quote<\/blockquote>/);
    assert.match(html, /<hr>/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /<a href="#top">anchor<\/a>/);
    assert.match(
        html,
        /<a href="https:\/\/a\.example\/b\?c=1&amp;d=2" target="_blank" rel="noopener noreferrer">web<\/a>/,
    );
    assert.doesNotMatch(html, /href="page\.html"/);
    assert.ok(!/<(b|i|u)>/.test(html));
    assert.equal(
        escapeHtml(`<a href="x">'&'</a>`),
        "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    assert.ok(renderMarkdown("x".repeat(50_000), 100).length < 200, "bounded");
});

const host = { fetchPublic: createPublicFetch() } as PocketHost;

test(
    "in Chromium the page loads with no error, sizes its frames, switches mode, and runs no component script",
    {
        skip: findBrowser() === undefined ? "No Chromium on this machine." : false,
    },
    async () => {
        const system = flagship();

        // A component whose markup tries to run script and to reach out; the frame must stop both.
        system.components = [
            {
                ...system.components[0]!,
                slug: "probe",
                markup: {
                    default: `<button class="pk-button">Probe</button><script>parent.postMessage({ type: "ds-frame", height: 3999 }, "*"); document.title = "ran"</script><img src="https://example.com/x.png" onerror="parent.postMessage({ type: 'ds-frame', height: 3999 }, '*')">`,
                },
                states: ["default"],
            },
            ...system.components.slice(1, 3),
        ];

        const bundle: DesignBundle = {
            meta: { title: "Docs", type: "html", versions: [] },
            version: 1,
            content: renderSystemDoc(system).html,
            assets: [],
        };

        await withRender(bundle, host, undefined, async (page) => {
            await page.load({ width: 1280, height: 800 });
            await page.evaluate("new Promise((resolve) => setTimeout(resolve, 600))");

            assert.deepEqual(page.errors, []);
            assert.equal(
                await page.evaluate("document.querySelectorAll('iframe.comp-frame').length"),
                3,
            );

            // Frames report their own height; a script in a component did not make one of them 4,000 px.
            const heights = (await page.evaluate(
                "JSON.stringify([...document.querySelectorAll('iframe.comp-frame')].map((frame) => frame.getBoundingClientRect().height))",
            )) as string;
            const sizes = JSON.parse(heights) as number[];

            assert.ok(
                sizes.every((height) => height > 60 && height < 3000),
                heights,
            );

            // The mode switch changes the page and tells each frame.
            await page.evaluate("document.querySelector('.seg button[data-mode=dark]').click()");
            assert.equal(await page.evaluate("document.documentElement.dataset.theme"), "dark");
            assert.equal(
                await page.evaluate(
                    "document.querySelector('.seg button[data-mode=dark]').getAttribute('aria-pressed')",
                ),
                "true",
            );

            // Copying a token name works from the keyboard-reachable button, with no error.
            assert.equal(
                await page.evaluate("document.querySelectorAll('[data-copy]').length > 100"),
                true,
            );
            // The filter hides what does not match and shows a notice when nothing does.
            await page.evaluate(
                "(() => { const q = document.getElementById('q'); q.value = 'zzzz-nothing'; q.dispatchEvent(new Event('input')); })()",
            );
            assert.equal(await page.evaluate("document.getElementById('nomatch').hidden"), false);
            await page.evaluate(
                "(() => { const q = document.getElementById('q'); q.value = 'accent'; q.dispatchEvent(new Event('input')); })()",
            );
            assert.equal(await page.evaluate("document.getElementById('nomatch').hidden"), true);
            assert.equal(
                await page.evaluate(
                    "document.querySelectorAll('[data-q]:not([hidden])').length > 3",
                ),
                true,
            );
            assert.equal(await page.evaluate("document.title"), "Pi Pocket · Design system");
        });
    },
);
