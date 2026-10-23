/**
 * The limit gate: a model request that hits a limit waits for it to clear, then goes on, inside the same stream. Pi
 * Durable sees one slow request, not a failure. `install` wraps `models.streamSimple` (as `timing.ts` does), outside
 * the timing wrapper, so each attempt is measured on its own.
 *
 * A request that fails before any content, with a limit `classify` (`limits.ts`) says clears with time, opens a gate
 * for the limit's key: the sign-in for a limit that covers the account, the model for one that does not. Every
 * request that meets a closed gate waits, until the reset time (or a backoff when there is none). Then ONE request, the
 * canary, goes out. That is the real request: one the provider rejects costs nothing. When it gets content, the gate
 * opens and the others leave one by one, a second or more apart.
 *
 * Nothing here stores a wait as the truth. A restart replays the generation's request, which meets the limit again
 * and waits again; `provider-limits.json` only keeps the gates, so each waiting session does not send one rejected
 * request first. A lost or damaged file means no limit is known.
 *
 * It never spends beyond that, chooses no other model, and gives up (`refusing`) rather than wait for a reset too far
 * away, so a limit that does not clear ends the run as it does without this.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    type FetchFunction,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { classify, type ResponseFacts, responseFacts, type Scope, type Source } from "./limits.ts";

/** A request made with this in its options never waits: it fails as it would without the gate (titles, summaries). */
export const NO_WAIT = Symbol("pocket.noWait");

/** `options`, marked so that its request does not wait for a limit. */
export function noWait<const T extends object>(options: T): T {
    return { ...options, [NO_WAIT]: true };
}

export type LimitTuning = {
    /** The soonest a wait ends, so a reset of "now" cannot make a loop. */
    minWaitMs: number;
    /** Added to a known reset, so many sessions do not meet it at the same second: from, to. */
    resetJitterMs: [number, number];
    /** The waits when no time is known, in order; the last repeats. */
    backoffMs: number[];
    /** The longest total wait when no time is known. */
    maxBackoffMs: number;
    /** Between the sessions a gate lets go after its canary got content: from, to. */
    spacingMs: [number, number];
    /** How long a gate that gave up fails requests at once. */
    refuseMs: number;
    /** Tries of one gate before it gives up. */
    maxTries: number;
    /** A wait this long (or longer) is told to the people in the session: a push. */
    longWaitMs: number;
};

export const DEFAULT_TUNING: LimitTuning = {
    minWaitMs: 5_000,
    resetJitterMs: [5_000, 30_000],
    backoffMs: [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
    maxBackoffMs: 30 * 60_000,
    spacingMs: [1_000, 5_000],
    refuseMs: 5 * 60_000,
    maxTries: 40,
    longWaitMs: 10 * 60_000,
};

/** What a gate shows to the people whose runs wait at it. */
export type WaitView = {
    /** The gate's key: the same for every session that waits on it. */
    key: string;
    provider: string;
    /** The model, for a limit that is the model's. */
    modelId?: string;
    scope: Scope;
    /** `reset`: until a known time. `backoff`: no time is known. */
    kind: "reset" | "backoff";
    since: number;
    /** When the next request goes out (the canary). */
    until: number;
    /** The time the provider gave, when it gave one. */
    resetAt?: number;
    reason: string;
    tries: number;
    /** The canary is out now. */
    probing: boolean;
};

type Waiter = {
    sessionId?: string;
    conversationId?: number;
    provider: string;
    modelId: string;
    signal?: AbortSignal | undefined;
    /** When this waiter may leave, after the gate opened. */
    releaseAt?: number;
    /** Ends the waiter's nap now. */
    poke?: () => void;
    told: boolean;
    /** The gate this request is in the set of. */
    at?: Gate | undefined;
};

type Gate = {
    key: string;
    scope: Scope;
    provider: string;
    modelId?: string;
    kind: "reset" | "backoff";
    since: number;
    until: number;
    resetAt?: number;
    source?: Source;
    reason: string;
    tries: number;
    state: "waiting" | "probing" | "refusing";
    /** What a request meeting a refusing gate fails with. */
    refusal?: string;
    canary?: Waiter;
    waiters: Set<Waiter>;
    timer?: NodeJS.Timeout;
};

/** What the app gives the gate. */
export type GateDeps = {
    /** Hours to wait for a known reset at most; 0 turns the gate off. */
    hours: () => number;
    /** How many sign-ins and sign-outs here the provider has had: a new one is a new account. */
    epoch: (provider: string) => number;
    /** The conversation whose generation makes a request with this session id, if it is known. */
    conversationOf: (sessionId: string) => Promise<number | undefined> | number | undefined;
    /** A wait began, changed, or ended: tell the tabs. */
    changed: () => void;
    /** A wait of `longWaitMs` or more began for this conversation. */
    started?: (conversationId: number, view: WaitView) => void;
    log: (line: string) => void;
    /** Where the gates are kept between runs. */
    file?: string;
    tuning?: Partial<LimitTuning>;
    now?: () => number;
    random?: () => number;
};

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Whether a stop signal fired (a function, so that a check after an await is not narrowed away). */
function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/** A span as people read it: `2 h 10 min`, `45 s`. */
export function span(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 90) {
        return `${seconds} s`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 90) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    if (hours < 48) {
        return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
    }

    const days = Math.floor(hours / 24);

    return `${days} d ${hours % 24} h`;
}

const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function failure(
    model: Model<Api>,
    started: number,
    stopReason: "error" | "aborted",
    errorMessage: string,
): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason,
        errorMessage,
        timestamp: started,
    };
}

export class LimitGate {
    readonly #deps: GateDeps;
    readonly #tuning: LimitTuning;
    readonly #gates = new Map<string, Gate>();
    /** The conversation of each provider session id found so far. */
    readonly #conversations = new Map<string, number>();
    readonly #now: () => number;
    readonly #random: () => number;

    constructor(deps: GateDeps) {
        this.#deps = deps;
        this.#tuning = { ...DEFAULT_TUNING, ...deps.tuning };
        this.#now = deps.now ?? Date.now;
        this.#random = deps.random ?? Math.random;
        this.#load();
    }

    // ─── What the app asks ──────────────────────────────────────────────────

    /** Wrap the runtime's `streamSimple` in place. Call it after the timing wrapper, so it is the outermost. */
    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        models.streamSimple = (model, context, options) => {
            const marked = options as (SimpleStreamOptions & { [NO_WAIT]?: true }) | undefined;

            if (marked?.[NO_WAIT] === true) {
                const { [NO_WAIT]: _marked, ...rest } = marked;

                return underlying(model, context, rest);
            }

            if (this.#deps.hours() <= 0) {
                return underlying(model, context, options);
            }

            return this.#stream(underlying, model, context, options);
        };
    }

    /** The wait a conversation's run is in, if it is in one (not one a gate refuses). */
    waitFor(conversationId: number): WaitView | undefined {
        for (const gate of this.#gates.values()) {
            if (gate.state === "refusing") {
                continue;
            }

            for (const waiter of gate.waiters) {
                if (waiter.conversationId === conversationId) {
                    return this.#view(gate);
                }
            }
        }

        return undefined;
    }

    /** Every conversation in a wait, with its wait. */
    waits(): { conversationId: number; view: WaitView }[] {
        const out: { conversationId: number; view: WaitView }[] = [];

        for (const gate of this.#gates.values()) {
            if (gate.state === "refusing") {
                continue;
            }

            for (const waiter of gate.waiters) {
                if (waiter.conversationId !== undefined) {
                    out.push({ conversationId: waiter.conversationId, view: this.#view(gate) });
                }
            }
        }

        return out;
    }

    /** Send the canary of the gate this conversation waits at now, rather than at its time. False: it is in no wait. */
    retryNow(conversationId: number): boolean {
        for (const gate of this.#gates.values()) {
            if (gate.state === "refusing") {
                continue;
            }

            for (const waiter of gate.waiters) {
                if (waiter.conversationId === conversationId) {
                    if (gate.state === "waiting") {
                        gate.until = this.#now();
                        this.#save();
                    }

                    this.#poke(gate);
                    this.#deps.changed();

                    return true;
                }
            }
        }

        return false;
    }

    /** A sign-in or a sign-out: what a provider's gates knew is about an account that is gone. Its waiters go on. */
    reset(provider: string): void {
        for (const gate of [...this.#gates.values()]) {
            if (gate.provider === provider) {
                this.#open(gate, false);
            }
        }
    }

    /** The gates now, for tests and the owner's log. */
    gates(): WaitView[] {
        return [...this.#gates.values()].map((gate) => this.#view(gate));
    }

    /** Stop every timer. */
    close(): void {
        for (const gate of this.#gates.values()) {
            clearTimeout(gate.timer);
        }
    }

    // ─── The stream ─────────────────────────────────────────────────────────

    #stream(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
    ): AssistantMessageEventStream {
        const out = createAssistantMessageEventStream();

        void this.#run(underlying, model, context, options, out).catch((error: unknown) => {
            const message = failure(model, this.#now(), "error", String(error));

            out.push({ type: "error", reason: "error", error: message });
            out.end(message);
        });

        return out;
    }

    async #run(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        out: AssistantMessageEventStream,
    ): Promise<void> {
        const signal = options?.signal;
        const started = this.#now();
        const waiter: Waiter = {
            ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            provider: model.provider,
            modelId: model.id,
            signal,
            told: false,
        };

        const end = (message: AssistantMessage) => {
            out.push(
                message.stopReason === "aborted"
                    ? { type: "error", reason: "aborted", error: message }
                    : { type: "error", reason: "error", error: message },
            );
            out.end(message);
        };

        try {
            for (;;) {
                if (isAborted(signal)) {
                    return end(failure(model, started, "aborted", "Request was aborted"));
                }

                const gate = this.#closed(model);
                let canary: Gate | undefined;

                if (gate !== undefined) {
                    const turn = await this.#wait(gate, waiter);

                    if (turn === "aborted") {
                        return end(failure(model, started, "aborted", "Request was aborted"));
                    }

                    if (turn === "refuse") {
                        return end(failure(model, started, "error", gate.refusal ?? gate.reason));
                    }

                    if (turn === "go") {
                        continue;
                    }

                    canary = gate;
                }

                const attempt = await this.#attempt(underlying, model, context, options, out);

                this.#leave(waiter);

                if (attempt.type === "done") {
                    if (canary !== undefined) {
                        if (attempt.content) {
                            this.#open(canary, true);
                        } else {
                            this.#free(canary, waiter);
                        }
                    }

                    return;
                }

                // The attempt failed before any content, and the failure is not an abort.
                const verdict = classify({
                    provider: model.provider,
                    message: attempt.message.errorMessage ?? "",
                    facts: attempt.facts,
                    now: this.#now(),
                    contextOverflow: isContextOverflow(attempt.message),
                });

                if (verdict.type === "other" || isAborted(signal)) {
                    if (canary !== undefined) {
                        this.#free(canary, waiter);
                    }

                    this.#flush(attempt, out);

                    return;
                }

                const gated = this.#limited(model, verdict, canary);

                if (gated.state === "refusing") {
                    // Gave up: this request fails with what the gate says.
                    this.#flush(attempt, out, gated.refusal);

                    return;
                }
            }
        } finally {
            this.#leave(waiter);
        }
    }

    /**
     * One request, forwarded as it comes. Its first events (the empty `start`) are held until content shows, so that a
     * failure leaves nothing behind it: the consumer then sees one request. `done`: the stream ended (content, or an
     * error after it, or an abort). `failed`: an error before any content.
     */
    async #attempt(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        out: AssistantMessageEventStream,
    ): Promise<
        | { type: "done"; content: boolean }
        | {
              type: "failed";
              message: AssistantMessage;
              held: AssistantMessageEvent[];
              facts: ResponseFacts | undefined;
          }
    > {
        let facts: ResponseFacts | undefined;
        const base: FetchFunction | undefined = options?.fetch;

        const recording: FetchFunction = async (input, init) => {
            const response = await (base ?? globalThis.fetch)(input, init);

            facts = responseFacts(response.status, response.headers);

            return response;
        };

        const stream = underlying(model, context, { ...options, fetch: recording });
        const held: AssistantMessageEvent[] = [];
        let flowing = false;
        let terminal: AssistantMessage | undefined;

        try {
            for await (const event of stream) {
                if (event.type === "error") {
                    terminal = event.error;

                    // Before content, a failure is held back: the gate decides whether the consumer ever sees it.
                    if (flowing || terminal.stopReason === "aborted") {
                        out.push(event);
                    }
                } else if (event.type === "done") {
                    terminal = event.message;
                    flowing = true;

                    for (const earlier of held.splice(0)) {
                        out.push(earlier);
                    }

                    out.push(event);
                } else if (flowing) {
                    out.push(event);
                } else if (event.partial.content.length === 0) {
                    held.push(event);
                } else {
                    flowing = true;

                    for (const earlier of held.splice(0)) {
                        out.push(earlier);
                    }

                    out.push(event);
                }
            }

            terminal ??= await stream.result();
        } catch (error) {
            terminal = failure(model, this.#now(), "error", String(error));
        }

        if (flowing || terminal.stopReason !== "error") {
            out.end(terminal);

            return { type: "done", content: flowing };
        }

        return { type: "failed", message: terminal, held, facts };
    }

    /** End the consumer's stream with a failed attempt as it was, or with `text` in place of its error. */
    #flush(
        attempt: { message: AssistantMessage; held: AssistantMessageEvent[] },
        out: AssistantMessageEventStream,
        text?: string,
    ): void {
        const message =
            text === undefined ? attempt.message : { ...attempt.message, errorMessage: text };

        for (const event of attempt.held) {
            out.push(event);
        }

        out.push({ type: "error", reason: "error", error: message });
        out.end(message);
    }

    // ─── Gates ──────────────────────────────────────────────────────────────

    #accountKey(provider: string): string {
        return `${provider}#${this.#deps.epoch(provider)}`;
    }

    #modelKey(provider: string, modelId: string): string {
        return `${this.#accountKey(provider)}/${modelId}`;
    }

    /** The closed gate a request for this model meets: its account's first, then its model's. */
    #closed(model: Model<Api>): Gate | undefined {
        const keys = [this.#accountKey(model.provider), this.#modelKey(model.provider, model.id)];

        for (const key of keys) {
            const gate = this.#gates.get(key);

            if (gate === undefined) {
                continue;
            }

            // A gate nobody waits at, long past its time (one kept from before a restart that no request met): gone.
            if (
                gate.waiters.size === 0 &&
                gate.state !== "probing" &&
                this.#now() > gate.until + 3_600_000
            ) {
                this.#drop(gate);

                continue;
            }

            return gate;
        }

        return undefined;
    }

    /**
     * A request failed on a limit: open the gate of its key (or move it on), and say when the next try is. A gate that
     * gives up (`refusing`) says no wait is worth it.
     */
    #limited(
        model: Model<Api>,
        verdict: Extract<ReturnType<typeof classify>, { type: "limit" }>,
        canary: Gate | undefined,
    ): Gate {
        const tuning = this.#tuning;
        const now = this.#now();
        const key =
            verdict.scope === "account"
                ? this.#accountKey(model.provider)
                : this.#modelKey(model.provider, model.id);
        let gate = this.#gates.get(key);

        // The canary's own failure moves the gate it came out of on, even when the scope now reads differently.
        gate ??= canary !== undefined && canary.key === key ? canary : undefined;

        if (gate === undefined) {
            gate = {
                key,
                scope: verdict.scope,
                provider: model.provider,
                ...(verdict.scope === "model" ? { modelId: model.id } : {}),
                kind: "backoff",
                since: now,
                until: now,
                reason: verdict.reason,
                tries: 0,
                state: "waiting",
                waiters: new Set(),
            };
            this.#gates.set(key, gate);
        }

        gate.tries++;
        gate.reason = verdict.reason;
        gate.canary = undefined;

        const maxReset = this.#deps.hours() * 3_600_000;
        let until: number;
        let why: string | undefined;

        if (verdict.resetAt !== undefined) {
            const jitter =
                tuning.resetJitterMs[0] +
                this.#random() * (tuning.resetJitterMs[1] - tuning.resetJitterMs[0]);

            until = Math.max(verdict.resetAt + jitter, now + tuning.minWaitMs);
            gate.kind = "reset";
            gate.resetAt = verdict.resetAt;

            if (verdict.source !== undefined) {
                gate.source = verdict.source;
            }

            if (until - now > maxReset) {
                why = `it resets in ${span(verdict.resetAt - now)} (${when(verdict.resetAt)}), and Pi Pocket waits at most ${span(maxReset)}`;
            }
        } else {
            const step = Math.min(gate.tries - 1, tuning.backoffMs.length - 1);
            const delay = tuning.backoffMs[step]! * (0.8 + this.#random() * 0.4);

            until = now + Math.max(delay, tuning.minWaitMs);
            gate.kind = "backoff";
            delete gate.resetAt;
            delete gate.source;

            if (now - gate.since >= Math.min(tuning.maxBackoffMs, maxReset)) {
                why = `it did not clear in ${span(now - gate.since)}`;
            }
        }

        if (why === undefined && gate.tries > tuning.maxTries) {
            why = `it did not clear after ${tuning.maxTries} tries`;
        }

        if (why !== undefined) {
            this.#giveUp(gate, `${verdict.reason} Not waiting: ${why}.`);

            return gate;
        }

        gate.until = until;
        gate.state = "waiting";
        this.#poke(gate);
        this.#save();
        this.#deps.changed();

        return gate;
    }

    /** A gate that will not wait: its requests fail at once, with `text`, for a few minutes. */
    #giveUp(gate: Gate, text: string): void {
        gate.state = "refusing";
        gate.refusal = text;
        gate.canary = undefined;
        gate.until = this.#now() + this.#tuning.refuseMs;
        clearTimeout(gate.timer);
        gate.timer = setTimeout(() => this.#drop(gate), this.#tuning.refuseMs);
        gate.timer.unref();
        this.#deps.log(`Limit at ${gate.key}: ${text}`);
        this.#poke(gate);
        this.#save();
        this.#deps.changed();
    }

    /** The canary got content, or a sign-in changed: the gate goes, and its waiters leave one by one. */
    #open(gate: Gate, spaced: boolean): void {
        if (this.#gates.get(gate.key) !== gate) {
            return;
        }

        const [from, to] = this.#tuning.spacingMs;
        let at = this.#now();

        for (const waiter of gate.waiters) {
            if (spaced && waiter !== gate.canary) {
                at += from + this.#random() * (to - from);
                waiter.releaseAt = at;
            }
        }

        this.#drop(gate);
    }

    /** The canary failed for another reason than a limit, or was stopped: the next waiter may try. */
    #free(gate: Gate, waiter: Waiter): void {
        if (gate.canary === waiter) {
            gate.canary = undefined;

            if (gate.state === "probing") {
                gate.state = "waiting";
            }

            this.#poke(gate);
            this.#deps.changed();
        }
    }

    /** Take a gate away, and wake whoever waits at it. */
    #drop(gate: Gate): void {
        clearTimeout(gate.timer);

        if (this.#gates.get(gate.key) === gate) {
            this.#gates.delete(gate.key);
        }

        this.#poke(gate);
        this.#save();
        this.#deps.changed();
    }

    #poke(gate: Gate): void {
        for (const waiter of gate.waiters) {
            waiter.poke?.();
        }
    }

    // ─── Waiting ────────────────────────────────────────────────────────────

    /**
     * Wait at `gate` until this request may go. `canary`: it is the one that goes first, to find out. `go`: the gate is
     * open or gone, look again. `refuse`: the gate gave up. `aborted`: the run was stopped.
     */
    async #wait(gate: Gate, waiter: Waiter): Promise<"canary" | "go" | "refuse" | "aborted"> {
        gate.waiters.add(waiter);
        waiter.at = gate;
        this.#tell(gate, waiter);

        let turn: "canary" | "go" | "refuse" | "aborted" | undefined;

        try {
            for (;;) {
                if (isAborted(waiter.signal)) {
                    return (turn = "aborted");
                }

                if (this.#gates.get(gate.key) !== gate) {
                    // Open: leave at the time the gate gave this request.
                    const left = (waiter.releaseAt ?? 0) - this.#now();

                    if (left > 0) {
                        await this.#nap(left, waiter);

                        if (isAborted(waiter.signal)) {
                            return (turn = "aborted");
                        }
                    }

                    delete waiter.releaseAt;

                    return (turn = "go");
                }

                if (gate.state === "refusing") {
                    return (turn = "refuse");
                }

                const left = gate.until - this.#now();

                if (left > 0) {
                    await this.#nap(left, waiter);

                    continue;
                }

                if (gate.canary === undefined) {
                    gate.canary = waiter;
                    gate.state = "probing";
                    this.#deps.changed();

                    return (turn = "canary");
                }

                // Someone else is finding out: look again when that ends (or after a while, if it hangs).
                await this.#nap(30_000, waiter);
            }
        } finally {
            // The canary stays in the gate while its request is out: people see it probe.
            if (turn !== "canary") {
                this.#leave(waiter);
            }
        }
    }

    /** Sleep `ms`, until poked, or until the run is stopped. */
    #nap(ms: number, waiter: Waiter): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                waiter.signal?.removeEventListener("abort", done);
                delete waiter.poke;
                resolve();
            };

            const timer = setTimeout(done, ms);

            timer.unref();
            waiter.poke = done;
            waiter.signal?.addEventListener("abort", done, { once: true });
        });
    }

    /** The request is no longer at its gate: it goes on, or is done. */
    #leave(waiter: Waiter): void {
        delete waiter.poke;

        const gate = waiter.at;

        if (gate === undefined) {
            return;
        }

        delete waiter.at;
        gate.waiters.delete(waiter);

        if (gate.canary === waiter && isAborted(waiter.signal)) {
            this.#free(gate, waiter);
        }

        this.#deps.changed();
    }

    /** Find the conversation of a waiting request, once, and tell the people of a long wait. */
    #tell(gate: Gate, waiter: Waiter): void {
        this.#deps.changed();

        if (waiter.told || waiter.sessionId === undefined) {
            return;
        }

        waiter.told = true;

        const known = this.#conversations.get(waiter.sessionId);
        const found = known ?? this.#deps.conversationOf(waiter.sessionId);

        void Promise.resolve(found).then(
            (conversationId) => {
                if (conversationId === undefined) {
                    return;
                }

                this.#conversations.set(waiter.sessionId!, conversationId);
                waiter.conversationId = conversationId;
                this.#deps.changed();

                if (
                    gate.until - this.#now() >= this.#tuning.longWaitMs &&
                    gate.waiters.has(waiter)
                ) {
                    this.#deps.started?.(conversationId, this.#view(gate));
                }
            },
            () => {},
        );
    }

    #view(gate: Gate): WaitView {
        return {
            key: gate.key,
            provider: gate.provider,
            ...(gate.modelId === undefined ? {} : { modelId: gate.modelId }),
            scope: gate.scope,
            kind: gate.kind,
            since: gate.since,
            until: gate.until,
            ...(gate.resetAt === undefined ? {} : { resetAt: gate.resetAt }),
            reason: gate.reason,
            tries: gate.tries,
            probing: gate.state === "probing",
        };
    }

    // ─── The file ───────────────────────────────────────────────────────────

    #save(): void {
        const file = this.#deps.file;

        if (file === undefined) {
            return;
        }

        const gates = [...this.#gates.values()]
            .filter((gate) => gate.state !== "refusing")
            .map((gate) => ({
                key: gate.key,
                scope: gate.scope,
                provider: gate.provider,
                modelId: gate.modelId,
                kind: gate.kind,
                since: gate.since,
                until: gate.until,
                resetAt: gate.resetAt,
                source: gate.source,
                reason: gate.reason,
                tries: gate.tries,
            }));

        try {
            writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, gates }), { mode: 0o600 });
            renameSync(`${file}.tmp`, file);
        } catch (error) {
            this.#deps.log(`Provider limits not saved: ${String(error)}`);
        }
    }

    /** Read the gates kept by the last run. A missing, unreadable, or odd file means no limit is known. */
    #load(): void {
        const file = this.#deps.file;

        if (file === undefined) {
            return;
        }

        let text: string;

        try {
            text = readFileSync(file, "utf8");
        } catch {
            return;
        }

        try {
            const saved = JSON.parse(text) as { version?: unknown; gates?: unknown };

            if (saved.version !== 1 || !Array.isArray(saved.gates)) {
                return;
            }

            const now = this.#now();

            for (const each of saved.gates.slice(0, 200) as Record<string, unknown>[]) {
                const gate = this.#restored(each, now);

                if (gate !== undefined) {
                    this.#gates.set(gate.key, gate);
                }
            }
        } catch (error) {
            this.#deps.log(`Provider limits file ignored: ${String(error)}`);
        }
    }

    #restored(each: Record<string, unknown>, now: number): Gate | undefined {
        const text = (value: unknown, max = 300) =>
            typeof value === "string" && value.length <= max ? value : undefined;
        const number = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const key = text(each.key, 200);
        const provider = text(each.provider, 100);
        const since = number(each.since);
        const until = number(each.until);
        const tries = number(each.tries);

        if (
            key === undefined ||
            provider === undefined ||
            since === undefined ||
            until === undefined ||
            tries === undefined ||
            (each.scope !== "account" && each.scope !== "model") ||
            (each.kind !== "reset" && each.kind !== "backoff") ||
            // A gate whose time passed long ago says nothing now.
            until < now - 10 * 60_000
        ) {
            return undefined;
        }

        const modelId = text(each.modelId, 200);
        const resetAt = number(each.resetAt);
        const source = each.source === "header" || each.source === "body" || each.source === "text";

        return {
            key,
            scope: each.scope,
            provider,
            ...(modelId === undefined ? {} : { modelId }),
            kind: each.kind,
            since,
            until,
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(source ? { source: each.source as Source } : {}),
            reason: text(each.reason) ?? "",
            tries,
            state: "waiting",
            waiters: new Set(),
        };
    }
}
