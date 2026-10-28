// A small stand-in for stream T's `loadDesignSystem` (src/server/design/tokens.ts), so that the documentation page and the
// guide can be built and tested before the real loader lands. It reads `.pi/design/` (DTCG tokens, mode files, component
// specimens, guidelines) and resolves references per mode. It is lenient and unbounded: only for trusted fixtures.
// `loadSystem` uses the real loader when `tokens.ts` exists, and this one otherwise.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
    ComponentSpec,
    DesignSystem,
    ModeValue,
    ResolvedToken,
    TokenTier,
    TokenType,
} from "../src/server/design/system-types.ts";

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
function resolve(value: unknown, lookup: (name: string) => unknown): unknown {
    if (typeof value === "string") {
        const match = REF.exec(value);

        return match === null ? value : resolve(lookup(match[1]!), lookup);
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolve(item, lookup));
    }

    if (isObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, resolve(item, lookup)]),
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
export function loadStubSystem(cwd: string): DesignSystem | undefined {
    const dir = join(cwd, ".pi", "design");

    if (!existsSync(join(dir, "tokens.json"))) {
        return undefined;
    }

    const base = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")) as Json;
    const meta = (isObject(base.$extensions) ? base.$extensions[EXT] : undefined) as
        Json | undefined;
    const defaultMode = String(meta?.mode ?? "default");
    const modeFiles = readdirSync(dir)
        .map((name) => /^tokens\.([a-z0-9-]+)\.json$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1]!)
        .sort();
    const modes = [defaultMode, ...modeFiles];
    const raws = flatten(base);
    const byName = new Map(raws.map((raw) => [raw.path.join("."), raw]));
    const overrides = new Map<string, Map<string, unknown>>();

    for (const mode of modeFiles) {
        const file = JSON.parse(readFileSync(join(dir, `tokens.${mode}.json`), "utf8")) as Json;
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
    const components = existsSync(componentsDir)
        ? readdirSync(componentsDir)
              .filter((name) => name.endsWith(".html"))
              .sort()
              .map((name) =>
                  component(name.slice(0, -5), readFileSync(join(componentsDir, name), "utf8")),
              )
        : [];
    const guidelines = existsSync(join(dir, "guidelines.md"))
        ? readFileSync(join(dir, "guidelines.md"), "utf8")
        : "";
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

// A variable, so that the type check does not need the file before stream T has written it.
const REAL = "../src/server/design/tokens.ts";

/** The real loader when stream T's `tokens.ts` exists, else the stand-in above. */
export async function loadSystem(cwd: string): Promise<DesignSystem | undefined> {
    const real = (await import(REAL).catch((error: NodeJS.ErrnoException) => {
        // Only "the file is not there yet" falls back; a loader that fails to load is a failure to see.
        if (error.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("tokens.ts")) {
            return undefined;
        }

        throw error;
    })) as { loadDesignSystem?: (cwd: string) => DesignSystem | undefined } | undefined;

    return real?.loadDesignSystem === undefined ? loadStubSystem(cwd) : real.loadDesignSystem(cwd);
}
