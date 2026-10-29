import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
    DesignSystem,
    ModeValue,
    ResolvedToken,
    TokenTier,
    TokenType,
} from "../../../src/server/design/system-types.ts";
import { colorOf, contrastRatio, toHex } from "./color.ts";
import { flatten, type FlatSystem, type FlatToken } from "./dtcg.ts";

export const cssVar = (name: string) => `--${name.replace(/\./g, "-")}`;

const needsQuotes = (family: string) => /[\s]/.test(family) && !/^["']/.test(family);

function cssValue(type: string, value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number") {
        return String(value);
    }

    if (type === "color") {
        const color = colorOf(value);

        return color === undefined ? "" : toHex(color);
    }

    if (type === "fontFamily" && Array.isArray(value)) {
        return value
            .map((name) => (needsQuotes(String(name)) ? `"${String(name)}"` : String(name)))
            .join(", ");
    }

    if (type === "cubicBezier" && Array.isArray(value)) {
        return `cubic-bezier(${value.join(", ")})`;
    }

    if (typeof value === "object" && value !== null && "value" in value && "unit" in value) {
        return `${(value as { value: unknown }).value}${(value as { unit: unknown }).unit}`;
    }

    if (type === "shadow") {
        const layers = Array.isArray(value) ? value : [value];

        return layers
            .map((layer) => {
                const object = layer as Record<string, unknown>;
                const color = cssValue("color", object.color);
                const length = (item: unknown) =>
                    item === undefined ? "0" : cssValue("dimension", item);

                return `${object.inset === true ? "inset " : ""}${length(object.offsetX)} ${length(object.offsetY)} ${length(object.blur)} ${length(object.spread)} ${color}`;
            })
            .join(", ");
    }

    return "";
}

const PLAIN = new Set([
    "color",
    "dimension",
    "fontFamily",
    "fontWeight",
    "duration",
    "cubicBezier",
    "number",
    "shadow",
]);

export function goldenCss(flat: FlatSystem): string {
    const tokens = flat.tokens.filter((token) => PLAIN.has(token.type));
    const lines = (mode: string, changed: boolean, indent: string) =>
        tokens
            .flatMap((token) => {
                const value = token.values[mode];
                const alias = token.aliases[mode];

                // A mode lists only what it changes: a reference to the same token flows through its primitive.
                if (
                    changed &&
                    (alias === undefined
                        ? JSON.stringify(value) === JSON.stringify(token.values.default) &&
                          token.aliases.default === undefined
                        : alias === token.aliases.default)
                ) {
                    return [];
                }

                const text =
                    alias === undefined ? cssValue(token.type, value) : `var(${cssVar(alias)})`;

                return text === "" ? [] : [`${indent}${cssVar(token.name)}: ${text};`];
            })
            .join("\n");
    const out = [
        `/* Golden tokens.css for the bench's lint system. Made by lint/system/make-golden.ts: do not edit by hand. */`,
        `:root {\n${lines("default", false, "    ")}\n}`,
    ];

    for (const mode of flat.modes.slice(1)) {
        out.push(`[data-theme="${mode}"] {\n${lines(mode, true, "    ")}\n}`);

        if (mode === "dark") {
            out.push(
                `@media (prefers-color-scheme: dark) {\n    :root:not([data-theme="light"]) {\n${lines(mode, true, "        ")}\n    }\n}`,
            );
        }
    }

    return `${out.join("\n\n")}\n`;
}

function tierOf(token: FlatToken, alias: boolean): TokenTier {
    return alias ? "semantic" : "primitive";
}

export function systemFromFlat(flat: FlatSystem, name: string): DesignSystem {
    const modeNames = flat.modes.map((mode) => (mode === "default" ? "light" : mode));
    const tokens: ResolvedToken[] = flat.tokens.map((token) => {
        const modes: Record<string, ModeValue> = {};

        for (const [index, mode] of flat.modes.entries()) {
            const alias = token.aliases[mode];

            modes[modeNames[index]!] = {
                value: token.values[mode],
                css:
                    alias === undefined
                        ? cssValue(token.type, token.values[mode])
                        : `var(${cssVar(alias)})`,
                ...(alias === undefined ? {} : { alias }),
            };
        }

        return {
            path: token.path,
            name: token.name,
            cssVar: cssVar(token.name),
            type: (PLAIN.has(token.type) ? token.type : "number") as TokenType,
            tier:
                (token.tier as TokenTier | undefined) ??
                tierOf(token, token.aliases.default !== undefined),
            modes,
            ...(token.description === undefined ? {} : { description: token.description }),
            ...(token.deprecated === undefined ? {} : { deprecated: token.deprecated }),
            ...(token.contrast === undefined
                ? {}
                : {
                      contrast: token.contrast as ResolvedToken["contrast"],
                      contrasts: token.contrasts as ResolvedToken["contrasts"],
                  }),
        };
    });

    return {
        name,
        modes: modeNames,
        schemes: Object.fromEntries(
            modeNames.map((mode) => [mode, /dark/i.test(mode) ? "dark" : "light"] as const),
        ),
        tokens,
        components: [],
        guidelines: "",
        problems: [],
        compiled: { css: goldenCss(flat), tailwind: "", json: "", components: "" },
    };
}

export function readFlat(designDir: string): FlatSystem {
    const read = (file: string) =>
        JSON.parse(readFileSync(join(designDir, file), "utf8")) as unknown;
    const modes: Record<string, unknown> = {};

    for (const file of readdirSync(designDir).sort()) {
        const match = /^tokens\.([a-z0-9-]+)\.json$/.exec(file);

        if (match !== null) {
            modes[match[1]!] = read(file);
        }
    }

    return flatten(read("tokens.json"), modes);
}

export interface PairResult {
    token: string;
    on: string;
    min: number;
    ratios: Record<string, number | undefined>;
    passesEverywhere: boolean;
    exempt?: string;
}

export function contrastPairs(tokens: ResolvedToken[], modes: string[]): PairResult[] {
    const byName = new Map(tokens.map((token) => [token.name, token]));
    const out: PairResult[] = [];

    for (const token of tokens) {
        for (const pair of token.contrasts ??
            (token.contrast === undefined ? [] : [token.contrast])) {
            const on = byName.get(pair.on.replace(/^\{|\}$/g, ""));
            const ratios: Record<string, number | undefined> = {};

            for (const mode of modes) {
                const [fg, bg] = [
                    colorOf(token.modes[mode]?.value),
                    colorOf(on?.modes[mode]?.value),
                ];

                ratios[mode] =
                    fg === undefined || bg === undefined ? undefined : contrastRatio(fg, bg);
            }

            out.push({
                token: token.name,
                on: pair.on,
                min: pair.min,
                ratios,
                passesEverywhere: modes.every(
                    (mode) => ratios[mode] !== undefined && ratios[mode]! >= pair.min,
                ),
                ...(pair.exempt === undefined ? {} : { exempt: pair.exempt }),
            });
        }
    }

    return out;
}

export function impliedPairs(
    tokens: ResolvedToken[],
    modes: string[],
): { text: string; on: string; failing: string[] }[] {
    const pick = (match: RegExp) =>
        tokens.filter((token) => token.type === "color" && match.test(token.name));
    const texts = pick(/^color\.text\.(primary|default|muted|secondary|body)$/);
    const fills = pick(/^color\.(bg|background|surface)\.(default|base|surface|subtle|raised)$/);
    const out: { text: string; on: string; failing: string[] }[] = [];

    for (const text of texts) {
        for (const fill of fills) {
            const failing = modes.filter((mode) => {
                const [fg, bg] = [
                    colorOf(text.modes[mode]?.value),
                    colorOf(fill.modes[mode]?.value),
                ];

                return fg === undefined || bg === undefined || contrastRatio(fg, bg) < 4.5;
            });

            out.push({ text: text.name, on: fill.name, failing });
        }
    }

    return out;
}
