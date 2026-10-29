// Profile pictures: set, shown to others by version, refused when not a picture, removed.
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let owner = "";
let guest = { id: "", token: "" };

// A 1x1 PNG.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

before(async () => {
    app = await openApp(scriptedModel(), join(root, "avatar-data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    owner = app.config.ownerToken;
    const added = app.config.addUser("Gale", "guest");

    guest = { id: added.user.id, token: added.token };
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const call = (token: string, path: string, method: string, body?: Buffer) =>
    fetch(`${base}${path}`, {
        method,
        body: body === undefined ? undefined : new Uint8Array(body),
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
    });
const people = async () =>
    (await (await call(owner, "/api/users", "GET")).json()) as { id: string; avatar?: number }[];

test("a picture is set, seen by others, and removed", async () => {
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const version = (await people()).find((each) => each.id === guest.id)?.avatar;

    assert.equal(typeof version, "number");
    const seen = await call(owner, `/api/avatar/${guest.id}?v=${version}`, "GET");

    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await seen.arrayBuffer()), PNG);

    assert.equal((await call(guest.token, "/api/me/avatar", "DELETE")).status, 200);
    assert.equal((await people()).find((each) => each.id === guest.id)?.avatar, undefined);
    assert.equal((await call(owner, `/api/avatar/${guest.id}`, "GET")).status, 404);
});

test("only pictures of an allowed type and size are kept", async () => {
    const text = await call(guest.token, "/api/me/avatar", "POST", Buffer.from("<svg onload=x>"));

    assert.equal(text.status, 415);
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", Buffer.alloc(0))).status, 400);
    const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);

    assert.equal((await call(guest.token, "/api/me/avatar", "POST", big)).status, 413);
    assert.equal((await people()).find((each) => each.id === guest.id)?.avatar, undefined);
});
