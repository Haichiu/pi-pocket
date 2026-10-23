import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, responseFacts } from "../src/server/limits.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const ask = (
    message: string,
    status?: number,
    headers: Record<string, string> = {},
    provider = "p",
) =>
    classify({
        provider,
        message,
        now,
        ...(status === undefined ? {} : { facts: { status, headers } }),
    });

test("what clears with time waits, for the account or the model, until the time the provider gave", () => {
    assert.deepEqual(ask("429 rate_limit_error", 429), {
        type: "limit",
        scope: "model",
        backoff: true,
        reason: "429 rate_limit_error",
    });
    assert.equal(
        (ask("429", 429, { "retry-after": "120" }) as { resetAt: number }).resetAt,
        now + 120_000,
    );

    // A Claude window and a ChatGPT usage limit are the account's.
    const claude = ask("429", 429, {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(now / 1000 + 3600),
    });
    const chatgpt = ask(
        "You have hit your ChatGPT usage limit. Try again in ~95 min.",
        undefined,
        {},
        "openai-codex",
    );

    assert.deepEqual(
        [claude, chatgpt].map((each) => each.type === "limit" && each.scope),
        ["account", "account"],
    );
    assert.equal((chatgpt as { resetAt: number }).resetAt, now + 95 * 60_000);
});

test("a person's problem, a refused request, or a plan limit with no time never waits", () => {
    for (const [text, status] of [
        ["insufficient_quota: you exceeded your current quota", undefined],
        ["OAuth refresh failed for anthropic", undefined],
        ["Monthly usage limit reached. Enable available balance.", undefined],
        // A permanent 4xx never waits, whatever its text says.
        ["400 invalid_request_error: unsupported parameter 'rate_limit'", 400],
        // A plain 409 does not wait.
        ["409 Conflict: resource already exists", 409],
    ] as const) {
        assert.equal(ask(text, status).type, "other", text);
    }

    // A 409 waits only when a header gives the time.
    assert.equal(ask("409 Conflict", 409, { "retry-after": "5" }).type, "limit");
});

test("only limit headers are kept from a response, never a key or a token", () => {
    const kept = responseFacts(
        429,
        new Headers({ authorization: "Bearer secret", "x-api-key": "secret", "Retry-After": "30" }),
    );

    assert.deepEqual(kept, { status: 429, headers: { "retry-after": "30" } });
});
