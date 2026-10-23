import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    type Api,
    type AssistantMessage,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { LimitGate, type LimitTuning, noWait } from "../src/server/limit-gate.ts";

const TUNING: Partial<LimitTuning> = {
    minWaitMs: 5,
    resetJitterMs: [1, 2],
    backoffMs: [30, 60, 90],
    maxBackoffMs: 400,
    spacingMs: [40, 40],
    refuseMs: 300,
    maxTries: 6,
    longWaitMs: 10_000,
};

const model = (id = "m1", provider = "prov") =>
    ({ id, provider, api: "anthropic-messages" }) as unknown as Model<Api>;

const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const message = (
    m: Model<Api>,
    over: Partial<AssistantMessage> = {},
    text: string | undefined = undefined,
): AssistantMessage =>
    ({
        role: "assistant",
        content: text === undefined ? [] : [{ type: "text", text }],
        api: "anthropic-messages",
        provider: m.provider,
        model: m.id,
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
        ...over,
    }) as AssistantMessage;

/** What one request of the scripted model does. */
type Step =
    | { ok: string }
    | { fail: string; headers?: Record<string, string>; status?: number }
    | { midstream: string }
    | { hang: true };

/** A model runtime whose requests follow `steps`, in order of arrival; a step may be reused with `repeat`. */
function runtime(steps: Step[], repeat?: Step) {
    const calls: { model: string; at: number }[] = [];
    const models = {
        streamSimple(m: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();
            const step = steps.shift() ?? repeat;

            calls.push({ model: m.id, at: Date.now() });
            queueMicrotask(async () => {
                if (step === undefined) {
                    throw new Error("no step");
                }

                const start = message(m);

                stream.push({ type: "start", partial: start });

                if ("hang" in step) {
                    await new Promise<void>((resolve) =>
                        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
                    );

                    const aborted = message(m, { stopReason: "aborted", errorMessage: "aborted" });

                    stream.push({ type: "error", reason: "aborted", error: aborted });
                    stream.end(aborted);

                    return;
                }

                if ("fail" in step) {
                    if (step.headers !== undefined) {
                        // The recording fetch wraps what the caller passed, as in the real adapters.
                        await options!.fetch!("https://provider.example/v1").catch(() => {});
                    }

                    const failed = message(m, { stopReason: "error", errorMessage: step.fail });

                    stream.push({ type: "error", reason: "error", error: failed });
                    stream.end(failed);

                    return;
                }

                const text = "ok" in step ? step.ok : step.midstream;
                const partial = message(m, {}, text);

                stream.push({ type: "text_start", contentIndex: 0, partial });

                if ("midstream" in step) {
                    const failed = message(
                        m,
                        {
                            stopReason: "error",
                            errorMessage: "529 overloaded_error",
                        },
                        text,
                    );

                    stream.push({ type: "error", reason: "error", error: failed });
                    stream.end(failed);

                    return;
                }

                const done = message(m, {}, text);

                stream.push({ type: "done", reason: "stop", message: done });
                stream.end(done);
            });

            return stream;
        },
    };

    return { models, calls };
}

function gate(extra: Partial<ConstructorParameters<typeof LimitGate>[0]> = {}) {
    let changes = 0;
    const g = new LimitGate({
        hours: () => 6,
        epoch: () => 0,
        conversationOf: () => undefined,
        changed: () => {
            changes++;
        },
        log: () => {},
        tuning: TUNING,
        ...extra,
    });

    return { g, changes: () => changes };
}

/** Collect a stream: its events' types, and its result. */
async function drain(stream: ReturnType<ReturnType<typeof runtime>["models"]["streamSimple"]>) {
    const types: string[] = [];

    for await (const event of stream) {
        types.push(event.type);
    }

    return { types, result: await stream.result() };
}

/** `fetch` that answers with the headers a step names: what the adapters' HTTP client would see. */
function fetchWith(headers: Record<string, string>, status = 429): typeof fetch {
    return async () => new Response("limit", { status, headers });
}

test("a 429 with a reset time waits, then the same stream answers", async () => {
    const { g } = gate();
    const rt = runtime([{ fail: "429 rate_limit_error Try again in 0 min" }, { ok: "hello" }]);

    g.install(rt.models);

    const started = Date.now();
    const { types, result } = await drain(
        rt.models.streamSimple(model(), { messages: [] } as never),
    );

    assert.equal(result.stopReason, "stop");
    assert.equal(rt.calls.length, 2);
    // No error event ever reached the consumer: one request, slow.
    assert.ok(!types.includes("error"), types.join());
    assert.ok(types.includes("done"));
    assert.ok(Date.now() - started >= 5);
    assert.deepEqual(g.gates(), []);
});

test("without a time it backs off, then answers", async () => {
    const { g } = gate();
    const rt = runtime([
        { fail: "529 overloaded_error" },
        { fail: "529 overloaded_error" },
        { ok: "x" },
    ]);

    g.install(rt.models);

    const { result } = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

    assert.equal(result.stopReason, "stop");
    assert.equal(rt.calls.length, 3);
    // 30 ms (±20%), then 60 ms (±20%) between the tries.
    assert.ok(rt.calls[1]!.at - rt.calls[0]!.at >= 20);
    assert.ok(rt.calls[2]!.at - rt.calls[1]!.at >= 45);
});

test("a failure that is not a limit goes straight on, unchanged", async () => {
    const { g } = gate();
    const rt = runtime([{ fail: "400 invalid_request_error: bad" }]);

    g.install(rt.models);

    const { result } = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "400 invalid_request_error: bad");
    assert.equal(rt.calls.length, 1);
    assert.deepEqual(g.gates(), []);
});

test("a failure after content started is not replayed", async () => {
    const { g } = gate();
    const rt = runtime([{ midstream: "partial" }]);

    g.install(rt.models);

    const { result } = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

    assert.equal(result.stopReason, "error");
    assert.equal(rt.calls.length, 1);
});

test("a request marked noWait fails at once", async () => {
    const { g } = gate();
    const rt = runtime([{ fail: "429 rate_limit_error" }, { ok: "never" }]);

    g.install(rt.models);

    const { result } = await drain(
        rt.models.streamSimple(model(), { messages: [] } as never, noWait({ maxTokens: 5 })),
    );

    assert.equal(result.stopReason, "error");
    assert.equal(rt.calls.length, 1);
});

test("off (0 hours) passes every request through", async () => {
    const { g } = gate({ hours: () => 0 });
    const rt = runtime([{ fail: "429 rate_limit_error" }]);

    g.install(rt.models);

    const { result } = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

    assert.equal(result.stopReason, "error");
    assert.equal(rt.calls.length, 1);
});

test("Stop ends a wait at once", async () => {
    const { g } = gate({ tuning: { ...TUNING, backoffMs: [60_000] } });
    const rt = runtime([{ fail: "529 overloaded_error" }, { ok: "never" }]);
    const controller = new AbortController();

    g.install(rt.models);

    const stream = rt.models.streamSimple(model(), { messages: [] } as never, {
        signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 60);

    const started = Date.now();
    const { result } = await drain(stream);

    assert.equal(result.stopReason, "aborted");
    assert.ok(Date.now() - started < 1000);
    assert.equal(rt.calls.length, 1);
    // The gate stays for the others, but no one waits at it.
    assert.equal(g.gates().length, 1);
});

test("a reset too far away fails at once and then fails fast, with no second wait", async () => {
    const { g } = gate({ hours: () => 1 });
    const week = "retryDelay: 604800s";
    const rt = runtime([{ fail: `429 usage ${week}` }, { ok: "never" }, { ok: "never" }]);

    g.install(rt.models);

    const first = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

    assert.equal(first.result.stopReason, "error");
    assert.match(first.result.errorMessage!, /Not waiting: it resets in 7 d/);
    assert.equal(rt.calls.length, 1);

    // Pi Durable's own retries meet the refusing gate: no request, no wait.
    const started = Date.now();

    for (let i = 0; i < 3; i++) {
        const again = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

        assert.equal(again.result.stopReason, "error");
        assert.match(again.result.errorMessage!, /Not waiting/);
    }

    assert.ok(Date.now() - started < 100);
    assert.equal(rt.calls.length, 1);

    // After a while the gate lets one request try again.
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(g.gates(), []);
});

test("a limit that never clears gives up after its total wait", async () => {
    const { g } = gate({ tuning: { ...TUNING, maxBackoffMs: 120, backoffMs: [40] } });
    const rt = runtime([], { fail: "529 overloaded_error" });

    g.install(rt.models);

    const started = Date.now();
    const { result } = await drain(rt.models.streamSimple(model(), { messages: [] } as never));

    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /Not waiting: it did not clear in/);
    assert.ok(Date.now() - started < 1500);
});

test("ten sessions on one account send one canary, and leave one by one", async () => {
    const { g } = gate({ tuning: { ...TUNING, backoffMs: [150], spacingMs: [30, 30] } });
    const rt = runtime([{ fail: "429 rate_limit_error" }], { ok: "yes" });

    g.install(rt.models);

    // One request meets the limit and opens the gate.
    const first = drain(rt.models.streamSimple(model("m1"), { messages: [] } as never));

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(g.gates().length, 1);

    // Nine more meet the closed gate.
    const rest = Array.from({ length: 9 }, (_, i) =>
        drain(
            rt.models.streamSimple(model("m1"), { messages: [] } as never, { sessionId: `s${i}` }),
        ),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Nothing went out while the gate was closed.
    assert.equal(rt.calls.length, 1);

    const results = await Promise.all([first, ...rest]);

    assert.ok(results.every((each) => each.result.stopReason === "stop"));
    assert.equal(rt.calls.length, 11);

    // The first call failed; the next one after it was the canary alone; the others followed spaced out.
    const times = rt.calls.slice(1).map((call) => call.at);
    const canaryAt = times[0]!;
    const later = times.slice(1);

    assert.equal(later.length, 9);
    assert.ok(
        later.every((at, i) => at >= canaryAt + 20 * (i + 1) - 5),
        `released together: ${later.map((at) => at - canaryAt).join(",")}`,
    );
    assert.deepEqual(g.gates(), []);
});

test("a limit that covers the account holds every model of the provider; a model's own does not", async () => {
    const { g } = gate({ tuning: { ...TUNING, backoffMs: [120] } });
    const account = {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor((Date.now() + 120) / 1000) + 1),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
    };
    const rt = runtime([{ fail: "429 rate_limit_error", headers: account }], { ok: "yes" });

    g.install(rt.models);

    const a = drain(
        rt.models.streamSimple(model("opus", "anthropic"), { messages: [] } as never, {
            fetch: fetchWith(account),
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const [view] = g.gates();

    assert.equal(view?.scope, "account");
    assert.equal(view?.kind, "reset");
    assert.equal(view?.modelId, undefined);

    // Another model of the provider meets the same gate: it waits.
    const b = drain(rt.models.streamSimple(model("haiku", "anthropic"), { messages: [] } as never));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(rt.calls.length, 1);

    // Another provider is not held.
    const other = await drain(
        rt.models.streamSimple(model("x", "openai"), { messages: [] } as never),
    );

    assert.equal(other.result.stopReason, "stop");

    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(ra.result.stopReason, "stop");
    assert.equal(rb.result.stopReason, "stop");
});

test("a per-model limit holds only that model", async () => {
    const { g } = gate({ tuning: { ...TUNING, backoffMs: [200] } });
    const rt = runtime([{ fail: "529 overloaded_error" }], { ok: "yes" });

    g.install(rt.models);

    const a = drain(rt.models.streamSimple(model("m1"), { messages: [] } as never));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(g.gates()[0]?.scope, "model");

    const other = await drain(rt.models.streamSimple(model("m2"), { messages: [] } as never));

    assert.equal(other.result.stopReason, "stop");
    assert.equal((await a).result.stopReason, "stop");
});

test("Retry now sends the canary at once", async () => {
    const found = new Map<string, number>([["s1", 7]]);
    const { g } = gate({
        tuning: { ...TUNING, backoffMs: [60_000] },
        conversationOf: (sessionId) => found.get(sessionId),
    });
    const rt = runtime([{ fail: "529 overloaded_error" }], { ok: "yes" });

    g.install(rt.models);

    const stream = drain(
        rt.models.streamSimple(model(), { messages: [] } as never, { sessionId: "s1" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(g.waitFor(7)?.kind, "backoff");
    assert.equal(g.waitFor(8), undefined);
    assert.equal(g.retryNow(8), false);
    assert.equal(g.retryNow(7), true);

    const started = Date.now();
    const { result } = await stream;

    assert.equal(result.stopReason, "stop");
    assert.ok(Date.now() - started < 1000);
});

test("a canary that fails for another reason frees the next waiter, and a stopped canary too", async () => {
    const { g } = gate({ tuning: { ...TUNING, backoffMs: [60] } });
    const rt = runtime([{ fail: "529 overloaded_error" }, { fail: "400 invalid_request_error" }], {
        ok: "yes",
    });

    g.install(rt.models);

    const a = drain(rt.models.streamSimple(model(), { messages: [] } as never));
    const b = drain(rt.models.streamSimple(model(), { messages: [] } as never));
    const [ra, rb] = await Promise.all([a, b]);
    const stops = [ra.result.stopReason, rb.result.stopReason].sort();

    // One got the 400 (a canary's failure for another reason), the other went on and answered.
    assert.deepEqual(stops, ["error", "stop"]);
});

test("a sign-in change lets the waiters go at once", async () => {
    let epoch = 0;
    const { g } = gate({ tuning: { ...TUNING, backoffMs: [60_000] }, epoch: () => epoch });
    const rt = runtime([{ fail: "529 overloaded_error" }], { ok: "yes" });

    g.install(rt.models);

    const stream = drain(rt.models.streamSimple(model(), { messages: [] } as never));

    await new Promise((resolve) => setTimeout(resolve, 30));
    epoch = 1;
    g.reset("prov");

    const started = Date.now();

    assert.equal((await stream).result.stopReason, "stop");
    assert.ok(Date.now() - started < 1000);
});

test("gates are kept in a file, and a restart reads them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "limit-gate-"));
    const file = join(dir, "provider-limits.json");
    const first = gate({ file, tuning: { ...TUNING, backoffMs: [250] } });
    const rt = runtime([{ fail: "529 overloaded_error" }], { ok: "yes" });

    first.g.install(rt.models);

    const stream = drain(rt.models.streamSimple(model(), { messages: [] } as never));

    await new Promise((resolve) => setTimeout(resolve, 30));

    const saved = JSON.parse(readFileSync(file, "utf8")) as { gates: { key: string }[] };

    assert.equal(saved.gates.length, 1);
    assert.ok(JSON.stringify(saved).indexOf("Bearer") === -1);

    // A new process: the gate is known, and its first request waits instead of going out.
    const second = gate({ file, tuning: { ...TUNING, backoffMs: [250] } });
    const rt2 = runtime([], { ok: "yes" });

    second.g.install(rt2.models);
    assert.equal(second.g.gates().length, 1);

    const again = drain(rt2.models.streamSimple(model(), { messages: [] } as never));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rt2.calls.length, 0);
    assert.equal((await again).result.stopReason, "stop");
    await stream;
    first.g.close();
    second.g.close();
});

test("a missing, empty, or damaged file means no limit is known", () => {
    const dir = mkdtempSync(join(tmpdir(), "limit-gate-"));
    const file = join(dir, "provider-limits.json");

    assert.equal(gate({ file }).g.gates().length, 0);

    for (const text of [
        "",
        "{",
        "null",
        "[]",
        '{"version":2,"gates":[]}',
        '{"version":1,"gates":"x"}',
        '{"version":1,"gates":[null,1,"a",{"key":3}]}',
        `{"version":1,"gates":[{"key":"a","scope":"x","provider":"p","kind":"reset","since":1,"until":${Date.now() + 1000},"tries":1}]}`,
        `{"version":1,"gates":[{"key":"a","scope":"model","provider":"p","kind":"reset","since":1,"until":1,"tries":1}]}`,
    ]) {
        writeFileSync(file, text);
        assert.equal(gate({ file }).g.gates().length, 0, text);
    }

    // A good entry is read.
    writeFileSync(
        file,
        `{"version":1,"gates":[{"key":"p#0","scope":"account","provider":"p","kind":"reset","since":1,"until":${Date.now() + 5000},"tries":1,"reason":"r"}]}`,
    );
    assert.equal(gate({ file }).g.gates().length, 1);
});

test("a wait that is long is told once, to the conversation", async () => {
    const told: number[] = [];
    const { g } = gate({
        tuning: { ...TUNING, backoffMs: [200], longWaitMs: 100 },
        conversationOf: () => 12,
        started: (id) => told.push(id),
    });
    const rt = runtime([{ fail: "529 overloaded_error" }], { ok: "yes" });

    g.install(rt.models);
    await drain(rt.models.streamSimple(model(), { messages: [] } as never, { sessionId: "s" }));
    assert.deepEqual(told, [12]);
});

test("an adapter that refuses a custom fetch gets none", async () => {
    const { g } = gate();
    const seen: unknown[] = [];
    const models = {
        streamSimple(m: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();
            const done = message(m, {}, "ok");

            seen.push(options?.fetch);
            queueMicrotask(() => {
                stream.push({ type: "done", reason: "stop", message: done });
                stream.end(done);
            });

            return stream;
        },
    };

    g.install(models);
    await drain(
        models.streamSimple({ ...model(), api: "google-generative-ai" } as never, {} as never),
    );
    await drain(models.streamSimple(model(), {} as never));
    assert.equal(seen[0], undefined);
    assert.equal(typeof seen[1], "function");
});
