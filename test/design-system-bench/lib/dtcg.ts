// Independent of the engine on purpose: the bench reads a scan draft without trusting the code that wrote it.
import { colorOf, type Rgba } from "./color.ts";

export interface FlatToken {
    name: string;
    path: string[];
    type: string;
    values: Record<string, unknown>;
    aliases: Record<string, string>;
    description?: string;
    deprecated?: boolean | string;
    tier?: string;
    contrast?: { on: string; min: number; exempt?: string };
    contrasts?: { on: string; min: number; exempt?: string }[];
}

export interface FlatSystem {
    modes: string[];
    tokens: FlatToken[];
    problems: string[];
}

const MAX_TOKENS = 5000;
const MAX_DEPTH = 24;
const REFERENCE = /^\{([^{}]+)\}$/;

interface Raw {
    path: string[];
    type: string | undefined;
    value: unknown;
    node?: Record<string, unknown>;
}

function collect(tree: unknown, problems: string[]): Map<string, Raw> {
    const found = new Map<string, Raw>();

    const walk = (node: unknown, path: string[], inherited: string | undefined, depth: number) => {
        if (typeof node !== "object" || node === null || Array.isArray(node) || depth > MAX_DEPTH) {
            return;
        }

        const object = node as Record<string, unknown>;
        const type = typeof object.$type === "string" ? object.$type : inherited;

        if (Object.hasOwn(object, "$value")) {
            if (found.size < MAX_TOKENS) {
                found.set(path.join("."), { path, type, value: object.$value, node: object });
            }

            return;
        }

        for (const [key, child] of Object.entries(object)) {
            if (key === "$root") {
                if (typeof child === "object" && child !== null && Object.hasOwn(child, "$value")) {
                    found.set(path.join("."), {
                        path,
                        type: (child as { $type?: string }).$type ?? type,
                        value: (child as { $value: unknown }).$value,
                        node: child as Record<string, unknown>,
                    });
                }

                continue;
            }

            if (!key.startsWith("$") && !key.includes("{") && !key.includes(".")) {
                walk(child, [...path, key], type, depth + 1);
            } else if (!key.startsWith("$")) {
                problems.push(`The name "${key}" has a dot or a brace.`);
            }
        }
    };

    walk(tree, [], undefined, 0);

    return found;
}

function guessType(value: unknown): string {
    if (typeof value === "number") {
        return "number";
    }

    if (typeof value === "string") {
        if (colorOf(value) !== undefined) {
            return "color";
        }

        if (/^-?[\d.]+(px|rem|em|pt|%)$/.test(value.trim())) {
            return "dimension";
        }

        if (/^-?[\d.]+m?s$/.test(value.trim())) {
            return "duration";
        }

        return "string";
    }

    if (Array.isArray(value)) {
        return value.every((item) => typeof item === "number") ? "cubicBezier" : "fontFamily";
    }

    if (typeof value === "object" && value !== null) {
        const keys = Object.keys(value);

        if ("colorSpace" in value) {
            return "color";
        }

        if ("unit" in value && "value" in value) {
            return /s$/.test(String((value as { unit: unknown }).unit)) &&
                !/^(px|rem|em)$/.test(String((value as { unit: unknown }).unit))
                ? "duration"
                : "dimension";
        }

        if (keys.includes("offsetX") || keys.includes("blur")) {
            return "shadow";
        }

        if (keys.includes("fontSize") || keys.includes("fontFamily")) {
            return "typography";
        }
    }

    return "unknown";
}

function resolve(
    value: unknown,
    raw: Map<string, Raw>,
    stack: string[],
    problems: string[],
): { value: unknown; alias?: string } {
    if (typeof value === "string") {
        const match = REFERENCE.exec(value.trim());

        if (match === null) {
            return { value };
        }

        const target = match[1]!.trim();

        if (stack.includes(target)) {
            problems.push(`Circular reference: ${[...stack, target].join(" → ")}.`);

            return { value: undefined, alias: target };
        }

        const next = raw.get(target);

        if (next === undefined || stack.length > MAX_DEPTH) {
            problems.push(`The reference {${target}} has no token.`);

            return { value: undefined, alias: target };
        }

        return {
            value: resolve(next.value, raw, [...stack, target], problems).value,
            alias: target,
        };
    }

    if (Array.isArray(value)) {
        return { value: value.map((item) => resolve(item, raw, stack, problems).value) };
    }

    if (typeof value === "object" && value !== null) {
        return {
            value: Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    resolve(item, raw, stack, problems).value,
                ]),
            ),
        };
    }

    return { value };
}

// An override replaces the default raw value before references resolve, so a changed primitive flows to the roles that use it.
export function flatten(tokens: unknown, modes: Record<string, unknown> = {}): FlatSystem {
    const problems: string[] = [];
    const base = collect(tokens, problems);
    const modeNames = ["default", ...Object.keys(modes)];
    const maps = new Map<string, Map<string, Raw>>([["default", base]]);

    for (const [name, tree] of Object.entries(modes)) {
        const merged = new Map(base);

        for (const [key, value] of collect(tree, problems)) {
            merged.set(key, { ...value, type: value.type ?? base.get(key)?.type });
        }

        maps.set(name, merged);
    }

    const flat: FlatToken[] = [];

    for (const [name, entry] of base) {
        const token: FlatToken = {
            name,
            path: entry.path,
            type: entry.type ?? guessType(resolve(entry.value, base, [name], problems).value),
            values: {},
            aliases: {},
        };

        const node = entry.node ?? {};
        const own = (node.$extensions as Record<string, Record<string, unknown>> | undefined)?.[
            "com.pi-pocket"
        ];

        if (typeof node.$description === "string") {
            token.description = node.$description;
        }

        if (node.$deprecated === true || typeof node.$deprecated === "string") {
            token.deprecated = node.$deprecated;
        }

        if (typeof own?.tier === "string") {
            token.tier = own.tier;
        }

        const declared = Array.isArray(own?.contrast)
            ? own.contrast
            : own?.contrast === undefined
              ? []
              : [own.contrast];
        const pairs = declared.flatMap((item) => {
            const pair = item as { on?: unknown; min?: unknown; exempt?: unknown };

            return typeof pair?.on === "string" && typeof pair.min === "number"
                ? [
                      {
                          on: pair.on,
                          min: pair.min,
                          ...(typeof pair.exempt === "string" ? { exempt: pair.exempt } : {}),
                      },
                  ]
                : [];
        });

        if (pairs.length > 0) {
            token.contrast = pairs[0];
            token.contrasts = pairs;
        }

        for (const mode of modeNames) {
            const raw = maps.get(mode)!;
            const own = raw.get(name) ?? entry;
            const resolved = resolve(own.value, raw, [name], problems);

            token.values[mode] = resolved.value;

            if (resolved.alias !== undefined) {
                token.aliases[mode] = resolved.alias;
            }
        }

        flat.push(token);
    }

    // A token that only an override file defines is an error in the engine; the bench ignores it.
    return { modes: modeNames, tokens: flat, problems };
}

export function pixels(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }

    let amount: number;
    let unit: string;

    if (typeof value === "object" && value !== null && "value" in value && "unit" in value) {
        amount = Number((value as { value: unknown }).value);
        unit = String((value as { unit: unknown }).unit);
    } else if (typeof value === "string") {
        const match = /^\s*(-?\d*\.?\d+)\s*(px|rem|em|pt)?\s*$/i.exec(value);

        if (match === null) {
            return undefined;
        }

        amount = Number(match[1]);
        unit = (match[2] ?? "px").toLowerCase();
    } else {
        return undefined;
    }

    if (!Number.isFinite(amount)) {
        return undefined;
    }

    switch (unit) {
        case "px":
            return amount;
        case "rem":
        case "em":
            return amount * 16;
        case "pt":
            return (amount * 4) / 3;
        default:
            return undefined;
    }
}

export interface ShadowLayer {
    x: number;
    y: number;
    blur: number;
    spread: number;
    inset: boolean;
    color: Rgba;
}

function splitTop(text: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];

        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
        } else if (char === sep && depth === 0) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }

    parts.push(text.slice(start));

    return parts.map((part) => part.trim()).filter((part) => part !== "");
}

export function shadowLayers(value: unknown): ShadowLayer[] {
    if (Array.isArray(value)) {
        return value.flatMap((item) => shadowLayers(item));
    }

    if (typeof value === "object" && value !== null) {
        const object = value as Record<string, unknown>;
        const color = colorOf(object.color);
        const [x, y, blur] = [pixels(object.offsetX), pixels(object.offsetY), pixels(object.blur)];

        if (color === undefined || x === undefined || y === undefined || blur === undefined) {
            return [];
        }

        return [
            { x, y, blur, spread: pixels(object.spread) ?? 0, inset: object.inset === true, color },
        ];
    }

    if (typeof value !== "string") {
        return [];
    }

    const layers: ShadowLayer[] = [];

    for (const layer of splitTop(value, ",")) {
        const inset = /\binset\b/.test(layer);
        const rest = layer.replace(/\binset\b/, " ");
        const colorMatch =
            /(#[0-9a-f]{3,8}\b|[a-z]+\([^)]*\)|\b(?:black|white|transparent)\b)/i.exec(rest);
        const color = colorMatch === null ? undefined : colorOf(colorMatch[1]!);
        const numbers = rest
            .replace(colorMatch?.[0] ?? "", " ")
            .split(/\s+/)
            .filter((part) => part !== "")
            .map((part) => pixels(part));

        if (
            color === undefined ||
            numbers.length < 2 ||
            numbers.some((item) => item === undefined)
        ) {
            continue;
        }

        const [x, y, blur = 0, spread = 0] = numbers as number[];

        layers.push({ x: x!, y: y!, blur, spread, inset, color });
    }

    return layers;
}

export function families(value: unknown): string[] {
    const list = Array.isArray(value)
        ? value.map(String)
        : typeof value === "string"
          ? splitTop(value, ",")
          : [];

    return list
        .map((name) => name.trim().replace(/^["']|["']$/g, ""))
        .filter((name) => name !== "");
}
