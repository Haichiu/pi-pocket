// A phone on its side with a notch: the parts at a side edge keep clear of the safe-area insets, and nothing moves where
// the insets are 0. A real Chromium fakes the insets with the DevTools command `Emulation.setSafeAreaInsetsOverride`,
// so `env(safe-area-inset-left)` and `-right` really resolve in the page; the test proves the layout's reaction to them,
// not how Safari reports them.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BrowserError, Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const executable = findBrowser();
const real = {
    skip: executable === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** An iPhone's landscape: the notch side and the home-indicator corner, in CSS pixels. */
const WIDTH = 844;
const HEIGHT = 390;
const NOTCH = 47;
const BOTTOM = 21;

let app: App;
let server: Server;
let browser: Chromium;
let base = "";
let session: ConversationId;

type Page = {
    /** Run a function body in the page; its return value comes back as JSON. */
    run<T>(body: string): Promise<T>;
    close(): Promise<void>;
};

/** A page at the size of a phone on its side, signed in, with `inset` pixels at each side (0 for none). */
async function open(inset: number, inSession = false): Promise<Page | undefined> {
    const { connection } = browser;
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
        connection.send(method, params, sessionId);

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: 2,
        mobile: true,
    });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    try {
        await send("Emulation.setSafeAreaInsetsOverride", {
            insets: { top: 0, left: inset, bottom: inset === 0 ? 0 : BOTTOM, right: inset },
        });
    } catch (error) {
        if (!(error instanceof BrowserError)) {
            throw error;
        }

        await connection.send("Target.closeTarget", { targetId });

        return undefined;
    }

    const run = async <T>(body: string): Promise<T> => {
        const answer = await send("Runtime.evaluate", {
            expression: `(async () => { ${body} })().then((value) => JSON.stringify(value ?? null))`,
            awaitPromise: true,
            returnByValue: true,
        });

        if (answer.exceptionDetails !== undefined) {
            throw new Error(String(answer.exceptionDetails.exception?.description ?? "page error"));
        }

        return JSON.parse(answer.result.value as string) as T;
    };

    await send("Page.navigate", {
        url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
    });
    await until(
        async () =>
            (
                await send("Runtime.evaluate", {
                    expression: `document.querySelector(".home-list .session-row") !== null`,
                    returnByValue: true,
                }).catch(() => ({ result: { value: false } }))
            ).result.value === true,
        "the session list",
        20_000,
    );

    const page: Page = {
        run,
        close: async () => {
            await connection.send("Target.closeTarget", { targetId }).catch(() => {});
        },
    };

    if (inSession) {
        await page.run(`(await import("/store.js")).navigate(${Number(session)})`);
        await until(
            () =>
                page.run<boolean>(`
                    return ["topbar", "pane > .scroller", "composer-wrap"].every(
                        (selector) => document.querySelector("." + selector) !== null,
                    );
                `),
            "the conversation",
        );
        await settle(page);
    }

    return page;
}

/** Wait for the page's moves (a route sliding in, a tile growing) to end, so that it is measured where it rests. */
const settle = (page: Page) =>
    until(
        () =>
            page.run<boolean>(`
                return document
                    .getAnimations()
                    .every((animation) => animation.effect?.getComputedTiming().iterations === Infinity);
            `),
        "the page to settle",
    );

type Edge = { what: string; left: number; right: number };

/** Where the visible elements that match `selector` start and end across the screen. */
const edges = (page: Page, selector: string) =>
    page.run<Edge[]>(`
        return [...document.querySelectorAll(${JSON.stringify(selector)})]
            .map((element) => ({ element, box: element.getBoundingClientRect() }))
            .filter(({ element, box }) => box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden")
            .map(({ element, box }) => ({
                what: element.tagName.toLowerCase() + "." + [...element.classList].join("."),
                left: Math.round(box.left * 10) / 10,
                right: Math.round(box.right * 10) / 10,
            }));
    `);

/** Every element that matches is past the notch on both sides, and there is at least one. */
async function clear(page: Page, selector: string): Promise<void> {
    const found = await edges(page, selector);

    assert.ok(found.length > 0, `${selector} shows`);

    for (const edge of found) {
        assert.ok(
            edge.left >= NOTCH,
            `${selector}: ${edge.what} starts at ${edge.left}, in the notch`,
        );
        assert.ok(
            edge.right <= WIDTH - NOTCH,
            `${selector}: ${edge.what} ends at ${edge.right}, in the notch`,
        );
    }
}

/** The one element that matches runs to both screen edges: its background is not inset. */
async function bleeds(page: Page, selector: string, from = 0, to = WIDTH): Promise<void> {
    const found = await edges(page, selector);

    assert.equal(found.length, 1, `${selector} shows once`);
    assert.deepEqual(
        [found[0]!.left, found[0]!.right],
        [from, to],
        `${selector} runs to the edges`,
    );
}

before(async () => {
    if (executable === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    session = await newSession(app);
    await say(app, session, "Hello from the side");
    browser = await Chromium.launch(executable, mkdtempSync(join(root, "insets-")), []);
});

after(async () => {
    browser?.kill();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "home: the rail clears the notch, its line stays at its buttons, and the list takes the width",
    real,
    async (t) => {
        const page = await open(NOTCH);

        if (page === undefined) {
            t.skip("this Chromium cannot fake safe-area insets");

            return;
        }

        try {
            await clear(page, ".home-list > .rail button, .home-list > .rail .avatar");
            await clear(page, ".home-list .new-button");
            await clear(page, ".home-list .search");

            const [rail] = await edges(page, ".home-list > .rail");
            const [list] = await edges(page, ".home-list > .sessions");

            // The rail's own box starts at the edge, its line 56px past the notch; the list ends at the other edge.
            assert.equal(rail!.left, 0);
            assert.equal(rail!.right, NOTCH + 56);
            assert.equal(list!.right, WIDTH);
            // The short landscape layout of a touch screen: the whole width, not the 584px column.
            assert.ok(list!.right - list!.left > 584, "the list is wider than its column");
        } finally {
            await page.close();
        }
    },
);

test("session: the top bar, the thread, and the message box clear the notch", real, async (t) => {
    const page = await open(NOTCH, true);

    if (page === undefined) {
        t.skip("this Chromium cannot fake safe-area insets");

        return;
    }

    try {
        await clear(page, ".topbar button");
        await clear(page, ".topbar .title");
        await clear(page, ".composer-wrap .composer");
        await clear(page, ".composer-wrap button");
        // What the thread holds starts past the notch too, whatever the column's width.
        const padding = await page.run<string[]>(`
            const style = getComputedStyle(document.querySelector(".pane > .scroller"));
            return [style.paddingLeft, style.paddingRight];
        `);

        assert.deepEqual(padding, [`${NOTCH}px`, `${NOTCH}px`]);
        // The backgrounds of the bar and the scroller still run to the edges.
        await bleeds(page, ".topbar");
        await bleeds(page, ".pane > .scroller");
    } finally {
        await page.close();
    }
});

test("session: the Files tile over the conversation clears the notch", real, async (t) => {
    const page = await open(NOTCH, true);

    if (page === undefined) {
        t.skip("this Chromium cannot fake safe-area insets");

        return;
    }

    try {
        await page.run(`document.querySelector('.topbar [aria-label="Files"]').click()`);
        await until(
            () =>
                page.run<boolean>(
                    `return document.querySelector(".files-tile .files-bar") !== null`,
                ),
            "the Files tile",
        );
        await settle(page);
        await clear(page, ".files-tile button:not([hidden])");
        await bleeds(page, ".files-tile");
    } finally {
        await page.close();
    }
});

test("subagents board: the header and the rows clear the notch", real, async (t) => {
    const page = await open(NOTCH);

    if (page === undefined) {
        t.skip("this Chromium cannot fake safe-area insets");

        return;
    }

    try {
        await page.run(
            `(await import("/store.js")).store.set({ board: true, drawer: false, page: null })`,
        );
        await until(
            () => page.run<boolean>(`return document.querySelector(".board-head") !== null`),
            "the board",
        );
        await clear(page, ".board-head button, .board-head input");
        await bleeds(page, ".board");
    } finally {
        await page.close();
    }
});

test("no insets: nothing moves from where it was", real, async (t) => {
    const page = await open(0, true);

    if (page === undefined) {
        t.skip("this Chromium cannot fake safe-area insets");

        return;
    }

    try {
        const sides = await page.run<Record<string, string>>(`
            const pad = (selector) => {
                const style = getComputedStyle(document.querySelector(selector));

                return style.paddingLeft + " " + style.paddingRight;
            };

            return {
                topbar: pad(".topbar"),
                scroller: pad(".pane > .scroller"),
                composer: pad(".composer-wrap"),
            };
        `);

        assert.equal(sides.topbar, "0px 0px");
        assert.equal(sides.scroller, "0px 0px");
        // The wrap's side padding is its own (24px, a spacing unit of 1).
        assert.equal(sides.composer, "24px 24px");
        await page.run(`history.back()`);
        await until(
            () => page.run<boolean>(`return document.querySelector(".home-list > .rail") !== null`),
            "the session list",
        );
        await settle(page);

        const [rail] = await edges(page, ".home-list > .rail");

        assert.deepEqual([rail!.left, rail!.right], [0, 56]);
    } finally {
        await page.close();
    }
});
