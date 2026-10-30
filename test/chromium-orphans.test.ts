import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Chromium, RECORD_FOLDER } from "../src/server/browser/cdp.ts";

/** A browser like ego lite: it answers the protocol, and it keeps running when its pipe closes. */
const FAKE_BROWSER = `#!/usr/bin/env node
const { createReadStream, createWriteStream } = require("node:fs");
const input = createReadStream(null, { fd: 3 });
const output = createWriteStream(null, { fd: 4 });
let buffer = "";
input.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\\0"); end >= 0; end = buffer.indexOf("\\0")) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        output.write(JSON.stringify({ id: message.id, result: { userAgent: "Fake" } }) + "\\0");
    }
});
input.on("error", () => {});
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        if (check()) {
            return true;
        }

        await new Promise((done) => setTimeout(done, 100));
    }

    return check();
}

/** Process ids whose command line holds the profile folder: the browser and any helper it started. */
function withProfile(profile: string): number[] {
    const out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });

    return out
        .split("\n")
        .filter((line) => line.includes(`--user-data-dir=${profile}`))
        .map((line) => Number(line.trim().split(" ")[0]));
}

/** A server process that launches one browser, prints its pid, and then exits or waits. */
function startServer(executable: string, profile: string, then: "hang" | "exit") {
    const cdp = new URL("../src/server/browser/cdp.ts", import.meta.url).href;
    const code = `
        import { Chromium } from ${JSON.stringify(cdp)};
        const browser = await Chromium.launch(${JSON.stringify(executable)}, ${JSON.stringify(profile)}, []);
        console.log("pid", browser.pid);
        ${then === "hang" ? "setInterval(() => {}, 1000);" : "process.exit(0);"}
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = new Promise<number>((done, fail) => {
        let out = "";

        child.stdout.on("data", (chunk) => {
            out += chunk;
            const match = /pid (\d+)/.exec(out);

            if (match !== null) {
                done(Number(match[1]));
            }
        });
        child.once("exit", () => fail(new Error(`The server stopped before it launched: ${out}`)));
    });

    return { child, pid };
}

/** Runs the body with a fake browser and a folder; kills every process left with that folder, pass or fail. */
async function scenario(body: (executable: string, folder: string) => Promise<void>) {
    const folder = mkdtempSync(join(tmpdir(), "orphan-test-"));
    const executable = join(folder, "fake-browser");

    writeFileSync(executable, FAKE_BROWSER);
    chmodSync(executable, 0o755);

    try {
        await body(executable, folder);
    } finally {
        for (const pid of withProfile(folder)) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // It is gone already.
            }
        }

        rmSync(folder, { recursive: true, force: true });
    }
}

const options = { timeout: 30_000, skip: process.platform === "win32" };

test("a normal server exit kills its browser", options, () =>
    scenario(async (executable, folder) => {
        const server = startServer(executable, join(folder, "a"), "exit");
        const pid = await server.pid;

        assert.equal(await until(() => !alive(pid)), true, "the browser outlived a normal exit");
    }),
);

test("the next launch kills the browser of a server that was killed", options, () =>
    scenario(async (executable, folder) => {
        const server = startServer(executable, join(folder, "a"), "hang");
        const pid = await server.pid;

        server.child.kill("SIGKILL");
        await new Promise((done) => server.child.once("exit", done));

        // The fake ignores its closed pipe, as ego lite does: without the sweep it would stay for ever.
        assert.equal(alive(pid), true, "the fake browser left with its server");

        const next = await Chromium.launch(executable, join(folder, "b"), []);

        try {
            assert.equal(
                await until(() => !alive(pid)),
                true,
                "the orphan browser is still running",
            );
            assert.deepEqual(withProfile(join(folder, "a")), [], "a process of the orphan is left");
        } finally {
            next.kill();
            await next.exited;
        }
    }),
);

test("the next launch leaves the browser of a live server alone", options, () =>
    scenario(async (executable, folder) => {
        const server = startServer(executable, join(folder, "a"), "hang");
        const pid = await server.pid;
        const next = await Chromium.launch(executable, join(folder, "b"), []);

        try {
            assert.equal(alive(pid), true, "a live server lost its browser");

            // The record survives too: if that server is killed later, a sweep must still find its browser.
            server.child.kill("SIGKILL");
            await new Promise((done) => server.child.once("exit", done));
            next.kill();
            await next.exited;

            const third = await Chromium.launch(executable, join(folder, "c"), []);

            try {
                assert.equal(
                    await until(() => !alive(pid)),
                    true,
                    "the record of a live server was lost",
                );
            } finally {
                third.kill();
                await third.exited;
            }
        } finally {
            // Only matters when an assertion failed before the body killed it.
            next.kill();
        }
    }),
);

test("a launch records its server, and the record is whole", options, () =>
    scenario(async (executable, folder) => {
        const server = startServer(executable, join(folder, "a"), "hang");
        const pid = await server.pid;
        const record = JSON.parse(readFileSync(join(RECORD_FOLDER, String(pid)), "utf8"));

        assert.deepEqual(record, { server: server.child.pid, profile: join(folder, "a") });
        assert.equal(
            readdirSync(RECORD_FOLDER).some((name) => name.endsWith(".tmp")),
            false,
            "a temporary record stays",
        );
    }),
);

test("a record that is still being written is not swept", options, () =>
    scenario(async (executable, folder) => {
        const server = startServer(executable, join(folder, "a"), "hang");

        await server.pid;

        const half = join(RECORD_FOLDER, "999999998");

        // A half-written record has a .tmp name, or a whole name with a cut body: both stay until whole.
        writeFileSync(join(RECORD_FOLDER, "999999999.tmp"), '{"server":');
        writeFileSync(half, '{"server":');

        try {
            const next = await Chromium.launch(executable, join(folder, "b"), []);

            next.kill();
            await next.exited;
            assert.equal(
                readdirSync(RECORD_FOLDER).includes("999999999.tmp"),
                true,
                "a .tmp record was removed",
            );
            assert.equal(existsSync(half), true, "a record with a cut body was removed");
        } finally {
            rmSync(join(RECORD_FOLDER, "999999999.tmp"), { force: true });
            rmSync(half, { force: true });
        }
    }),
);

test("a normal exit leaves no record", options, () =>
    scenario(async (executable, folder) => {
        const server = startServer(executable, join(folder, "a"), "exit");
        const pid = await server.pid;

        await until(() => !alive(pid));
        // The folder exists: the launch made it. A read error fails the test.
        assert.equal(
            readdirSync(RECORD_FOLDER).includes(String(pid)),
            false,
            "the record of a stopped browser stays",
        );
    }),
);
