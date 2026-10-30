/** The DevTools protocol over a pipe, and the Chromium process at the other end of it. */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Readable, Writable } from "node:stream";

export class BrowserError extends Error {}

/** A DevTools protocol message: untyped JSON, read field by field where it arrives. */
export type Json = any;
type EventListener = (method: string, params: Json) => void;

/** Messages are JSON, each ended by a NUL byte: Chromium reads from fd 3 and writes to fd 4. */
export class Connection {
    readonly #out: Writable;
    #parts: string[] = [];
    #next = 0;
    readonly #pending = new Map<
        number,
        { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    readonly #sessions = new Map<string, EventListener>();
    #closed: string | undefined;
    /** Events without a session: the browser's own, such as targets appearing. */
    onEvent: EventListener | undefined;
    onClose: (() => void) | undefined;

    constructor(out: Writable, input: Readable) {
        this.#out = out;
        input.setEncoding("utf8");
        input.on("data", (chunk: string) => this.#receive(chunk));
        input.on("close", () => this.close("The browser closed."));
        input.on("error", () => this.close("The browser closed."));
        out.on("error", () => this.close("The browser closed."));
    }

    get closed(): boolean {
        return this.#closed !== undefined;
    }

    #receive(chunk: string): void {
        let start = 0;
        let end = chunk.indexOf("\0");

        while (end !== -1) {
            this.#parts.push(chunk.slice(start, end));
            const text = this.#parts.join("");

            this.#parts = [];
            this.#dispatch(text);
            start = end + 1;
            end = chunk.indexOf("\0", start);
        }

        if (start < chunk.length) {
            this.#parts.push(chunk.slice(start));
        }
    }

    #dispatch(text: string): void {
        let message: Json;

        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        if (typeof message.id === "number") {
            const pending = this.#pending.get(message.id);

            if (pending === undefined) {
                return;
            }

            this.#pending.delete(message.id);
            clearTimeout(pending.timer);

            if (message.error !== undefined) {
                pending.reject(new BrowserError(String(message.error.message ?? message.error)));
            } else {
                pending.resolve(message.result ?? {});
            }

            return;
        }

        if (typeof message.method !== "string") {
            return;
        }

        try {
            if (typeof message.sessionId === "string") {
                this.#sessions.get(message.sessionId)?.(message.method, message.params ?? {});
            } else {
                this.onEvent?.(message.method, message.params ?? {});
            }
        } catch {
            // A listener's mistake must not stop the connection.
        }
    }

    send(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string,
        timeoutMs = 30_000,
    ): Promise<Json> {
        if (this.#closed !== undefined) {
            return Promise.reject(new BrowserError(this.#closed));
        }

        const id = ++this.#next;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new BrowserError(`The browser did not answer ${method} in time.`));
            }, timeoutMs);

            timer.unref();
            this.#pending.set(id, { resolve, reject, timer });
            this.#out.write(
                `${JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId })}\0`,
            );
        });
    }

    listen(sessionId: string, listener: EventListener): void {
        this.#sessions.set(sessionId, listener);
    }

    unlisten(sessionId: string): void {
        this.#sessions.delete(sessionId);
    }

    close(reason: string): void {
        if (this.#closed !== undefined) {
            return;
        }

        this.#closed = reason;

        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new BrowserError(reason));
        }

        this.#pending.clear();
        this.#sessions.clear();
        this.onClose?.();
    }
}

const LAUNCH_ARGS = [
    "--headless=new",
    "--remote-debugging-pipe",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    // Pages keep running while nobody watches: Pi tests them in the background.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio",
    "--password-store=basic",
    "--use-mock-keychain",
    "--force-color-profile=srgb",
];

/**
 * Some Chromium builds (ego lite) do not exit when the pipe closes. So each launch writes a record, a normal exit kills
 * every live child, and the next launch kills the browsers of servers that died without a normal exit (SIGKILL, crash).
 * A record names the server that owns the browser: a browser of a live server is never touched.
 */
export const RECORD_FOLDER = join(tmpdir(), `pi-pocket-chromium-${process.getuid?.() ?? "user"}`);
const run = promisify(execFile);
/** Each live browser and the record file that names it. */
const live = new Map<ChildProcess, string>();

process.once("exit", () => {
    for (const [child, record] of live) {
        child.kill("SIGKILL");
        rmSync(record, { force: true });
    }
});

async function sweepOrphans(): Promise<void> {
    // No `ps` on Windows: there only the exit hook runs.
    if (process.platform === "win32") {
        return;
    }

    let names: string[] = [];

    try {
        names = readdirSync(RECORD_FOLDER);
    } catch {
        return;
    }

    // A name that is not a pid is a record still being written: its owner renames it when it is whole.
    for (const name of names.filter((name) => /^\d+$/.test(name))) {
        const file = join(RECORD_FOLDER, name);

        try {
            const record = JSON.parse(readFileSync(file, "utf8")) as {
                server: number;
                profile: string;
            };
            const { stdout } = await run("ps", ["-o", "ppid=,command=", "-p", name]).catch(() => ({
                stdout: "",
            }));
            const line = stdout.trim();

            // The owner is alive while the browser is still its child. An orphan has a new parent, so this also
            // holds when the owner's pid belongs to another process now. A process without this profile is not ours.
            if (line.startsWith(`${record.server} `)) {
                continue;
            }

            if (line.includes(`--user-data-dir=${record.profile}`)) {
                process.kill(Number(name), "SIGKILL");
            }
        } catch (error) {
            // Another server swept this record first.
            const code = (error as NodeJS.ErrnoException).code;

            if (code !== "ENOENT" && code !== "ESRCH") {
                console.error(`Could not sweep browser record ${file}:`, error);
            }

            continue;
        }

        rmSync(file, { force: true });
    }
}

/** One Chromium process. */
export class Chromium {
    readonly connection: Connection;
    readonly #child: ChildProcess;
    readonly exited: Promise<void>;
    userAgent = "";

    get pid(): number | undefined {
        return this.#child.pid;
    }

    private constructor(child: ChildProcess, connection: Connection) {
        this.#child = child;
        this.connection = connection;
        this.exited = new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                done();
            } else {
                child.once("exit", () => done());
            }
        });
    }

    static async launch(
        executable: string,
        profile: string,
        extra: readonly string[],
    ): Promise<Chromium> {
        mkdirSync(profile, { recursive: true, mode: 0o700 });
        await sweepOrphans();
        const child = spawn(
            executable,
            [...LAUNCH_ARGS, `--user-data-dir=${profile}`, ...extra, "about:blank"],
            {
                stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
            },
        );
        let stderr = "";

        if (child.pid !== undefined) {
            const record = join(RECORD_FOLDER, String(child.pid));

            live.set(child, record);

            try {
                mkdirSync(RECORD_FOLDER, { recursive: true, mode: 0o700 });
                // Whole or not there: a sweep by another server must never read a half-written record.
                writeFileSync(`${record}.tmp`, JSON.stringify({ server: process.pid, profile }));
                renameSync(`${record}.tmp`, record);
            } catch (error) {
                // The browser still works: only a crash of this server could leave it behind.
                console.error(`Could not record browser ${child.pid}:`, error);
            }

            child.once("exit", () => {
                live.delete(child);
                rmSync(record, { force: true });
            });
        }

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-4000);
        });
        const failed = new Promise<never>((_, reject) => {
            // Every error: one after the start (a failed kill) would otherwise be unhandled and stop the server.
            child.on("error", (error) =>
                reject(new BrowserError(`Could not start ${executable}: ${error.message}`)),
            );
            child.once("exit", (code, signal) => {
                const why = stderr.trim().split("\n").slice(-6).join("\n");

                reject(
                    new BrowserError(
                        `The browser exited as it started (${signal ?? `code ${code}`}).${why === "" ? "" : `\n${why}`}`,
                    ),
                );
            });
        });

        failed.catch(() => {});

        if (child.stdio[3] == null || child.stdio[4] == null) {
            child.kill("SIGKILL");

            throw new BrowserError(`Could not start ${executable}.`);
        }

        const connection = new Connection(child.stdio[3] as Writable, child.stdio[4] as Readable);
        const chromium = new Chromium(child, connection);

        child.once("exit", () => connection.close("The browser stopped."));

        try {
            const version = await Promise.race([
                connection.send("Browser.getVersion", {}, undefined, 20_000),
                failed,
            ]);

            chromium.userAgent = String(version.userAgent ?? "").replace(
                "HeadlessChrome/",
                "Chrome/",
            );
            await connection.send("Target.setDiscoverTargets", { discover: true });
        } catch (error) {
            chromium.kill();

            throw error;
        }

        return chromium;
    }

    kill(): void {
        this.connection.close("The browser stopped.");

        if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
            return;
        }

        this.#child.kill("SIGTERM");
        const force = setTimeout(() => this.#child.kill("SIGKILL"), 3000);

        force.unref();
        this.#child.once("exit", () => clearTimeout(force));
    }
}
