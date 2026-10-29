import { parseColor } from "./color.ts";
import type { Facts } from "./scan-facts.ts";

const FUNCTION = String.raw`\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*`;

export function noteChannels(facts: Facts, value: string): void {
    if (!value.includes("var(") || facts.channels.size > 400) {
        return;
    }

    for (const call of value.matchAll(
        new RegExp(String.raw`${FUNCTION}((?:[^()]|\([^()]*\))*)\)`, "gi"),
    )) {
        const kind = call[1]!.toLowerCase().replace(/a$/, "");

        for (const name of call[2]!.matchAll(/var\(\s*--([\w-]+)/g)) {
            facts.channels.set(name[1]!, kind);
        }
    }
}

const NUMBERS =
    /^\s*-?[\d.]+(?:deg|%)?(?:\s*[ ,]\s*-?[\d.]+(?:deg|%)?){2,3}(?:\s*\/\s*[\d.]+%?)?\s*$/;

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

export function resolveChannels(facts: Facts): void {
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

        const kind = facts.channels.get(variable.name);

        if (kind !== undefined && !variable.value.includes("(") && NUMBERS.test(variable.value)) {
            const color = `${kind}(${variable.value.trim().replace(/,\s*/g, " ")})`;

            if (parseColor(color) !== undefined) {
                variable.value = color;
            }

            continue;
        }

        if (
            variable.value.includes("var(") &&
            new RegExp(String.raw`^${FUNCTION}`, "i").test(variable.value.trim())
        ) {
            const text = variable.value.replace(/<alpha-value>/g, "1");
            const filled = fill(text, lookup);

            if (filled !== undefined) {
                const color = parseColor(filled.replace(/\s*\/\s*1\s*\)/, ")"));

                if (color !== undefined) {
                    variable.value = filled.replace(/\s*\/\s*1\s*\)/, ")");
                }
            }
        }
    }
}
