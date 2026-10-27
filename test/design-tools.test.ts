// Design tools receive a committed bundle reader from the integration, never a host or snapshot fallback.
import { cleanUp, context, newSession, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { loadBundle, type DesignBundleReader } from "../src/server/design/bundle.ts";
import { designRoutes, designTools } from "../src/server/design/index.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { ExtensionWeb, PocketHost, WebHandler, WebRequest } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let conversation: ConversationId;
const host = { fetchPublic: createPublicFetch() } as PocketHost;
const content =
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><h1 data-pid="title">Design</h1>';
const readBundle: DesignBundleReader = async (id, artifact, version) => ({
    ...(await app.artifactBody(id, artifact, version)),
    assets: [],
});

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
    await call(createArtifacts(host).tools![0]!, {
        id: "notes",
        title: "Notes",
        type: "markdown",
        content: "# Notes",
    });
});

after(async () => {
    await app.close();
    cleanUp();
});

test("the injected bundle reader receives the conversation, artifact, and selected version", async () => {
    const found = await loadBundle(readBundle, conversation, "test", undefined);

    assert.equal(found.content, content);
    assert.equal(found.version, 1);
    await assert.rejects(loadBundle(readBundle, conversation, "../test"), /kebab/);
    await assert.rejects(loadBundle(readBundle, conversation, "test", 99), /version/i);
    await assert.rejects(loadBundle(readBundle, conversation, "test", NaN), /positive/);
    await assert.rejects(loadBundle(readBundle, conversation, "notes"), /HTML/);
    await assert.rejects(
        loadBundle(async () => ({ ...found, version: 0 }), conversation, "test"),
        /invalid version/,
    );
    const other = await newSession(app);

    await assert.rejects(loadBundle(readBundle, other, "test"), /artifact/i);
});

test("design_export writes a real HTML bundle to the default session-local path", async () => {
    const tool = designTools(host, readBundle).find((item) => item.name === "design_export")!;
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
    await assert.rejects(
        tool.execute(
            { id: "test", format: "html" },
            { ...api(), agent: async () => ({}) } as never,
            context,
        ),
        /no working directory/,
    );
});

test("the workspace POST export writes a visible session's default file and returns JSON metadata", async () => {
    let handler: WebHandler | undefined;

    const route: ExtensionWeb["route"] = (method, path, handle, options) => {
        assert.equal(method, "POST");
        assert.equal(path, "export");
        assert.equal(options?.access, "steer");
        handler = handle;
    };

    designRoutes(
        {
            route,
            error: (status: number, message: string) =>
                Object.assign(new Error(message), { status }),
        } as unknown as ExtensionWeb,
        host,
        readBundle,
    );
    const request = {
        body: { conversation, id: "test", format: "html", path: "../ignored.zip" },
        sessions: () => [{ id: conversation, cwd: work }],
        signal: new AbortController().signal,
        context,
    } as unknown as WebRequest;
    const result = (await handler!(request)) as { path: string; name: string; size: number };
    const bytes = await readFile(result.path);

    assert.deepEqual(result, {
        path: `${work}/exports/test-v1.zip`,
        name: "test-v1.zip",
        size: bytes.length,
    });
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(JSON.parse(JSON.stringify(result)).name, "test-v1.zip");
    const toolResult = await call(
        designTools(host, readBundle).find((tool) => tool.name === "design_export")!,
        { id: "test", format: "html" },
    );
    const toolFile = toolResult.details as { path: string; bytes: number };

    assert.equal(toolFile.path, result.path);
    assert.equal(toolFile.bytes, result.size);
    await assert.rejects(async () => handler!({ ...request, sessions: () => [] }), /No session/);
    await assert.rejects(
        async () => handler!({ ...request, body: { ...request.body, format: "exe" } }),
        /Choose/,
    );
    await assert.rejects(
        async () => handler!({ ...request, body: { ...request.body, version: 0 } }),
        /positive/,
    );
});

test(
    "design_preview returns screenshots from two private viewport renders",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const result = await call(
            designTools(host, readBundle).find((item) => item.name === "design_preview")!,
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
