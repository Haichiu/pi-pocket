// The System view's server part (`extensions/design/system-routes.ts`) over HTTP: who reads and who writes the design
// system, what a save accepts and what it refuses, the check of a design, the documentation page as an artifact, and the
// zip of the files for code. The engines behind it (`system-api.ts`) are whatever this copy has; the tests ask only what
// their contract says.
import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CheckReport } from "../src/server/design/system-types.ts";
import { ArtifactAssetDoc, ArtifactBodyDoc, ArtifactsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import {
    cleanChange,
    cleanReport,
    DOCS_ID,
    LIMITS,
    revisionOf,
} from "../src/server/extensions/design/system-routes.ts";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { publishAll, publishDesign } from "./design-fixtures.ts";
import { ferryPage, writeSystemFixture } from "./design-system-fixtures.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let session: ConversationId;
let bare: ConversationId;
let legacy: ConversationId;
let folder = "";
const people: Record<string, { token: string; id: string }> = {};

before(async () => {
    app = await openApp(scriptedModel(), join(root, "data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // Three folders: with a system, with none, and with only the old Markdown file.
    folder = join(root, "with-system");
    mkdirSync(folder, { recursive: true });
    writeSystemFixture(folder);

    const none = join(root, "no-system");
    const old = join(root, "old-system");

    mkdirSync(join(old, ".pi"), { recursive: true });
    mkdirSync(none, { recursive: true });
    writeFileSync(join(old, ".pi", "design-system.md"), "# Old\n\nAccent #3b6cf6.\n");

    session = await newSession(app, folder);
    bare = await newSession(app, none);
    legacy = await newSession(app, old);
    await publishAll(app, session);
    await publishDesign(app, session, {
        id: "ferry",
        title: "Ferry booking",
        content: ferryPage(loadDesignSystem(folder)!.compiled.css),
    });

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Vic", "viewer", undefined],
        ["Sid", "guest", [String(session)]],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, id: added.user.id };
    }

    people.owner = { token: app.config.ownerToken, id: owner(app).id };
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function call(who: string, path: string, body?: unknown, id: ConversationId = session) {
    const response = await fetch(`${base}/api/x/design/c/${id}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${people[who]!.token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, any> };
}

const read = async (who = "owner", id = session) => (await call(who, "system", undefined, id)).data;
const file = (...parts: string[]) => join(folder, ".pi", "design", ...parts);
const tokenOf = (data: Record<string, any>, name: string) =>
    data.system.tokens.find((each: { name: string }) => each.name === name);

test("everyone who sees the session reads the system, and a person invited to one session does not", async () => {
    const data = await read();

    assert.equal(data.system.name, "Harbor");
    assert.deepEqual(data.system.modes, ["light", "dark"]);
    assert.ok(data.system.tokens.length > 50);
    assert.deepEqual(data.system.components.map((each: { slug: string }) => each.slug).sort(), [
        "badge",
        "button",
        "input",
    ]);
    assert.match(data.system.guidelines, /^# Harbor/);
    assert.deepEqual(data.system.problems, []);
    assert.match(data.system.revision, /^[0-9a-f]{16}$/);
    // The files that were made, with their sizes: the browser needs no more of them.
    assert.ok(data.system.dist["tokens.css"] > 0);
    assert.equal(data.system.compiled, undefined);
    assert.equal(typeof data.system.componentsCss, "string");

    // A viewer reads the same; so does anyone who steers.
    assert.deepEqual(await read("Vic"), data);
    assert.deepEqual(await read("Gale"), data);
    // Invited to one session: a module's web part is for the whole app, so there is none for them.
    assert.equal((await call("Sid", "system")).status, 404);
    assert.equal((await call("owner", "system", undefined, 99999 as ConversationId)).status, 404);
});

test("the revision answers `unchanged`, and a project with no system says what it has instead", async () => {
    const data = await read();
    const same = (await call("owner", `system?revision=${data.system.revision}`)).data;

    assert.deepEqual(same, { unchanged: true, revision: data.system.revision });
    // Another revision is the whole system again.
    assert.equal((await call("owner", "system?revision=nope")).data.system.name, "Harbor");
    assert.deepEqual(await read("owner", bare), { system: null, legacy: null });

    const old = await read("owner", legacy);

    assert.equal(old.system, null);
    assert.ok(old.legacy > 10);
    // A linked folder is not followed.
    const hidden = join(root, "linked");

    mkdirSync(join(hidden, ".pi"), { recursive: true });
    symlinkSync(join(folder, ".pi", "design"), join(hidden, ".pi", "design"));

    const linked = await newSession(app, hidden);

    assert.equal((await read("owner", linked)).system, null);
});

test("a save changes tokens in a mode, writes the files, and answers with the system", async () => {
    const before = await read();
    const saved = await call("owner", "system", {
        set: [
            { mode: "light", token: "color.accent.default", value: "#e8590c" },
            { mode: "dark", token: "color.accent.default", value: "{color.red.400}" },
        ],
        baseRevision: before.system.revision,
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.data.ok, true);
    assert.equal(tokenOf(saved.data, "color.accent.default").modes.light.value, "#e8590c");
    assert.equal(tokenOf(saved.data, "color.accent.default").modes.dark.alias, "color.red.400");
    assert.notEqual(saved.data.system.revision, before.system.revision);
    // The files on disk, and what is generated from them.
    assert.equal(
        JSON.parse(readFileSync(file("tokens.json"), "utf8")).color.accent.default.$value,
        "#e8590c",
    );
    assert.equal(
        JSON.parse(readFileSync(file("tokens.dark.json"), "utf8")).color.accent.default.$value,
        "{color.red.400}",
    );
    assert.match(
        readFileSync(file("dist", "tokens.css"), "utf8"),
        /--color-accent-default: #e8590c/,
    );
    assert.deepEqual((await read()).system.revision, saved.data.system.revision);

    // A viewer cannot save (the route is for those who steer: the path answers a viewer as one that only reads); someone who steers can.
    assert.ok([404, 405].includes((await call("Vic", "system", { guidelines: "x" })).status));
    assert.equal(
        (
            await call("Gale", "system", {
                set: [{ mode: "light", token: "color.accent.default", value: "#3b6cf6" }],
            })
        ).data.ok,
        true,
    );
});

test("a save that the engine refuses answers in words and changes nothing", async () => {
    const before = await read();
    const refused = await call("owner", "system", {
        set: [{ mode: "light", token: "color.accent.hover", value: "{color.nope.at.all}" }],
    });

    assert.equal(refused.status, 200);
    assert.equal(refused.data.ok, false);
    assert.equal(typeof refused.data.error, "string");
    assert.ok(refused.data.error.length > 0);
    assert.ok(Array.isArray(refused.data.problems));
    assert.equal((await read()).system.revision, before.system.revision);

    // A mode that is not there.
    assert.equal(
        (
            await call("owner", "system", {
                set: [{ mode: "neon", token: "color.accent.default", value: "#fff" }],
            })
        ).data.ok,
        false,
    );
    assert.equal((await read()).system.revision, before.system.revision);
});

test("a save made on an older revision is refused, and the one made on the newest goes through", async () => {
    const first = await read();

    await call("owner", "system", {
        set: [{ mode: "light", token: "space.4", value: { value: 20, unit: "px" } }],
    });

    const stale = await call("owner", "system", {
        set: [{ mode: "light", token: "space.4", value: { value: 24, unit: "px" } }],
        baseRevision: first.system.revision,
    });

    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /changed since/);
    assert.deepEqual(tokenOf(await read(), "space.4").modes.light.value, { value: 20, unit: "px" });

    const now = await read();
    const fresh = await call("owner", "system", {
        set: [{ mode: "light", token: "space.4", value: { value: 16, unit: "px" } }],
        baseRevision: now.system.revision,
    });

    assert.equal(fresh.data.ok, true);
});

test("a save is shape-checked: what it carries, its sizes, and what a person may not write", async () => {
    const send = (body: unknown) => call("owner", "system", body);
    const good = { mode: "light", token: "color.accent.default", value: "#3b6cf6" };

    for (const [name, body] of Object.entries({
        "nothing to save": {},
        "a field it has not got": { tokens: { color: {} } },
        "components are Pi's": { components: { button: "<x>" } },
        "set that is no list": { set: "x" },
        "set that is an object": { set: { mode: "light" } },
        "an entry that is no object": { set: [1] },
        "no mode": { set: [{ token: "a.b", value: 1 }] },
        "a mode that is no slug": { set: [{ ...good, mode: "Light Mode" }] },
        "a token with a path out": { set: [{ ...good, token: "../etc.passwd" }] },
        "a token with braces": { set: [{ ...good, token: "a.{b}" }] },
        "a token that is a place on every object": { set: [{ ...good, token: "a.__proto__.b" }] },
        "a token called constructor": { set: [{ ...good, token: "constructor" }] },
        "a token that is not text": { set: [{ ...good, token: 5 }] },
        "no value": { set: [{ mode: "light", token: "a.b" }] },
        "a null value": { set: [{ ...good, value: null }] },
        "a value that is too deep": {
            set: [{ ...good, value: { a: { b: { c: { d: { e: { f: 1 } } } } } } }],
        },
        "a value with a list that is too long": {
            set: [{ ...good, value: Array.from({ length: 33 }, () => 1) }],
        },
        "a value with a key that is no name": { set: [{ ...good, value: { "a b": 1 } }] },
        "too many changes": { set: Array.from({ length: LIMITS.set + 1 }, () => good) },
        "guidelines that are not text": { guidelines: 5 },
        "guidelines that are too long": { guidelines: "x".repeat(LIMITS.guidelines + 1) },
        "modes that are a list": { modes: ["dark"] },
        "a mode with a bad name": { modes: { "Dark!": {} } },
        "a mode with a body": { modes: { fresh: { color: {} } } },
        "too many modes": {
            modes: Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`m${at}x`, {}])),
        },
        "a revision that is not text": { guidelines: "x", baseRevision: 5 },
        "a revision that is too long": { guidelines: "x", baseRevision: "r".repeat(65) },
    })) {
        const answer = await send(body);

        assert.equal(answer.status, 400, name);
    }

    // Nothing was written through a name that is a place on every object.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("guidelines are saved as text, with no control characters, and modes are added and removed", async () => {
    const saved = await call("owner", "system", { guidelines: "# New\r\n\u0007Rules\n" });

    assert.equal(saved.data.ok, true);
    assert.equal(saved.data.system.guidelines, "# New\nRules\n");
    assert.equal(readFileSync(file("guidelines.md"), "utf8"), "# New\nRules\n");

    const added = await call("owner", "system", { modes: { "high-contrast": {} } });

    assert.equal(added.data.ok, true);
    assert.deepEqual(added.data.system.modes, ["light", "dark", "high-contrast"]);
    // A mode starts with the default's values, in every token.
    assert.deepEqual(
        tokenOf(added.data, "color.bg.canvas").modes["high-contrast"].value,
        tokenOf(added.data, "color.bg.canvas").modes.light.value,
    );
    assert.ok(existsSync(file("tokens.high-contrast.json")));

    // A mode is added or removed, never rewritten, and the default is the tokens file: it stays.
    const before = readFileSync(file("tokens.dark.json"), "utf8");

    assert.equal((await call("owner", "system", { modes: { dark: {} } })).status, 400);
    assert.equal((await call("owner", "system", { modes: { light: null } })).status, 400);
    assert.equal((await call("owner", "system", { modes: { nothere: null } })).status, 400);
    assert.equal(readFileSync(file("tokens.dark.json"), "utf8"), before);
    assert.ok(existsSync(file("tokens.json")));

    const removed = await call("owner", "system", { modes: { "high-contrast": null } });

    assert.equal(removed.data.ok, true);
    assert.deepEqual(removed.data.system.modes, ["light", "dark"]);
    assert.ok(!existsSync(file("tokens.high-contrast.json")));
});

test("what a browser sends is cut to a change before it goes to the engine", () => {
    const web = {
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    };
    const { change, baseRevision } = cleanChange(web, {
        set: [
            { mode: "dark", token: "color.bg.canvas", value: "x".repeat(900), extra: "left out" },
        ],
        guidelines: "a\r\nb\u0000c",
        modes: { fresh: {}, gone: null },
        baseRevision: "abc",
    });

    assert.deepEqual(change.set, [
        { mode: "dark", token: "color.bg.canvas", value: "x".repeat(500) },
    ]);
    assert.equal(change.guidelines, "a\nbc");
    assert.deepEqual(change.modes, { fresh: {}, gone: null });
    assert.equal(baseRevision, "abc");
});

test("a check of a design answers with a report that has a fixed shape, for those who steer", async () => {
    const checked = await call("owner", "system/check", {
        id: "ferry",
        colorScheme: "light",
        viewport: "mobile",
    });

    assert.equal(checked.status, 200);
    assert.equal(checked.data.id, "ferry");
    assert.equal(checked.data.version, 1);

    const report = checked.data.report as CheckReport;

    assert.equal(report.colorScheme, "light");
    assert.deepEqual(report.viewport, { width: 390, height: 844 });
    assert.equal(report.withoutSystem, false);
    assert.equal(report.summary.errors + report.summary.warnings, report.findings.length);
    assert.ok(
        report.findings.every(
            (each) => typeof each.message === "string" && ["error", "warning"].includes(each.level),
        ),
    );

    // Nobody who cannot steer runs one (it draws the page on the server), and the body is checked.
    assert.equal((await call("Vic", "system/check", { id: "ferry" })).status, 404);
    assert.equal((await call("owner", "system/check", { id: "nope" })).status, 400);
    assert.equal((await call("owner", "system/check", {})).status, 400);
    assert.equal((await call("owner", "system/check", { id: "ferry", version: "1" })).status, 400);
    assert.equal((await call("owner", "system/check", { id: "ferry", version: 9 })).status, 400);
    assert.equal(
        (await call("owner", "system/check", { id: "ferry", colorScheme: "sepia" })).status,
        400,
    );
    assert.equal(
        (await call("owner", "system/check", { id: "ferry", viewport: "watch" })).status,
        400,
    );
    // The id is the artifact's: not a path.
    assert.equal((await call("owner", "system/check", { id: "../ferry" })).status, 400);
});

test("a report from the check is cut to its fixed shape: the page's words are data", () => {
    const hostile = {
        viewport: { width: Number.NaN, height: 1e12 },
        colorScheme: "pink",
        withoutSystem: "yes",
        summary: { errors: 9999, warnings: -1, elements: "many", byRule: { x: 1 } },
        findings: [
            {
                rule: "contrast",
                level: "fatal",
                selector: "x".repeat(900),
                message: "m".repeat(900),
                value: 5,
                suggestion: "s".repeat(900),
                pid: "p\u0000q",
                rect: { x: Number.NaN, y: 1e12, width: 3.14159, height: "9" },
            },
            { rule: "made-up", level: "error", selector: "a", message: "dropped" },
            null,
            "x",
            ...Array.from({ length: 400 }, () => ({
                rule: "tap-target",
                level: "warning",
                selector: "b",
                message: "small",
            })),
        ],
    } as unknown as CheckReport;
    const clean = cleanReport(hostile);

    assert.equal(clean.colorScheme, "light");
    assert.equal(clean.withoutSystem, false);
    assert.equal(clean.viewport.width, 0);
    assert.equal(clean.findings.length, LIMITS.findings);
    assert.equal(clean.findings[0]!.level, "warning");
    assert.equal(clean.findings[0]!.selector.length, 500);
    assert.equal(clean.findings[0]!.message.length, 400);
    assert.equal(clean.findings[0]!.suggestion!.length, 300);
    assert.equal(clean.findings[0]!.value, undefined);
    assert.equal(clean.findings[0]!.pid, "p q");
    assert.deepEqual(clean.findings[0]!.rect, { x: 0, y: 1e7, width: 3.1, height: 0 });
    assert.ok(clean.findings.every((each) => each.rule !== ("made-up" as never)));
    // The counts are of the findings kept, not of what the page said.
    assert.equal(clean.summary.errors, 0);
    assert.equal(clean.summary.warnings, LIMITS.findings);
    assert.equal(clean.summary.elements, 0);
    assert.deepEqual(clean.summary.byRule, { contrast: 1, "tap-target": LIMITS.findings - 1 });
    assert.deepEqual(cleanReport({} as CheckReport).findings, []);
});

test("the documentation page is published as a design, a version each time, once for each key", async () => {
    assert.equal((await call("Vic", "system/docs", { key: "key-docs-0001" })).status, 404);
    assert.equal((await call("owner", "system/docs", {})).status, 400);
    assert.equal((await call("owner", "system/docs", { key: "x" })).status, 400);
    assert.equal((await call("owner", "system/docs", { key: "has spaces here" })).status, 400);
    assert.equal((await call("owner", "system/docs", { key: "key-docs-0001" }, bare)).status, 404);

    const first = await call("owner", "system/docs", { key: "key-docs-0001" });

    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { id: DOCS_ID, version: 1 });
    // The same tap again finds the version it made; another tap makes the next.
    assert.equal((await call("owner", "system/docs", { key: "key-docs-0001" })).data.version, 1);
    assert.equal((await call("Gale", "system/docs", { key: "key-docs-0002" })).data.version, 2);

    // An artifact of the session: HTML, with its page, and its files kept by their hash.
    const index = await app.harness.snapshot(
        ArtifactsDoc,
        session,
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
    );
    const meta = index!.items[DOCS_ID]!;

    assert.equal(meta.type, "html");
    assert.equal(meta.versions.length, 2);
    assert.match(meta.title, /Harbor/);

    const context = (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT;
    const body = await app.harness.snapshot(ArtifactBodyDoc, session, `${DOCS_ID}@2`, context);

    assert.match(body!.content, /^<!doctype html>/i);

    for (const [name, asset] of Object.entries(meta.versions.at(-1)!.assets ?? {})) {
        const stored = await app.harness.snapshot(ArtifactAssetDoc, asset.hash, context);

        assert.ok(
            stored !== undefined && Buffer.from(stored.base64, "base64").length === asset.size,
            name,
        );
    }

    // It shows up as a design of the session.
    const list = (await call("owner", "artifacts")).data.artifacts as { id: string }[];

    assert.ok(list.some((each) => each.id === DOCS_ID));
});

test("the generated files are exported as a zip in the session's folder", async () => {
    assert.equal((await call("Vic", "system/export", {})).status, 404);
    assert.equal((await call("owner", "system/export", {}, bare)).status, 404);

    const made = await call("owner", "system/export", {});

    assert.equal(made.status, 200);
    assert.equal(made.data.name, "harbor-tokens.zip");
    assert.equal(made.data.relative, "exports/harbor-tokens.zip");
    assert.equal(made.data.path, join(folder, "exports", "harbor-tokens.zip"));

    const bytes = readFileSync(made.data.path);

    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.equal(bytes.length, made.data.size);

    for (const name of ["tokens.css", "tailwind.css", "tokens.resolved.json", "components.css"]) {
        assert.ok(bytes.includes(Buffer.from(name)), name);
    }

    // The browser downloads it through the core route.
    const download = await fetch(
        `${base}/api/c/${session}/download?path=${encodeURIComponent(made.data.relative)}`,
        {
            headers: { authorization: `Bearer ${people.owner!.token}`, "x-pocket": "1" },
        },
    );

    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).length, bytes.length);
});

test("a system with an error is not published or exported, and a revision is a short fingerprint", async () => {
    const broken = join(root, "broken");

    mkdirSync(broken, { recursive: true });
    writeSystemFixture(broken);
    writeFileSync(
        join(broken, ".pi", "design", "tokens.dark.json"),
        JSON.stringify({ color: { accent: { hover: { $value: "{color.missing}" } } } }),
    );

    const id = await newSession(app, broken);
    const data = await read("owner", id);

    assert.ok(data.system.problems.some((each: { level: string }) => each.level === "error"));
    assert.equal((await call("owner", "system/docs", { key: "key-broken-01" }, id)).status, 409);
    assert.equal((await call("owner", "system/export", {}, id)).status, 409);

    const system = loadDesignSystem(folder)!;

    assert.equal(revisionOf(system), revisionOf(loadDesignSystem(folder)!));
    assert.match(revisionOf(system), /^[0-9a-f]{16}$/);
});
