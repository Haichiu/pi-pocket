/**
 * The shared pieces of the tokens engine (stream T): the limits, the names, and the small helpers that the token
 * model, the value converters, and the writer use.
 */
import type { SystemProblem, TokenType } from "./system-types.ts";

/** The key of Pi Pocket's `$extensions` block. */
export const EXT = "com.pi-pocket";

export const TOKEN_TYPES: readonly TokenType[] = [
    "color",
    "dimension",
    "fontFamily",
    "fontWeight",
    "duration",
    "cubicBezier",
    "number",
    "shadow",
    "typography",
    "border",
    "transition",
    "gradient",
    "strokeStyle",
];

/** What the engine reads and keeps, so that a stray file or a hostile one stays cheap. */
export const LIMITS = {
    /** One token file. */
    tokenFileBytes: 524_288,
    /** Mode files. */
    modes: 16,
    /** Tokens in the default file. */
    tokens: 5000,
    /** Nesting of groups. */
    depth: 12,
    /** The text of one CSS value. */
    valueChars: 400,
    /** One component file, and how many. */
    componentBytes: 131_072,
    components: 100,
    /** `guidelines.md`. */
    guidelinesBytes: 16_384,
    /** Problems kept in a report. */
    problems: 200,
} as const;

export const MODE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** The parsed files of a design system folder, before any check. */
export interface RawSystem {
    /** The session folder's name: the system's name when `tokens.json` gives none. */
    folder: string;
    /** `tokens.json`, parsed; undefined when there is none. */
    tokens: unknown;
    /** `tokens.<mode>.json`, parsed, by mode name. */
    modes: Map<string, unknown>;
    /** The component files' text, by slug. */
    components: Map<string, string>;
    guidelines: string;
    /** Problems met while reading the files (a file too large, bad JSON). */
    problems: SystemProblem[];
}

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);
export const clip = (text: string, max = 60) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;
export const show = (value: unknown) =>
    clip(typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));
export const plain = (text: string) =>
    text
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

/** The `com.pi-pocket` block of a node's `$extensions`, or an empty object. */
export const extensionOf = (node: Obj): Obj => {
    const extensions = node.$extensions;

    return isObject(extensions) && isObject(extensions[EXT]) ? extensions[EXT] : {};
};
