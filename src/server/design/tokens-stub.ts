/**
 * A stand-in for stream T's `loadDesignSystem` and `systemSummary` (`tokens.ts`), so that the guide and the docs page
 * (stream G) can work and be tested before the real engine lands. It reads `.pi/design/` (DTCG tokens, mode files,
 * component specimens, `guidelines.md`) with bounded, symlink-safe reads and resolves references per mode. It checks and
 * compiles nothing: `problems` is empty and `compiled` holds a rough copy of the variables. DELETE this file when
 * `tokens.ts` lands: `guide.ts` then imports the same two names from it.
 */
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readdirSync,
    readSync,
} from "node:fs";
import { join } from "node:path";
import type {
    ComponentSpec,
    DesignSystem,
    ModeValue,
    ResolvedToken,
    TokenTier,
    TokenType,
} from "./system-types.ts";

type Json = Record<string, unknown>;

const EXT = "com.pi-pocket";
const isObject = (value: unknown): value is Json =>
    value !== null && typeof value === "object" && !Array.isArray(value);
const isToken = (value: unknown): value is Json => isObject(value) && "$value" in value;

interface Raw {
    path: string[];
    type: TokenType;
    tier?: TokenTier;
    description?: string;
    deprecated?: boolean | string;
    value: unknown;
    contrast?: { on: string; min: number };
}

/** Flattens a DTCG tree: types and tiers come down from groups. */
function flatten(tree: Json, base: Raw[] = []): Raw[] {
    const walk = (node: Json, path: string[], type?: string, tier?: string) => {
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith("$") || !isObject(child)) {
                continue;
            }

            const ext = isObject(child.$extensions)
                ? (child.$extensions[EXT] as Json | undefined)
                : undefined;
            const childType = (child.$type as string | undefined) ?? type;
            const childTier = (ext?.tier as string | undefined) ?? tier;

            if (isToken(child)) {
                base.push({
                    path: [...path, key],
                    type: childType as TokenType,
                    tier: childTier as TokenTier | undefined,
                    description: child.$description as string | undefined,
                    deprecated: child.$deprecated as boolean | string | undefined,
                    value: child.$value,
                    contrast: ext?.contrast as Raw["contrast"],
                });
            } else {
                walk(child, [...path, key], childType, childTier);
            }
        }
    };

    walk(tree, []);

    return base;
}

const REF = /^\{([^{}]+)\}$/;
const cssVar = (name: string) => `--${name.split(".").join("-")}`;

/** The value with every reference replaced, deeply. */
function resolve(value: unknown, lookup: (name: string) => unknown, depth = 0): unknown {
    if (depth > 24) {
        throw new Error("A reference leads back to itself.");
    }

    if (typeof value === "string") {
        const match = REF.exec(value);

        return match === null ? value : resolve(lookup(match[1]!), lookup, depth + 1);
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolve(item, lookup, depth + 1));
    }

    if (isObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, resolve(item, lookup, depth + 1)]),
        );
    }

    return value;
}

const dim = (value: unknown, lookup: (v: unknown) => string): string =>
    isObject(value) ? `${value.value}${value.unit}` : lookup(value);

/** CSS text of a raw value: a reference becomes `var(--…)`. */
function toCss(raw: unknown, type: TokenType | undefined): string {
    const part = (value: unknown): string => {
        if (typeof value === "string") {
            const match = REF.exec(value);

            return match === null ? value : `var(${cssVar(match[1]!)})`;
        }

        if (isObject(value) && typeof value.hex === "string") {
            return value.hex;
        }

        return isObject(value) && "value" in value ? dim(value, part) : String(value);
    };

    if (Array.isArray(raw)) {
        if (type === "cubicBezier") {
            return `cubic-bezier(${raw.map(part).join(", ")})`;
        }

        if (type === "fontFamily") {
            return raw
                .map((family) => (/^[\w-]+$/.test(String(family)) ? String(family) : `"${family}"`))
                .join(", ");
        }

        return raw.map((item) => toCss(item, type)).join(", ");
    }

    if (isObject(raw) && type === "shadow") {
        return [raw.offsetX, raw.offsetY, raw.blur, raw.spread, raw.color].map(part).join(" ");
    }

    if (isObject(raw) && type === "typography") {
        const family = isObject(raw.fontFamily) ? "" : part(raw.fontFamily);

        return `${part(raw.fontWeight)} ${part(raw.fontSize)}/${part(raw.lineHeight)} ${family}`;
    }

    if (isObject(raw) && type === "transition") {
        return [raw.duration, raw.delay, raw.timingFunction].map(part).join(" ");
    }

    if (isObject(raw) && type === "border") {
        return [raw.width, raw.style, raw.color].map(part).join(" ");
    }

    if (type === "fontFamily" && typeof raw === "string") {
        return part(raw);
    }

    return part(raw);
}

const TIERS = new Set(["primitive", "semantic", "component"]);

function tierOf(raw: Raw): TokenTier {
    if (raw.tier !== undefined && TIERS.has(raw.tier)) {
        return raw.tier;
    }

    return typeof raw.value === "string" && REF.test(raw.value) ? "semantic" : "primitive";
}

/** Bounds of what the stand-in reads: a project's files are untrusted. */
const MAX_FILE = 1_000_000;
const MAX_COMPONENTS = 64;
const MAX_COMPONENT_FILE = 120_000;
const MAX_GUIDELINES = 16_384;

/** A regular file's text, or `undefined` when it is not there. A symlink or a file over `max` bytes is an error. */
function readBounded(path: string, max: number): string | undefined {
    let info;

    try {
        info = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }

    if (!info.isFile() || info.size > max) {
        throw new Error(`${path} must be a regular file of ${max} bytes at most.`);
    }

    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        if (!fstatSync(fd).isFile()) {
            throw new Error(`${path} must be a regular file.`);
        }

        const bytes = Buffer.alloc(Math.min(info.size, max));
        let size = 0;

        while (size < bytes.length) {
            const read = readSync(fd, bytes, size, bytes.length - size, null);

            if (read <= 0) {
                break;
            }

            size += read;
        }

        return bytes.subarray(0, size).toString("utf8");
    } finally {
        closeSync(fd);
    }
}

/** The names in a real folder (not a symlink), sorted; none when there is no such folder. */
function listFolder(path: string): string[] {
    try {
        if (!lstatSync(path).isDirectory()) {
            return [];
        }
    } catch {
        return [];
    }

    return readdirSync(path).sort();
}

function component(slug: string, source: string): ComponentSpec {
    const meta = JSON.parse(
        /<script[^>]*id="pocket-component"[^>]*>([\s\S]*?)<\/script>/.exec(source)![1]!,
    ) as Json;
    const markup: Record<string, string> = {};

    for (const match of source.matchAll(/<template data-state="([^"]+)">([\s\S]*?)<\/template>/g)) {
        markup[match[1]!] = match[2]!.trim();
    }

    return {
        slug,
        name: String(meta.name),
        description: String(meta.description ?? ""),
        states: (meta.states as string[]) ?? Object.keys(markup),
        markup,
        css: (/<style>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? "").trim(),
        usage: meta.usage as ComponentSpec["usage"],
        tokens: (meta.tokens as string[]) ?? [],
    };
}

/** Loads a design system from `<cwd>/.pi/design/`, or `undefined` when the folder is missing. */
export function loadDesignSystem(cwd: string): DesignSystem | undefined {
    const dir = join(cwd, ".pi", "design");
    const baseText = readBounded(join(dir, "tokens.json"), MAX_FILE);

    if (baseText === undefined) {
        return undefined;
    }

    const base = JSON.parse(baseText) as Json;
    const meta = (isObject(base.$extensions) ? base.$extensions[EXT] : undefined) as
        Json | undefined;
    const defaultMode = String(meta?.mode ?? "default");
    const modeFiles = listFolder(dir)
        .map((name) => /^tokens\.([a-z0-9-]+)\.json$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1]!)
        .sort();
    const modes = [defaultMode, ...modeFiles];
    const raws = flatten(base);
    const byName = new Map(raws.map((raw) => [raw.path.join("."), raw]));
    const overrides = new Map<string, Map<string, unknown>>();

    for (const mode of modeFiles) {
        const file = JSON.parse(
            readBounded(join(dir, `tokens.${mode}.json`), MAX_FILE) ?? "{}",
        ) as Json;
        const map = new Map<string, unknown>();

        for (const raw of flatten(file)) {
            map.set(raw.path.join("."), raw.value);
        }

        overrides.set(mode, map);
    }

    const rawIn = (mode: string, name: string): unknown =>
        overrides.get(mode)?.get(name) ?? byName.get(name)?.value;

    const tokens: ResolvedToken[] = raws.map((raw) => {
        const name = raw.path.join(".");
        const values: Record<string, ModeValue> = {};

        for (const mode of modes) {
            const lookup = (ref: string) => {
                const found = rawIn(mode, ref);

                if (found === undefined) {
                    throw new Error(`${name}: no token ${ref}`);
                }

                return found;
            };

            const own = rawIn(mode, name);
            const alias = typeof own === "string" ? REF.exec(own)?.[1] : undefined;
            const css = toCss(own, raw.type);

            values[mode] = {
                value: resolve(own, lookup),
                css,
                ...(alias === undefined ? {} : { alias }),
            };
        }

        return {
            path: raw.path,
            name,
            cssVar: cssVar(name),
            type: raw.type,
            tier: tierOf(raw),
            ...(raw.description === undefined ? {} : { description: raw.description }),
            ...(raw.deprecated === undefined ? {} : { deprecated: raw.deprecated }),
            modes: values,
            ...(raw.contrast === undefined ? {} : { contrast: raw.contrast }),
        };
    });

    const componentsDir = join(dir, "components");
    const components = listFolder(componentsDir)
        .filter((name) => /^[a-z0-9-]+\.html$/.test(name))
        .slice(0, MAX_COMPONENTS)
        .map((name) =>
            component(
                name.slice(0, -5),
                readBounded(join(componentsDir, name), MAX_COMPONENT_FILE) ?? "",
            ),
        );
    const guidelines = readBounded(join(dir, "guidelines.md"), MAX_GUIDELINES) ?? "";
    const css = [
        `:root {\n${tokens.map((token) => `    ${token.cssVar}: ${token.modes[defaultMode]!.css};`).join("\n")}\n}`,
        ...modeFiles.map(
            (mode) =>
                `[data-theme="${mode}"] {\n${tokens
                    .filter((token) => token.modes[mode]!.css !== token.modes[defaultMode]!.css)
                    .map((token) => `    ${token.cssVar}: ${token.modes[mode]!.css};`)
                    .join("\n")}\n}`,
        ),
    ].join("\n\n");

    return {
        name: String(meta?.name ?? "Design system"),
        ...(typeof meta?.description === "string" ? { description: meta.description } : {}),
        modes,
        tokens,
        components,
        guidelines,
        problems: [],
        compiled: {
            css,
            tailwind: `@theme {\n${tokens.map((token) => `    ${token.cssVar}: var(${token.cssVar});`).join("\n")}\n}`,
            json: JSON.stringify(
                tokens.map((token) => ({ name: token.name, modes: token.modes })),
                null,
                2,
            ),
            components: components.map((spec) => spec.css).join("\n\n"),
        },
    };
}

const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A token's default-mode value as short text for the summary. */
function short(token: ResolvedToken, mode: string): string {
    const value = token.modes[mode]?.value;

    if (typeof value === "string" || typeof value === "number") {
        return String(value);
    }

    if (Array.isArray(value) && value.every((item) => typeof item !== "object")) {
        return clip(value.join(" "), 24);
    }

    if (token.type === "typography" && isObject(value)) {
        const family = Array.isArray(value.fontFamily) ? value.fontFamily[0] : value.fontFamily;

        return `${String(family)} ${String(value.fontSize)}/${String(value.lineHeight)} ${String(value.fontWeight)}`;
    }

    if (token.type === "shadow") {
        return "shadow";
    }

    if (token.type === "transition" && isObject(value)) {
        return String(value.duration);
    }

    return clip(JSON.stringify(value) ?? "", 40);
}

/**
 * The system as compact text for the prompt: the modes, the roles and component tokens by group with their values in
 * the default mode, the palette's names only, the components with their states, and the start of the guidelines. At most
 * `maxBytes` bytes. All of it is project data: the caller says so to the model.
 */
export function systemSummary(system: DesignSystem, maxBytes: number): string {
    const first = system.modes[0] ?? "default";
    const lines = [
        `${system.name}: ${system.tokens.length} tokens, ${system.components.length} components. Modes: ${system.modes.map((mode, index) => (index === 0 ? `${mode} (default)` : mode)).join(", ")}. Values below are the default mode's; the other modes override some. A token is the custom property --a-b-c for the name a.b.c.`,
    ];

    if (system.guidelines.trim() !== "") {
        lines.push(`Guidelines:\n${clip(system.guidelines.trim(), Math.floor(maxBytes / 4))}`);
    }

    // Component tokens are named by their component (its file has them); roles and scales are listed.
    const used = system.tokens.filter((token) => token.tier === "semantic");
    const groups = new Map<string, ResolvedToken[]>();

    for (const token of used) {
        const key = token.path.slice(0, -1).join(".");

        groups.set(key, [...(groups.get(key) ?? []), token]);
    }

    for (const [key, tokens] of groups) {
        lines.push(
            `${key}: ${tokens.map((token) => `${token.path[token.path.length - 1]}=${short(token, first)}`).join(" ")}`,
        );
    }

    const palette = new Map<string, string[]>();

    for (const token of system.tokens.filter((item) => item.tier === "primitive")) {
        const key = token.path.slice(0, -1).join(".");

        palette.set(key, [...(palette.get(key) ?? []), token.path[token.path.length - 1]!]);
    }

    if (palette.size > 0) {
        lines.push(
            `Primitives (the raw scales that roles point at; do not use them in a design): ${[...palette].map(([key, steps]) => `${key} (${steps.length})`).join(", ")}`,
        );
    }

    for (const spec of system.components) {
        lines.push(
            `Component ${spec.name}: states ${spec.states.join(", ")}; markup in .pi/design/components/${spec.slug}.html`,
        );
    }

    let out = "";

    for (const line of lines) {
        if (Buffer.byteLength(out) + Buffer.byteLength(line) + 1 > maxBytes) {
            out += `\n(Cut at ${maxBytes} bytes: read .pi/design/tokens.json for the rest.)`;
            break;
        }

        out += `${out === "" ? "" : "\n"}${line}`;
    }

    return out;
}
