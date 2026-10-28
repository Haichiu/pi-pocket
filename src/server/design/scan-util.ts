/** Small helpers that the scan modules share (stream T). */
import { parseColor, toHex } from "./color.ts";
import { type Category, type VarFact } from "./scan-facts.ts";

/** A list of words from one string. */
export const w = (text: string) => text.split(" ");

export type Obj = Record<string, unknown>;

/** A variable's identity: where it is set, what it holds, and its name. */
export const vkey = (variable: { kind: VarFact["kind"]; hint?: Category; name: string }) =>
    `${variable.kind === "theme" ? "css" : variable.kind}:${variable.hint ?? ""}:${variable.name}`;

export const kebab = (name: string) =>
    name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");

export const slug = (text: string) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);

// --- Variables -----------------------------------------------------------------------------------------------------

export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));

/** A color's `#rrggbb` (`#rrggbbaa` with alpha) from its CSS text, if it is a color. */
export function hexOf(text: string | undefined): string | undefined {
    const color = text === undefined ? undefined : parseColor(text);

    return color === undefined ? undefined : toHex(color);
}

/** The color as `#hex` or a function, trimmed, for a token's value. */
export function normalizeColor(text: string): string {
    const trimmed = text.trim();

    return trimmed.startsWith("#") ? trimmed.toLowerCase() : trimmed.replace(/\s+/g, " ");
}
