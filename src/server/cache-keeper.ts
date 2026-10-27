/**
 * The cache keeper: while a run waits on a tool call, it re-sends the last model request with a one-token output cap
 * just before its prompt cache entry expires, when that costs less than the expected rebill. Pi's own cache warmer
 * (`cache-warmer.ts` in pi-coding-agent, its "streaming" mode) does this for Pi's CLI; Pi Durable has none.
 *
 * It warms only between the requests of one run: a request that ended in a tool call will be followed by another when
 * the tool ends, so the chance of a real request is high. It never warms an idle session: in the owner's own history
 * a warm during idle time costs about what it saves. It is on by default; `PI_POCKET_CACHE_KEEPER=off` turns it off.
 *
 * At each refresh point: warm when `hazard * missCost > warmCost`.
 *   - `warmCost`  a cache read of the whole prompt plus one output token.
 *   - `missCost`  what the next real request pays more if the entry is gone: a cache write instead of a read.
 *   - `hazard`    the chance that the run's next request comes in the next interval (`TOOL_HAZARD`).
 * A new real request, the run ending or being stopped (`runEnded`), an error, shutdown, or the age cap (`MAX_AGE_MS`,
 * 30 minutes) stops it. An entry whose first refresh would fall after the cap (the 1h tier) is never started: a
 * 30-minute tool wait does not outlive a 1h cache.
 * The cap is the best of 10 to 60 minutes on the owner's own tool-call gaps, and it bounds the loss when a tool waits
 * on a person (an approval).
 *
 * `install` wraps `models.streamSimple` in place, as `timing.ts` and `limit-gate.ts` do. The warm request goes to the
 * wrapped function, so it is not recorded as a real request. Deleting this module and its install line removes it.
 */
import { noWait } from "./limit-gate.ts";
import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Model,
    SimpleStreamOptions,
    TranscriptContext,
} from "@earendil-works/pi-ai";

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Refresh at 90% of the lifetime, and never closer than 10 seconds to its end. */
export function refreshDelayMs(ttlMs: number): number | undefined {
    return ttlMs <= 10_000 ? undefined : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Warming never goes on past this long after the real request that started it. */
export const MAX_AGE_MS = 30 * 60_000;
/** Chance of a real request in the next interval after a tool call: the run goes on when the tool ends. */
export const TOOL_HAZARD = 0.9;

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Decision = {
    action: "warm" | "stop";
    warmCost: number;
    missCost: number;
    hazard: number;
    expectedSavings: number;
};

/** Dollars. `rates` are per million tokens, as `Model.cost` is. */
export function decide(input: {
    promptTokens: number;
    rates: Rates;
    /** What a cache write costs per million tokens for the tier in use (the 1h tier costs more than the 5m tier). */
    writeRate: number;
    hazard: number;
}): Decision {
    const { promptTokens, rates, writeRate, hazard } = input;
    const warmCost = (promptTokens * rates.cacheRead + rates.output) / 1e6;
    const missCost = (promptTokens * (writeRate - rates.cacheRead)) / 1e6;
    const expectedSavings = hazard * missCost - warmCost;

    return { action: expectedSavings > 0 ? "warm" : "stop", warmCost, missCost, hazard, expectedSavings };
}

/** Whether a one-token replay leaves the cache entry alone: budget-based thinking would change `budget_tokens`. */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
    if (!options?.reasoning || model.api !== "anthropic-messages") {return true;}

    return (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
}

function ttlMsOf(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
    const long =
        options?.cacheRetention === "long" ||
        (options?.cacheRetention === undefined &&
            (options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION) === "long");

    if (options?.cacheRetention === "none") {return undefined;}

    const seconds = model.promptCache?.[long ? "long" : "short"];

    return seconds === undefined ? undefined : seconds * 1000;
}

type Entry = {
    model: Model<Api>;
    context: TranscriptContext;
    options: SimpleStreamOptions;
    promptTokens: number;
    ttlMs: number;
    /** The conversation this session belongs to, once known. */
    conversationId?: number;
    warms: number;
    spent: number;
    /** When the real request ended; the age cap counts from here, not from a refresh. */
    endedAt: number;
    /** When the next refresh should go out; a refresh later than the slack after it would pay a full rewrite. */
    dueAt: number;
    timer?: ReturnType<typeof setTimeout>;
    abort?: AbortController;
};

export type KeeperStatus = { warming: number; warms: number; spent: number };
export type KeeperDeps = {
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    log?: (line: string) => void;
    /** The conversation that sends requests under a provider session id, so `runEnded` can find its warm. */
    conversationOf?: (sessionId: string) => Promise<number | undefined>;
    /** Whether a conversation is in a run now. */
    isRunning?: (conversationId: number) => boolean;
    /** True turns the keeper off. Read at each decision. */
    disabled?: () => boolean;
};

export class CacheKeeper {
    readonly #deps: Required<Omit<KeeperDeps, "conversationOf" | "isRunning">> & Pick<KeeperDeps, "conversationOf" | "isRunning">;
    readonly #entries = new Map<string, Entry>();
    #underlying: StreamSimple | undefined;
    #closed = false;
    #warms = 0;
    #spent = 0;

    constructor(deps: KeeperDeps = {}) {
        this.#deps = {
            now: Date.now,
            setTimer: (fn, ms) => {
                const timer = setTimeout(fn, ms);

                timer.unref();

                return timer;
            },
            clearTimer: clearTimeout,
            log: () => {},
            disabled: () => process.env.PI_POCKET_CACHE_KEEPER === "off",
            ...deps,
        };
    }

    status(): KeeperStatus {
        return { warming: this.#entries.size, warms: this.#warms, spent: this.#spent };
    }

    /** Shutdown: no warm goes out after this. */
    close(): void {
        this.#closed = true;

        for (const key of [...this.#entries.keys()]) {this.#drop(key);}
    }

    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        this.#underlying = underlying;
        models.streamSimple = (model, context, options) => this.#stream(underlying, model, context, options);
    }

    #stream(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
    ): AssistantMessageEventStream {
        const stream = underlying(model, context, options);
        const key = options?.sessionId;

        if (key === undefined) {return stream;}

        // A real request that writes the cache replaces the entry, so stop warming the old one. A request that
        // does not use the cache (a title, with `cacheRetention: "none"`) leaves it alone.
        if (ttlMsOf(model, options) !== undefined) {this.#drop(key);}

        void stream.result().then(
            (message) => this.#onSettled(key, model, context, options, message),
            () => {},
        );

        return stream;
    }

    #onSettled(
        key: string,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        message: AssistantMessage,
    ): void {
        // Only a request that ended in a tool call is followed by another one soon.
        if (message.stopReason !== "toolUse" || options === undefined) {return;}

        if (this.#closed || this.#deps.disabled() || !isReplayable(model, options)) {return;}

        const ttlMs = ttlMsOf(model, options);
        const usage = message.usage;
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        const delay = ttlMs === undefined ? undefined : refreshDelayMs(ttlMs);

        // The first refresh must fall inside the cap: a longer cache outlives any wait the cap allows.
        if (ttlMs === undefined || delay === undefined || delay >= MAX_AGE_MS || promptTokens === 0) {return;}

        const now = this.#deps.now();
        const entry: Entry = {
            model,
            context,
            options,
            promptTokens,
            ttlMs,
            endedAt: now,
            dueAt: now + delay,
            warms: 0,
            spent: 0,
        };

        this.#entries.set(key, entry);
        this.#schedule(key, entry, delay);

        // Which conversation it is, so that the run's end can stop it. It still warms when this is not known.
        void this.#deps.conversationOf?.(key).then(
            (id) => {
                if (id === undefined || this.#entries.get(key) !== entry) {return;}

                entry.conversationId = id;

                // The run ended before the lookup came back: its end was missed, so stop now.
                if (this.#deps.isRunning?.(id) === false) {this.#drop(key);}
            },
            () => {},
        );
    }

    /** A run ended or was stopped: no request follows its last tool call, so its warm stops. */
    runEnded(conversationId: number): void {
        for (const [key, entry] of [...this.#entries]) {
            if (entry.conversationId === conversationId) {this.#drop(key);}
        }
    }

    #schedule(key: string, entry: Entry, delay: number): void {
        entry.dueAt = this.#deps.now() + delay;
        entry.timer = this.#deps.setTimer(() => void this.#tick(key, entry), delay);
    }

    #decision(entry: Entry): Decision {
        // Only the 5m tier is ever warmed (see `#onSettled`), which writes at the model's `cacheWrite` price.
        const writeRate = entry.model.cost.cacheWrite || entry.model.cost.input;

        return decide({ promptTokens: entry.promptTokens, rates: entry.model.cost, writeRate, hazard: TOOL_HAZARD });
    }

    async #tick(key: string, entry: Entry): Promise<void> {
        if (this.#entries.get(key) !== entry) {return;}

        const now = this.#deps.now();
        const delay = refreshDelayMs(entry.ttlMs) as number;
        // A timer that fired late (the machine slept) would send its refresh after the entry expired.
        const slack = (entry.ttlMs - delay) / 2;

        if (this.#deps.disabled() || now - entry.endedAt >= MAX_AGE_MS || now > entry.dueAt + slack) {
            return this.#drop(key);
        }

        if (this.#decision(entry).action === "stop") {return this.#drop(key);}

        const { signal: _signal, telemetry: _telemetry, ...rest } = entry.options as SimpleStreamOptions & {
            telemetry?: unknown;
        };
        const abort = new AbortController();

        entry.abort = abort;

        try {
            // `noWait`: a warm request that meets a limit fails; it must not queue behind the limit gate.
            const stream = (this.#underlying as StreamSimple)(
                entry.model,
                entry.context,
                noWait({ ...rest, maxTokens: 1, maxRetries: 0, signal: abort.signal }),
            );
            const message = await stream.result();

            if (this.#entries.get(key) !== entry) {return;}

            if (message.stopReason === "error" || message.stopReason === "aborted") {return this.#drop(key);}

            this.#warms++;
            this.#spent += message.usage.cost.total;
            entry.warms++;
            entry.spent += message.usage.cost.total;
            this.#schedule(key, entry, delay);
        } catch (error) {
            this.#deps.log(
                `Cache keeper stopped for a session: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.#drop(key);
        }
    }

    #drop(key: string): void {
        const entry = this.#entries.get(key);

        if (entry === undefined) {return;}

        if (entry.timer !== undefined) {this.#deps.clearTimer(entry.timer);}

        // The cost of a warm is in no usage total, so say it here.
        if (entry.warms > 0) {
            this.#deps.log(`Cache keeper: ${String(entry.warms)} warm requests for one tool wait, $${entry.spent.toFixed(4)}.`);
        }

        entry.abort?.abort();
        this.#entries.delete(key);
    }
}
