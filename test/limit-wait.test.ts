// A run that hits a provider limit waits for it, inside its request, and goes on by itself. These tests drive a real
// app with the scripted model, so no quota is spent: the "limit" is an error the scripted model throws.
import {
    type App,
    cleanUp,
    fakeTab,
    modelTexts,
    openApp,
    owner,
    root,
    scriptedModel,
    newSession,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { LimitTuning } from "../src/server/limit-gate.ts";

const TUNING: Partial<LimitTuning> = {
    minWaitMs: 50,
    resetJitterMs: [1, 2],
    backoffMs: [100, 200],
    spacingMs: [50, 50],
    refuseMs: 400,
};

/** A scripted model that is limited while `state.limited`, and says what it was asked each time it answers. */
function limitedModel(state: {
    limited: boolean;
    text: string;
    calls: number;
    answered: string[];
}) {
    return scriptedModel((context) => {
        state.calls++;

        if (state.limited) {
            throw new Error(state.text);
        }

        const last = (context.messages.findLast((m) => m.role === "user")?.content ??
            "") as unknown;
        const text = typeof last === "string" ? last : JSON.stringify(last);

        state.answered.push(text);

        return fauxAssistantMessage([fauxText("answered")]);
    });
}

const apps: App[] = [];

async function open(
    model: ReturnType<typeof scriptedModel>,
    dir = join(root, `limit-${apps.length}`),
    limits: Partial<LimitTuning> = TUNING,
) {
    const app = await openApp(model, dir, undefined, limits);

    apps.push(app);

    return app;
}

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

const send = (app: App, id: ConversationId, text: string, mode?: "interrupt") =>
    app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
        ...(mode === undefined ? {} : { mode }),
    });

const lastAssistant = async (app: App, id: ConversationId) =>
    (await app.transcripts.allEntries(id, false)).findLast(
        (entry) => entry.kind === "assistant",
    ) as { stopReason?: string; error?: string } | undefined;

test("a run that hits a limit waits inside its request and answers by itself, with no failure on record", async () => {
    const state = {
        limited: true,
        text: "429 rate_limit_error. Try again in ~0 min.",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state));
    const id = await newSession(app);

    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");

    const wait = app.limits.waitFor(Number(id))!;

    assert.equal(wait.kind, "reset");
    assert.match(wait.reason, /rate_limit_error/);
    assert.ok(app.isBusy(id), "the run is still going");
    state.limited = false;
    await until(async () => (await lastAssistant(app, id))?.stopReason === "stop", "the answer");

    const entries = await app.transcripts.allEntries(id, false);

    // Pi Durable never saw a failure: no error entry, and the session is not marked failed.
    assert.ok(!entries.some((entry) => (entry as { stopReason?: string }).stopReason === "error"));
    assert.ok(!app.sessions(owner(app)).find((s) => s.id === Number(id))?.failed);
    assert.equal(app.limits.waitFor(Number(id)), undefined);
});

test("Stop ends the wait at once", async () => {
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state), undefined, { ...TUNING, backoffMs: [60_000] });
    const id = await newSession(app);

    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    state.limited = false;

    const started = Date.now();

    await app.commands.abort(id, owner(app));
    await until(() => !app.isBusy(id), "the run to end");
    assert.ok(Date.now() - started < 2000);
    assert.equal(app.limits.waitFor(Number(id)), undefined);
    assert.equal(state.calls, 1, "no request went out after Stop");
});

test("Interrupt ends the wait at once, and its own message waits at the gate it finds, then is sent", async () => {
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state), undefined, { ...TUNING, backoffMs: [60_000] });
    const id = await newSession(app);

    await send(app, id, "first");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    state.limited = false;

    const started = Date.now();

    await send(app, id, "second", "interrupt");
    await until(
        async () => (await modelTexts(app, id)).some((text) => text.includes("second")),
        "the second message",
    );
    assert.ok(Date.now() - started < 2000, "the old wait ended at once");
    assert.equal(state.calls, 1, "the stopped request sent nothing more");
    // The limit is known to be closed for 60 s: the new run waits too. Retry now sends its canary.
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the new run to wait");
    assert.ok(app.limits.retryNow(Number(id)));
    await until(async () => (await lastAssistant(app, id))?.stopReason === "stop", "its answer");
    assert.ok(state.answered.some((text) => text.includes("second")));
});

test("a message sent during a wait queues, and is answered after it", async () => {
    const state = {
        limited: true,
        text: "429 rate_limit_error. Try again in ~0 min.",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state));
    const id = await newSession(app);

    await send(app, id, "first");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    await send(app, id, "second");
    state.limited = false;
    await until(
        async () =>
            (await app.transcripts.allEntries(id, false)).filter((e) => e.kind === "assistant")
                .length >= 2,
        "both answers",
    );
    assert.equal(state.answered.length, 2);
});

test("a restart in the middle of a wait: the run waits again with no request, then answers", async () => {
    const dir = join(root, "limit-restart");
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const model = limitedModel(state);
    const slow = { ...TUNING, backoffMs: [60_000] };
    let app = await open(model, dir, slow);
    const id = await newSession(app);

    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    assert.equal(state.calls, 1);
    assert.ok(existsSync(join(dir, "provider-limits.json")));
    await app.close();

    app = await open(model, dir, slow);
    // The run resumes: its request meets the kept gate and waits, without sending anything.
    await until(
        () => app.limits.waitFor(Number(id)) !== undefined,
        "the run to wait again",
        15_000,
    );
    assert.equal(state.calls, 1, "the replayed request waited instead of going out");
    assert.ok(app.isBusy(id));

    state.limited = false;
    app.limits.retryNow(Number(id));
    await until(async () => (await lastAssistant(app, id))?.stopReason === "stop", "the answer");
    assert.equal(app.limits.gates().length, 0);
});

test("a restart with the file lost: the replayed request meets the limit again and waits", async () => {
    const dir = join(root, "limit-restart-lost");
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const model = limitedModel(state);
    const slow = { ...TUNING, backoffMs: [60_000] };
    let app = await open(model, dir, slow);
    const id = await newSession(app);

    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");
    await app.close();
    writeFileSync(join(dir, "provider-limits.json"), "{ damaged");

    app = await open(model, dir, slow);
    await until(() => state.calls >= 2, "the replayed request", 15_000);
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the wait again");
    state.limited = false;
    app.limits.retryNow(Number(id));
    await until(async () => (await lastAssistant(app, id))?.stopReason === "stop", "the answer");
    // The file is written again.
    assert.ok(readFileSync(join(dir, "provider-limits.json"), "utf8").startsWith("{"));
});

test("ten sessions that hit one limit send one request when it may clear, then leave one by one", async () => {
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state), undefined, {
        ...TUNING,
        backoffMs: [400],
        spacingMs: [60, 60],
    });
    const ids: ConversationId[] = [];

    for (let i = 0; i < 10; i++) {
        ids.push(await newSession(app));
    }

    for (const [i, id] of ids.entries()) {
        await send(app, id, `message ${i}`);
    }

    await until(() => app.limits.waits().length === 10, "ten waits");
    const sent = state.calls;

    // Only the first failures so far: nothing else goes out while the gate is closed.
    assert.ok(sent <= 10);
    state.limited = false;
    app.limits.retryNow(Number(ids[0]));
    await until(
        async () => {
            for (const id of ids) {
                if ((await lastAssistant(app, id))?.stopReason !== "stop") {
                    return false;
                }
            }

            return true;
        },
        "ten answers",
        20_000,
    );
    // One canary plus nine that followed: each of the ten asked once more.
    assert.equal(state.calls - sent, 10);
});

test("a reset too far away fails the run at once, with the reset in its text, and no second wait", async () => {
    const state = {
        limited: true,
        text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~4000 min.",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state));
    const id = await newSession(app);

    await send(app, id, "hello");
    await until(async () => (await lastAssistant(app, id))?.stopReason === "error", "the failure");
    assert.match((await lastAssistant(app, id))?.error ?? "", /Not waiting: it resets in 2 d/);
    assert.equal(state.calls, 1);
    assert.equal(app.limits.waits().length, 0);
});

test("with the setting at 0 hours, a limit fails as it does without the gate", async () => {
    const state = {
        limited: true,
        text: "You have hit your ChatGPT usage limit. Try again in ~1 min.",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state));

    app.config.limitWaitHours = 0;

    const id = await newSession(app);

    await send(app, id, "hello");
    await until(async () => (await lastAssistant(app, id))?.stopReason === "error", "the failure");
    assert.equal(state.calls, 1);
    app.config.limitWaitHours = 6;
});

test("a wait that lasts is safe in Pi Durable: it holds the run busy, survives a restart, and ends by its own time", async () => {
    const dir = join(root, "limit-long");
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const model = limitedModel(state);
    const long: Partial<LimitTuning> = { ...TUNING, backoffMs: [9_000], resetJitterMs: [0, 0] };
    let app = await open(model, dir, long);
    const id = await newSession(app);
    const started = Date.now();

    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");

    const until1 = app.limits.waitFor(Number(id))!.until;

    state.limited = false;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.ok(app.isBusy(id), "busy while it waits");
    assert.equal(state.calls, 1);
    await app.close();

    app = await open(model, dir, long);
    await until(
        () => app.limits.waitFor(Number(id)) !== undefined,
        "the wait after the restart",
        15_000,
    );
    // The same time: the restart did not start the wait over, and did not skip it.
    assert.equal(app.limits.waitFor(Number(id))!.until, until1);
    assert.equal(state.calls, 1);
    await until(
        async () => (await lastAssistant(app, id))?.stopReason === "stop",
        "the answer",
        30_000,
    );
    assert.ok(Date.now() - started >= until1 - started - 50, "it did not go before its time");
    assert.equal(state.calls, 2);
});

test("the wait shows in the session list, the open view, the peek, and the subagents board, and Retry now needs someone who may steer", async () => {
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state), undefined, { ...TUNING, backoffMs: [60_000] });
    const id = await newSession(app);
    const tab = fakeTab(id, owner(app), 5);

    await app.attach(tab.client);
    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");

    const row = () => app.sessions(owner(app)).find((session) => session.id === Number(id));

    await until(() => row()?.limited !== undefined, "the session list to say so");
    assert.equal(row()?.limited, app.limits.waitFor(Number(id))!.until);
    await until(
        () =>
            (tab.field("live") as { limit?: { kind: string; provider: string; probing: boolean } })
                ?.limit !== undefined,
        "the view to say so",
    );

    const live = tab.field("live") as { limit: { kind: string; provider: string; reason: string } };

    assert.equal(live.limit.kind, "backoff");
    assert.equal(live.limit.provider, "faux");
    assert.match(live.limit.reason, /overloaded/);

    const peek = (await app.openRoom(id)!)!.peek()!;

    assert.ok(
        peek.lines.some((line) => line.kind === "event" && /limit/.test(line.text ?? "")),
        JSON.stringify(peek.lines),
    );

    // Someone who may only watch cannot send the request now; the owner can.
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.commands.retryLimit(id, viewer), { status: 403 });
    state.limited = false;
    assert.equal(await app.commands.retryLimit(id, owner(app)), true);
    await until(async () => (await lastAssistant(app, id))?.stopReason === "stop", "the answer");
    await until(() => row()?.limited === undefined, "the square to clear");
    await until(
        () => (tab.field("live") as { limit?: unknown } | undefined)?.limit === undefined,
        "the view to clear it",
    );
    // Nothing waits now: there is nothing to try again.
    assert.equal(await app.commands.retryLimit(id, owner(app)), false);
});

test("a subagent's wait shows on the subagents board and in its session's list, and its session can send it now", async () => {
    let limitedNow = true;
    const model = scriptedModel((request) => {
        const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
        const text = JSON.stringify(messages.findLast((m) => m.role === "user")?.content ?? "");

        if (text.includes("work for the helper")) {
            if (limitedNow) {
                throw new Error("529 overloaded_error");
            }

            return fauxAssistantMessage([fauxText("helper done")]);
        }

        if (messages.at(-1)?.role === "toolResult") {
            return fauxAssistantMessage([fauxText("started")]);
        }

        return fauxAssistantMessage(
            [
                fauxText("Starting a helper."),
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "helper",
                    message: "work for the helper",
                }),
            ],
            { stopReason: "toolUse" },
        );
    });
    const app = await open(model, undefined, { ...TUNING, backoffMs: [60_000] });
    const id = await newSession(app);

    await send(app, id, "start a helper");

    const entry = () => app.subagents(owner(app)).find((agent) => agent.name === "helper");

    await until(() => entry()?.limited !== undefined, "the board to show the wait", 15_000);
    assert.equal(entry()?.busy, true);
    assert.ok(
        app.sessions(owner(app)).find((session) => session.id === Number(id))?.limited !==
            undefined,
        "the session's square says so too",
    );
    limitedNow = false;
    assert.equal(await app.commands.retryLimit(id, owner(app)), true);
    await until(
        () => entry()?.limited === undefined && entry()?.busy === false,
        "the helper to finish",
        15_000,
    );
    assert.equal(entry()?.failed, undefined);
});

test("the owner sets how long a run waits; turning it off lets waiting runs go on at once", async () => {
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state), undefined, { ...TUNING, backoffMs: [60_000] });
    const guest = app.config.addUser("Gil", "guest").user;
    const id = await newSession(app);

    assert.equal(app.config.limitWaitHours, 6);
    await assert.rejects(app.setLimitWaitHours(guest, 1), { status: 403 });
    await assert.rejects(app.setLimitWaitHours(owner(app), 7), { status: 400 });
    await assert.rejects(app.setLimitWaitHours(owner(app), "6"), { status: 400 });
    await send(app, id, "hello");
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the run to wait");

    await app.setLimitWaitHours(owner(app), 0);
    assert.equal(app.config.limitWaitHours, 0);
    // The run that waited goes on at once: its request goes out, and the limit, with no gate, fails it as before.
    await until(async () => (await lastAssistant(app, id))?.stopReason === "error", "the failure");
    assert.equal(app.limits.waitFor(Number(id)), undefined);
    assert.equal(state.calls, 2);
    await app.setLimitWaitHours(owner(app), 12);
    assert.equal(app.config.limitWaitHours, 12);
});

test("a wait of more than ten minutes is pushed once, unless the person turned that kind off", async () => {
    const state = {
        limited: true,
        text: "529 overloaded_error",
        calls: 0,
        answered: [] as string[],
    };
    const app = await open(limitedModel(state), undefined, {
        ...TUNING,
        backoffMs: [60_000],
        longWaitMs: 30_000,
    });
    const store = app.pushStore!;
    const sent: { userId: string; title: string; body: string }[] = [];

    store.notify = async (userId: string, message: { title: string; body: string }) => {
        sent.push({ userId, title: message.title, body: message.body });

        return 1;
    };

    store.subscriptions = (() => [{}]) as never;

    const first = await newSession(app);

    await send(app, first, "hello");
    await until(
        () => sent.some((each) => each.title.startsWith("Waiting for a usage limit")),
        "a push",
    );

    const one = sent.find((each) => each.title.startsWith("Waiting for a usage limit"))!;

    assert.equal(one.userId, owner(app).id);
    assert.match(one.body, /overloaded/);
    assert.match(one.body, /tries again in/);

    // Turned off: no push for the next one.
    store.setPrefs(owner(app).id, { limit: false });
    sent.length = 0;

    const second = await newSession(app);

    await send(app, second, "again");
    await until(() => app.limits.waitFor(Number(second)) !== undefined, "the second wait");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sent.filter((each) => each.title.startsWith("Waiting")).length, 0);
    assert.equal(store.prefs(owner(app).id).limit, false);
});
