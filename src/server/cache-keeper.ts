/**
 * The cache keeper: while the owner has it on, it re-sends a finished model request with a one-token output cap
 * just before its prompt cache entry expires, but only when that costs less than the expected rebill. Pi's own
 * cache warmer (`cache-warmer.ts` in pi-coding-agent) does this for Pi's CLI; Pi Durable has none, so this does
 * the same for Pocket.
 *
 * One rule, no modes. At each refresh point it asks: is `hazard * missCost` greater than `warmCost`?
 *   - `warmCost`  is a cache read of the whole prompt plus one output token.
 *   - `missCost`  is what the next real request pays more if the entry is gone: a cache write instead of a read.
 *   - `hazard`    is the chance that a real request arrives in the next refresh interval. After a tool call it is
 *                 high (the run goes on). While idle it is learned from this server's own idle gaps by age, with a
 *                 prior, so a quiet session stops being warmed and a busy one keeps going.
 * It stops at the first "no" and starts again at the next real request. A hard age cap bounds the spend.
 *
 * `install` wraps `models.streamSimple` in place, as `timing.ts` and `limit-gate.ts` do. The warm request goes to
 * the wrapped function, so it is not recorded as a real request. The switch is a file: `{ "enabled": true }`.
 * Nothing else in the app reads it, so deleting this module and its install line removes the feature.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
export const MAX_AGE_MS = 60 * 60_000;
/** Chance of a real request in the next interval after a tool call: the run goes on when the tool ends. */
const TOOL_HAZARD = 0.9;
/** The idle hazard before there is data, and how many observations that prior is worth. */
const PRIOR_HAZARD = 0.15;
const PRIOR_WEIGHT = 5;
const MAX_GAPS = 500;
/** How long a read of the switch file is trusted. */
const ENABLED_CACHE_MS = 5_000;
/** The learned gaps reach the file at most this often. */
const SAVE_EVERY_MS = 30_000;

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

/**
 * Chance that a real request arrives in the interval starting at `ageMs`, given that none has by then. It is
 * learned from past gaps (`gaps`, in ms) in buckets of one interval, pulled toward the prior with few data.
 */
export function idleHazard(gaps: readonly number[], ageMs: number, intervalMs: number): number {
    const bucket = Math.floor(ageMs / intervalMs);
    let atRisk = 0;
    let arrived = 0;

    for (const gap of gaps) {
        if (gap < bucket * intervalMs) {continue;}

        atRisk++;

        if (gap < (bucket + 1) * intervalMs) {arrived++;}
    }

    return (arrived + PRIOR_HAZARD * PRIOR_WEIGHT) / (atRisk + PRIOR_WEIGHT);
}

/** Whether a one-token replay leaves the cache entry alone: budget-based thinking would change `budget_tokens`. */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
    if (!options?.reasoning || model.api !== "anthropic-messages") {return true;}

    return (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
}

function ttlMsOf(model: Model<Api>, options: SimpleStreamOptions | undefined): { ms: number; long: boolean } | undefined {
    const long =
        options?.cacheRetention === "long" ||
        (options?.cacheRetention === undefined && (options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION) === "long");

    if (options?.cacheRetention === "none") {return undefined;}

    const seconds = model.promptCache?.[long ? "long" : "short"];

    return seconds === undefined ? undefined : { ms: seconds * 1000, long };
}

type Entry = {
    model: Model<Api>;
    context: TranscriptContext;
    options: SimpleStreamOptions;
    promptTokens: number;
    ttlMs: number;
    long: boolean;
    toolNext: boolean;
    /** When the real request ended; the age of a warm run counts from here. */
    endedAt: number;
    /** When the next refresh should go out; a refresh later than the slack after it would pay a full rewrite. */
    dueAt?: number;
    timer?: ReturnType<typeof setTimeout>;
    abort?: AbortController;
};

export type KeeperStatus = { enabled: boolean; warming: number; warms: number; spent: number };
export type KeeperDeps = {
    /** The switch file, `{ "enabled": true }`, read at every decision. A missing or bad file means off. */
    file: string;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    log?: (line: string) => void;
};

export class CacheKeeper {
    readonly #deps: Required<Omit<KeeperDeps, "file">> & { file: string };
    readonly #entries = new Map<string, Entry>();
    /** When each session's last real request ended, to learn the idle gaps from the next one. */
    readonly #idleSince = new Map<string, number>();
    #gaps: number[] = [];
    #warms = 0;
    #spent = 0;

    constructor(deps: KeeperDeps) {
        this.#deps = {
            now: Date.now,
            setTimer: (fn, ms) => {
                const timer = setTimeout(fn, ms);

                timer.unref();

                return timer;
            },
            clearTimer: clearTimeout,
            log: () => {},
            ...deps,
        };
        this.#gaps = this.#loadGaps();
    }

    /** The switch. The file is read at most every few seconds, not on each request. */
    enabled(): boolean {
        const now = this.#deps.now();

        if (this.#enabledAt === undefined || now - this.#enabledAt >= ENABLED_CACHE_MS) {
            this.#enabled = this.#readFile().enabled === true;
            this.#enabledAt = now;
        }

        return this.#enabled;
    }

    setEnabled(on: boolean): void {
        this.#enabled = on;
        this.#enabledAt = this.#deps.now();
        this.#save(on);

        if (!on) {this.cancelAll();}
    }

    /** Shutdown: no warm goes out after this, and the learned gaps reach the file. */
    close(): void {
        this.cancelAll();

        if (this.#saveTimer !== undefined) {
            clearTimeout(this.#saveTimer);
            this.#saveTimer = undefined;
        }

        if (this.#dirty) {this.#save(this.#readFile().enabled === true);}
    }

    #enabled = false;
    #enabledAt: number | undefined;
    #dirty = false;
    #saveTimer: ReturnType<typeof setTimeout> | undefined;

    #readFile(): { enabled?: unknown; gaps?: unknown } {
        try {
            return JSON.parse(readFileSync(this.#deps.file, "utf8")) as { enabled?: unknown; gaps?: unknown };
        } catch {
            return {};
        }
    }

    status(): KeeperStatus {
        return { enabled: this.enabled(), warming: this.#entries.size, warms: this.#warms, spent: this.#spent };
    }

    cancelAll(): void {
        for (const key of [...this.#entries.keys()]) {this.#drop(key);}
    }

    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        this.#underlying = underlying;
        models.streamSimple = (model, context, options) => this.#stream(underlying, model, context, options);
    }

    #underlying: StreamSimple | undefined;

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

        const started = this.#deps.now();
        const since = this.#idleSince.get(key);

        if (since !== undefined) {
            this.#recordGap(started - since);
            this.#idleSince.delete(key);
        }

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
        if (message.stopReason === "error" || message.stopReason === "aborted") {return;}

        const endedAt = this.#deps.now();

        // Only a gap after a finished answer is a person's idle time; after a tool call the run just goes on.
        if (message.stopReason === "toolUse") {this.#idleSince.delete(key);}
        else {this.#idleSince.set(key, endedAt);}

        if (!this.enabled() || options === undefined || !isReplayable(model, options)) {return;}

        const ttl = ttlMsOf(model, options);
        const usage = message.usage;
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;

        if (ttl === undefined || promptTokens === 0 || refreshDelayMs(ttl.ms) === undefined) {return;}

        const entry: Entry = {
            model,
            context,
            options,
            promptTokens,
            ttlMs: ttl.ms,
            long: ttl.long,
            toolNext: message.stopReason === "toolUse",
            endedAt,
        };

        this.#entries.set(key, entry);
        this.#schedule(key, entry);
    }

    #schedule(key: string, entry: Entry): void {
        const delay = refreshDelayMs(entry.ttlMs) as number;

        entry.dueAt = this.#deps.now() + delay;
        entry.timer = this.#deps.setTimer(() => void this.#tick(key, entry), delay);
    }

    #decision(entry: Entry): Decision {
        const interval = refreshDelayMs(entry.ttlMs) as number;
        const age = this.#deps.now() - entry.endedAt;
        const hazard = entry.toolNext ? TOOL_HAZARD : idleHazard(this.#gaps, age, interval);
        // The 1h tier writes at twice the input price; the 5m tier at the model's own `cacheWrite` price.
        const writeRate = entry.long ? entry.model.cost.input * 2 : entry.model.cost.cacheWrite || entry.model.cost.input;

        return decide({ promptTokens: entry.promptTokens, rates: entry.model.cost, writeRate, hazard });
    }

    async #tick(key: string, entry: Entry): Promise<void> {
        if (this.#entries.get(key) !== entry) {return;}

        const age = this.#deps.now() - entry.endedAt;

        if (!this.enabled() || age >= MAX_AGE_MS) {return this.#drop(key);}

        // A timer that fired late (the machine slept) would send its refresh after the entry expired.
        const slack = (entry.ttlMs - (refreshDelayMs(entry.ttlMs) as number)) / 2;

        if (entry.dueAt !== undefined && this.#deps.now() > entry.dueAt + slack) {return this.#drop(key);}

        const decision = this.#decision(entry);

        if (decision.action === "stop") {return this.#drop(key);}

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
            this.#schedule(key, entry);
        } catch (error) {
            this.#deps.log(`Cache keeper stopped for a session: ${error instanceof Error ? error.message : String(error)}`);
            this.#drop(key);
        }
    }

    #drop(key: string): void {
        const entry = this.#entries.get(key);

        if (entry === undefined) {return;}

        if (entry.timer !== undefined) {this.#deps.clearTimer(entry.timer);}

        entry.abort?.abort();
        this.#entries.delete(key);
    }

    #recordGap(ms: number): void {
        this.#gaps.push(ms);

        if (this.#gaps.length > MAX_GAPS) {this.#gaps.splice(0, this.#gaps.length - MAX_GAPS);}

        this.#dirty = true;

        if (this.#saveTimer === undefined) {
            this.#saveTimer = setTimeout(() => {
                this.#saveTimer = undefined;
                this.#save(this.#readFile().enabled === true);
            }, SAVE_EVERY_MS);
            this.#saveTimer.unref();
        }
    }

    #loadGaps(): number[] {
        const gaps = this.#readFile().gaps;

        return Array.isArray(gaps) ? gaps.filter((gap): gap is number => typeof gap === "number") : [];
    }

    #save(enabled: boolean): void {
        try {
            const temporary = `${this.#deps.file}.tmp`;

            writeFileSync(temporary, JSON.stringify({ enabled, gaps: this.#gaps }));
            renameSync(temporary, this.#deps.file);
            this.#dirty = false;
        } catch (error) {
            this.#deps.log(`Cache keeper could not save its file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
