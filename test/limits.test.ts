import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, durationMs, responseFacts, type Classified } from "../src/server/limits.ts";

const now = Date.parse("2026-10-23T12:00:00Z");
const facts = (status: number, headers: Record<string, string> = {}) => ({ status, headers });

function limit(result: Classified) {
    assert.equal(result.type, "limit", JSON.stringify(result));

    return result as Extract<Classified, { type: "limit" }>;
}

test("durations read as providers write them", () => {
    assert.equal(durationMs("34s"), 34_000);
    assert.equal(durationMs("6m0s"), 360_000);
    assert.equal(durationMs("1h2m3.5s"), 3_723_500);
    assert.equal(durationMs("20ms"), 20);
    assert.equal(durationMs("~5 min".replace("~", "")), 300_000);
    assert.equal(durationMs("soon"), undefined);
});

test("a short 429 with no time backs off, for the model", () => {
    const result = limit(
        classify({
            provider: "anthropic",
            message:
                '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}',
            facts: facts(429),
            now,
        }),
    );

    assert.equal(result.backoff, true);
    assert.equal(result.scope, "model");
    assert.equal(result.resetAt, undefined);
});

test("an overload and a 5xx back off", () => {
    for (const message of [
        '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        "503 Service Unavailable",
        "The service is temporarily unavailable",
    ]) {
        const result = limit(classify({ provider: "anthropic", message, now }));

        assert.equal(result.backoff, true, message);
    }
});

test("Retry-After in seconds and as a date sets the reset", () => {
    const seconds = limit(
        classify({
            provider: "openai",
            message: "429 Too Many Requests",
            facts: facts(429, { "retry-after": "120" }),
            now,
        }),
    );

    assert.equal(seconds.resetAt, now + 120_000);
    assert.equal(seconds.source, "header");
    assert.equal(seconds.backoff, false);

    const date = limit(
        classify({
            provider: "openai",
            message: "429",
            facts: facts(429, { "retry-after": new Date(now + 90_000).toUTCString() }),
            now,
        }),
    );

    assert.equal(date.resetAt, now + 90_000);

    const ms = limit(
        classify({
            provider: "openai",
            message: "429",
            facts: facts(429, { "retry-after-ms": "1500", "retry-after": "60" }),
            now,
        }),
    );

    assert.equal(ms.resetAt, now + 1500);
});

test("the 60 second cap error keeps its time", () => {
    const result = limit(
        classify({
            provider: "anthropic",
            message: "Server requested 7200s retry delay (max: 60s). 429 rate_limit_error",
            now,
        }),
    );

    assert.equal(result.resetAt, now + 7_200_000);
    assert.equal(result.source, "text");
});

test("a Claude subscription window is the account's, and clears at the unified reset", () => {
    const reset = Math.floor((now + 4 * 3_600_000) / 1000);
    const result = limit(
        classify({
            provider: "anthropic",
            message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"limit"}}',
            facts: facts(429, {
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-reset": String(reset),
                "anthropic-ratelimit-unified-representative-claim": "five_hour",
            }),
            now,
        }),
    );

    assert.equal(result.scope, "account");
    assert.equal(result.resetAt, reset * 1000);
    assert.equal(result.source, "header");
});

test("a cap for one Claude model is the model's", () => {
    const reset = Math.floor((now + 3_600_000) / 1000);
    const result = limit(
        classify({
            provider: "anthropic",
            message: "429 rate_limit_error",
            facts: facts(429, {
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-reset": String(reset),
                "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
            }),
            now,
        }),
    );

    assert.equal(result.scope, "model");
});

test("an allowed Claude response is no reset", () => {
    const result = limit(
        classify({
            provider: "anthropic",
            message: "529 overloaded_error",
            facts: facts(529, {
                "anthropic-ratelimit-unified-status": "allowed",
                "anthropic-ratelimit-unified-reset": String(Math.floor(now / 1000) + 600),
            }),
            now,
        }),
    );

    assert.equal(result.backoff, true);
    assert.equal(result.scope, "model");
});

test("a ChatGPT usage limit reads its minutes from pi-ai's text, for the account", () => {
    const result = limit(
        classify({
            provider: "openai-codex",
            message: "You have hit your ChatGPT usage limit (plus plan). Try again in ~95 min.",
            now,
        }),
    );

    assert.equal(result.scope, "account");
    assert.equal(result.resetAt, now + 95 * 60_000);
    assert.equal(result.source, "text");
});

test("a ChatGPT usage limit's body gives its reset", () => {
    const at = Math.floor(now / 1000) + 3600;
    const result = limit(
        classify({
            provider: "openai-codex",
            message: `429 {"error":{"type":"usage_limit_reached","resets_at":${at},"resets_in_seconds":3600}}`,
            now,
        }),
    );

    assert.equal(result.resetAt, now + 3_600_000);
    assert.equal(result.source, "body");
});

test("Codex headers: the later full window decides", () => {
    const result = limit(
        classify({
            provider: "openai-codex",
            message: "429",
            facts: facts(429, {
                "x-codex-primary-used-percent": "100",
                "x-codex-primary-reset-after-seconds": "600",
                "x-codex-secondary-used-percent": "40",
                "x-codex-secondary-reset-after-seconds": "86400",
            }),
            now,
        }),
    );

    assert.equal(result.resetAt, now + 600_000);
    assert.equal(result.scope, "account");
});

test("OpenAI reset durations: the exhausted one decides", () => {
    const result = limit(
        classify({
            provider: "openai",
            message: "429 rate limit",
            facts: facts(429, {
                "x-ratelimit-reset-requests": "1s",
                "x-ratelimit-remaining-requests": "10",
                "x-ratelimit-reset-tokens": "6m0s",
                "x-ratelimit-remaining-tokens": "0",
            }),
            now,
        }),
    );

    assert.equal(result.resetAt, now + 360_000);
});

test("Google's retryDelay is read", () => {
    const result = limit(
        classify({
            provider: "google",
            message: '429 RESOURCE_EXHAUSTED {"retryDelay":"34s"}',
            now,
        }),
    );

    assert.equal(result.resetAt, now + 34_000);
});

test("a reset already past is soon, not unknown", () => {
    const result = limit(
        classify({
            provider: "anthropic",
            message: "429",
            facts: facts(429, { "retry-after": "-5" }),
            now,
        }),
    );

    assert.equal(result.resetAt, now);
    assert.equal(result.backoff, false);
});

test("a plan's usage limit with no time is not waited for", () => {
    for (const message of [
        "Monthly usage limit reached. Enable available balance.",
        '429 {"type":"GoUsageLimitError","message":"limit"}',
        "You have hit your ChatGPT usage limit.",
        "429 subscription_sharing_usage_limit_exceeded",
    ]) {
        const result = classify({ provider: "opencode-go", message, now });

        assert.equal(result.type, "other", message);
    }
});

test("billing, sign-in, refused requests, and context overflow are not limits", () => {
    const other = (message: string, status?: number, overflow?: boolean) =>
        classify({
            provider: "anthropic",
            message,
            ...(status === undefined ? {} : { facts: facts(status) }),
            now,
            ...(overflow === undefined ? {} : { contextOverflow: overflow }),
        });

    assert.equal(other("insufficient_quota: you exceeded your current quota").type, "other");
    assert.equal(other("429 Your credit balance is too low", 429).type, "other");
    assert.equal(other("OAuth refresh failed for anthropic").type, "other");
    assert.equal(other("401 invalid x-api-key", 401).type, "other");
    assert.equal(other("400 invalid_request_error: bad field", 400).type, "other");
    assert.equal(other("404 model not found", 404).type, "other");
    assert.equal(other("prompt is too long: 250000 tokens > 200000 maximum", 400).type, "other");
    assert.equal(other("429 rate limit: too many tokens", 429, true).type, "other");
    assert.equal(other("fetch failed").type, "other");
});

test("the reason is one short line", () => {
    const result = limit(
        classify({
            provider: "anthropic",
            message: `429 ${"rate limit\n".repeat(200)}`,
            now,
        }),
    );

    assert.ok(result.reason.length <= 300);
    assert.ok(!result.reason.includes("\n"));
});

test("response facts keep limit headers and nothing else", () => {
    const headers = new Headers({
        authorization: "Bearer secret",
        "x-api-key": "secret",
        "set-cookie": "a=b",
        "Retry-After": "30",
        "anthropic-ratelimit-unified-reset": "1790000000",
        "x-codex-primary-used-percent": "100",
        "content-type": "application/json",
    });
    const kept = responseFacts(429, headers);

    assert.equal(kept.status, 429);
    assert.deepEqual(Object.keys(kept.headers).sort(), [
        "anthropic-ratelimit-unified-reset",
        "retry-after",
        "x-codex-primary-used-percent",
    ]);
});

test("a known HTTP status decides first: a permanent 4xx never waits, whatever its text says", () => {
    for (const status of [400, 401, 404, 405, 413, 415, 422]) {
        const result = classify({
            provider: "p",
            message: `${status} invalid_request_error: unsupported parameter 'rate_limit' (too many requests, overloaded)`,
            facts: facts(status),
            now,
        });

        assert.equal(result.type, "other", `HTTP ${status}`);
    }

    // The statuses that clear with time still wait.
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
        assert.equal(
            classify({ provider: "p", message: `${status} overloaded`, facts: facts(status), now })
                .type,
            "limit",
            `HTTP ${status}`,
        );
    }

    // A status that is not a failure of load, even with a 5xx's shape: not implemented does not clear.
    assert.equal(
        classify({ provider: "p", message: "501 not implemented", facts: facts(501), now }).type,
        "other",
    );
});

test("a usage limit sent as a 403 with a reset time waits; a plain 403 does not", () => {
    const usage = limit(
        classify({
            provider: "openai-codex",
            message: "403 usage_limit_reached. Try again in ~30 min.",
            facts: facts(403),
            now,
        }),
    );

    assert.equal(usage.scope, "account");
    assert.equal(usage.resetAt, now + 30 * 60_000);
    assert.equal(
        classify({ provider: "p", message: "403 Forbidden", facts: facts(403), now }).type,
        "other",
    );
    // With no reset time, a usage limit has nothing to wait until.
    assert.equal(
        classify({ provider: "p", message: "403 usage_limit_reached", facts: facts(403), now })
            .type,
        "other",
    );
});

test("a plain 409 does not wait; a 409 that gives a reset time does", () => {
    assert.equal(
        classify({
            provider: "p",
            message: "409 Conflict: resource already exists",
            facts: facts(409),
            now,
        }).type,
        "other",
    );
    // Text that says "try again in" is not a reset the response gave: only a header counts for a 409.
    assert.equal(
        classify({
            provider: "p",
            message: "409 conflict. Try again in 5 s",
            facts: facts(409),
            now,
        }).type,
        "other",
    );

    for (const headers of [
        { "retry-after": "5" },
        { "retry-after-ms": "5000" },
        { "x-ratelimit-reset-requests": "5s" },
    ] as Record<string, string>[]) {
        const result = limit(
            classify({
                provider: "p",
                message: "409 Conflict: the request is locked",
                facts: facts(409, headers),
                now,
            }),
        );

        assert.equal(result.resetAt, now + 5000, JSON.stringify(headers));
        assert.equal(result.source, "header");
    }
});
