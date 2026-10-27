// Agent tools use the same committed artifact versions as the viewer, scoped to the calling conversation.
import { cleanUp, context, newSession, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { readBundle } from "../src/server/design/bundle.ts";
import { designRoutes, designTools } from "../src/server/design/index.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { ExtensionWeb, PocketHost, WebHandler, WebRequest } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let conversation: ConversationId;
const host = { fetchPublic: createPublicFetch() } as PocketHost;
const content =
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><h1 data-pid="title">Design</h1>';

function api(id = conversation) {
    return {
        conversationId: id,
        taskId: 900,
        callId: "design-tool-test",
        agent: async () => ({ cwd: work }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
}

async function call(tool: ToolRegistration, args: object) {
    return tool.execute(args, api() as never, context);
}

before(async () => {
    app = await openApp(scriptedModel());
    conversation = await newSession(app);
    await call(createArtifacts(host).tools![0]!, { id: "test", title: "Test", content });
});

after(async () => {
    await app.close();
    cleanUp();
});

test("the bundle reader reads the committed version and refuses missing, foreign, or non-HTML artifacts", async () => {
    const snapshot = app.harness.snapshot.bind(app.harness);
    const found = await readBundle(host, snapshot, conversation, "test", undefined, context);

    assert.equal(found.content, content);
    assert.equal(found.version, 1);
    await assert.rejects(
        readBundle(host, snapshot, conversation, "../test", undefined, context),
        /kebab/,
    );
    await assert.rejects(
        readBundle(host, snapshot, conversation, "test", 99, context),
        /does not exist/,
    );
    await assert.rejects(
        readBundle(host, snapshot, conversation, "test", NaN, context),
        /positive/,
    );
    const other = await newSession(app);

    await assert.rejects(
        readBundle(host, snapshot, other, "test", undefined, context),
        /does not exist/,
    );
});

test("design_export writes a real HTML bundle to the default session-local path", async () => {
    const tool = designTools(host).find((item) => item.name === "design_export")!;
    const result = await call(tool, { id: "test", format: "html" });
    const details = result.details as { path: string; version: number };
    const bytes = await readFile(details.path);

    assert.equal(details.path, `${work}/exports/test-v1.zip`);
    assert.equal(details.version, 1);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    await assert.rejects(
        call(tool, { id: "test", format: "html", path: "../escape.zip" }),
        /inside/,
    );
});

test("the workspace export returns binary bytes only for a visible session", async () => {
    let handler: WebHandler | undefined;

    const route: ExtensionWeb["route"] = (_method, _path, handle) => {
        handler = handle;
    };

    designRoutes(
        {
            route,
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
        host,
    );
    const request = {
        query: new URLSearchParams({
            conversation: String(conversation),
            id: "test",
            format: "html",
        }),
        sessions: () => [{ id: conversation }],
        snapshot: app.harness.snapshot.bind(app.harness),
        signal: new AbortController().signal,
        context,
    } as unknown as WebRequest;
    const response = (await handler!(request)) as Response;

    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(response.headers.get("content-disposition")!, /test-v1.zip/);
    assert.equal(Buffer.from(await response.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    await assert.rejects(async () => handler!({ ...request, sessions: () => [] }), /No session/);
    await assert.rejects(
        async () =>
            handler!({
                ...request,
                query: new URLSearchParams({
                    conversation: String(conversation),
                    id: "test",
                    format: "exe",
                }),
            }),
        /Choose/,
    );
});

test(
    "design_preview returns screenshots from two private viewport renders",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const result = await call(
            designTools(host).find((item) => item.name === "design_preview")!,
            { id: "test" },
        );
        const images = result.output?.filter((item) => item.type === "image") ?? [];

        assert.equal(images.length, 2);
        assert.equal(images[0]!.mimeType, "image/png");
        assert.equal(Buffer.from(images[0]!.data, "base64").readUInt32BE(16), 390);
        assert.equal(Buffer.from(images[1]!.data, "base64").readUInt32BE(16), 1280);
        const details = result.details as { version: number; errors: string[] };

        assert.equal(details.version, 1);
        assert.deepEqual(details.errors, []);
    },
);
