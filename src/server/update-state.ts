/**
 * What an update of Pi Pocket's own checkout leaves on disk, in `.pocket-update/` in the checkout: the update under way
 * (`pending.json`), how the last one ended (`last.json`), the packages it installs (`staging/`), and the ones it
 * replaced (`previous/`). The server writes them (`updates.ts`); the launcher reads them when a server it started after
 * an update stops before it is ready, and goes back to the version before (`rollBackUpdate`). It imports only Node's
 * own modules and runs no server code, so the launcher can import it: keep it so.
 */
import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

/** The folder in the checkout, which `.gitignore` leaves out. */
export const UPDATE_DIR = ".pocket-update";

/** An update under way: from one commit to another, written before the checkout changes. */
export type PendingUpdate = {
    v: 1;
    tag: string;
    fromVersion: string;
    toVersion: string;
    /** The commit before, and the release's. */
    from: string;
    to: string;
    /** The branch the update moves, or null for a detached checkout. */
    branch: string | null;
    /** New packages went in, and the ones before wait in `previous/`. */
    modules: boolean;
    /** The release notes warn of a step that cannot be undone: the launcher does not go back by itself. */
    oneWay: boolean;
    /** "switching" once git may have changed files: a stop then can leave some of the release's files. */
    phase: "packages" | "switching";
    at: number;
};

/** How the last update ended, for the owner to read after the restart. */
export type UpdateOutcome = {
    v: 1;
    /** Each outcome's own: the app tells each one once. */
    id: string;
    ok: boolean;
    tag: string;
    fromVersion: string;
    toVersion: string;
    message: string;
    at: number;
};

export function updatePaths(appRoot: string) {
    const dir = join(appRoot, UPDATE_DIR);

    return {
        dir,
        pending: join(dir, "pending.json"),
        last: join(dir, "last.json"),
        staging: join(dir, "staging"),
        previous: join(dir, "previous"),
        failed: join(dir, "failed"),
    };
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function readJson(path: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));

        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

/** Written in full or not at all: a stop in the middle leaves the file before. */
function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;

    writeFileSync(temp, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 });
    renameSync(temp, path);
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The update under way, or undefined. A file that is not one (cut short, or by hand) counts as none. */
export function readPending(appRoot: string): PendingUpdate | undefined {
    const raw = readJson(updatePaths(appRoot).pending);
    const from = text(raw?.from);
    const to = text(raw?.to);

    if (raw?.v !== 1 || from === undefined || to === undefined) {
        return undefined;
    }

    if (!COMMIT.test(from) || !COMMIT.test(to)) {
        return undefined;
    }

    return {
        v: 1,
        tag: text(raw.tag) ?? "",
        fromVersion: text(raw.fromVersion) ?? "",
        toVersion: text(raw.toVersion) ?? "",
        from,
        to,
        branch: text(raw.branch) ?? null,
        modules: raw.modules === true,
        oneWay: raw.oneWay === true,
        // A file without a phase may have got as far as git.
        phase: raw.phase === "packages" ? "packages" : "switching",
        at: typeof raw.at === "number" ? raw.at : 0,
    };
}

export function writePending(appRoot: string, pending: PendingUpdate): void {
    writeJson(updatePaths(appRoot).pending, pending);
}

export function clearPending(appRoot: string): void {
    rmSync(updatePaths(appRoot).pending, { force: true });
}

export function readOutcome(appRoot: string): UpdateOutcome | undefined {
    const raw = readJson(updatePaths(appRoot).last);

    if (raw?.v !== 1 || typeof raw.ok !== "boolean" || text(raw.message) === undefined) {
        return undefined;
    }

    return {
        v: 1,
        id: text(raw.id) ?? "",
        ok: raw.ok,
        tag: text(raw.tag) ?? "",
        fromVersion: text(raw.fromVersion) ?? "",
        toVersion: text(raw.toVersion) ?? "",
        message: text(raw.message) ?? "",
        at: typeof raw.at === "number" ? raw.at : 0,
    };
}

/** Note how an update ended that never got as far as a pending update (its packages did not install, say). */
export function recordOutcome(
    appRoot: string,
    fields: { tag: string; fromVersion: string; toVersion: string },
    message: string,
    now = Date.now(),
): UpdateOutcome {
    const outcome: UpdateOutcome = {
        v: 1,
        id: `${now}-${fields.tag}-failed`,
        ok: false,
        ...fields,
        message,
        at: now,
    };

    writeJson(updatePaths(appRoot).last, outcome);

    return outcome;
}

/** End the update under way with `message`: the outcome is written first, then the pending update goes. */
export function finishPending(
    appRoot: string,
    pending: PendingUpdate,
    ok: boolean,
    message: string,
    now = Date.now(),
): UpdateOutcome {
    const outcome: UpdateOutcome = {
        v: 1,
        id: `${pending.at}-${pending.to.slice(0, 12)}-${ok ? "ok" : "back"}`,
        ok,
        tag: pending.tag,
        fromVersion: pending.fromVersion,
        toVersion: pending.toVersion,
        message,
        at: now,
    };

    writeJson(updatePaths(appRoot).last, outcome);
    clearPending(appRoot);

    return outcome;
}

/**
 * Put the packages an update installed in place of the checkout's (`staging/node_modules`), keeping the ones before in
 * `previous/`. Each step is a rename in the checkout's own file system, so it takes a moment. Throws, with the packages
 * before back in place, when it cannot.
 */
export function swapInModules(appRoot: string): void {
    const paths = updatePaths(appRoot);
    const fresh = join(paths.staging, "node_modules");
    const current = join(appRoot, "node_modules");
    const kept = join(paths.previous, "node_modules");

    // A lock file with no packages in it installs none: an empty folder takes their place.
    mkdirSync(fresh, { recursive: true });
    rmSync(paths.previous, { recursive: true, force: true });
    mkdirSync(paths.previous, { recursive: true });

    if (existsSync(current)) {
        renameSync(current, kept);
    }

    try {
        renameSync(fresh, current);
    } catch (error) {
        if (existsSync(kept)) {
            renameSync(kept, current);
        }

        throw error;
    }

    rmSync(paths.staging, { recursive: true, force: true });
}

/** Put back the packages from before an update. False when there are none to put back. */
export function restoreModules(appRoot: string): boolean {
    const paths = updatePaths(appRoot);
    const kept = join(paths.previous, "node_modules");
    const current = join(appRoot, "node_modules");

    if (!existsSync(kept)) {
        return false;
    }

    rmSync(paths.failed, { recursive: true, force: true });

    if (existsSync(current)) {
        mkdirSync(paths.failed, { recursive: true });
        renameSync(current, join(paths.failed, "node_modules"));
    }

    renameSync(kept, current);
    rmSync(paths.failed, { recursive: true, force: true });
    rmSync(paths.previous, { recursive: true, force: true });

    return true;
}

/** The checkout's branch, null when detached, undefined when git cannot say. */
function branchOf(appRoot: string): string | null | undefined {
    const head = gitSync(appRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

    if (head.ok) {
        return head.out;
    }

    return gitSync(appRoot, ["rev-parse", "HEAD"]).ok ? null : undefined;
}

/** The paths a move from `from` to `to` changes: the ones it adds, and the others (changed or deleted). */
export function switchPaths(
    appRoot: string,
    from: string,
    to: string,
): { added: string[]; other: string[] } {
    const diff = gitSync(appRoot, ["diff", "--name-status", "--no-renames", "-z", from, to]);

    if (!diff.ok) {
        throw new Error(diff.out);
    }

    const parts = diff.out.split("\0").filter((each) => each !== "");
    const added: string[] = [];
    const other: string[] = [];

    for (let at = 0; at + 1 < parts.length; at += 2) {
        (parts[at] === "A" ? added : other).push(parts[at + 1]!);
    }

    return { added, other };
}

/** Each file of a commit, by path: its blob. */
function blobs(appRoot: string, commit: string): Map<string, string> {
    const tree = gitSync(appRoot, ["ls-tree", "-r", "--full-tree", "-z", commit]);

    if (!tree.ok) {
        throw new Error(tree.out);
    }

    const found = new Map<string, string>();

    for (const entry of tree.out.split("\0")) {
        // "<mode> blob <hash>\t<path>"
        const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);

        if (match !== null) {
            found.set(match[2]!, match[1]!);
        }
    }

    return found;
}

/**
 * What the regular files under `root` hold, as git's blob hashes of their bytes as they are, with no filter: two files
 * get the same hash only when they hold the same bytes. A checkout whose filters change files (line endings, say) gets
 * hashes that match no blob, and so keeps more. One git for each file: recovery is rare, and a name may hold any
 * character.
 */
function hashes(appRoot: string, root: string, paths: string[]): Map<string, string> {
    const found = new Map<string, string>();

    for (const path of paths) {
        const hashed = gitSync(appRoot, ["hash-object", "--no-filters", "--", join(root, path)]);

        if (!hashed.ok) {
            throw new Error(hashed.out);
        }

        found.set(path, hashed.out);
    }

    return found;
}

/** Remove the folders that `path` leaves empty, up to the checkout. */
function removeEmptyParents(appRoot: string, path: string): void {
    for (let folder = dirname(path); folder !== "." && folder !== ""; folder = dirname(folder)) {
        try {
            rmdirSync(join(appRoot, folder));
        } catch {
            return;
        }
    }
}

/** What `undoPartialSwitch` moved aside, and where: a folder of its own for each try. */
export type Kept = { paths: string[]; folder?: string };

/**
 * Git stopped part way from `from` to `to` (the server stopped while it moved the checkout): HEAD is still `from`, but
 * some files may be the release's. Only the paths the move changes are looked at. Each one there is first moved, as it
 * is, into a new folder of its own in `.pocket-update/kept/`, and looked at only there, where an edit meanwhile cannot
 * slip past the look. A regular file with the release's version, or `from`'s, goes: git puts `from`'s back. Anything
 * else (other content, a folder, a link) is someone's own, and stays kept; the answer names it. Then the paths the
 * release changes or deletes come back from `from`, and the ones it adds leave the index. Throws when git cannot.
 */
export function undoPartialSwitch(appRoot: string, pending: PendingUpdate): Kept {
    const { added, other } = switchPaths(appRoot, pending.from, pending.to);
    const before = blobs(appRoot, pending.from);
    const after = blobs(appRoot, pending.to);
    const parent = join(updatePaths(appRoot).dir, "kept");

    mkdirSync(parent, { recursive: true });
    // A new folder each try: a second try never writes over what a first one kept.
    const folder = mkdtempSync(join(parent, `${pending.at}-`));
    const moved: string[] = [];

    // The release's new files first: a folder the version before has a file in place of may need their room.
    for (const path of [...added, ...other]) {
        try {
            lstatSync(join(appRoot, path));
        } catch {
            continue;
        }

        const aside = join(folder, path);

        mkdirSync(dirname(aside), { recursive: true });
        renameSync(join(appRoot, path), aside);
        moved.push(path);

        if (added.includes(path)) {
            removeEmptyParents(appRoot, path);
        }
    }

    // Looked at where nobody edits: what git wrote, or what was there before, goes; the rest is kept.
    const now = hashes(
        appRoot,
        folder,
        moved.filter((path) => lstatSync(join(folder, path)).isFile()),
    );
    const kept: Kept = { paths: [], folder };

    for (const path of moved) {
        const hash = now.get(path);
        const known = hash !== undefined && (hash === after.get(path) || hash === before.get(path));

        if (known) {
            rmSync(join(folder, path), { force: true });
            removeEmptyParents(folder, path);
        } else {
            kept.paths.push(path);
        }
    }

    if (kept.paths.length === 0) {
        rmSync(folder, { recursive: true, force: true });
        delete kept.folder;
    }

    if (added.length > 0) {
        const unstaged = gitSync(
            appRoot,
            [
                "rm",
                "--quiet",
                "--cached",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            `${added.join("\0")}\0`,
        );

        if (!unstaged.ok) {
            throw new Error(unstaged.out);
        }
    }

    if (other.length > 0) {
        // The files and the index of every path the release changes or deletes, as `from` has them.
        const back = gitSync(
            appRoot,
            ["checkout", "--quiet", pending.from, "--pathspec-from-file=-", "--pathspec-file-nul"],
            `${other.join("\0")}\0`,
        );

        if (!back.ok) {
            throw new Error(back.out);
        }
    }

    return kept;
}

/**
 * Before the checkout goes back from `to` to `from`: what is at a path that only `from` tracks is someone's, since `to`
 * has nothing there. It moves, as it is, into a new folder of its own in `.pocket-update/kept/`; a regular file with
 * the very bytes `from` has goes, since git writes the same.
 */
export function setAsideForRollback(appRoot: string, pending: PendingUpdate): Kept {
    const before = blobs(appRoot, pending.from);
    const after = blobs(appRoot, pending.to);
    const only = [...before.keys()].filter((path) => !after.has(path));
    const kept: Kept = { paths: [] };

    for (const path of only) {
        let file: boolean;

        try {
            file = lstatSync(join(appRoot, path)).isFile();
        } catch {
            continue;
        }

        if (kept.folder === undefined) {
            const parent = join(updatePaths(appRoot).dir, "kept");

            mkdirSync(parent, { recursive: true });
            kept.folder = mkdtempSync(join(parent, `${pending.at}-`));
        }

        const aside = join(kept.folder, path);

        mkdirSync(dirname(aside), { recursive: true });
        renameSync(join(appRoot, path), aside);

        if (file && hashes(appRoot, kept.folder, [path]).get(path) === before.get(path)) {
            rmSync(aside, { force: true });
            removeEmptyParents(kept.folder, path);
        } else {
            kept.paths.push(path);
        }
    }

    if (kept.folder !== undefined && kept.paths.length === 0) {
        rmSync(kept.folder, { recursive: true, force: true });
        delete kept.folder;
    }

    return kept;
}

/** The words for what `undoPartialSwitch` kept, to add to an outcome. */
export function keptNote(appRoot: string, kept: Kept): string {
    if (kept.folder === undefined || kept.paths.length === 0) {
        return "";
    }

    const where = relative(appRoot, kept.folder);
    const names = `${kept.paths.slice(0, 3).join(", ")}${kept.paths.length > 3 ? ", …" : ""}`;

    return ` What was in its place meanwhile (${names}) is kept in ${where}.`;
}

function gitSync(cwd: string, args: string[], input?: string): { ok: boolean; out: string } {
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        ...(input === undefined ? {} : { input }),
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, LC_ALL: "C", GIT_LITERAL_PATHSPECS: "1" },
    });

    return {
        ok: result.status === 0,
        out: (result.status === 0 ? result.stdout : result.stderr || String(result.error ?? ""))
            .toString()
            .trim(),
    };
}

/**
 * For the launcher: a server it started after an update stopped before it was ready. Put the checkout and its packages
 * back as they were before the update, and say what was done; undefined when no update is under way. A release whose
 * notes warn of a one-way step (a database upgrade, say) is not undone: the version before may not read what the new
 * one changed. Synchronous: it runs between two starts of the server, with nothing else to do.
 */
export function rollBackUpdate(appRoot: string, now = Date.now()): string | undefined {
    const pending = readPending(appRoot);

    if (pending === undefined) {
        return undefined;
    }

    const head = gitSync(appRoot, ["rev-parse", "HEAD"]);
    const to = pending.toVersion || pending.tag;
    const from = pending.fromVersion || pending.from.slice(0, 12);

    if (!head.ok) {
        return finishPending(
            appRoot,
            pending,
            false,
            `Could not read the checkout: ${head.out}`,
            now,
        ).message;
    }

    // Someone switched branches meanwhile: going back would move a branch the update never moved.
    if (branchOf(appRoot) !== pending.branch) {
        return finishPending(
            appRoot,
            pending,
            false,
            `${to} did not start, and the checkout is no longer on ${pending.branch ?? "the commit the update left"}, so Pi Pocket did not go back to ${from} by itself.`,
            now,
        ).message;
    }

    if (head.out === pending.to) {
        if (pending.oneWay) {
            return finishPending(
                appRoot,
                pending,
                false,
                `${to} did not start. Its release notes warn of a step that cannot be undone, so Pi Pocket did not go back to ${from} by itself: read the release notes, and the server's log.`,
                now,
            ).message;
        }

        // Files only the version before tracks, that someone put there since (ignored ones too): git would write over
        // them, so they go aside first.
        const kept = setAsideForRollback(appRoot, pending);
        const back = gitSync(
            appRoot,
            pending.branch === null
                ? ["checkout", "--quiet", "--detach", pending.from]
                : ["reset", "--quiet", "--keep", pending.from],
        );

        if (!back.ok) {
            return finishPending(
                appRoot,
                pending,
                false,
                `${to} did not start, and going back to ${from} failed: ${back.out}${keptNote(appRoot, kept)}`,
                now,
            ).message;
        }

        if (pending.modules) {
            restoreModules(appRoot);
        }

        return finishPending(
            appRoot,
            pending,
            false,
            `${to} did not start, so Pi Pocket went back to ${from}. The server's log says why.${keptNote(appRoot, kept)}`,
            now,
        ).message;
    }

    if (head.out === pending.from) {
        // Stopped between the new packages and the checkout, or while git moved it: both go back.
        const kept: Kept =
            pending.phase === "switching" ? undoPartialSwitch(appRoot, pending) : { paths: [] };

        if (pending.modules) {
            restoreModules(appRoot);
        }

        return finishPending(
            appRoot,
            pending,
            false,
            `The update to ${to} did not finish, so Pi Pocket stays at ${from}.${keptNote(appRoot, kept)}`,
            now,
        ).message;
    }

    return finishPending(
        appRoot,
        pending,
        false,
        `The checkout changed during the update to ${to}, so nothing was undone.`,
        now,
    ).message;
}
