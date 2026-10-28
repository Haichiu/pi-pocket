/**
 * The file walk of the design system scan (stream T): finds the style files of a project, ranks them by how likely they
 * are to hold the design (a stylesheet called `theme.css` before a deep component file), and reads each one bounded.
 * The walk never follows a symlink, so a project cannot lead it out of the folder.
 */
import { closeSync, constants, openSync, readdirSync, readSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Folders that hold other people's code or build output, not the project's own styles. */
const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".output",
    ".vercel",
    ".netlify",
    ".yarn",
    ".pnpm-store",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "vendor",
    "bower_components",
    "exports",
    "storybook-static",
    ".pi",
    ".idea",
    ".vscode",
    ".github",
    ".husky",
]);

/** Dot folders that hold a project's styles. */
const DOT_STYLE_FOLDERS = new Set([".storybook", ".vitepress", ".vuepress", ".docusaurus"]);

const STYLE =
    /\.(?:css|scss|sass|less|pcss|postcss|html?|vue|svelte|astro|mdx|tsx|jsx|ts|js|mjs|cjs|mts|cts)$/i;
const TOKEN_JSON =
    /(?:^|\/)(?:[^/]*tokens?[^/]*|theme[^/]*)\.json$|(?:^|\/)(?:design-)?tokens\/[^/]+\.json$/i;

export const LIMITS = {
    /** Files read. */
    files: 400,
    /** Candidate files kept for ranking. */
    candidates: 3000,
    /** Entries looked at in the walk. */
    entries: 20_000,
    depth: 8,
    /** Bytes read from one file. */
    fileBytes: 200_000,
    /** Bytes read in all. */
    totalBytes: 8_000_000,
    /** Characters kept of a value in the report. */
    valueChars: 200,
} as const;

/** How likely a file is to hold the design, for ordering: higher is read first. */
export function priority(rel: string): number {
    const name = rel.split("/").at(-1)!.toLowerCase();
    const extension = extname(name);
    let score = 0;

    if (/^\.(?:css|scss|sass|less|pcss|postcss)$/.test(extension)) {
        score += 40;
    } else if (extension === ".json") {
        score += 45;
    } else if (/^\.(?:[cm]?[jt]s)$/.test(extension)) {
        score += 20;
    } else if (/^\.(?:html?|vue|svelte|astro|mdx)$/.test(extension)) {
        score += 25;
    } else {
        score += 12;
    }

    if (
        /(?:^|\/)(?:tailwind\.config|theme|tokens?|variables|vars|globals?|global|base|colors?|palette|design|root|index|main|app|styles?)(?:[.\-_/]|$)/.test(
            rel.toLowerCase(),
        )
    ) {
        score += 20;
    }

    if (/(?:^|\/)(?:theme|themes|tokens|styles|css|design|assets\/css)\//.test(rel.toLowerCase())) {
        score += 8;
    }

    if (
        /\.min\.|(?:^|\/)(?:vendor|third[-_]?party|generated|__generated__)\/|\.d\.ts$/.test(
            rel.toLowerCase(),
        )
    ) {
        score -= 40;
    }

    if (/\.(?:test|spec|stories)\.|(?:^|\/)(?:__tests__|e2e|fixtures?)\//.test(rel.toLowerCase())) {
        score -= 10;
    }

    return score - rel.split("/").length * 2;
}

/** Whether a file is worth reading at all. */
function wanted(rel: string, name: string): boolean {
    if (!STYLE.test(name)) {
        return TOKEN_JSON.test(rel) && name.endsWith(".json");
    }

    // Scripts only when they may hold a theme or styles (so a project of ten thousand .ts files costs a walk, not a read).
    if (/\.(?:[cm]?[jt]s)$/i.test(name) && !/\.d\.[cm]?ts$/.test(name)) {
        return /(?:tailwind\.config|theme|tokens?|colors?|palette|design|variables|styles?|constants?|config)/i.test(
            rel,
        );
    }

    return !name.endsWith(".d.ts");
}

/** The files to read under `root`, best first, and whether a limit left some out. */
export function collectFiles(root: string): { files: string[]; partial: boolean } {
    const found: string[] = [];
    let partial = false;
    let seen = 0;

    const walk = (dir: string, depth: number) => {
        let entries;

        try {
            entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } catch {
            return;
        }

        for (const entry of entries) {
            if (found.length >= LIMITS.candidates || ++seen > LIMITS.entries) {
                partial = true;

                return;
            }

            // Dirent reports a symlink as a symlink, not as its target: neither branch below takes one.
            if (entry.isDirectory()) {
                const skip =
                    SKIP.has(entry.name) ||
                    (entry.name.startsWith(".") && !DOT_STYLE_FOLDERS.has(entry.name));

                if (depth < LIMITS.depth && !skip) {
                    walk(join(dir, entry.name), depth + 1);
                } else if (depth >= LIMITS.depth && !skip) {
                    partial = true;
                }
            } else if (entry.isFile()) {
                const path = join(dir, entry.name);
                const rel = relative(root, path).split(sep).join("/");

                if (wanted(rel, entry.name)) {
                    found.push(rel);
                }
            }
        }
    };

    walk(root, 0);

    const ranked = found
        .map((rel) => ({ rel, score: priority(rel) }))
        .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))
        .map((entry) => entry.rel);

    if (ranked.length > LIMITS.files) {
        partial = true;
    }

    return { files: ranked.slice(0, LIMITS.files), partial };
}

/** The first `LIMITS.fileBytes` bytes of a file as text; it reads no more than that and never follows a link. */
export function readHead(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        const buffer = Buffer.alloc(LIMITS.fileBytes);
        let size = 0;

        while (size < buffer.length) {
            const read = readSync(fd, buffer, size, buffer.length - size, null);

            if (read <= 0) {
                break;
            }

            size += read;
        }

        return buffer.subarray(0, size).toString("utf8");
    } finally {
        closeSync(fd);
    }
}
