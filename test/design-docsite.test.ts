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
import {
    article,
    escapeHtml,
    plural,
    renderMarkdown,
} from "../src/server/design/docsite-markdown.ts";
import { sectionOf } from "../src/server/design/docsite-core.ts";
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

/** The page without the code listings, which hold project markup and CSS as escaped text. */
const outsideListings = (html: string) =>
    html.replace(/<pre class="snip"[\s\S]*?<\/pre>/g, "<pre></pre>");

test("the page has a section and a link for each part of the system, and a stage for each component", () => {
    const system = flagship();
    const { html } = renderSystemDoc(system);

    for (const id of [
        "overview",
        "color",
        "typography",
        "spacing",
        "radii",
        "shadows",
        "motion",
        "other",
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

    // The states are drawn in the page itself (a shadow root that the page's script fills), never in a frame.
    assert.equal(
        (html.match(/<div class="comp-stage"/g) ?? []).length,
        system.components.length,
        "one stage each",
    );
    assert.doesNotMatch(html, /<iframe|srcdoc=/i, "no frame");

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
        assert.ok(
            html.includes(`<button class="tk">${named.name}</button>`),
            `${named.name} can be copied`,
        );
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
    assert.match(html, /class="mv" data-m="1"/);
    assert.match(html, /html:not\(\[data-mode="dark"\]\) \.mv\[data-m="1"\]\{display:none\}/);
});

test("the page asks for nothing: no external request, no script or style file, no frame", () => {
    const { html, assets } = renderSystemDoc(flagship());
    const page = outsideListings(html);

    assert.deepEqual(assets, []);
    assert.doesNotMatch(page, /<link[\s>]/i, "no <link>");
    assert.doesNotMatch(page, /<script[^>]*\ssrc=/i, "no script file");
    assert.doesNotMatch(page, /<iframe|<object|<embed|srcdoc=/i, "no frame or plug-in");
    // `@import` may appear as text in a code listing (the generated Tailwind file says how to import it), but never
    // in a style that the page runs.
    const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)]
        .map((match) => match[1])
        .join("\n");

    assert.doesNotMatch(styles, /@import/i, "no @import in a style");
    assert.doesNotMatch(page, /url\(\s*['"]?(https?:)?\/\//i, "no remote url()");
    assert.doesNotMatch(
        page,
        /\s(src|href|action|poster)=["']?(https?:)?\/\//i,
        "no remote address",
    );
    assert.equal((page.match(/<script/g) ?? []).length, 2, "the page's two scripts only");

    // The policy: nothing from outside, no frame, form, or base, and an image or font only as data.
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";

    for (const part of [
        "default-src 'none'",
        "script-src 'nonce-",
        "form-action 'none'",
        "base-uri 'none'",
        "img-src data:",
        "font-src data:",
    ]) {
        assert.ok(policy.includes(part), `the policy has ${part}`);
    }

    assert.doesNotMatch(policy, /frame-src/);
    // Script runs only with the page's nonce, which is new for each page and is on each of the page's two scripts.
    const nonce = /script-src 'nonce-([\w-]+)'/.exec(policy)?.[1];

    assert.ok(nonce !== undefined && nonce.length >= 20, "a nonce");
    assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
    assert.equal((page.match(new RegExp(`<script nonce="${nonce}">`, "g")) ?? []).length, 2);
    assert.notEqual(
        /script-src 'nonce-([\w-]+)'/.exec(renderSystemDoc(flagship()).html)?.[1],
        nonce,
        "new for each page",
    );
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
    const page = outsideListings(html);

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

    // Component markup and CSS are on the page once, as escaped text in a listing: no raw tag can leave it.
    const listings = [
        ...html.matchAll(/<pre class="snip" id="code-\d+-\d+"><code>([\s\S]*?)<\/code><\/pre>/g),
    ].map((match) => match[1]!);

    assert.ok(listings.length >= 3);
    assert.ok(
        listings.every((text) => !text.includes("<")),
        "every listing is escaped",
    );
    assert.ok(
        listings.some((text) => text.includes("&lt;/style&gt;&lt;script&gt;alert(2)")),
        "the CSS is text",
    );
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

    // An exempt pair (disabled text) may be below its minimum: it is shown with its reason, not as a failure.
    const exempt = system.tokens.filter((item) => item.contrast?.exempt !== undefined);

    assert.deepEqual(
        exempt.map((item) => item.name),
        ["color.text.disabled"],
    );
    assert.equal(system.notes?.length, 1, "the system notes the exempt pair");

    for (const named of system.tokens.filter(
        (item) => item.contrast !== undefined && item.contrast.exempt === undefined,
    )) {
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
    "in Chromium the page loads with no error, draws every state in place, switches mode, and runs no component script",
    {
        skip: findBrowser() === undefined ? "No Chromium on this machine." : false,
    },
    async () => {
        const system = flagship();

        // A component whose markup tries to run script, to reach out, and to leave: the page must strip all of it.
        system.components = [
            {
                ...system.components[0]!,
                slug: "probe",
                markup: {
                    default: `<button class="pk-button pk-button--primary" id="probe" onclick="window.__ran = 4">Probe</button><script>window.__ran = 1</script><img src="https://example.com/x.png" onerror="window.__ran = 2"><a id="leave" href="javascript:window.__ran = 3">leave</a><a href="https://example.com/" id="out">out</a><form action="https://example.com/post"><button type="submit" id="send">Send</button></form><iframe srcdoc="<script>parent.__ran = 5</script>"></iframe>`,
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
                await page.evaluate("document.documentElement.hasAttribute('data-docs-ready')"),
                true,
            );
            assert.equal(await page.evaluate("document.querySelectorAll('.comp-stage').length"), 3);

            // Every stage has its shadow root, with its states, drawn in the page: each is tall and in the page's layout.
            const sizes = JSON.parse(
                (await page.evaluate(
                    "JSON.stringify([...document.querySelectorAll('.comp-stage')].map((stage) => [stage.hasAttribute('data-ready'), !!stage.querySelector('.comp-host').shadowRoot, stage.getBoundingClientRect().height, stage.querySelector('.comp-host').shadowRoot.querySelectorAll('.__c').length]))",
                )) as string,
            ) as [boolean, boolean, number, number][];

            assert.ok(
                sizes.every(
                    ([ready, root, height, cells]) => ready && root && height > 100 && cells >= 1,
                ),
                JSON.stringify(sizes),
            );

            // The probe's script, handlers, addresses, and frame are gone; nothing ran.
            const inside = (await page.evaluate(
                "document.querySelector('#comp-probe .comp-host').shadowRoot.innerHTML",
            )) as string;

            assert.doesNotMatch(
                inside,
                /<script|onclick|onerror|javascript:|<iframe|example\.com|action=/i,
            );
            assert.match(inside, /id="probe"/);
            assert.equal(await page.evaluate("typeof window.__ran"), "undefined");

            const here = await page.evaluate("location.href");

            // Clicking its button, its links, and its form does nothing, and the page stays where it is.
            await page.evaluate(
                "(() => { const root = document.querySelector('#comp-probe .comp-host').shadowRoot; for (const id of ['probe', 'leave', 'out', 'send']) root.getElementById(id)?.click(); })()",
            );
            assert.equal(await page.evaluate("typeof window.__ran"), "undefined");
            assert.equal(await page.evaluate("location.href"), here);

            // The mode switch recolors the states, with nothing sent to them: they read the page's variables.
            // (The button eases its color for 150 ms, so read it after that.)
            const color = async () => {
                await page.evaluate("new Promise((resolve) => setTimeout(resolve, 400))");

                return page.evaluate(
                    "getComputedStyle(document.querySelector('#comp-button .comp-host').shadowRoot.querySelector('.pk-button--primary')).backgroundColor",
                );
            };

            await page.evaluate("document.querySelector('.seg button[data-mode=light]').click()");

            const light = await color();

            await page.evaluate("document.querySelector('.seg button[data-mode=dark]').click()");
            assert.equal(await page.evaluate("document.documentElement.dataset.theme"), "dark");
            assert.notEqual(await color(), light);
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
                    "document.querySelectorAll('[data-s]:not([hidden])').length > 3",
                ),
                true,
            );
            assert.equal(await page.evaluate("document.title"), "Pi Pocket · Design system");
        });
    },
);

test("section counts follow one rule: a headline of role tokens, the palette and component tokens inside, all adding up", () => {
    const system = flagship();
    const { html } = renderSystemDoc(system);
    const count = (id: string) =>
        Number(
            new RegExp(`<a href="#${id}">[^<]*<span class="count">(\\d+)</span>`).exec(html)?.[1],
        );
    const ids = ["color", "typography", "spacing", "radii", "shadows", "motion", "other"] as const;
    const sectionIds = {
        color: "color",
        typography: "typography",
        spacing: "spacing",
        radii: "radii",
        shadows: "shadows",
        motion: "motion",
        other: "other",
    } as const;
    let total = 0;

    for (const id of ids) {
        // The section's tokens, by the rule that every token is in exactly one section (the System view's `sectionOf`).
        const mine = system.tokens.filter((token) => sectionOf(token) === sectionIds[id]);
        const semantic = mine.filter((token) => token.tier === "semantic").length;
        const primitive = mine.filter((token) => token.tier === "primitive").length;
        const component = mine.filter((token) => token.tier === "component").length;
        // The headline is the role tokens; a section with none counts its primitives. Component tokens never count in it.
        const headline = semantic > 0 ? semantic : primitive;
        const inside = (semantic > 0 ? primitive : 0) + component;

        assert.equal(count(id), headline, `${id}: the navigation says its role tokens`);
        assert.equal(
            headline + inside,
            mine.length,
            `${id}: the headline and what is inside add up`,
        );
        total += mine.length;

        // Under the title, the counts of what is inside, in one line.
        const line =
            new RegExp(
                `<section class="block" id="${id}"[^>]*>(?:(?!</section>)[\\s\\S])*?<p class="counts">([^<]*)</p>`,
            ).exec(html)?.[1] ?? "";
        const numbers = [...line.matchAll(/(\d+) /g)].map((match) => Number(match[1]));

        assert.equal(numbers[0], headline, `${id}: ${line}`);
        assert.equal(
            numbers.reduce((sum, value) => sum + value, 0),
            mine.length,
            `${id}: ${line}`,
        );
    }

    assert.equal(total, system.tokens.length, "the sections' tokens add up to the system's");
    assert.equal(count("tokens"), system.tokens.length, "the table lists every token");
    assert.equal(count("components"), system.components.length, "Components counts components");
    assert.equal(count("color"), 52, "the flagship's Color says its 52 roles");
    assert.match(html, /<p class="counts">52 roles · 97 palette colors · 62 component colors<\/p>/);

    // A token that no specimen draws is still on the page, in its section's table.
    for (const token of system.tokens) {
        assert.ok(
            html.includes(`<button class="tk">${token.name}</button>`),
            `${token.name} is on the page`,
        );
    }
});

test("a ratio is written with one decimal, cut and never rounded up; cards copy a token three ways; the footer says what it is", () => {
    const { html } = renderSystemDoc(flagship());
    const ratios = [...html.matchAll(/<span class="ratio">([^<]+)<\/span>/g)].map(
        (match) => match[1]!,
    );

    assert.ok(ratios.length > 50);
    assert.ok(
        ratios.every((text) => /^\d+\.\d:1$/.test(text)),
        String(ratios.find((text) => !/^\d+\.\d:1$/.test(text))),
    );
    // The page's script makes the three buttons from the values a card carries.
    assert.match(
        html,
        /<div class="copy-row" data-var="--color-bg-surface" data-tw="bg-surface" data-json="color\.bg\.surface\.\$value"><\/div>/,
    );
    assert.match(html, /data-var="--color-text-primary" data-tw="text-primary"/);
    assert.doesNotMatch(
        html,
        /data-tw="(bg-bg|text-text|border-border)-/,
        "the class is the compiled theme's name",
    );
    assert.match(html, /data-var="--color-border-default" data-tw="border-default"/);
    assert.match(
        html,
        /<footer class="foot"><strong>Pi Pocket<\/strong> · \d+ tokens · 3 modes · 10 components · generated \d{4}-\d{2}-\d{2} by Pi Pocket<\/footer>/,
    );
    // Small groups share a grid, so that no row is half empty; the hero's swatches carry their names.
    assert.match(html, /<h4[^>]*>Brand · Spark/);
    assert.match(
        html,
        /<button type="button" class="sw" data-copy="color\.[a-z.-]+" title="color\.[a-z.-]+"><i /,
    );
    // A phone gets a menu for the modes and keeps the system's name in the header.
    assert.match(html, /<select class="modesel"/);
    assert.match(html, /<span class="brand-name">Pi Pocket<\/span>/);
});

test("the page's sentences have the right number and article", () => {
    assert.equal(plural(0, "mode"), "0 modes");
    assert.equal(plural(1, "mode"), "1 mode");
    assert.equal(plural(2, "text style"), "2 text styles");
    assert.equal(plural(2, "category", "categories"), "2 categories");
    assert.equal(article("info"), "an");
    assert.equal(article("danger"), "a");
    assert.equal(article("hour"), "an");
    assert.equal(article("unit"), "a");
    assert.equal(article("user"), "a");
    assert.equal(article("Error"), "an");

    // Every sentence the page generates, for a system with one of each and for the flagship.
    const one: DesignSystem = {
        name: "One",
        modes: ["default"],
        schemes: { default: "light" },
        tokens: [
            token("color.bg.base", "color", { default: "#ffffff" }),
            token(
                "color.text.primary",
                "color",
                { default: "#000000" },
                { contrast: { on: "{color.bg.base}", min: 4.5 } },
            ),
            token("font.family.sans", "fontFamily", { default: ["Arial"] }),
            token("font.size.md", "dimension", { default: "14px" }),
        ],
        components: [],
        guidelines: "",
        problems: [
            { level: "error", message: "x" },
            { level: "warning", message: "y" },
        ],
        compiled: { css: "", tailwind: "", json: "{}", components: "" },
    };
    const text = (html: string) =>
        outsideListings(html)
            .replace(/<style>[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<pre[\s\S]*?<\/pre>/g, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&[a-z#0-9]+;/g, " ")
            .replace(/\s+/g, " ");

    for (const system of [one, flagship()]) {
        const words = text(renderSystemDoc(system).html);

        assert.doesNotMatch(
            words,
            /\b(a|A) [aeiou]\w+/,
            "a before a vowel: " + words.match(/\b(a|A) [aeiou]\w+/)?.[0],
        );
        assert.doesNotMatch(words, /\b(an|An) [bcdfgjklmnpqrstvwxz]\w+/, "an before a consonant");
        assert.doesNotMatch(words, /\bEvery contrast checks?\b/);
        assert.doesNotMatch(words, /\b1 (modes|tokens|components|sizes|roles|errors|warnings)\b/);
        assert.doesNotMatch(
            words,
            /\b(?!1\b)\d+ (mode|token|size|role|error|warning|typeface)\b(?!s)/,
        );
    }

    const words = text(renderSystemDoc(one).html);

    assert.match(words, /The contrast check meets its minimum\./);
    assert.match(words, /2 roles/);
    assert.match(words, /1 typeface, 1 size/);
    assert.match(words, /1 error and 1 warning from the validator/);
    assert.match(
        text(renderSystemDoc(flagship()).html),
        /All 20 contrast checks meet their minimum|All \d+ contrast checks meet their minimum/,
    );
});

test("an exempt pair is labelled and not a failure; notes have an area; the code section shows how to use each output", () => {
    const { html } = renderSystemDoc(flagship());

    // The contrast table: the label, with the ratio, in every mode; and the counts leave the exempt pair out.
    assert.match(html, /<td class="num">exempt \(disabled\)<\/td>/);
    assert.equal(
        (html.match(/<span class="pill">exempt \(disabled\)<\/span>/g) ?? []).length >= 3,
        true,
    );
    assert.match(html, /All 60 contrast checks meet their minimum/);
    assert.doesNotMatch(html, /Fails/);
    assert.match(html, /exempt \(disabled\); would need 4\.5:1 on color\.bg\.surface/);

    // Notes are apart from problems.
    assert.match(html, /<details class="notes"><summary>1 note from the validator<\/summary>/);
    assert.match(html, /the pair is exempt \(disabled\)/);
    assert.doesNotMatch(html, /from the validator<\/summary><ul><li><strong>Warning/);

    // Use it: CSS, Tailwind v4, and JSON, and the generated files.
    assert.match(html, /<h4>CSS<\/h4>/);
    assert.match(html, /<h4>Tailwind v4<\/h4>/);
    assert.match(html, /<h4>JSON \(DTCG\)<\/h4>/);
    assert.match(html, /<h4>Tokens Studio<\/h4>/);
    assert.match(html, /tokens\.studio\.json\./, "how to load the Tokens Studio file");
    assert.match(html, /\$themes array/);
    assert.match(
        html,
        /&quot;format&quot;: &quot;2025\.10&quot;/,
        "how to ask for the 2025.10 forms",
    );
    assert.ok(
        html.includes("@import &quot;tailwindcss&quot;;\n@import &quot;./tailwind.css&quot;;"),
    );
    assert.ok(html.includes("&lt;link rel=&quot;stylesheet&quot; href=&quot;tokens.css&quot;&gt;"));
    assert.ok(html.includes("var(--color-"));
    assert.match(html, /Style Dictionary/);
    assert.match(html, /Tokens Studio/);

    for (const file of [
        "tokens.css",
        "tailwind.css",
        "tokens.studio.json",
        "tokens.resolved.json",
        "tokens.light.resolved.json",
        "tokens.dark.resolved.json",
        "tokens.high-contrast.resolved.json",
    ]) {
        assert.ok(html.includes(`<summary>${file}<`), file);
    }
});

test("the flagship's page is small, its hero swatches are roles, and its radii are grouped by use", () => {
    const { html } = renderSystemDoc(flagship());

    assert.ok(Buffer.byteLength(html) < 600_000, `${Buffer.byteLength(html)} bytes`);

    // The hero: one swatch for each role, in reading order, labelled by the role and named in full on hover.
    const hero = /<div class="strip">([\s\S]*?)<\/div>/.exec(html)![1]!;
    const labels = [...hero.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1]);

    assert.deepEqual(labels, [
        "background",
        "surface",
        "text",
        "muted",
        "border",
        "accent",
        "danger",
        "warning",
        "success",
        "info",
        "brand",
        "code",
    ]);
    assert.match(hero, /title="color\.accent\.default"/);
    assert.ok(
        labels.every((label) => label!.length <= 12),
        "short enough not to wrap",
    );

    // Radii: the jobs they do, small to large, each with a line on why.
    for (const [title, note] of [
        ["Marks and tags", "Up to 4 px"],
        ["Controls", "5 to 7 px"],
        ["Containers", "8 px and more"],
        ["Round", "Fully round"],
    ]) {
        assert.ok(
            html.includes(
                `<h4 style="margin-top:22px">${title}</h4><p class="sub" style="margin-bottom:0">${note}`,
            ),
            String(title),
        );
    }

    // Spacing bars share the width: the longest step is a full row.
    assert.match(html, /<div class="spec cols">/);
    assert.match(html, /<div class="bar" style="width:100%"><\/div>/);
});

/** Probes of component markup and CSS that try to run script or to cover the page. Each is one component. */
const PROBES: { slug: string; markup: string; css?: string; target: string }[] = [
    {
        slug: "smil-animate",
        // SMIL sets a link's address to a script address; a click then follows it.
        markup: `<svg width="80" height="30"><a href="#" id="t"><rect width="80" height="30" fill="red"/><animate attributeName="href" values="javascript:window.__ran='animate'" fill="freeze"/></a></svg>`,
        target: "t",
    },
    {
        slug: "smil-set",
        markup: `<svg width="80" height="30"><a href="#" id="t"><rect width="80" height="30" fill="red"/><set attributeName="href" to="javascript:window.__ran='set'"/></a></svg>`,
        target: "t",
    },
    {
        slug: "smil-others",
        markup: `<svg width="80" height="30"><a id="t" href="#"><rect width="80" height="30" fill="red"/><animateTransform attributeName="href" from="javascript:window.__ran='a'" to="javascript:window.__ran='b'" by="javascript:window.__ran='c'"/><animateMotion path="M0 0"/><discard/></a></svg>`,
        target: "t",
    },
    {
        slug: "svg-xlink",
        markup: `<svg width="80" height="30" xmlns:xlink="http://www.w3.org/1999/xlink"><a id="t" xlink:href="javascript:window.__ran='xlink'" href="javascript:window.__ran='href'"><rect width="80" height="30" fill="red"/></a></svg>`,
        target: "t",
    },
    {
        slug: "use-external",
        markup: `<svg width="80" height="30"><use id="t" href="https://example.com/x.svg#a" xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/><rect id="r" width="80" height="30" fill="red"/></svg>`,
        target: "r",
    },
    {
        slug: "foreign-object",
        markup: `<svg width="120" height="40"><foreignObject width="120" height="40"><div xmlns="http://www.w3.org/1999/xhtml" id="t" onclick="window.__ran='fo'"><img src=x onerror="window.__ran='fo-img'"><script>window.__ran = 'fo-script'</script>html in svg</div></foreignObject><rect id="r" width="120" height="40" fill="red"/></svg>`,
        target: "r",
    },
    {
        slug: "math-href",
        markup: `<math id="t" href="javascript:window.__ran='math'" onclick="window.__ran='math-click'"><mtext>x</mtext><mi xlink:href="javascript:window.__ran='mi'">y</mi></math><button id="r">after</button>`,
        target: "r",
    },
    {
        slug: "css-fetch",
        // Every way to make the page fetch an image or a font from outside: functions, escapes, and at-rules, in a style
        // attribute, in a style element, and in the component's CSS.
        markup: `<div id="t" style="border-image:image-set('https://evil.example/s1' 1x);background:u\\72l(https://evil.example/s2);list-style-image:url(https://evil.example/s3);cursor:url(https://evil.example/s4),auto;mask:-webkit-image-set(url(https://evil.example/s5) 1x);width:60px;height:20px">x</div><style>#t{content:image-set('https://evil.example/s6' 1x);background:cross-fade(url(https://evil.example/s7),#fff,50%)}@\\69mport 'https://evil.example/s8';</style><svg width="20" height="20"><rect id="r" width="20" height="20" style="fill:url(https://evil.example/s9)" fill="url(https://evil.example/s10)"/></svg>`,
        css: `#t{border-image:image-set("https://evil.example/c1" 1x);background:-webkit-image-set(url(https://evil.example/c2) 1x)}@\\69mport "https://evil.example/c3";@font-face{font-family:f;src:url(https://evil.example/c4.woff2)}.x{background:element(#t);list-style:src("https://evil.example/c5")}`,
        target: "t",
    },
    {
        slug: "style-url",
        markup: `<div id="t" style="width:80px;height:30px;background:url(https://example.com/x.png);background-image:url('javascript:window.__ran=1');behavior:url(x.htc)">style</div><div id="r" style="color:red;width:20px;height:20px">ok</div>`,
        css: `#t{background:url(https://example.com/y.png)}@import url(https://example.com/z.css);`,
        target: "t",
    },
    {
        slug: "host-overlay",
        // The component's CSS makes its own host cover the whole window, over everything.
        markup: `<button id="t">under</button>`,
        css: `:host{position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;background:red!important;width:100vw!important;height:100vh!important}`,
        target: "t",
    },
    {
        slug: "form-submit",
        markup: `<form id="f" action="javascript:window.__ran='form'" method="post"><input name="a" value="1"><button type="submit" id="t" formaction="javascript:window.__ran='formaction'">go</button></form>`,
        target: "t",
    },
    {
        slug: "html-links",
        markup: `<a id="t" href="javascript:window.__ran='a'" onclick="window.__ran='click'">a</a><a id="u" href="https://example.com/">out</a><img src=x onerror="window.__ran='img'"><iframe srcdoc="<script>parent.__ran='frame'</script>"></iframe><object data="javascript:window.__ran='object'"></object><embed src="javascript:window.__ran='embed'"><meta http-equiv="refresh" content="0;url=javascript:window.__ran='meta'"><base href="https://example.com/"><link rel="stylesheet" href="https://example.com/a.css"><button id="b" onclick="window.__ran='button'">b</button>`,
        target: "t",
    },
];

test(
    "no probe in a component's markup or CSS runs script, leaves the page, or covers it: real clicks in Chromium",
    { skip: findBrowser() === undefined ? "No Chromium on this machine." : false },
    async () => {
        const system = flagship();
        const base = system.components[0]!;

        system.components = PROBES.map((probe) => ({
            ...base,
            slug: probe.slug,
            name: probe.slug,
            states: ["default"],
            markup: { default: probe.markup },
            css: probe.css ?? "",
        }));

        const bundle: DesignBundle = {
            meta: { title: "Docs", type: "html", versions: [] },
            version: 1,
            content: renderSystemDoc(system).html,
            assets: [],
        };

        await withRender(bundle, host, undefined, async (page) => {
            await page.load({ width: 1280, height: 800 });
            await page.evaluate("new Promise((resolve) => setTimeout(resolve, 500))");

            assert.deepEqual(page.errors, []);
            assert.equal(
                await page.evaluate("document.querySelectorAll('.comp-stage[data-ready]').length"),
                PROBES.length,
            );

            const here = await page.evaluate("location.href");

            const click = async (x: number, y: number) => {
                const point = { x, y, button: "left", clickCount: 1 };

                await page.send("Input.dispatchMouseEvent", { ...point, type: "mouseMoved" });
                await page.send("Input.dispatchMouseEvent", { ...point, type: "mousePressed" });
                await page.send("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" });
                await page.evaluate("new Promise((resolve) => setTimeout(resolve, 60))");
            };

            for (const probe of PROBES) {
                // What is in the shadow root: no element or attribute that could run script or reach out.
                const inside = (await page.evaluate(
                    `document.querySelector('#comp-${probe.slug} .comp-host').shadowRoot.innerHTML`,
                )) as string;

                assert.doesNotMatch(
                    inside,
                    /<(script|iframe|object|embed|meta|base|link|math|foreignobject|animate|animatetransform|animatemotion|set|discard|form)\b|\son[a-z]+=|javascript:|attributename|example\.com|evil\.example|image-set|cross-fade|@import|@font-face|formaction|action=/i,
                    `${probe.slug}: ${inside.slice(0, 300)}`,
                );

                // Scroll the probe's target into view and press it with a real mouse, in the middle of its box.
                const at = JSON.parse(
                    (await page.evaluate(`(() => {
                        const root = document.querySelector('#comp-${probe.slug} .comp-host').shadowRoot;
                        const target = root.getElementById('${probe.target}') ?? root.querySelector('a, button, rect, div');

                        target?.scrollIntoView({ block: 'center' });
                        const box = target?.getBoundingClientRect();

                        return JSON.stringify(box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null);
                    })()`)) as string,
                ) as { x: number; y: number } | null;

                if (at !== null) {
                    await click(at.x, at.y);
                }

                assert.equal(
                    await page.evaluate("typeof window.__ran"),
                    "undefined",
                    `${probe.slug}: a script ran`,
                );
                assert.equal(
                    await page.evaluate("location.href"),
                    here,
                    `${probe.slug}: the page moved`,
                );
            }

            // No request was attempted, for a script's sake or an image's: none failed, none was blocked, none was made.
            assert.deepEqual(page.failedRequests, [], "a request was attempted and blocked");
            assert.equal(
                await page.evaluate(
                    "performance.getEntriesByType('resource').some((entry) => /evil\\.example/.test(entry.name))",
                ),
                false,
                "a request was made",
            );
            assert.equal(
                await page.evaluate(
                    "(() => { const t = document.querySelector('#comp-css-fetch .comp-host').shadowRoot.getElementById('t'); const s = getComputedStyle(t); return [s.borderImageSource, s.listStyleImage, s.cursor, s.maskImage].join('|'); })()",
                ),
                "none|none|auto|none",
            );

            // A click in the middle of the window, and the corners, runs nothing: the overlay probe did not cover the page.
            for (const [x, y] of [
                [640, 400],
                [20, 20],
                [1260, 780],
            ] as const) {
                const top = await page.evaluate(
                    `(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? (el.closest('.comp-stage') ? 'stage' : el.tagName) : null; })()`,
                );

                await click(x, y);
                assert.equal(await page.evaluate("typeof window.__ran"), "undefined");
                assert.notEqual(top, "stage", `a component covers the page at ${x},${y}`);
            }

            // The overlay's fixed host is placed against its own stage (layout containment), not the window, and is clipped to it.
            const inside = await page.evaluate(
                `(() => { const stage = document.querySelector('#comp-host-overlay .comp-stage').getBoundingClientRect(); const host = document.querySelector('#comp-host-overlay .comp-host').getBoundingClientRect(); return Math.abs(host.left - stage.left) < 2 && Math.abs(host.top - stage.top) < 2; })()`,
            );

            assert.equal(inside, true);
            // The page still works: the filter, with no script error.
            await page.evaluate("document.querySelector('.seg button[data-mode=dark]').click()");
            assert.equal(await page.evaluate("document.documentElement.dataset.theme"), "dark");
            assert.deepEqual(page.errors, []);
        });
    },
);

test("the sanitizer's allowlists name no animation, no frame, no foreign object, no script, and no action attribute", async () => {
    const lists = await import("../src/server/design/docsite-sanitize.ts");
    const elements = [...lists.HTML_ELEMENTS, ...lists.SVG_ELEMENTS];
    const attributes = [
        ...lists.GLOBAL_ATTRIBUTES,
        ...lists.HTML_ATTRIBUTES,
        ...lists.SVG_ATTRIBUTES,
    ];

    for (const banned of [
        "script",
        "iframe",
        "frame",
        "object",
        "embed",
        "form",
        "foreignobject",
        "animate",
        "set",
        "animatetransform",
        "animatemotion",
        "mpath",
        "discard",
        "math",
        "link",
        "meta",
        "base",
        "template",
        "image",
    ]) {
        assert.ok(!elements.includes(banned), `${banned} is not allowed`);
        assert.ok(
            lists.DROPPED_ELEMENTS.includes(banned) || ["form", "image"].includes(banned),
            `${banned} is dropped`,
        );
    }

    for (const banned of [
        "attributename",
        "to",
        "from",
        "by",
        "action",
        "formaction",
        "srcdoc",
        "srcset",
        "poster",
        "target",
        "contenteditable",
        "autofocus",
        "onclick",
        "begin",
        "dur",
        "keytimes",
    ]) {
        assert.ok(!attributes.includes(banned), `${banned} is not allowed`);
    }

    assert.ok(
        attributes.every((name) => !name.startsWith("on")),
        "no handler attribute",
    );
});
