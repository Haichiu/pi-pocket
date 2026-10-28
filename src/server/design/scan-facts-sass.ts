/** Sass maps (stream T): `$colors: (primary: #123, ...)` and maps of modes, read as variables. */
import { commaParts, type Scope } from "./scan-parse.ts";
import { addVar, type Facts } from "./scan-facts.ts";
import { modeOf } from "./scan-facts-lists.ts";

/** One entry of a Sass map: its key, and its value as text, or as entries when the value is a map. */
interface MapEntry {
    key: string;
    value: string;
    map?: MapEntry[];
}

/** Reads a Sass map `(a: 1, b: (c: 2))`; undefined when the text is not one. */
function sassMap(text: string, depth = 0): MapEntry[] | undefined {
    const inner = text.trim();

    if (depth > 3 || !inner.startsWith("(") || !inner.endsWith(")")) {
        return undefined;
    }

    const entries: MapEntry[] = [];

    // A value with commas of its own (a shadow with two layers) continues the entry before it.
    const parts: string[] = [];

    for (const part of commaParts(inner.slice(1, -1))) {
        if (parts.length > 0 && !/^["']?[\w-]{1,40}["']?\s*:/.test(part)) {
            parts[parts.length - 1] += `, ${part}`;
        } else {
            parts.push(part);
        }
    }

    for (const part of parts.slice(0, 120)) {
        const colon = part.indexOf(":");
        const key = part
            .slice(0, colon)
            .trim()
            .replace(/^["']|["']$/g, "");
        const value = part.slice(colon + 1).trim();

        if (colon <= 0 || !/^[\w-]{1,40}$/.test(key) || value === "") {
            continue;
        }

        const map = sassMap(value, depth + 1);

        entries.push(map === undefined ? { key, value } : { key, value, map });
    }

    return entries;
}

/**
 * A Sass map is one variable for each entry: `$spacers: (1: 0.25rem, 2: 0.5rem)` is `spacers-1` and `spacers-2`. A map
 * of modes (`$themes: (light: (bg: #fff), dark: (bg: #000))`) holds the variables of each mode; a map of names that
 * each hold modes (`primary: (light: #fff, dark: #000)`) holds one variable with two values.
 */
export function sassMapVars(
    facts: Facts,
    file: string,
    name: string,
    text: string,
    scope: Scope,
    line?: number,
): void {
    const entries = sassMap(text);

    if (entries === undefined) {
        return;
    }

    const modeKey = (key: string): Scope | undefined =>
        /^(?:default|base|root|standard)$/i.test(key) ? "default" : modeOf(key);
    const add = (variable: string, value: string, at: Scope) =>
        addVar(facts, {
            name: variable,
            value: value.slice(0, 400),
            scope: at,
            kind: "scss",
            file,
            ...(line === undefined ? {} : { line }),
        });
    const modes = entries.filter(
        (entry) => entry.map !== undefined && modeKey(entry.key) !== undefined,
    );

    if (modes.length > 0 && modes.length * 2 >= entries.length) {
        for (const entry of modes) {
            for (const inner of entry.map!) {
                if (inner.map === undefined) {
                    add(inner.key, inner.value, modeKey(entry.key)!);
                }
            }
        }

        return;
    }

    for (const entry of entries) {
        if (entry.map === undefined) {
            add(`${name}-${entry.key}`, entry.value, scope);
        } else if (entry.map.some((inner) => modeKey(inner.key) !== undefined)) {
            for (const inner of entry.map) {
                const at = modeKey(inner.key);

                if (at !== undefined && inner.map === undefined) {
                    add(`${name}-${entry.key}`, inner.value, at);
                }
            }
        }
    }
}
