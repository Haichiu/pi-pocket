import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";

const executable = findBrowser();

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

/** A server process that launches one browser and prints its pid. */
function startServer(profile: string, then: "hang" | "exit") {
    const code = `
        import { Chromium } from ${JSON.stringify(new URL("../src/server/browser/cdp.ts", import.meta.url).href)};
        import { findBrowser } from ${JSON.stringify(new URL("../src/server/browser/discovery.ts", import.meta.url).href)};
        const browser = await Chromium.launch(findBrowser(), ${JSON.stringify(profile)}, []);
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
        child.once("exit", () => fail(new Error(`Server stopped before launch: ${out}`)));
    });

    return { child, pid };
}

test("a normal server exit kills its browser", { skip: executable === undefined }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "orphan-test-"));

    try {
        const server = startServer(join(folder, "a"), "exit");
        const pid = await server.pid;

        assert.equal(await until(() => !alive(pid)), true, "the browser outlived a normal exit");
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test("the next launch kills a browser a killed server left", { skip: executable === undefined }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "orphan-test-"));

    try {
        const server = startServer(join(folder, "a"), "hang");
        const pid = await server.pid;

        server.child.kill("SIGKILL");
        // A browser that exits with its pipe leaves nothing to sweep: the test then proves only that it is gone.
        await until(() => !alive(pid), 1500);

        const next = await Chromium.launch(executable as string, join(folder, "b"), []);

        try {
            assert.equal(await until(() => !alive(pid)), true, "the orphan browser is still running");
        } finally {
            next.kill();
            await next.exited;
        }
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
