// Background tasks: commands Pi starts without waiting, read later, and stops; a message when one ends; across restarts.
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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { alive, type BackgroundTask } from "../src/server/background.ts";
import { BackgroundDoc } from "../src/server/docs.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { runningNow } from "../src/server/running.ts";

const skip = existsSync("/proc/self/stat") ? false : "no /proc on this machine";

/** Pi runs the background tool as the last message asks: `bg <json args>`. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    const args = /^bg (\{.*\})$/s.exec(text)?.[1];

    if (args !== undefined) {
        return fauxAssistantMessage([fauxToolCall("background", JSON.parse(args))], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 2000)}`)]);
};

const model = scriptedModel(route);
const dataDir = join(root, "data");
let app: App;

before(async () => {
    app = await openApp(model, dataDir);
    app.background.lookMs = 50;
});

after(async () => {
    // Nothing a test started outlives it.
    for (const id of started) {
        for (const item of await app.background.list(id).catch(() => [])) {
            if (item.status === "running") {
                try {
                    process.kill(-item.pid, "SIGKILL");
                } catch {
                    // Gone already.
                }
            }
        }
    }

    await app?.close();
    cleanUp();
});

const started = new Set<ConversationId>();

async function session(): Promise<ConversationId> {
    const id = await newSession(app);

    started.add(id);

    return id;
}

async function say(id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

async function userTexts(id: ConversationId): Promise<string[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        200,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model));
}

const items = async (id: ConversationId): Promise<BackgroundTask[]> =>
    Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {});

/** Pi's answers, which say what the tool said. */
const toolSaid = async (id: ConversationId): Promise<string> => {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        200,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.assistant")
        .map((entry) => JSON.stringify(entry.model))
        .join("\n");
};

test(
    "Pi starts a command in the background, reads it, and gets a message when it ends",
    { skip },
    async () => {
        const id = await session();

        await say(
            id,
            `bg ${JSON.stringify({ action: "start", command: "echo one; sleep 0.4; echo two; exit 3" })}`,
        );
        const [item] = await items(id);

        assert.ok(item, "the task is recorded");
        assert.equal(item.status, "running");
        assert.equal(item.requestedBy, owner(app).id, "Pi works for whom asked");

        await until(async () => (await items(id))[0]?.status !== "running", "the command to end");
        const [ended] = await items(id);

        assert.equal(ended?.status, "exited");
        assert.equal(ended?.code, 3);

        await until(
            async () => (await userTexts(id)).some((text) => text.includes("[background] Task")),
            "Pi's message about it",
        );
        const message = (await userTexts(id)).find((text) => text.includes("[background] Task"))!;

        assert.match(message, /exited with code 3/);
        assert.match(message, /<background-output>\\none\\ntwo\\n<\/background-output>/);

        // Its output, read with the tool: all of it once, then nothing new.
        await until(() => !app.isBusy(id), "Pi to answer the message");
        const first = await app.background.read(id, ended!.id);

        assert.equal(first?.text, "one\ntwo\n");
        assert.equal((await app.background.read(id, ended!.id))?.text, "", "nothing new since");
    },
);

test(
    "a read with the same key gives the same part again, as a replayed call needs",
    { skip },
    async () => {
        const id = await session();
        const item = await app.background.start(id, {
            command: "printf 'a\\n'; while [ ! -f go-read ]; do sleep 0.05; done; printf 'b\\n'",
            notify: false,
        });
        let key = "";
        let tries = 0;

        // Each try is another call: a new key.
        await until(async () => {
            key = `probe-${++tries}`;

            return (await app.background.read(id, item.id, key))?.text === "a\n";
        }, "the first output");
        assert.equal((await app.background.read(id, item.id, key))?.text, "a\n", "the same again");

        const { writeFileSync } = await import("node:fs");

        writeFileSync(join(item.cwd, "go-read"), "");
        await until(async () => (await items(id))[0]?.status !== "running", "the end");
        assert.equal(
            (await app.background.read(id, item.id, "next"))?.text,
            "b\n",
            "reads on after it",
        );
    },
);

test("a stop ends the whole process group, and Pi gets no message for it", { skip }, async () => {
    const id = await session();
    const item = await app.background.start(id, {
        // A child of the command too: a stop must reach it.
        command: "sleep 300 & echo $! > child.pid; wait",
    });

    await until(() => existsSync(join(item.cwd, "child.pid")), "the child to start");
    assert.equal(alive(item), true);

    const stopped = await app.background.stop(id, item.id);

    assert.equal(stopped?.status, "stopped");
    assert.equal(alive(item), false, "the command is gone");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
        !(await userTexts(id)).some((text) => text.includes("[background]")),
        "no message for a task Pi stopped",
    );
});

test(
    "Running now shows a background task, and stopping it there stops the command",
    { skip },
    async () => {
        const id = await session();
        const item = await app.background.start(id, { command: "sleep 300" });
        const sessions = await runningNow(app, owner(app));
        const shown = sessions
            .find((each) => each.id === Number(id))
            ?.tasks.find((task) => task.kind === "pocket.background");

        assert.equal(shown?.label, "running in the background: sleep 300");

        await app.harness.abortTask(item.taskId, context);
        await until(async () => (await items(id))[0]?.status === "stopped", "the abort to stop it");
        assert.equal(alive(item), false);
    },
);

test(
    "a background task runs on across a restart, and its end is told after it",
    { skip },
    async () => {
        const id = await session();
        const item = await app.background.start(id, {
            command: "while [ ! -f release ]; do sleep 0.05; done; echo released; exit 0",
        });

        await app.close();
        assert.equal(alive(item), true, "the command outlives the server");
        app = await openApp(model, dataDir);
        app.background.lookMs = 50;

        // Let it end, now that its watch runs in a new server.
        const { writeFileSync } = await import("node:fs");

        writeFileSync(join(item.cwd, "release"), "");
        await until(
            async () => (await items(id))[0]?.status === "exited",
            "the end, seen after the restart",
        );
        assert.equal((await items(id))[0]?.code, 0, "its exit code, from the wrapper's file");
        await until(
            async () => (await userTexts(id)).some((text) => text.includes("released")),
            "Pi's message with its output",
        );
    },
);

test("a session runs as many tasks at once as the owner allows", { skip }, async () => {
    const id = await session();
    const limits = app.background.limits;
    const was = limits.running;

    limits.running = 1;

    try {
        await app.background.start(id, { command: "sleep 300", notify: false });
        await assert.rejects(
            app.background.start(id, { command: "sleep 300" }),
            /can run 1 background tasks at once/,
        );
    } finally {
        limits.running = was;

        for (const item of await items(id)) {
            await app.background.stop(id, item.id);
        }
    }
});

test("the same key starts a task once", { skip }, async () => {
    const id = await session();
    const first = await app.background.start(id, { command: "sleep 300", key: "call-1" });
    const again = await app.background.start(id, { command: "sleep 300", key: "call-1" });

    assert.equal(again.id, first.id);
    assert.equal((await items(id)).length, 1);
    await app.background.stop(id, first.id);
});

test("plan mode allows reading and stopping background tasks, not starting one", () => {
    assert.equal(blockedInPlanMode("background", { action: "list" }, false), undefined);
    assert.equal(blockedInPlanMode("background", { action: "output", id: "x" }, false), undefined);
    assert.equal(blockedInPlanMode("background", { action: "stop", id: "x" }, false), undefined);
    assert.match(
        blockedInPlanMode("background", { action: "start", command: "rm -rf /" }, false) ?? "",
        /Plan mode is on/,
    );
});

test("Pi's tool lists and stops its tasks", { skip }, async () => {
    const id = await session();

    await say(id, `bg ${JSON.stringify({ action: "start", command: "sleep 300", notify: false })}`);
    const [item] = await items(id);

    await say(id, `bg ${JSON.stringify({ action: "list" })}`);
    assert.match(await toolSaid(id), new RegExp(`${item!.id}: running`));
    await say(id, `bg ${JSON.stringify({ action: "stop", id: item!.id })}`);
    assert.equal((await items(id))[0]?.status, "stopped");
    assert.equal(alive(item!), false);
});
