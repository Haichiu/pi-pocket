/**
 * The design checks for a CI job: run `checkDesign` on an HTML file, with a design system if there is one, and exit 1
 * when there is an error.
 *
 *   node src/server/design/check-cli.ts <page.html> [--system <folder>] [--mode <name>] [--viewport <preset|WxH>]
 *                                       [--scheme light|dark] [--json]
 *
 * `--system` is a project folder that has `.pi/design/` (or that folder itself). The files next to the page (its folder,
 * without links, dot folders, or `node_modules`) are its bundle, so `ds/tokens.css` and images load as they do in the
 * app; with a system, `ds/tokens.css` and `ds/components.css` are added when the folder has none. Exit code: 0 with no
 * error (warnings are printed), 1 with an error, 2 when the arguments or the files cannot be used.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";
import { checkDesign, type CheckOptions } from "./lint.ts";
import type { DesignSystem } from "./system-types.ts";
import { loadDesignSystem } from "./tokens.ts";

const MAX_PAGE = 2_000_000;
const MAX_FILES = 200;
const MAX_FILE = 5_000_000;
const MAX_TOTAL = 20_000_000;
const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
};

const USAGE =
    "Usage: node src/server/design/check-cli.ts <page.html> [--system <folder>] [--mode <name>] [--viewport <mobile|tablet|desktop|WxH>] [--scheme light|dark] [--json]";

interface Io {
    log: (text: string) => void;
    error: (text: string) => void;
}

/** The files of a folder as a bundle's assets: bounded, no links, no dot folders, no `node_modules`. */
function assetsOf(folder: string, page: string): DesignBundle["assets"] {
    const assets: DesignBundle["assets"] = [];
    let total = 0;

    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const path = join(directory, entry.name);
            const name = relative(folder, path).split(sep).join("/");

            if (entry.isSymbolicLink() || assets.length >= MAX_FILES) {
                continue;
            }

            if (entry.isDirectory()) {
                if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                    walk(path);
                }
            } else if (
                entry.isFile() &&
                path !== page &&
                /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
                !name.split("/").some((part) => part === "." || part === "..")
            ) {
                const size = lstatSync(path).size;

                if (size <= MAX_FILE && total + size <= MAX_TOTAL) {
                    total += size;
                    assets.push({
                        name,
                        type: TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
                        bytes: readFileSync(path),
                    });
                }
            }
        }
    };

    walk(folder);

    return assets;
}

/** The project folder of a `--system` argument: the folder with `.pi/design/`, or that `.pi/design` itself. */
function projectOf(path: string): string {
    const full = resolve(path);

    return basename(full) === "design" && basename(dirname(full)) === ".pi"
        ? dirname(dirname(full))
        : full;
}

/** Run the check. Returns the exit code. */
export async function runCheck(args: string[], io: Io): Promise<number> {
    const values: Record<string, string> = {};
    const flags = new Set<string>();
    const files: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;

        if (arg === "--json") {
            flags.add("json");
        } else if (["--system", "--mode", "--viewport", "--scheme"].includes(arg)) {
            const value = args[++index];

            if (value === undefined || value.startsWith("--")) {
                io.error(`${arg} needs a value.\n${USAGE}`);

                return 2;
            }

            values[arg.slice(2)] = value;
        } else if (arg.startsWith("--")) {
            io.error(`Unknown option ${arg}.\n${USAGE}`);

            return 2;
        } else {
            files.push(arg);
        }
    }

    if (files.length !== 1) {
        io.error(USAGE);

        return 2;
    }

    if (values.scheme !== undefined && values.scheme !== "light" && values.scheme !== "dark") {
        io.error("--scheme is light or dark.");

        return 2;
    }

    try {
        const page = realpathSync(resolve(files[0]!));
        const info = lstatSync(page);

        if (!info.isFile() || info.size > MAX_PAGE) {
            throw new Error(`${files[0]} is not a file of up to ${MAX_PAGE} bytes.`);
        }

        let system: DesignSystem | undefined;

        if (values.system !== undefined) {
            system = loadDesignSystem(projectOf(values.system));

            if (system === undefined) {
                throw new Error(`There is no design system in ${values.system} (.pi/design/).`);
            }

            for (const problem of system.problems.filter((each) => each.level === "error")) {
                io.error(`Design system error: ${problem.message}`);
            }
        }

        const assets = assetsOf(dirname(page), page);

        if (system !== undefined) {
            const have = new Set(assets.map((asset) => asset.name));

            for (const [name, text] of [
                ["ds/tokens.css", system.compiled.css],
                ["ds/components.css", system.compiled.components],
            ] as const) {
                if (!have.has(name)) {
                    assets.push({ name, type: "text/css", bytes: Buffer.from(text) });
                }
            }
        }

        const options: CheckOptions = {
            viewport: (values.viewport as CheckOptions["viewport"]) ?? "desktop",
            colorScheme: (values.scheme as "light" | "dark" | undefined) ?? "light",
            ...(values.mode === undefined ? {} : { mode: values.mode }),
        };
        const bundle: DesignBundle = {
            meta: { title: basename(page), type: "html", versions: [] },
            version: 1,
            content: readFileSync(page, "utf8"),
            assets,
        };
        // Offline: a page that asks for the network gets nothing, as in the app's private renders.
        const host = {
            fetchPublic: async () => {
                throw new Error("The check is offline.");
            },
        } as unknown as PocketHost;
        const report = await checkDesign(bundle, system, options, host);

        if (flags.has("json")) {
            io.log(JSON.stringify(report, null, 2));
        } else {
            const { errors, warnings, elements } = report.summary;

            for (const finding of report.findings) {
                io.log(
                    `${finding.level.padEnd(7)} ${finding.rule}  ${finding.selector || "(page)"}\n        ${finding.message}`,
                );
            }

            io.log(
                `${basename(page)}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in ${elements} elements (${report.viewport.width}×${report.viewport.height}, ${report.colorScheme}${report.mode === undefined ? "" : `, mode ${report.mode}`}${report.withoutSystem ? ", no design system" : ""}).`,
            );
        }

        return report.summary.errors > 0 ? 1 : 0;
    } catch (error) {
        io.error(error instanceof Error ? error.message : String(error));

        return 2;
    }
}

if (process.argv[1] !== undefined && import.meta.filename === realpathSync(process.argv[1])) {
    process.exitCode = await runCheck(process.argv.slice(2), {
        log: (text) => console.log(text),
        error: (text) => console.error(text),
    });
}
