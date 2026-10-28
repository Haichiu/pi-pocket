/**
 * The reference parts of the documentation page: the table of every token, the validator notes, and the code to use it. (Split from `docsite.ts`; see it for how the page is built and kept safe.)
 */
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import type { ResolvedToken } from "./system-types.ts";
import {
    clip,
    modeLabel,
    pxOf,
    sectionOf,
    type Ctx,
    valueIn,
    findToken,
    varOf,
    BASE_GROUNDS,
    tableRows,
} from "./docsite-core.ts";

/**
 * The table of every token: a column for each mode, and above it a search of names and values and a filter by type and
 * by tier. (The page's script filters the rows, and on a phone draws them a screenful at a time.)
 */
export function referenceSection(ctx: Ctx, max: number): { html: string; count: number } {
    const all = ctx.system.tokens;
    const tokens = all.slice(0, max);
    const cut =
        tokens.length < all.length
            ? `<p class="sub">This table shows the first ${tokens.length} of ${all.length} tokens, to keep the page small. The sections above show the rest.</p>`
            : "";
    const types = [...new Set(tokens.map((token) => token.type))].sort();
    const tiers = ["primitive", "semantic", "component"].filter((tier) =>
        tokens.some((token) => token.tier === tier),
    );
    const option = (value: string, label: string) =>
        `<option value="${esc(value)}">${esc(label)}</option>`;
    const toolbar = `<div class="toolbar" role="search"><input id="tq" type="search" placeholder="Search names and values" aria-label="Search the table of tokens" autocomplete="off" spellcheck="false"><select id="tt" aria-label="Filter by type">${option("", "All types")}${types.map((type) => option(type, `${type} (${tokens.filter((token) => token.type === type).length})`)).join("")}</select><select id="tr" aria-label="Filter by tier">${option("", "All tiers")}${tiers.map((tier) => option(tier, tier)).join("")}</select><span class="rows-count" id="tc" aria-live="polite"></span></div>`;

    return {
        html: `<p class="intro">Every token with its CSS variable and its value in each mode. Click a name to copy it.</p>${cut}${toolbar}<div class="table-wrap ref"><table><thead><tr><th>Token</th><th>Type</th>${ctx.modes.map((mode) => `<th>${esc(modeLabel(mode))}</th>`).join("")}</tr></thead><tbody>${tableRows(ctx, tokens, true)}</tbody></table></div>`,
        count: all.length,
    };
}

export function problemsHtml(ctx: Ctx): string {
    const problems = ctx.system.problems;

    if (problems.length === 0) {
        return "";
    }

    const errors = problems.filter((problem) => problem.level === "error").length;

    return `<details class="notes"><summary>${errors > 0 ? `${errors} error${errors === 1 ? "" : "s"} and ` : ""}${problems.length - errors} warning${problems.length - errors === 1 ? "" : "s"} from the validator</summary><ul>${problems
        .slice(0, 50)
        .map(
            (problem) =>
                `<li><strong>${problem.level === "error" ? "Error" : "Warning"}</strong>${problem.file === undefined ? "" : ` in <code>${esc(problem.file)}</code>`}${problem.token === undefined ? "" : ` at <code>${esc(problem.token)}</code>`}: ${esc(clip(problem.message, 300))}</li>`,
        )
        .join("")}</ul></details>`;
}

/** Notes that need no action (an exempt contrast pair, for one): a small area of their own, apart from problems. */
export function notesHtml(ctx: Ctx): string {
    const notes = ctx.system.notes ?? [];

    if (notes.length === 0) {
        return "";
    }

    return `<details class="notes"><summary>${plural(notes.length, "note")} from the validator</summary><ul>${notes
        .slice(0, 50)
        .map(
            (note) =>
                `<li>${note.file === undefined ? "" : `<code>${esc(note.file)}</code> `}${note.token === undefined ? "" : `<code>${esc(note.token)}</code>: `}${esc(clip(note.message, 300))}</li>`,
        )
        .join("")}</ul></details>`;
}

/** The most of a generated file that the page prints: the files are large, and the page is one file too. */
const FILE_PREVIEW = 3_000;

/**
 * A short, real piece of `tokens.studio.json`: the first mode's set with one token, the first theme, and the order of
 * the sets, cut from the generated file, so that what is shown is what the file holds.
 */
function studioSnippet(ctx: Ctx, sample: ResolvedToken | undefined): string {
    let file: Record<string, unknown> | undefined;

    try {
        file = JSON.parse(ctx.system.compiled.studio ?? "") as Record<string, unknown>;
    } catch {
        file = undefined;
    }

    const first = ctx.modes[0]!;
    const set = file?.[first] as Record<string, unknown> | undefined;
    const themes = file?.$themes as { selectedTokenSets?: Record<string, string> }[] | undefined;

    if (file === undefined || set === undefined || sample === undefined) {
        return JSON.stringify(
            { [first]: {}, $themes: [], $metadata: { tokenSetOrder: ctx.modes } },
            null,
            2,
        );
    }

    // One token of the set, by its path (color.bg.surface), as the file has it.
    let node: unknown = set;
    const leaf: Record<string, unknown> = {};
    let into = leaf;

    for (const [index, key] of sample.path.entries()) {
        node = (node as Record<string, unknown> | undefined)?.[key];
        into[key] = index === sample.path.length - 1 ? node : {};
        into = into[key] as Record<string, unknown>;
    }

    const theme = themes?.[0];
    const sets = Object.fromEntries(Object.entries(theme?.selectedTokenSets ?? {}).slice(0, 2));

    return JSON.stringify(
        {
            [first]: leaf,
            $themes: [{ ...(theme ?? {}), selectedTokenSets: sets }],
            $metadata: file.$metadata,
        },
        null,
        2,
    );
}

/** A snippet in a box with a Copy button; the text is project data, so it is escaped. */
export function snippet(id: string, text: string, lang = ""): string {
    return `<div class="snip-wrap"><button class="copy" type="button" data-copy-from="${esc(id)}" data-copy="">Copy</button><pre class="snip" id="${esc(id)}"${lang === "" ? "" : ` data-lang="${esc(lang)}"`}><code>${esc(text)}</code></pre></div>`;
}

/** What the generated files are and how to use each: CSS, Tailwind v4, and JSON for Style Dictionary or Tokens Studio. */
export function codeSection(ctx: Ctx): { html: string; count: number } {
    const { compiled } = ctx.system;
    const first = ctx.modes[0]!;
    const sample =
        findToken(ctx, BASE_GROUNDS) ??
        ctx.system.tokens.find((token) => token.type === "color" && token.tier === "semantic") ??
        ctx.system.tokens[0];
    // A middle step of the spacing scale reads better than step zero.
    const steps = ctx.system.tokens.filter(
        (token) =>
            sectionOf(token) === "spacing" &&
            token.tier !== "component" &&
            (pxOf(valueIn(token, first)?.value) ?? 0) > 0,
    );
    const spacing =
        steps.find((token) => pxOf(valueIn(token, first)?.value) === 16) ??
        steps[Math.floor(steps.length / 2)];
    const dark = ctx.modes.find((mode) => ctx.theme.get(mode) === "dark" && mode !== first);
    const cssVar = sample?.cssVar ?? "--color-bg-surface";
    const css = `<link rel="stylesheet" href="tokens.css">\n\n.card {\n    background: var(${cssVar});\n    padding: var(${spacing?.cssVar ?? "--space-4"});\n}${dark === undefined ? "" : `\n\n<!-- ${modeLabel(dark)} mode -->\n<html data-theme="${dark}">`}`;
    // The utilities come from the variables that the compiled theme gives the sample tokens (`tailwindNames`): no utility
    // name is written here. A system with no color or no spacing token shows no class for it.
    const sampleVar = sample === undefined ? undefined : ctx.twVar.get(sample.name);
    const spacingVar = spacing === undefined ? undefined : ctx.twVar.get(spacing.name);
    const classes = [
        sampleVar?.startsWith("--color-") ? `bg-${sampleVar.slice("--color-".length)}` : undefined,
        spacingVar?.startsWith("--spacing-")
            ? `p-${spacingVar.slice("--spacing-".length)}`
            : undefined,
    ].filter((name) => name !== undefined);
    const tailwind = `@import "tailwindcss";\n@import "./tailwind.css";${classes.length === 0 ? "" : `\n\n<div class="${classes.join(" ")}">…</div>`}`;
    const modeFiles = Object.entries(compiled.modes ?? {});
    const jsonName =
        modeFiles[0] === undefined
            ? "tokens.resolved.json"
            : `tokens.${modeFiles[0][0]}.resolved.json`;
    // Style Dictionary reads the DTCG files as they are. The config is plain JSON: what it means is written beside it.
    const json = JSON.stringify(
        {
            source: [jsonName],
            platforms: {
                css: {
                    transformGroup: "css",
                    buildPath: "build/",
                    files: [{ destination: "variables.css", format: "css/variables" }],
                },
            },
        },
        null,
        2,
    );
    // Tokens Studio: the first entry of the generated file, so that what a person sees is what the file holds.
    const studio = studioSnippet(ctx, sample);
    const files = [
        {
            id: "code-css",
            title: "tokens.css",
            note: "Variables for every mode. Link it from every page.",
            text: compiled.css,
        },
        {
            id: "code-tailwind",
            title: "tailwind.css",
            note: "A Tailwind v4 @theme block, one variable for each token.",
            text: compiled.tailwind,
        },
        {
            id: "code-names",
            title: "names.md",
            note: "Every token with its variable in tokens.css and in tailwind.css, and its Tailwind utilities.",
            text: compiled.names ?? "",
        },
        ...modeFiles.map(([mode, text], index) => ({
            id: `code-mode-${index}`,
            title: `tokens.${mode}.resolved.json`,
            note: `The ${modeLabel(mode).toLowerCase()} mode as a DTCG file (with $value and $type).`,
            text,
        })),
        {
            id: "code-mode-studio",
            title: "tokens.studio.json",
            note: "For Tokens Studio: a token set for each mode, and a $themes array.",
            text: compiled.studio ?? "",
        },
        {
            id: "code-json",
            title: "tokens.resolved.json",
            note: "A compact summary for scripts. Prefer the DTCG files above.",
            text: compiled.json,
        },
    ].filter((file) => file.text.trim() !== "");
    const use = (title: string, note: string, id: string, text: string, lang: string) =>
        `<div class="use"><h4>${esc(title)}</h4><p class="sub">${note}</p>${snippet(id, text, lang)}</div>`;

    // The colors of the code come from the system's own code tokens, so that they follow the mode and sit on the ground
    // that the system made for code. Each is left out when the system has no such token (the CSS has a fallback).
    const syntax = (
        [
            ["bg", ["color.code.bg"]],
            ["text", ["color.code.text"]],
            ["c", ["color.code.comment", "color.text.muted"]],
            ["s", ["color.code.string"]],
            ["n", ["color.code.number"]],
            ["k", ["color.code.keyword"]],
            ["f", ["color.code.function"]],
            ["p", ["color.code.type", "color.code.property"]],
            ["t", ["color.code.tag"]],
        ] as [string, string[]][]
    )
        .map(([key, names]) => [key, findToken(ctx, names)] as const)
        .filter(([, token]) => token !== undefined && token.type === "color")
        .map(([key, token]) => `--sx-${key}:${varOf(token!)}`)
        .join(";");

    return {
        html: `<div class="sx"${syntax === "" ? "" : ` style="${esc(syntax)}"`}><p class="intro">The files that the system generates in <code>.pi/design/dist/</code> (<code>components.css</code> holds the CSS of every component, which each component above shows). Read tokens as variables, classes, or JSON. Never copy a value by hand.</p><div class="uses">${use("CSS", "Link tokens.css, then read a token with var(). Set data-theme for a mode.", "code-use-css", css, "web")}${use("Tailwind v4", `Import Tailwind, then tailwind.css. Each token is a variable, so the utilities follow it.${compiled.names === undefined || compiled.names.trim() === "" ? "" : ' <a href="#code-names">names.md</a> lists every name and utility.'}`, "code-use-tailwind", tailwind, "web")}${use("JSON (DTCG)", `Style Dictionary reads the file for each mode as it is. For DTCG 2025.10 objects and not strings (<code>"#7aa2f7"</code>, <code>"16px"</code>), set <code>"format": "2025.10"</code> in the <code>com.pi-pocket</code> extension of tokens.json.`, "code-use-json", json, "json")}${use("Tokens Studio", "In Tokens Studio open Tools, Load from file or URL, and pick tokens.studio.json. Each mode is a token set, and each theme turns its set on.", "code-use-studio", studio, "json")}</div><h3>The files</h3>${files
            .map(
                (file) =>
                    `<details class="code"><summary>${esc(file.title)}<span class="desc" style="margin-left:10px;font-weight:400">${esc(file.note)}</span></summary><div class="code-body">${file.text.length > FILE_PREVIEW ? `<p class="sub">The first ${FILE_PREVIEW / 1000} KB of ${Math.round(file.text.length / 1024)} KB. The whole file is in <code>.pi/design/dist/</code>, and in the zip that the System view exports.</p>` : ""}${snippet(file.id, clip(file.text, FILE_PREVIEW), file.title.endsWith(".css") ? "css" : file.title.endsWith(".json") ? "json" : "")}</div></details>`,
            )
            .join("")}</div>`,
        count: files.length,
    };
}
