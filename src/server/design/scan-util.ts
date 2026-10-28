/** Small helpers that the scan modules share (stream T). */
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
