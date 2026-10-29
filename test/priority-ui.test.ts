// The session list's Priority tab in a headless browser: sessions by what they ask of you, the call that opens in its
// row and is answered there, a failure dismissed, and the open session staying put while it is read.
import {
    type App,
    cleanUp,
    context,
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
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import type { ApprovalAnswer } from "../src/server/host.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "fail now" ends the run in an error that is not a wait for a limit; the rest is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    return role === "user" && text.endsWith("fail now")
        ? fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "Invalid request: unsupported parameter",
          })
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let calls = 0;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "priority-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".sidebar .session-tabs") !== null)`,
            ),
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** A call waiting in `id`; the promise is the answer it gets. */
function ask(id: ConversationId, subject: string, createdAt: number): Promise<ApprovalAnswer> {
    return app.approvals.request(
        {
            id: `priority-ui-${++calls}`,
            conversationId: id,
            taskId: calls as never,
            callId: `call-${calls}`,
            tool: "bash",
            subject,
            reason: "Publishes to a package registry",
            createdAt,
        },
        context,
    );
}

const group = (name: string) => `.sidebar [data-group="${name}"]`;
const rowIn = (name: string, id: ConversationId) => `${group(name)} .session-row[data-id="${id}"]`;

const exists = (selector: string) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
    );

const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

const text = (selector: string) =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null)`,
    );

const present = (selector: string, what: string) => until(() => exists(selector), what);

const gone = (selector: string, what: string) => until(async () => !(await exists(selector)), what);

/** The ids of a group's rows, in order. */
const idsIn = (name: string) =>
    inPage<number[]>(
        `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${group(name)} .session-row`)})].map((row) => Number(row.dataset.id)))`,
    );

test(
    "a browser that kept no choice starts on Recent, with Priority first and Archived an icon",
    real,
    async () => {
        const tabs = await inPage<{ name: string; label: string | null; selected: boolean }[]>(`
        return JSON.stringify([...document.querySelectorAll(".sidebar .session-tabs [role=tab]")].map((tab) => ({
            name: tab.dataset.tab,
            label: tab.getAttribute("aria-label"),
            selected: tab.getAttribute("aria-selected") === "true",
        })));
    `);

        assert.deepEqual(
            tabs.map((tab) => tab.name),
            ["priority", "recent", "folders", "archived"],
        );
        assert.equal(tabs.find((tab) => tab.selected)?.name, "recent");
        assert.equal(tabs.find((tab) => tab.name === "archived")?.label, "Archived");
    },
);

test("calls wait in Needs you, oldest first, and are answered in their rows", real, async () => {
    const short = await newSession(app);
    const long = await newSession(app);
    const quiet = await newSession(app);
    const shortAnswer = ask(short, "npm publish --tag beta", 1_000);
    const longAnswer = ask(long, `echo ${"a very long command ".repeat(10)}`, 2_000);

    // The Sessions button counts them, before Priority is chosen.
    await until(async () => (await text(".sidebar .rail-count.attn")) === "2", "the rail's count");
    await click('.sidebar .session-tabs [data-tab="priority"]');
    await present(group("needs"), "Needs you");
    assert.deepEqual(await idsIn("needs"), [Number(short), Number(long)]);
    assert.equal(await text('.sidebar [data-tab="priority"] .tab-count'), "2");
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(group("quiet"))}).classList.contains("closed") ? "folded" : "open")`,
        ),
        "folded",
        "Quiet starts folded",
    );
    assert.ok(await exists(rowIn("quiet", quiet)));

    // Review opens the call in its row: a short one can be allowed.
    await click(`${rowIn("needs", short)} [data-review]`);
    await present(`${rowIn("needs", short)} .need-ask`, "the call");
    assert.match(
        (await text(`${rowIn("needs", short)} .need-command`)) ?? "",
        /npm publish --tag beta/,
    );
    assert.ok(await exists(`${rowIn("needs", short)} [data-part="session-allow"]`));
    await click(`${rowIn("needs", short)} [data-part="session-allow"]`);
    assert.deepEqual(await shortAnswer, { allow: true, by: "Owner" });

    // The next call opens by itself, with the focus on its Review; one too long to show whole is not allowed here.
    await present(`${rowIn("needs", long)} .need-ask`, "the next call");
    assert.equal(await exists(`${rowIn("needs", long)} [data-part="session-allow"]`), false);
    assert.ok(await exists(`${rowIn("needs", long)} [data-part="session-ask-open"]`));
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.activeElement?.dataset.review === ${JSON.stringify(String(long))})`,
            ),
        "the focus on its Review",
    );
    await click(`${rowIn("needs", long)} [data-part="session-deny"]`);
    assert.equal((await longAnswer).allow, false);

    // Nothing needs you now.
    await present(".sidebar .priority-clear", "the empty line");
    assert.equal(await text(".sidebar .priority-clear"), "Nothing needs you");
    await gone(".sidebar .rail-count.attn", "the rail's count");
});

test("a failed run is dismissed from its row, and goes quiet", real, async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "fail now", requestId: "priority-fail" });
    await present(
        `${rowIn("needs", id)} [data-part="session-dismiss"]`,
        "the failure in Needs you",
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(`${rowIn("needs", id)} [data-part="session-dismiss"]`)}).title)`,
        ),
        /^Dismiss: Run failed: Invalid request/,
    );
    await click(`${rowIn("needs", id)} [data-part="session-dismiss"]`);
    await gone(rowIn("needs", id), "the row, out of Needs you");
    assert.ok(await exists(rowIn("quiet", id)), "it is quiet");
});

test(
    "the open session stays in its group while it is read, and moves when another opens",
    real,
    async () => {
        const mine = await newSession(app);
        const other = await newSession(app);

        await page.evaluate(`
        const { setUnread } = await import("/store.js");

        setUnread(${Number(mine)}, true);
    `);
        await present(rowIn("ready", mine), "the session to read");
        await click(`${rowIn("ready", mine)} > .session`);
        await until(
            async () =>
                (await inPage<string>(`return JSON.stringify(location.pathname)`)) === `/s/${mine}`,
            "the session open",
        );
        // Opening it read it; its row stays where it was.
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.ok(await exists(rowIn("ready", mine)), "still in Ready to read while open");
        // Another session opens: it moves.
        await page.evaluate(`
        const { navigate } = await import("/store.js");

        navigate(${Number(other)});
    `);
        await present(rowIn("quiet", mine), "Quiet, once another is open");
        assert.equal(await exists(rowIn("ready", mine)), false);
    },
);
