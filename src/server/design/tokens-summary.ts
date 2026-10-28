/**
 * The design system as compact text for the prompt (stream T): the variables Pi may use, with their values, grouped by
 * what they are for, then the components and the rules. It is bounded: the most useful lines come first, and what does
 * not fit is named, not guessed. Project text (descriptions, component names, guidelines) is data: it is cut to one
 * line, stripped of invisible characters, and made safe to put between tags.
 */
import { defang } from "../fence.ts";
import type { DesignSystem, ResolvedToken } from "./system-types.ts";

const plain = (text: string) =>
    defang(
        text
            .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim(),
    );
const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What a token reads like in a list: the value in the default mode, and in each other mode where it differs. */
function valueLine(system: DesignSystem, token: ResolvedToken): string {
    const [base, ...others] = system.modes as [string, ...string[]];

    const show = (mode: string) => {
        const value = token.modes[mode]!;

        return clip(value.hex ?? value.literal ?? value.css, 70);
    };

    const first = show(base);
    const changes = others
        .filter((mode) => show(mode) !== first)
        .map((mode) => `${mode} ${show(mode)}`);

    return `${first}${changes.length > 0 ? ` (${changes.join("; ")})` : ""}`;
}

/** A group heading for a token: its first path segment, so `color.bg.surface` is under `color`. */
const headingOf = (token: ResolvedToken) => token.path[0]!;

/** Collapses `color.blue.50` … `color.blue.900` into `color.blue.{50, 100 … 900}`. */
function palettes(tokens: ResolvedToken[]): string[] {
    const groups = new Map<string, string[]>();

    for (const token of tokens) {
        const parent = token.path.slice(0, -1).join(".") || token.name;
        const list = groups.get(parent) ?? [];

        list.push(token.path.at(-1)!);
        groups.set(parent, list);
    }

    return [...groups].map(([parent, leaves]) =>
        leaves.length === 1 && parent === leaves[0]
            ? `${parent}`
            : `${parent}.{${clip(leaves.join(", "), 80)}}`,
    );
}

/**
 * The summary of a system, at most `maxBytes` bytes. In order: how to link it, the semantic and component tokens with
 * values, the primitives in short, the components, the guidelines. Lines that do not fit are named.
 */
export function systemSummary(system: DesignSystem, maxBytes: number): string {
    const lines: string[] = [];
    const errors = system.problems.filter((problem) => problem.level === "error").length;
    const warnings = system.problems.length - errors;
    const modes = system.modes
        .map((mode, at) => (at === 0 ? `${mode} (default)` : mode))
        .join(", ");

    lines.push(
        `Design system "${plain(system.name).slice(0, 60)}": ${system.tokens.length} tokens, modes ${modes}, ${system.components.length} component${system.components.length === 1 ? "" : "s"}${errors + warnings > 0 ? `; ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} (design_system validate lists them)` : ""}.`,
    );

    if (system.description !== undefined) {
        lines.push(plain(system.description).slice(0, 200));
    }

    lines.push(
        'Link it in every design: <link rel="stylesheet" href="ds/tokens.css">' +
            (system.components.length > 0
                ? ' and <link rel="stylesheet" href="ds/components.css">'
                : "") +
            ". Use only these variables as var(--name); do not write raw colors, font sizes, or pixel spacing. Modes change by themselves" +
            (system.modes.length > 1 ? `, or set <html data-theme="${system.modes[1]}">.` : "."),
        'Set a variable in a design\'s tweaks manifest with its "--" name to let people change it live.',
    );

    // Palette colors are collapsed when roles name them; everything else is listed with its value, scales included.
    const roles = system.tokens.some(
        (token) => token.type === "color" && token.tier !== "primitive",
    );
    const palette = roles
        ? system.tokens.filter((token) => token.type === "color" && token.tier === "primitive")
        : [];
    const listed = system.tokens.filter((token) => !palette.includes(token));
    const headings = [...new Set(listed.map(headingOf))];

    for (const heading of headings) {
        lines.push("", `${heading}:`);

        for (const token of listed.filter((each) => headingOf(each) === heading)) {
            const note =
                token.deprecated === undefined
                    ? ""
                    : ` [deprecated${typeof token.deprecated === "string" ? `: ${clip(plain(token.deprecated), 50)}` : ""}]`;
            const why =
                token.description === undefined ? "" : `  // ${clip(plain(token.description), 50)}`;

            lines.push(`  ${token.cssVar} ${valueLine(system, token)}${note}${why}`);
        }
    }

    if (palette.length > 0) {
        lines.push(
            "",
            `Palette (raw colors; prefer the roles above): ${palettes(palette).join("; ")}`,
        );
    }

    if (system.components.length > 0) {
        lines.push(
            "",
            "Components (design_system read file=components/<name>.html has the markup):",
        );

        for (const component of system.components) {
            const markup = component.markup[component.states[0]!] ?? "";
            const opening = /<[a-z][^>]*>/i.exec(markup)?.[0] ?? "";

            lines.push(
                `  ${component.slug}: ${clip(plain(component.name), 40)}; states ${component.states.join(", ")}${component.description === "" ? "" : `; ${clip(plain(component.description), 80)}`}${opening === "" ? "" : `; ${clip(plain(opening), 90)}`}`,
            );
        }
    }

    const guidelines = system.guidelines.trim();

    if (guidelines !== "") {
        lines.push("", "Guidelines (project rules):");
        lines.push(
            ...defang(guidelines)
                .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]+/gu, (run) =>
                    run.includes("\n") ? "\n" : " ",
                )
                .split("\n")
                .map((line) => `  ${line.trimEnd()}`)
                .filter((line) => line.trim() !== "")
                .slice(0, 40),
        );
    }

    // Fit: whole lines, then a note that names what was left out.
    const bytes = (text: string) => Buffer.byteLength(text) + 1;
    const note = (left: number) =>
        `… ${left} more line${left === 1 ? "" : "s"} not shown: call design_system read for all of it.`;

    if (lines.reduce((total, line) => total + bytes(line), 0) <= maxBytes) {
        return lines.join("\n");
    }

    const budget = maxBytes - bytes(note(lines.length));
    const kept: string[] = [];
    let used = 0;

    for (const line of lines) {
        if (used + bytes(line) > budget) {
            break;
        }

        kept.push(line);
        used += bytes(line);
    }

    return [...kept, note(lines.length - kept.length)].join("\n");
}
