/**
 * Colors written in parts (stream T): a custom property that holds the channels of a color, with no function around them
 * (`--c-brand: 37 99 235;`), and is used as `rgb(var(--c-brand))` or `rgb(var(--c-brand) / 0.5)`; the same for hue,
 * saturation, and lightness in three properties (`hsl(var(--h) var(--s) var(--l))`); and Tailwind's
 * `rgb(var(--color-primary) / <alpha-value>)`. A property used inside a color function is a part of a color. The scan notes
 * which ones are, once the files are read, and makes their values what they stand for: `--c-brand` is `rgb(37 99 235)`, and
 * `--accent: hsl(var(--h) var(--s) var(--l))` is `hsl(262 83% 58%)`.
 */
import { parseColor } from "./color.ts";
import type { Facts } from "./scan-facts.ts";

const FUNCTION = String.raw`\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*`;

/** Notes the custom properties that are used inside a color function, in a value of a declaration or a variable. */
export function noteChannels(facts: Facts, value: string): void {
    if (!value.includes("var(") || facts.channels.size > 400) {
        return;
    }

    for (const call of value.matchAll(
        new RegExp(String.raw`${FUNCTION}((?:[^()]|\([^()]*\))*)\)`, "gi"),
    )) {
        const kind = call[1]!.toLowerCase().replace(/a$/, "");

        for (const name of call[2]!.matchAll(/var\(\s*--([\w-]+)/g)) {
            // A color in the function is built of this property: in the first part, the whole color; in several, a channel.
            facts.channels.set(name[1]!, kind);
        }
    }
}

const NUMBERS =
    /^\s*-?[\d.]+(?:deg|%)?(?:\s*[ ,]\s*-?[\d.]+(?:deg|%)?){2,3}(?:\s*\/\s*[\d.]+%?)?\s*$/;

/** The text of a function with its `var()` filled in from `values`, or undefined when a part is not known. */
function fill(text: string, values: Map<string, string>, depth = 0): string | undefined {
    if (depth > 4) {
        return undefined;
    }

    let missing = false;
    const out = text.replace(
        /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g,
        (_, name: string, fallback?: string) => {
            const value = values.get(name) ?? fallback?.trim();

            if (value === undefined) {
                missing = true;

                return "";
            }

            const inner = value.includes("var(") ? fill(value, values, depth + 1) : value;

            if (inner === undefined) {
                missing = true;

                return "";
            }

            return inner;
        },
    );

    return missing ? undefined : out;
}

/** Makes the channel properties and the colors built of them the colors they stand for. */
export function resolveChannels(facts: Facts): void {
    // The plain value of each property, by scope: a property set in the dark scope is the dark mode's.
    const scopes = ["default", "dark", "light"] as const;
    const by = new Map<string, Map<string, string>>(scopes.map((scope) => [scope, new Map()]));

    for (const variable of facts.vars) {
        by.get(variable.scope)?.set(variable.name, variable.value);
    }

    // Built once: a copy for each property made the scan quadratic in the number of properties.
    const lookups = {
        default: by.get("default")!,
        dark: new Map([...by.get("default")!, ...by.get("dark")!]),
    };

    for (const variable of facts.vars) {
        const lookup = lookups[variable.scope === "dark" ? "dark" : "default"];

        // The channels: `37 99 235`, `222.2 47.4% 11.2%`.
        const kind = facts.channels.get(variable.name);

        if (kind !== undefined && !variable.value.includes("(") && NUMBERS.test(variable.value)) {
            const color = `${kind}(${variable.value.trim().replace(/,\s*/g, " ")})`;

            if (parseColor(color) !== undefined) {
                variable.value = color;
            }

            continue;
        }

        // A color built of parts: `hsl(var(--h) var(--s) var(--l))`, `rgb(var(--c) / <alpha-value>)`.
        if (
            variable.value.includes("var(") &&
            new RegExp(String.raw`^${FUNCTION}`, "i").test(variable.value.trim())
        ) {
            const text = variable.value.replace(/<alpha-value>/g, "1");
            const filled = fill(text, lookup);

            if (filled !== undefined) {
                // The channels that were just filled in are plain numbers: `rgb(37 99 235 / 1)`.
                const color = parseColor(filled.replace(/\s*\/\s*1\s*\)/, ")"));

                if (color !== undefined) {
                    variable.value = filled.replace(/\s*\/\s*1\s*\)/, ")");
                }
            }
        }
    }
}
