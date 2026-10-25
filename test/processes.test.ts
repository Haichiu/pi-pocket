// Background processes (`src/server/extensions/processes.ts`), with real processes: what a session's command leaves
// running is found by its session, with its port; what still runs under the server is not; a process from before the
// tag is found too, with no session; and Stop ends them, only while each is still the one the owner saw.
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    jobsOf,
    type LeftProcess,
    scanProcesses,
    scanSupported,
    SESSION_VARIABLE,
    stopProcesses,
} from "../src/server/extensions/processes.ts";
import { context } from "./helpers.ts";

const linux = { skip: !scanSupported() && "Linux only: it reads /proc" };
const dataDir = join(root, "processes-data");
const started: number[] = [];

mkdirSync(dataDir, { recursive: true });

after(() => {
    for (const pid of started) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Stopped by the test.
        }
    }

    cleanUp();
});

/**
 * Start `script` as a command does, and leave it running after the shell ends, as `cmd &` does: it is then no longer
 * under this process. Returns its pid.
 */
function leave(script: string, env: Record<string, string>): number {
    const shell = spawnSync("sh", ["-c", `(${script}) >/dev/null 2>&1 & echo $!`], {
        env: { ...process.env, PI_POCKET_DIR: dataDir, ...env },
        encoding: "utf8",
    });
    const pid = Number(shell.stdout.trim());

    started.push(pid);

    return pid;
}

const scan = (ports = false) => scanProcesses({ dataDir, under: [process.pid], ports });

const until = async (check: () => boolean, what: string) => {
    for (let tries = 0; tries < 100 && !check(); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(check(), what);
};

test(
    "what a session's command leaves running is found by its session, with its port",
    linux,
    async () => {
        const server = leave(
            `exec node -e "require('http').createServer(() => {}).listen(0, '127.0.0.1', () => setInterval(() => {}, 1000))"`,
            { [SESSION_VARIABLE]: "7" },
        );
        const old = leave("exec sleep 300", {});
        // Another Pi Pocket's (another data folder), and one still under this process: neither is this one's to show.
        const other = leave("exec sleep 300", { PI_POCKET_DIR: join(root, "elsewhere") });
        const under = spawn("sleep", ["300"], { env: { ...process.env, PI_POCKET_DIR: dataDir } });

        started.push(other, under.pid!);

        await until(
            () => scan(true).some((each) => each.pid === server && each.ports.length > 0),
            "the server listens",
        );
        const found = scan(true);
        const mine = found.find((each) => each.pid === server)!;

        assert.equal(mine.session, 7);
        assert.match(mine.command, /^node -e /);
        assert.ok(mine.ports[0]! > 0);
        assert.ok(Math.abs(mine.startedAt - Date.now()) < 60_000, "its start time is now");
        assert.equal(
            found.find((each) => each.pid === old)?.session,
            undefined,
            "from before the tag: no session",
        );
        assert.ok(found.some((each) => each.pid === old));
        assert.ok(!found.some((each) => each.pid === other), "another Pi Pocket's");
        assert.ok(!found.some((each) => each.pid === under.pid), "still under the server");

        const jobs = jobsOf(found.filter((each) => each.pid === server || each.pid === old));

        assert.equal(jobs.length, 2);
        assert.deepEqual(jobs.find((each) => each.session === 7)?.ports, mine.ports);
    },
);

test("a command's processes are one job, under the command at their top", () => {
    const at = 1_000_000;
    const processes: LeftProcess[] = [
        {
            pid: 11,
            ppid: 1,
            pgid: 10,
            startedAt: at,
            command: "npm run dev",
            session: 3,
            ports: [],
        },
        {
            pid: 12,
            ppid: 11,
            pgid: 10,
            startedAt: at + 5,
            command: "node vite",
            session: 3,
            ports: [5173],
        },
        { pid: 20, ppid: 1, pgid: 20, startedAt: at, command: "sleep 9", session: 3, ports: [] },
        { pid: 30, ppid: 1, pgid: 10, startedAt: at, command: "sleep 9", ports: [] },
    ];
    const jobs = jobsOf(processes);

    assert.equal(jobs.length, 3, "by group, and by session");

    const dev = jobs.find((each) => each.key === "3:10")!;

    assert.equal(dev.command, "npm run dev");
    assert.deepEqual(dev.ports, [5173]);
    assert.deepEqual(
        dev.processes.map((each) => each.pid),
        [11, 12],
    );
});

test(
    "Stop ends the processes the owner saw, by force when they will not end, and never a pid used again",
    linux,
    async () => {
        const polite = leave("exec sleep 300", { [SESSION_VARIABLE]: "8" });
        const stubborn = leave(`trap '' TERM; while :; do sleep 1; done`, {
            [SESSION_VARIABLE]: "8",
        });

        await until(() => scan().filter((each) => each.session === 8).length >= 2, "both run");
        const seen = scan().filter((each) => each.pid === polite || each.pid === stubborn);

        // A pid with another start time is not the process the owner saw: it is left alone.
        const wrong = await stopProcesses(
            [
                {
                    pid: polite,
                    startedAt: seen.find((each) => each.pid === polite)!.startedAt - 60_000,
                },
            ],
            () => scan(),
            200,
        );

        assert.deepEqual(wrong, { stopped: 0, left: 0 });
        assert.ok(scan().some((each) => each.pid === polite));

        const result = await stopProcesses(
            seen.map(({ pid, startedAt }) => ({ pid, startedAt })),
            () => scan(),
            500,
        );

        assert.deepEqual(result, { stopped: 2, left: 0 });
        assert.ok(
            !scan().some(
                (each) => each.session === 8 && (each.pid === polite || each.pid === stubborn),
            ),
        );
    },
);

test(
    "each command a session runs says which session it is for, and a subagent's says its session's",
    linux,
    async () => {
        const app = await openApp(scriptedModel(), join(root, "processes-app"));
        const was = process.env.PI_POCKET_DIR;

        try {
            assert.ok(app.loader.extensionNames().includes("pocket-processes"), "on by default");

            let output = "";
            const env = app.envFor(5 as never);
            const out = await env.exec(
                `printf %s "$${SESSION_VARIABLE}"`,
                { onOutput: (text) => (output += text) },
                context,
            );

            assert.ok(out.ok);
            assert.equal(output, "5");

            // A subagent's command (conversation 9, of session 5) is for its session.
            assert.deepEqual(
                await app.commandEnvs.for({
                    conversationId: 9,
                    sessionId: 5,
                    command: "true",
                    cwd: root,
                }),
                { PI_POCKET_DIR: app.dataDir, [SESSION_VARIABLE]: "5" },
            );
        } finally {
            process.env.PI_POCKET_DIR = was;
            await app.close();
        }
    },
);
