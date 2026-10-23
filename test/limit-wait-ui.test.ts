// A run waiting for a provider's limit, in a real browser where this machine has Chromium: the live line says so and
// has Retry now, the session list's square and the peek tile show the state, and Retry now sends the request.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const state = { limited: true };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let limited: ConversationId;
let open: ConversationId;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const model = scriptedModel(() => {
        if (state.limited) {
            throw new Error("529 overloaded_error");
        }

        return fauxAssistantMessage([fauxText("answered")]);
    });

    app = await openApp(model, undefined, undefined, {
        minWaitMs: 50,
        backoffMs: [60_000],
        resetJitterMs: [1, 2],
    });
    limited = await newSession(app);
    open = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "limit-wait-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the live line, the session square, and the peek tile show the wait; Retry now sends the request",
    real,
    async () => {
        await app.commands.submit(limited, owner(app), { text: "hello", requestId: "w-1" });
        await until(() => app.limits.waitFor(Number(limited)) !== undefined, "the wait");
        await page.navigate(`${base}/s/${limited}`);

        const line = () =>
            inPage<{ state: string; limit: string; retry: boolean; why: string }>(`
            const line = document.querySelector(".live-line");

            return JSON.stringify({
                state: line?.querySelector(".live-state")?.textContent.trim() ?? "",
                limit: line?.querySelector(".live-limit")?.textContent.replace(/\\s+/g, " ").trim() ?? "",
                retry: line?.querySelector(".live-retry") != null,
                why: line?.querySelector(".live-why")?.textContent.trim() ?? "",
            });
        `);

        await until(async () => (await line()).state !== "", "the live line", 20_000);

        const shown = await line();

        assert.match(shown.state, /^Waiting for prov|^Waiting for faux/i);
        assert.match(shown.limit, /^next try in /);
        assert.equal(shown.retry, true);
        assert.match(shown.why, /overloaded/);

        // The session list's square for it, and the same on a peek tile when another session is open.
        const mark = await inPage<{ row: string; shape: string }>(`
        const row = document.querySelector('.session-row[data-id="${Number(limited)}"]');

        return JSON.stringify({
            row: row?.dataset.state ?? row?.querySelector("[data-state]")?.dataset.state ?? "",
            shape: row?.querySelector(".state-mark")?.className ?? "",
        });
    `);

        assert.match(mark.shape, /\blimited\b/);
        assert.equal(mark.row, "limited");

        await page.navigate(`${base}/s/${open}`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.topbar [aria-label="Peek tiles"]') !== null)`,
                )) === true,
            "the tiles switch",
            20_000,
        );
        await page.evaluate(`document.querySelector('.topbar [aria-label="Peek tiles"]').click()`);
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(document.querySelector('.peeks .peek[data-peek="${Number(limited)}"]')?.dataset.state ?? "")`,
                )) === "limited",
            "the peek tile to show the wait",
            20_000,
        );

        // Retry now, from the session: the request goes out and is answered.
        state.limited = false;
        await page.navigate(`${base}/s/${limited}`);
        await until(async () => (await line()).retry, "Retry now", 20_000);
        await page.click({ selector: ".live-retry" });
        await until(
            async () =>
                (await app.transcripts.allEntries(limited, false)).some(
                    (entry) => (entry as { stopReason?: string }).stopReason === "stop",
                ),
            "the answer",
        );
        await until(async () => (await line()).state === "", "the line to go");
    },
);

test(
    "the Providers sheet has the owner's setting for how long to wait, and a tap changes it",
    real,
    async () => {
        await page.navigate(`${base}/s/${open}`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify((await import("/store.js")).store.state.server?.limitWaitHours === 6)`,
                )) === true,
            "the server's setting",
            20_000,
        );
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "providers" })`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".limit-wait") !== null)`,
                )) === true,
            "the setting in the sheet",
            20_000,
        );

        const on = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector('.limit-wait .segmented button.on')?.textContent.trim() ?? "")`,
            );

        assert.equal(await on(), "6 hours");
        await page.click({ selector: ".limit-wait .segmented button:nth-child(2)" });
        await until(async () => (await on()) === "1 hour", "the choice to show");
        assert.equal(app.config.limitWaitHours, 1);
    },
);
