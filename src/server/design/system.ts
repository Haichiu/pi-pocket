/**
 * The project's design system, and the `design_system` tool that reads and changes it.
 *
 * Since 0.27 a design system is a folder, `.pi/design/` (DTCG tokens, modes, component specimens, guidelines, and the
 * compiled `dist/`): `tokens.ts` loads and writes it, and the tool's actions `init`, `set`, `component`, `guidelines`,
 * `validate`, and `compile` work on it. The 0.26 format still works: a Markdown file at
 * `<session folder>/.pi/design-system.md` that `guide.ts` puts into the prompt when there is no folder, and that the
 * tool's `write` saves. The file is bounded UTF-8 text. A write never follows a symlink to the file itself and replaces
 * it atomically: the new bytes go to a temporary file next to it, and a rename puts them in place. A read never follows
 * a symlink either.
 */
import { randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { boundedText } from "./tokens-base.ts";
import { checkTokensBlock, scanReport, scanRoot, scanTokens } from "./scan.ts";
import type { DesignSystem, SystemChange } from "./system-types.ts";
import { readDesignFile } from "./tokens-io.ts";
import { loadDesignSystem, problemLine, systemSummary, writeDesignSystem } from "./tokens.ts";

export { boundedText, utf8Cut } from "./tokens-base.ts";

/** The file's path, in the session's working directory. */
export const SYSTEM_FILE = join(".pi", "design-system.md");

/** The file's size limit, in bytes: tokens and rules stay short enough to sit in a prompt. */
export const MAX_BYTES = 16_384;

const file = (cwd: string) => join(cwd, SYSTEM_FILE);

function systemDirectory(cwd: string): boolean {
    try {
        const info = lstatSync(join(cwd, ".pi"));

        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("The project's .pi folder must be a directory, not a symlink.");
        }

        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }

        throw error;
    }
}

/** The file's text, bounded, or undefined when there is no file. It never follows a symlink to the file. */
export function readDesignSystemText(
    cwd: string,
): { text: string; truncated: boolean } | undefined {
    if (!systemDirectory(cwd)) {
        return undefined;
    }

    const path = file(cwd);
    let stats;

    try {
        stats = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    if (!stats.isFile()) {
        throw new Error(
            `${SYSTEM_FILE} must be a regular file, not a directory, device, or symlink.`,
        );
    }

    // O_NOFOLLOW closes the window between the lstat and this open, where a symlink could appear.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        if (!fstatSync(fd).isFile()) {
            throw new Error(`${SYSTEM_FILE} must be a regular file.`);
        }

        // Read at most the limit, so a stray large file is no more work than a bounded one.
        const head = Buffer.alloc(MAX_BYTES + 4);
        let size = 0;

        while (size < head.length) {
            const read = readSync(fd, head, size, head.length - size, null);

            if (read <= 0) {
                break;
            }

            size += read;
        }

        if (size === 0) {
            return { text: "", truncated: false };
        }

        return boundedText(head.subarray(0, size), MAX_BYTES);
    } finally {
        closeSync(fd);
    }
}

/** Replaces the file with `content`, atomically, and returns its size in bytes. */
export function writeDesignSystemText(cwd: string, content: string): number {
    const bytes = Buffer.from(content, "utf8");

    if (bytes.length > MAX_BYTES) {
        throw new Error(
            `The design system is bounded text: ${MAX_BYTES} bytes at most (16 KB); the text is ${bytes.length}. Cut the design system down, or move components and rules into separate project files that the design system names.`,
        );
    }

    if (!systemDirectory(cwd)) {
        mkdirSync(join(cwd, ".pi"), { recursive: true });
    }

    systemDirectory(cwd);
    // A fresh name each time: only this write's temporary file, and none of an earlier one under the same name.
    const temp = join(cwd, ".pi", `.${randomUUID()}.tmp`);

    try {
        writeFileSync(temp, bytes, { flag: "wx" });
        // A rename replaces the final name whole on one file system: if the target was a symlink, the file takes its
        // place and no write ever follows the link.
        renameSync(temp, file(cwd));
    } finally {
        // The rename already removed it; a failed call may have left it there.
        rmSync(temp, { force: true });
    }

    return bytes.length;
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const sizeOf = (value: string) => `${(Buffer.byteLength(value) / 1024).toFixed(1)} KB`;

/** The problems as lines, errors first, at most `max`; empty when there are none. */
function problemsText(system: DesignSystem, max = 15): string {
    if (system.problems.length === 0) {
        return "";
    }

    const errors = system.problems.filter((problem) => problem.level === "error").length;
    const warnings = system.problems.length - errors;
    const shown = system.problems.slice(0, max).map((problem) => `- ${problemLine(problem)}`);

    return [
        `Problems (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}):`,
        ...shown,
        ...(system.problems.length > max ? [`- … and ${system.problems.length - max} more`] : []),
    ].join("\n");
}

/** What a design needs to know after a change: the size of the system, the files, and the problems. */
function afterWrite(system: DesignSystem, headline: string): string {
    const dist = system.compiled;

    return [
        headline,
        `Design system "${system.name}": ${system.tokens.length} tokens, modes ${system.modes.join(", ")}, ${system.components.length} component${system.components.length === 1 ? "" : "s"}. Compiled .pi/design/dist/: tokens.css ${sizeOf(dist.css)}, tailwind.css ${sizeOf(dist.tailwind)}, tokens.resolved.json ${sizeOf(dist.json)}, components.css ${sizeOf(dist.components)}.`,
        problemsText(system),
        'A design uses it with <link rel="stylesheet" href="ds/tokens.css"> (and ds/components.css): the artifact tool attaches the current files.',
    ]
        .filter((line) => line !== "")
        .join("\n");
}

/** The `design_system` tool. */
export function designSystemTool(): ToolRegistration {
    return defineTool({
        name: "design_system",
        description: [
            `The project's design system, kept in .pi/design/: DTCG design tokens (tokens.json), modes such as dark (tokens.dark.json), component specimens (components/<name>.html), and guidelines.md. It compiles to dist/tokens.css (CSS variables), dist/tailwind.css (Tailwind v4 @theme), tokens.resolved.json, and components.css. A design links it with <link rel="stylesheet" href="ds/tokens.css"> and uses only var(--…) values.`,
            "Actions: read (a summary, or one file with file), scan (draft tokens from the project's style files; saves nothing), init (save the first tokens: your DTCG object, or fromScan), set (add, change, or remove single tokens), component (add, replace, or drop a specimen), guidelines (replace guidelines.md), validate (check; writes nothing), compile (rewrite dist/). Every change is checked first, and nothing is written when it adds an error. write saves the older single-file system, .pi/design-system.md: prefer init.",
            'Token format: groups nest; a token is { "$value": …, "$type": … }; $type is inherited from the group; a reference is "{color.gray.900}". Types: color, dimension, fontFamily, fontWeight, duration, cubicBezier, number, shadow, typography, border, transition, gradient, strokeStyle. Example: {"color":{"$type":"color","gray":{"900":{"$value":"#1a1b26"}},"bg":{"surface":{"$value":"{color.gray.900}"}}},"space":{"$type":"dimension","4":{"$value":"16px"}}}. A mode holds only the tokens that change: {"dark":{"color":{"bg":{"surface":{"$value":"{color.gray.50}"}}}}}. The CSS variable is the path joined by "-": color.bg.surface is --color-bg-surface. A text color can declare "$extensions":{"com.pi-pocket":{"contrast":{"on":"{color.bg.surface}","min":4.5}}}, checked in every mode.',
        ].join("\n"),
        parameters: Type.Object({
            action: Type.Union(
                [
                    Type.Literal("read"),
                    Type.Literal("write"),
                    Type.Literal("scan"),
                    Type.Literal("init"),
                    Type.Literal("set"),
                    Type.Literal("validate"),
                    Type.Literal("compile"),
                    Type.Literal("component"),
                    Type.Literal("guidelines"),
                ],
                { description: "What to do (see the tool description)." },
            ),
            file: Type.Optional(
                Type.String({
                    description:
                        "read: one file to show as text: tokens.json, tokens.dark.json, guidelines.md, components/button.html, or dist/tokens.css. Leave out for the summary.",
                }),
            ),
            path: Type.Optional(
                Type.String({
                    description:
                        "scan, init with fromScan: a folder inside the session's folder to scan (default: the whole folder).",
                }),
            ),
            fromScan: Type.Optional(
                Type.Boolean({
                    description:
                        "init: save the scan's draft (tokens.json and tokens.dark.json) as it is. Combine with set to correct roles in the same call.",
                }),
            ),
            tokens: Type.Optional(
                Type.Unknown({
                    description:
                        "init: the whole tokens.json, one DTCG object (groups and tokens with $value).",
                }),
            ),
            modes: Type.Optional(
                Type.Record(Type.String(), Type.Unknown(), {
                    description: `init: mode files by name, each a DTCG object with only the tokens that change: { "dark": { … } }.`,
                }),
            ),
            name: Type.Optional(
                Type.String({
                    description: "init: the system's name (default: the folder's name).",
                }),
            ),
            description: Type.Optional(
                Type.String({ description: "init: one sentence about what the system is for." }),
            ),
            replace: Type.Optional(
                Type.Boolean({
                    description:
                        "init: replace a design system that exists. Without it, init refuses, so a system is never lost by mistake.",
                }),
            ),
            changes: Type.Optional(
                Type.Array(
                    Type.Object({
                        token: Type.String({
                            description: 'The token\'s dotted path: "color.bg.surface".',
                        }),
                        value: Type.Unknown({
                            description:
                                'The $value: "#7aa2f7", "{color.blue.500}", "16px", a DTCG object; or a whole token { "$value": …, "$type": … }.',
                        }),
                        mode: Type.Optional(
                            Type.String({
                                description:
                                    "The mode to change. Default: the default mode (tokens.json). A name such as dark changes that mode's file, and makes it if it is new.",
                            }),
                        ),
                        type: Type.Optional(
                            Type.String({
                                description:
                                    "The token's $type; needed for a new token whose group has none and whose value does not show it.",
                            }),
                        ),
                        description: Type.Optional(
                            Type.String({ description: "A short note on what the token is for." }),
                        ),
                    }),
                    {
                        maxItems: 200,
                        description:
                            "set, init: tokens to add or change, in order. Later entries win.",
                    },
                ),
            ),
            remove: Type.Optional(
                Type.Array(
                    Type.Object({
                        token: Type.String({ description: "The token's dotted path." }),
                        mode: Type.Optional(
                            Type.String({
                                description:
                                    "The mode to remove it from. Default: the default mode, which deletes the token.",
                            }),
                        ),
                    }),
                    { maxItems: 200, description: "set: tokens to delete." },
                ),
            ),
            slug: Type.Optional(
                Type.String({
                    description:
                        'component: the component\'s file name, lowercase with hyphens: "button", "text-field".',
                }),
            ),
            drop: Type.Optional(
                Type.Boolean({ description: "component: delete the component named by slug." }),
            ),
            content: Type.Optional(
                Type.String({
                    description:
                        'write: the whole 0.26 file. guidelines: the Markdown text. component: the specimen\'s HTML: <script type="application/json" id="pocket-component">{"name","description","states":["default","hover"],"usage":{"do":[],"dont":[]},"tokens":["color.accent.default"]}</script>, one <style> that uses only var(--…) tokens and scopes each rule by a class, and a <template data-state="default">…markup…</template> for each state.',
                }),
            ),
        }),
        // Not read-only: most actions change the session's files. Not replay-safe either, on purpose: a call that a
        // restart stopped comes back interrupted instead of running and writing twice.
        execute: async (args, api, context) => {
            const { cwd } = await api.agent(context);

            if (cwd === undefined) {
                throw new Error(
                    "This session has no working directory, so the design system has no place.",
                );
            }

            const change = (value: SystemChange, headline: string) =>
                text(afterWrite(writeDesignSystem(cwd, value), headline));
            const toSet = (system: DesignSystem | undefined): SystemChange["set"] =>
                (args.changes ?? []).map((entry) => ({
                    mode: entry.mode ?? system?.modes[0] ?? "light",
                    token: entry.token,
                    value: entry.value,
                    ...(entry.type === undefined ? {} : { type: entry.type as never }),
                    ...(entry.description === undefined ? {} : { description: entry.description }),
                }));

            switch (args.action) {
                case "scan": {
                    const draft = scanReport(scanTokens(scanRoot(cwd, args.path)));

                    return text(draft);
                }

                case "write": {
                    if (args.content === undefined) {
                        throw new Error("write needs the new design system in content.");
                    }

                    if (loadDesignSystem(cwd) !== undefined) {
                        throw new Error(
                            "This project has a design system folder (.pi/design/), which replaces .pi/design-system.md. Change it with set, component, guidelines, or init (replace: true).",
                        );
                    }

                    // A broken tokens block is refused before anything is written.
                    const hasTokens = checkTokensBlock(args.content);
                    const size = writeDesignSystemText(cwd, args.content);

                    return text(
                        `Wrote ${SYSTEM_FILE} (${size} bytes). The next design request reads it.${hasTokens ? "" : " It has no fenced JSON tokens block; add one so designs can read the tokens."} For a design system that compiles to CSS, Tailwind, and JSON, and that designs can link, use init instead.`,
                    );
                }

                case "init": {
                    const existing = readFolderTokens(cwd);

                    if (existing && args.replace !== true) {
                        throw new Error(
                            "A design system already exists in .pi/design/. Change it with set, component, or guidelines; or pass replace: true to start over (the old tokens are overwritten).",
                        );
                    }

                    let tokens = args.tokens;
                    let modes = args.modes as SystemChange["modes"];

                    if (args.fromScan === true) {
                        if (tokens !== undefined) {
                            throw new Error("Give fromScan or tokens, not both.");
                        }

                        const scan = scanTokens(scanRoot(cwd, args.path));

                        if (Object.keys(scan.draft.tokens).length === 0) {
                            throw new Error(
                                "The scan found no colors, fonts, or sizes to build a system from. Write the tokens yourself: init with tokens.",
                            );
                        }

                        tokens = scan.draft.tokens;
                        modes = { ...scan.draft.modes, ...(modes ?? {}) };
                    }

                    if (tokens === undefined) {
                        throw new Error(
                            'init needs tokens (a DTCG object such as {"color":{"$type":"color","accent":{"$value":"#7aa2f7"}}}) or fromScan: true.',
                        );
                    }

                    const system = writeDesignSystem(cwd, {
                        tokens,
                        modes,
                        ...(args.name === undefined ? {} : { name: args.name }),
                        ...(args.description === undefined
                            ? {}
                            : { description: args.description }),
                        ...(args.changes === undefined ? {} : { set: toSet(undefined) }),
                        ...(args.content === undefined ? {} : { guidelines: args.content }),
                    });

                    return text(afterWrite(system, "Saved the design system."));
                }

                case "set": {
                    if ((args.changes ?? []).length === 0 && (args.remove ?? []).length === 0) {
                        throw new Error(
                            'set needs changes: [{ "token": "color.accent.default", "value": "#7aa2f7" }], or remove: [{ "token": "color.old" }].',
                        );
                    }

                    const system = loadDesignSystem(cwd);

                    return change(
                        {
                            set: toSet(system),
                            remove: (args.remove ?? []).map((entry) => ({
                                mode: entry.mode ?? system?.modes[0] ?? "light",
                                token: entry.token,
                            })),
                        },
                        `Saved ${(args.changes ?? []).length} change${(args.changes ?? []).length === 1 ? "" : "s"}${(args.remove ?? []).length > 0 ? ` and removed ${(args.remove ?? []).length} token${(args.remove ?? []).length === 1 ? "" : "s"}` : ""}.`,
                    );
                }

                case "component": {
                    if (args.slug === undefined) {
                        throw new Error('component needs slug, such as "button".');
                    }

                    if (args.drop === true) {
                        return change(
                            { components: { [args.slug]: null } },
                            `Removed component ${args.slug}.`,
                        );
                    }

                    if (args.content === undefined) {
                        throw new Error(
                            "component needs content: the specimen's HTML (see the content field), or drop: true to delete it.",
                        );
                    }

                    return change(
                        { components: { [args.slug]: args.content } },
                        `Saved component ${args.slug}.`,
                    );
                }

                case "guidelines": {
                    if (args.content === undefined) {
                        throw new Error("guidelines needs content: the Markdown text.");
                    }

                    return change({ guidelines: args.content }, "Saved guidelines.md.");
                }

                case "validate": {
                    const system = loadDesignSystem(cwd);

                    if (system === undefined) {
                        return text(noSystem());
                    }

                    const problems = problemsText(system, 40);

                    return text(
                        `Design system "${system.name}": ${system.tokens.length} tokens, modes ${system.modes.join(", ")}, ${system.components.length} components. ${problems === "" ? "No problems." : problems}`,
                    );
                }

                case "compile": {
                    if (loadDesignSystem(cwd) === undefined) {
                        return text(noSystem());
                    }

                    return change({}, "Compiled the design system.");
                }

                default: {
                    if (args.file !== undefined) {
                        const file = readDesignFile(cwd, args.file);

                        if (file === undefined) {
                            throw new Error(`${args.file} does not exist in .pi/design/.`);
                        }

                        return text(
                            `${args.file}${file.truncated ? " (cut at 60 KB)" : ""}:\n\n${file.text}`,
                        );
                    }

                    const system = loadDesignSystem(cwd);

                    if (system !== undefined) {
                        const problems = problemsText(system);

                        return text(
                            `${systemSummary(system, 14_000)}${problems === "" ? "" : `\n\n${problems}`}`,
                        );
                    }

                    const read = readDesignSystemText(cwd);

                    if (read === undefined) {
                        return text(noSystem());
                    }

                    const size = Math.min(Buffer.byteLength(read.text, "utf8"), MAX_BYTES);

                    return text(
                        `Read ${SYSTEM_FILE} (${size} bytes${read.truncated ? `, cut at the ${MAX_BYTES}-byte limit` : ""}): the design system, in the older single-file format. init saves a structured one that compiles to CSS.\n\n${read.text}`,
                    );
                }
            }
        },
    });
}

/** What to say when the project has no design system. */
function noSystem(): string {
    return `There is no design system in this session yet (no .pi/design/ and no ${SYSTEM_FILE}). Run design_system scan for a draft from the project's styles, then init with fromScan: true (or your own tokens); or init with tokens when there is no code to scan.`;
}

/** Whether the project's design folder already has a tokens.json. */
function readFolderTokens(cwd: string): boolean {
    return readDesignFile(cwd, "tokens.json") !== undefined;
}
