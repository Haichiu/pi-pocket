/**
 * The reference parts of the documentation page: the table of every token, the validator notes, and the code to use it. (Split from `docsite.ts`; see it for how the page is built and kept safe.)
 */
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    clip,
    modeLabel,
    pxOf,
    sectionOf,
    type Ctx,
    valueIn,
    findToken,
    BASE_GROUNDS,
    tableRows,
} from "./docsite-core.ts";

export function referenceSection(ctx: Ctx, max: number): { html: string; count: number } {
    const all = ctx.system.tokens;
    const tokens = all.slice(0, max);
    const cut =
        tokens.length < all.length
            ? `<p class="sub">This table shows the first ${tokens.length} of ${all.length} tokens, to keep the page small. The sections above show the rest.</p>`
            : "";

    return {
        html: `<p class="intro">Every token with its CSS variable and its value in the mode you chose. Click a name to copy it.</p>${cut}<div class="table-wrap ref"><table><thead><tr><th>Token</th><th>Type</th><th>Value</th></tr></thead><tbody>${tableRows(ctx, tokens)}</tbody></table></div>`,
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
const FILE_PREVIEW = 8_000;

/** A snippet in a box with a Copy button; the text is project data, so it is escaped. */
export function snippet(id: string, text: string): string {
    return `<div class="snip-wrap"><button class="copy" type="button" data-copy-from="${esc(id)}" data-copy="">Copy</button><pre class="snip" id="${esc(id)}"><code>${esc(text)}</code></pre></div>`;
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
    // The utility comes from the variable that the compiled theme gives the sample token.
    const twVar =
        (sample === undefined ? undefined : ctx.twVar.get(sample.name)) ?? "--color-surface";
    const utility = twVar.startsWith("--color-")
        ? `bg-${twVar.slice("--color-".length)}`
        : "bg-surface";
    const tailwind = `@import "tailwindcss";\n@import "./tailwind.css";\n\n<div class="${utility} p-4">…</div>`;
    const modeFiles = Object.entries(compiled.modes ?? {});
    const jsonName =
        modeFiles[0] === undefined
            ? "tokens.resolved.json"
            : `tokens.${modeFiles[0][0]}.resolved.json`;
    const json = `{\n    "source": ["${jsonName}"],\n    "platforms": {\n        "css": {\n            "transformGroup": "css",\n            "buildPath": "build/",\n            "files": [{ "destination": "variables.css", "format": "css/variables" }]\n        }\n    }\n}\n// Style Dictionary config.\n// For DTCG 2025.10 objects, not strings\n// ("#7aa2f7", "16px"), set in tokens.json:\n// "$extensions": {\n//     "com.pi-pocket": { "format": "2025.10" }\n// }`;
    const studio = `// In Tokens Studio, open Tools, then\n// Load from file or URL, and pick\n// tokens.studio.json.\n//\n// Each mode is a token set:\n// ${modeFiles.map(([mode]) => mode).join(", ") || "one set"}.\n// The $themes array has a theme for each\n// mode, which turns its set on.`;
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
    const use = (title: string, note: string, id: string, text: string) =>
        `<div class="use"><h4>${esc(title)}</h4><p class="sub">${note}</p>${snippet(id, text)}</div>`;

    return {
        html: `<p class="intro">The files that the system generates in <code>.pi/design/dist/</code> (<code>components.css</code> holds the CSS of every component, which each component above shows). Read tokens as variables, classes, or JSON. Never copy a value by hand.</p><div class="uses">${use("CSS", "Link tokens.css, then read a token with var(). Set data-theme for a mode.", "code-use-css", css)}${use("Tailwind v4", "Import Tailwind, then tailwind.css. Each token is a variable, so the utilities follow it.", "code-use-tailwind", tailwind)}${use("JSON (DTCG)", "The main output: one file for each mode. Style Dictionary reads it as it is.", "code-use-json", json)}${use("Tokens Studio", "One file for all modes, with a token set for each mode and a $themes array.", "code-use-studio", studio)}</div><h3>The files</h3>${files
            .map(
                (file) =>
                    `<details class="code"><summary>${esc(file.title)}<span class="desc" style="margin-left:10px;font-weight:400">${esc(file.note)}</span></summary><div class="code-body">${file.text.length > FILE_PREVIEW ? `<p class="sub">The first ${FILE_PREVIEW / 1000} KB of ${Math.round(file.text.length / 1024)} KB. The whole file is in <code>.pi/design/dist/</code>, and in the zip that the System view exports.</p>` : ""}${snippet(file.id, clip(file.text, FILE_PREVIEW))}</div></details>`,
            )
            .join("")}`,
        count: files.length,
    };
}
