// Your messages (`extensions/your-messages.ts`), in a real Chromium: on by default, it lists the people's messages,
// newest first, filters them, and a tap jumps to one the transcript has not loaded yet (issue #149).
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
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** More than the newest rows a session opens with (80), so the first messages are not loaded. */
const MESSAGES = 60;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);

    for (let index = 1; index <= MESSAGES; index++) {
        await say(app, session, `message ${index}`);
    }

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "your-messages-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the session",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".outline-row .outline-text")].map((each) => each.textContent.trim()))`,
    );

test("it lists every message newest first, filters them, and jumps to one", real, async () => {
    const listed = app.loader.list().find((each) => each.file === "your-messages.ts");

    assert.equal(listed?.enabled, true, "on by default");
    assert.equal(listed?.web?.client, "view");

    // Its launcher action opens the sheet.
    await until(async () => {
        await page.press("Control+k");
        await page.type(undefined, "Jump to one of your messages");

        return inPage<boolean>(
            `return JSON.stringify([...document.querySelectorAll("button, [role=option]")].some((each) => each.textContent.includes("Jump to one of your messages")))`,
        );
    }, "the launcher action");
    await page.press("Enter");
    await until(async () => (await rows()).length === MESSAGES, "every message listed");

    const all = await rows();

    assert.equal(all[0], `message ${MESSAGES}`);
    assert.equal(all.at(-1), "message 1");

    await page.type({ selector: ".outline-filter" }, "message 7");
    await until(async () => (await rows()).length === 1, "the filter");
    assert.deepEqual(await rows(), ["message 7"]);

    const loaded = () =>
        inPage<boolean>(
            `return JSON.stringify([...document.querySelectorAll("[id^=entry-]")].some((each) => each.textContent.includes("message 7") && !each.textContent.includes("message 7" + "0")))`,
        );

    assert.equal(await loaded(), false, "not loaded as the session opened");
    await page.click({ selector: ".outline-row" });
    await until(loaded, "the message, loaded and shown");
    await until(
        async () =>
            !(await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".outline-sheet")))`,
            )),
        "the sheet closed",
    );
});
