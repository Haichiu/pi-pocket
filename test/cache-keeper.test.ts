// The cache keeper with fake streams and a fake clock: when it warms, when it stops, and what it never does.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Api, createAssistantMessageEventStream, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CacheKeeper, decide, idleHazard, MAX_AGE_MS, refreshDelayMs } from "../src/server/cache-keeper.ts";

// Claude Sonnet prices per million tokens, with a 5 minute cache.
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const model = {
    id: "m", provider: "anthropic", api: "anthropic-messages", cost: COST, promptCache: { short: 300, long: 3600 },
} as unknown as Model<Api>;
const usage = (stop: string) => ({
    input: 10, output: 5, cacheRead: 50_000, cacheWrite: 0, totalTokens: 50_015,
    cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 }, stop,
});

/** A model runtime plus a clock. `timers` are the keeper's pending timers; `run` fires the next one. */
function rig(enabled = true, gaps: number[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const file = join(dir, "cache-keeper.json");

    writeFileSync(file, JSON.stringify({ enabled, gaps }));
    let now = 1_000_000;
    const timers: { at: number; fn: () => void }[] = [];
    const calls: { maxTokens?: number; aborted: () => boolean; signal?: AbortSignal }[] = [];
    let stopReason = "stop";
    const models = {
        streamSimple(m: Model<Api>, _c: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();

            calls.push({ ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }), aborted: () => options?.signal?.aborted === true, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
            const message = { role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id, usage: usage(stopReason), stopReason, timestamp: now };

            queueMicrotask(() => stream.push({ type: "done", reason: "stop", message } as never));

            return stream;
        },
    };
    const keeper = new CacheKeeper({
        file, now: () => now,
        setTimer: ((fn: () => void, ms: number) => { const t = { at: now + ms, fn };

 timers.push(t);

 return t as never; }) as never,
        clearTimer: ((t: { fn: () => void }) => { const i = timers.indexOf(t as never);

 if (i >= 0) {timers.splice(i, 1);} }) as never,
    });

    keeper.install(models);

    const real = async (sessionId = "s", stop = "stop") => {
        stopReason = stop;
        await models.streamSimple(model, { messages: [] } as never, { sessionId, cacheRetention: "short" }).result();
        await new Promise((r) => setImmediate(r));
    };

    const advance = async () => {
        const next = timers.sort((a, b) => a.at - b.at)[0];

        assert.ok(next, "a timer is pending");
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
        await new Promise((r) => setTimeout(r, 5));
    };

    return { keeper, real, advance, calls, timers, file, setNow: (t: number) => { now = t; }, now: () => now };
}

test("break-even: 5m write is 12.5x a read, so about 8.7% hazard pays for a warm", () => {
    const at = (hazard: number) => decide({ promptTokens: 50_000, rates: COST, writeRate: COST.cacheWrite, hazard }).action;

    assert.equal(at(0.05), "stop");
    assert.equal(at(0.15), "warm");
});

test("refresh delay is 90% of the lifetime, 10 seconds early at least", () => {
    assert.equal(refreshDelayMs(300_000), 270_000);
    assert.equal(refreshDelayMs(5_000), undefined);
});

test("idle hazard follows the gaps: no data gives the prior, a busy bucket raises it", () => {
    assert.equal(idleHazard([], 0, 270_000), 0.15);
    assert.ok(idleHazard(Array(50).fill(100_000), 0, 270_000) > 0.9);
    assert.ok(idleHazard(Array(50).fill(100_000), 270_000, 270_000) < 0.2);
});

test("off: a finished request starts no timer", async () => {
    const r = rig(false);

    await r.real();
    assert.equal(r.timers.length, 0);
});

test("on: warms with a one-token cap, and the warm request is not a real one", async () => {
    const r = rig();

    await r.real("s", "toolUse");
    assert.equal(r.timers.length, 1);
    await r.advance();
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1]?.maxTokens, 1);
    assert.equal(r.keeper.status().warms, 1);
    assert.equal(r.timers.length, 1, "the next refresh is scheduled");
});

test("idle: people who come back just after the cache would expire keep it warm", async () => {
    // Gaps of 5 minutes: bucket 1 (the first refresh decision) has every one of them arriving, so hazard is high.
    const r = rig(true, Array(100).fill(300_000));

    await r.real();
    await r.advance();
    assert.equal(r.keeper.status().warms, 1);
});

test("idle: people who never come back inside the first hour get no warm at all", async () => {
    // 100 gaps beyond the cap: bucket 1 has 100 at risk and 0 arrivals, so hazard falls below break-even.
    const r = rig(true, Array(100).fill(MAX_AGE_MS + 1));

    await r.real();
    await r.advance();
    assert.equal(r.keeper.status().warms, 0);
    assert.equal(r.timers.length, 0);
});

test("a new real request cancels the pending warm", async () => {
    const r = rig();

    await r.real();
    assert.equal(r.timers.length, 1);
    await r.real();
    assert.equal(r.timers.length, 1, "one timer for the newest request, not two");
});

test("switching off cancels every pending warm", async () => {
    const r = rig();

    await r.real("a");
    await r.real("b");
    assert.equal(r.timers.length, 2);
    r.keeper.setEnabled(false);
    assert.equal(r.timers.length, 0);
    assert.equal(r.keeper.enabled(), false);
});

test("the age cap ends warming even when every refresh would pay", async () => {
    const r = rig();

    await r.real("s", "toolUse");

    for (let i = 0; i < 40 && r.timers.length > 0; i++) {await r.advance();}

    assert.ok(r.now() - 1_000_000 <= MAX_AGE_MS + 300_000);
    assert.equal(r.timers.length, 0);
});
