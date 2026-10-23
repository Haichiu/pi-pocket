// Issue #140: the circle that says how a call went keeps its own size and shape while it waits for an
// approval and while it runs, instead of taking the approval and Running-now cards' padding and border.
import {
    type App,
    cleanUp,
    lastText,
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
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "risky please" runs a slow command, which Lancet Guard asks about; everything else is echoed at once. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text === "risky please") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const BOX = ".composer textarea";
const MARK = (state: string) =>
    `[data-part~="tool-call"][data-state="${state}"] [data-part~="step-mark"]`;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let one: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** What the browser computes for the mark of the call in `state`: null while there is none. */
async function measureMark(state: string): Promise<{
    width: string;
    height: string;
    padding: string;
    border: string;
} | null> {
    return inPage(`
        const mark = document.querySelector(${JSON.stringify(MARK(state))});

        if (mark === null) {
            return "null";
        }

        const shape = getComputedStyle(mark);

        return JSON.stringify({
            width: shape.width,
            height: shape.height,
            padding: shape.paddingTop,
            border: shape.borderTopWidth,
        });
    `);
}

const sessionOpen = () =>
    inPage<boolean>(`
        const { store } = await import("/store.js");

        return JSON.stringify(
            document.querySelector(${JSON.stringify(BOX)}) !== null &&
                store.state.view.conversation?.id === ${Number(one)},
        );
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    // Lancet Guard is off by default; turn it on here and make it ask about every guarded call.
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    app.guard.judge = async (_tool, args) =>
        ({
            subject: String(args.command),
            decision: { action: "ask", reason: "risky", source: "test", terminate: false },
        }) as never;
    one = await newSession(app);

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "step-mark-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
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
    "a call's mark keeps its circle while it waits for an approval and while it runs",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/s/${Number(one)}`);
        await until(sessionOpen, "the session open", 20_000);
        await app.commands.submit(one, owner(app), {
            text: "risky please",
            requestId: "step-mark-140",
        });

        // Waiting for approval: the mark is the 19 px circle, with no card padding or border.
        await until(
            async () => (await measureMark("waiting")) !== null,
            "the call waiting for approval",
            15_000,
        );

        const waiting = await measureMark("waiting");

        assert.deepEqual(
            waiting,
            { width: "19px", height: "19px", padding: "0px", border: "0px" },
            "the waiting call's mark keeps its own shape",
        );

        // After Allow: the call runs, and the mark is still the circle.
        await page.click({ selector: ".approval .button.primary" });
        await until(
            async () => (await measureMark("running")) !== null,
            "the call running",
            15_000,
        );

        const running = await measureMark("running");

        assert.deepEqual(
            running,
            { width: "19px", height: "19px", padding: "0px", border: "0px" },
            "the running call's mark keeps its own shape",
        );

        // And the run comes to its answer.
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify((await import("/store.js")).store.state.view.live.busy === false)`,
                ),
            "the run's end",
            20_000,
        );
    },
);
