/**
 * Background processes: the servers and other programs that sessions' commands started and left running. It tags each
 * command with its session, finds those that outlived the command that started them, and shows them to the owner, by
 * session, with their ports and age, to stop. Linux only (it reads /proc).
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";

/** The variable each command gets: the session its work is for. */
export const SESSION_VARIABLE = "PI_POCKET_SESSION";
/** How often the counts are read again for the status line, and how long a stop waits before it forces one. */
const COUNT_MS = 30_000;
const FORCE_AFTER_MS = 4000;
/** Linux's clock ticks a second, for a process's start time: 100 on every common system. */
const TICKS = 100;
const MAX_COMMAND = 400;

/** A process a session's command left running. `session` is undefined for one from before the tag. */
export type LeftProcess = {
    pid: number;
    ppid: number;
    pgid: number;
    /** When it started, ms since the epoch, to show. */
    startedAt: number;
    /** When it started, in the kernel's clock ticks since boot: with `pid`, what says it is still the same process. */
    startTicks: number;
    command: string;
    cwd?: string;
    session?: number;
    ports: number[];
};

/** Processes a command started together (one process group), as the owner sees and stops them. */
export type Job = {
    key: string;
    session?: number;
    command: string;
    cwd?: string;
    startedAt: number;
    ports: number[];
    processes: { pid: number; startTicks: number; command: string }[];
};

type Stat = { ppid: number; pgid: number; start: number };

/** `/proc/<pid>/stat`'s parent, group, and start, read after the name, which can hold spaces and parentheses. */
function readStat(proc: string, pid: number): Stat | undefined {
    try {
        const text = readFileSync(join(proc, String(pid), "stat"), "utf8");
        const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");

        // Fields 3 on: state, ppid (4), pgrp (5), …, starttime (22).
        return { ppid: Number(rest[1]), pgid: Number(rest[2]), start: Number(rest[19]) };
    } catch {
        return undefined;
    }
}

function bootTime(proc: string): number {
    try {
        const line = /^btime (\d+)$/m.exec(readFileSync(join(proc, "stat"), "utf8"));

        return line === null ? 0 : Number(line[1]) * 1000;
    } catch {
        return 0;
    }
}

/** The socket inodes that listen for TCP, and their ports. */
function listening(proc: string): Map<string, number> {
    const sockets = new Map<string, number>();

    for (const file of ["tcp", "tcp6"]) {
        let text = "";

        try {
            text = readFileSync(join(proc, "net", file), "utf8");
        } catch {
            continue;
        }

        for (const line of text.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);

            if (fields[3] === "0A" && fields[9] !== undefined) {
                sockets.set(fields[9], Number.parseInt(fields[1]?.split(":")[1] ?? "", 16));
            }
        }
    }

    return sockets;
}

function portsOf(proc: string, pid: number, sockets: Map<string, number>): number[] {
    const ports = new Set<number>();

    try {
        for (const fd of readdirSync(join(proc, String(pid), "fd"))) {
            try {
                const inode = /^socket:\[(\d+)\]$/.exec(
                    readlinkSync(join(proc, String(pid), "fd", fd)),
                )?.[1];
                const port = inode === undefined ? undefined : sockets.get(inode);

                if (port !== undefined && Number.isInteger(port)) {
                    ports.add(port);
                }
            } catch {
                // Closed while we looked.
            }
        }
    } catch {
        // Gone, or not ours to read.
    }

    return [...ports].sort((a, b) => a - b);
}

/** Whether this system has what a scan reads. */
export const scanSupported = (proc = "/proc") => {
    try {
        readFileSync(join(proc, "self", "stat"));

        return true;
    } catch {
        return false;
    }
};

/**
 * The processes of this Pi Pocket (their environment holds its data folder, as every command's does) that no longer
 * run under it: what commands left running after they ended. `under` are the processes whose trees are left out, the
 * server's and the launcher's, with what still runs in them (a command in progress, the browser, MCP servers).
 * Only the owner's own processes can be read: others are passed over. Ports are read only when `ports` is true.
 */
export function scanProcesses(options: {
    dataDir: string;
    under: number[];
    ports?: boolean;
    proc?: string;
}): LeftProcess[] {
    const proc = options.proc ?? "/proc";
    const pids = readdirSync(proc)
        .filter((name) => /^\d+$/.test(name))
        .map(Number);
    const stats = new Map<number, Stat>();

    for (const pid of pids) {
        const stat = readStat(proc, pid);

        if (stat !== undefined) {
            stats.set(pid, stat);
        }
    }

    // The trees to leave out: each process whose parent chain reaches one of `under`.
    const skipped = new Set(options.under);

    const inTree = (pid: number): boolean => {
        const chain: number[] = [];
        let at: number | undefined = pid;

        while (at !== undefined && at > 0 && !chain.includes(at)) {
            if (skipped.has(at)) {
                for (const each of chain) {
                    skipped.add(each);
                }

                return true;
            }

            // The top: init, or a process with no parent here. Checked for `under` first, so a server that is
            // pid 1 is left out too.
            if (at === 1) {
                break;
            }

            chain.push(at);
            at = stats.get(at)?.ppid;
        }

        return false;
    };

    const marker = `PI_POCKET_DIR=${options.dataDir}`;
    const prefix = `${SESSION_VARIABLE}=`;
    const boot = bootTime(proc);
    const sockets = options.ports === true ? listening(proc) : new Map<string, number>();
    const found: LeftProcess[] = [];

    for (const [pid, stat] of stats) {
        let environ: string[];

        try {
            environ = readFileSync(join(proc, String(pid), "environ"), "utf8").split("\0");
        } catch {
            continue;
        }

        if (!environ.includes(marker) || inTree(pid)) {
            continue;
        }

        const tag = environ.find((each) => each.startsWith(prefix))?.slice(prefix.length);
        const session = tag !== undefined && /^\d+$/.test(tag) ? Number(tag) : undefined;
        let command = "";
        let cwd: string | undefined;

        try {
            command = readFileSync(join(proc, String(pid), "cmdline"), "utf8")
                .split("\0")
                .filter((each) => each !== "")
                .join(" ")
                .slice(0, MAX_COMMAND);
        } catch {
            // Gone while we looked.
        }

        try {
            cwd = readlinkSync(join(proc, String(pid), "cwd"));
        } catch {
            // Not ours, or gone.
        }

        found.push({
            pid,
            ppid: stat.ppid,
            pgid: stat.pgid,
            startedAt: boot + (stat.start / TICKS) * 1000,
            startTicks: stat.start,
            command,
            ...(cwd === undefined ? {} : { cwd }),
            ...(session === undefined ? {} : { session }),
            ports: options.ports === true ? portsOf(proc, pid, sockets) : [],
        });
    }

    return found;
}

/**
 * Processes a command started together are one job: those of one process group, and one session. Its command is the
 * one at the top of the group (its parent is not in it), else the oldest.
 */
export function jobsOf(processes: LeftProcess[]): Job[] {
    const groups = new Map<string, LeftProcess[]>();

    for (const each of processes) {
        const key = `${each.session ?? "-"}:${each.pgid}`;

        groups.set(key, [...(groups.get(key) ?? []), each]);
    }

    return [...groups].map(([key, members]) => {
        const pids = new Set(members.map((each) => each.pid));
        const sorted = [...members].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
        const top = sorted.find((each) => !pids.has(each.ppid)) ?? sorted[0]!;

        return {
            key,
            ...(top.session === undefined ? {} : { session: top.session }),
            command: top.command,
            ...(top.cwd === undefined ? {} : { cwd: top.cwd }),
            startedAt: sorted[0]!.startedAt,
            ports: [...new Set(members.flatMap((each) => each.ports))].sort((a, b) => a - b),
            processes: sorted.map(({ pid, startTicks, command }) => ({ pid, startTicks, command })),
        };
    });
}

/**
 * Whether `pid` is still the process the owner saw: the same start, in clock ticks, read again now. Read just before
 * each signal, to keep the moment in which a pid could be used again as short as can be: Node has no way to send a
 * signal to one process for sure (a pidfd), so this narrows the window, and does not close it.
 */
function stillSame(proc: string, pid: number, startTicks: number): boolean {
    return readStat(proc, pid)?.start === startTicks;
}

function signal(proc: string, target: { pid: number; startTicks: number }, kind: NodeJS.Signals) {
    if (!stillSame(proc, target.pid, target.startTicks)) {
        return;
    }

    try {
        process.kill(target.pid, kind);
    } catch {
        // Gone already.
    }
}

/**
 * Stop processes, each only while it is still the one the owner saw (its pid and exact start, and found by a scan of
 * this Pi Pocket's): first politely, then, for those still running after a moment, by force. Returns how many ended.
 */
export async function stopProcesses(
    wanted: { pid: number; startTicks: number }[],
    scan: () => LeftProcess[],
    forceAfterMs = FORCE_AFTER_MS,
    proc = "/proc",
): Promise<{ stopped: number; left: number }> {
    const same = (list: LeftProcess[]) =>
        list.filter((each) =>
            wanted.some((want) => want.pid === each.pid && want.startTicks === each.startTicks),
        );
    const targets = same(scan());

    for (const each of targets) {
        signal(proc, each, "SIGTERM");
    }

    const deadline = Date.now() + forceAfterMs;
    let alive = targets;

    while (alive.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        alive = same(scan());
    }

    for (const each of alive) {
        signal(proc, each, "SIGKILL");
    }

    if (alive.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        alive = same(scan());
    }

    return { stopped: targets.length - alive.length, left: alive.length };
}

export default function createProcesses(host: PocketHost, web: ExtensionWeb) {
    web.client("processes", { access: "owner" });

    // A server that is pid 1 (a container's) adopts what its commands leave: they cannot be told from its own.
    const supported = scanSupported() && process.pid !== 1;
    // The server's own tree, and the launcher's (cloudflared, and the server after a restart). The launcher is the
    // parent only with its channel open, as `main.ts` checks: the variable alone is inherited by what a session starts.
    const launched =
        process.env.PI_POCKET_LAUNCHER === "1" &&
        typeof process.send === "function" &&
        process.ppid > 1;
    const under = [process.pid, ...(launched ? [process.ppid] : [])];
    const scan = (ports = false) =>
        supported ? scanProcesses({ dataDir: host.dataDir, under, ports }) : [];

    // Each command says which session it is for, and whose it is (the server sets PI_POCKET_DIR for itself, and its
    // commands inherit it; a copy that runs without `main.ts` gets it here), and so does everything it starts.
    if (typeof host.commandEnv === "function") {
        web.onDispose(
            host.commandEnv((run) => ({
                PI_POCKET_DIR: host.dataDir,
                [SESSION_VARIABLE]: String(
                    (run as { sessionId?: number }).sessionId ?? run.conversationId,
                ),
            })),
        );
    }

    /** How many jobs each session left, and those from before the tag. */
    const counts = () => {
        const bySession: Record<string, number> = {};
        let untracked = 0;

        for (const job of jobsOf(scan())) {
            if (job.session === undefined) {
                untracked++;
            } else {
                bySession[job.session] = (bySession[job.session] ?? 0) + 1;
            }
        }

        return { supported, bySession, untracked };
    };

    web.route("GET", "counts", () => counts());

    web.route("GET", "list", ({ sessions }) => {
        const known = new Map(sessions().map((each) => [each.id, each]));

        return {
            supported,
            jobs: jobsOf(scan(true))
                .sort((a, b) => a.startedAt - b.startedAt)
                .map((job) => {
                    const session = job.session === undefined ? undefined : known.get(job.session);

                    return {
                        ...job,
                        ...(session === undefined
                            ? {}
                            : { title: session.title, archived: session.archived }),
                    };
                }),
        };
    });

    web.route("POST", "stop", async ({ body }) => {
        const list = Array.isArray(body.processes) ? body.processes : [];
        const wanted = list
            .filter(
                (each): each is { pid: number; startTicks: number } =>
                    typeof each === "object" &&
                    each !== null &&
                    Number.isInteger((each as { pid?: unknown }).pid) &&
                    Number.isInteger((each as { startTicks?: unknown }).startTicks),
            )
            .slice(0, 500);

        if (wanted.length === 0) {
            throw web.error(400, "Name the processes to stop");
        }

        const result = await stopProcesses(wanted, () => scan());

        void tell();

        return result;
    });

    // The status line's counts: sent when they change.
    let last = "";

    const tell = async () => {
        const now = counts();
        const text = JSON.stringify(now);

        if (text !== last) {
            last = text;
            web.send("counts", now);
        }
    };

    if (supported) {
        const timer = setInterval(() => void tell(), COUNT_MS);

        timer.unref();
        web.onDispose(() => clearInterval(timer));

        // A run that ends may have left something: look a moment later.
        if (typeof host.on === "function") {
            web.onDispose(host.on("run.ended", () => void setTimeout(() => void tell(), 2000)));
            web.onDispose(
                host.on("session.archived", ({ conversationId, archived }) => {
                    const left = archived ? (counts().bySession[conversationId] ?? 0) : 0;

                    if (left > 0) {
                        web.send("left", { session: conversationId, count: left });
                    }
                }),
            );
        }
    }

    return defineExtension({ name: "pocket-processes" });
}
