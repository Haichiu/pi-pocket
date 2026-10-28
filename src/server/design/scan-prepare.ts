/** The variables of one mode, ready to infer from (stream T): each one classified, its colors evaluated, and the page checked for a dark default. */
import { px } from "./scan-parse.ts";
import { luminance, parseColor, type Rgba, toHex } from "./color.ts";
import { nameScore, words } from "./scan-colors.ts";
import { type Category, type Facts, type Kinds } from "./scan-facts.ts";
import { colorFact, ingest } from "./scan-facts-use.ts";
import { TAILWIND_3_COLORS, TAILWIND_4_COLORS } from "./scan-tailwind.ts";
import { kebab } from "./scan-util.ts";
import { channelColor, evalMath, follow, type Variable, variables } from "./scan-variables.ts";
import { categorize } from "./scan-categorize.ts";
import { evalColor, SASS_COLOR } from "./scan-sass-colors.ts";

/** A variable sorted into a category, with its value in the default scope and in the other mode. */
export interface Classified {
    variable: Variable;
    category: Category;
    light?: string;
    dark?: string;
    lightColor?: string;
    darkColor?: string;
    via?: Variable;
    /** The variable the dark value was followed through. */
    darkVia?: Variable;
}

export interface Prepared {
    index: Map<string, Variable>;
    classified: Classified[];
    /** The other mode: `dark` in most projects, `light` in a dark-first one. */
    alt: "dark" | "light";
    /** Colors kept for the other mode under names of their own (`$dark-text`), as the roles they stand for. */
    others: { role: string; entry: Classified }[];
}

/** Sorts the project's variables into categories and reads their values in both modes. */
export function prepare(facts: Facts, alt: "dark" | "light"): Prepared {
    const all = variables(facts, alt);
    const index = new Map<string, Variable>();

    for (const variable of all) {
        index.set(`${variable.kind === "theme" ? "css" : variable.kind}:${variable.name}`, variable);
    }

    const classified: Classified[] = [];
    const hasDefault = all.filter((variable) => variable.light?.scope === "default").length >= 2;

    for (const variable of all) {
        // `--text-hero--line-height` belongs to `--text-hero`; it is not a token of its own. A variable that holds the
        // other mode's value of another one (`--dark-bg`) is not either.
        if (variable.name.includes("--") || variable.twin === true) {
            continue;
        }

        const fluid = (found: { text: string; via?: Variable } | undefined) => {
            if (found === undefined) {
                return found;
            }

            const text = sassColors(found.text, index);
            const clamp = /^clamp\(\s*([^,()]+),/i.exec(text.trim());

            return clamp === null || px(clamp[1]!) === undefined
                ? { ...found, text }
                : { ...found, text: clamp[1]!.trim() };
        };

        // A variable that only the other mode sets, in a project whose default mode sets others, has no default value:
        // its value is that mode's (`.dark { --success: #4ade80 }`), and the default is found some other way.
        const otherOnly =
            variable.light === undefined &&
            variable.dark !== undefined &&
            hasDefault &&
            variable.hint === undefined;
        const light = otherOnly ? undefined : fluid(follow(index, variable, "light"));
        const dark =
            variable.dark === undefined ? undefined : fluid(follow(index, variable, "dark"));
        const sample = light?.text ?? dark?.text;

        if (
            sample === undefined ||
            /^(?:inherit|initial|unset|none|auto|currentcolor|transparent)$/i.test(sample)
        ) {
            continue;
        }

        const category = categorize(variable, sample, facts.varLayout);

        if (category === undefined) {
            continue;
        }

        const entry: Classified = {
            variable,
            category,
            light: light?.text,
            dark: dark?.text,
            via: light?.via,
            ...(dark?.via === undefined ? {} : { darkVia: dark.via }),
        };

        if (category === "color") {
            // What the author wrote when it is a color; the computed color when it is a `color-mix()` or a `var()`.
            const asColor = (text: string | undefined, mode: "light" | "dark") => {
                if (text === undefined) {
                    return undefined;
                }

                const direct = channelColor(text, variable.name) ?? text;

                if (parseColor(direct) !== undefined) {
                    return direct;
                }

                const computed = evalColor(text, variable.name, mode, index);

                return computed === undefined ? undefined : toHex(computed);
            };

            entry.lightColor = asColor(light?.text, "light");
            entry.darkColor = asColor(dark?.text, "dark");

            if (entry.lightColor === undefined && entry.darkColor === undefined) {
                continue;
            }
        }

        classified.push(entry);
    }

    // A variable that a role is set from in one mode and that is named for that mode (`--light-bg` and `--dark-bg` behind
    // `--bg`) holds that mode's value: it is not a color of its own.
    const modeNamed = /(?:^|[-_])(?:light|dark|day|night)(?:[-_]|$)/i;
    // The short forms of a mode in a name (`--d-paper`, `--ok-dk`): a source variable is the role variable's name with
    // only such words added.
    const modeWords = new Set([
        "light",
        "dark",
        "day",
        "night",
        "d",
        "dk",
        "drk",
        "l",
        "lt",
        "lgt",
        "alt",
    ]);

    const feeds = (through: Variable, role: Variable) => {
        const extra = kebab(through.name).replace(/^-/, "").split("-");
        const own = kebab(role.name).replace(/^-/, "").split("-");
        const start = extra.findIndex((_, at) =>
            own.every((word, index) => extra[at + index] === word),
        );

        return (
            start !== -1 &&
            extra.length > own.length &&
            extra
                .filter((_, index) => index < start || index >= start + own.length)
                .every((word) => modeWords.has(word)) &&
            (facts.varUse.get(through.name) ?? 0) <= 1
        );
    };

    for (const entry of classified) {
        for (const through of [entry.via, entry.darkVia]) {
            if (
                through !== undefined &&
                through !== entry.variable &&
                ((modeNamed.test(kebab(through.name)) &&
                    !modeNamed.test(kebab(entry.variable.name))) ||
                    feeds(through, entry.variable))
            ) {
                through.twin = true;
            }
        }
    }

    // `$dark-background`, `$dark-text-muted`: when a project keeps a few colors for the other mode under names that are
    // roles with a mode word before them, they are that mode's roles, not colors of their own. (`$dark-blue` is a shade.)
    const mode = alt === "dark" ? /^(?:dark|night)$/ : /^(?:light|day)$/;
    const loose = classified.flatMap((entry) => {
        const parts = kebab(entry.variable.name)
            .replace(/^(?:color|colour|clr)-/, "")
            .split("-");
        const at = parts.findIndex((part) => mode.test(part));
        const rest = parts.filter((_, index) => index !== at);
        const role =
            entry.category === "color" && at !== -1 && rest.length > 0
                ? (["background", "surface", "text", "muted", "border"] as const).find(
                      (each) => nameScore(each, words(rest.join("-"))) >= 60,
                  )
                : undefined;

        return role === undefined ? [] : [{ role, entry, rest: rest.join("-") }];
    });
    const others: Prepared["others"] = [];

    // A project that sets the other mode's values on its variables already has that mode (`--color-text` in the dark scope).
    const sets = facts.vars.some((fact) => fact.scope === alt);

    if (!sets && loose.length >= 2 && new Set(loose.map((item) => item.role)).size >= 2) {
        for (const item of loose) {
            others.push({ role: item.rest, entry: item.entry });
            item.entry.variable.twin = true;
        }
    }

    return {
        index,
        classified: classified.filter((entry) => entry.variable.twin !== true),
        alt,
        others,
    };
}

/** Whether the project's page background (in the default scope) is dark. */
export function pageIsDark(prep: Prepared, facts: Facts): boolean {
    let best: { score: number; color: Rgba } | undefined;

    for (const entry of prep.classified) {
        const color = entry.lightColor === undefined ? undefined : parseColor(entry.lightColor);
        const score = nameScore("background", words(entry.variable.name));

        if (
            entry.category === "color" &&
            color !== undefined &&
            score >= 60 &&
            (best === undefined || score > best.score)
        ) {
            best = { score, color };
        }
    }

    if (best !== undefined) {
        return luminance(best.color) < 0.2;
    }

    // No variable is called the background: the variable, or the color, that the page's root is painted with.
    const painted = prep.classified
        .map((entry) => ({
            color: entry.lightColor === undefined ? undefined : parseColor(entry.lightColor),
            root: facts.varKinds.get(entry.variable.name)?.root ?? 0,
            category: entry.category,
        }))
        .filter(
            (entry) => entry.category === "color" && entry.root > 0 && entry.color !== undefined,
        )
        .sort((a, b) => b.root - a.root)[0]?.color;
    const literal = [...facts.colors.values()]
        .filter((fact) => fact.root > 0)
        .sort((a, b) => b.root - a.root)[0];
    const page = painted ?? (literal === undefined ? undefined : parseColor(literal.hex));

    return page !== undefined && luminance(page) < 0.2;
}

/**
 * The colors that Tailwind's utility classes name without the project defining them (`bg-slate-200`, `text-white`) are
 * uses of those colors. A name the project defines itself (its own `blue-500`) is its own, not the default.
 */
export function useDefaultColors(facts: Facts): void {
    if (!facts.tailwind || facts.classColors.size === 0) {
        return;
    }

    const table = facts.tailwindVersion === 4 ? TAILWIND_4_COLORS : TAILWIND_3_COLORS;
    const own = new Set(facts.vars.map((variable) => variable.name.replace(/^color-/, "")));

    for (const [name, kinds] of facts.classColors) {
        const color = own.has(name) ? undefined : parseColor(table.get(name) ?? "");

        if (color === undefined) {
            continue;
        }

        const fact = colorFact(facts.colors, toHex(color), table.get(name)!);

        for (const kind of Object.keys(kinds) as (keyof Kinds)[]) {
            fact[kind] += kinds[kind];
        }
    }
}

/** Sass color functions in a value, over variables or colors, as the colors they come to: `rgba($black, .2)` is `rgba(0, 0, 0, 0.2)`. */
function sassColors(text: string, index: Map<string, Variable>): string {
    if (!/[a-z]\(/i.test(text)) {
        return text;
    }

    return text.replace(
        /(?<![\w-])([a-z][a-z-]*)\(((?:[^()]|\([^()]*\))*)\)/gi,
        (all, fn: string, args: string) => {
            // Plain CSS `rgba(0, 0, 0, .2)` is a color already.
            if (!SASS_COLOR.has(fn.toLowerCase()) || parseColor(all) !== undefined) {
                return all;
            }

            const color = evalColor(all, "", "light", index);

            return color === undefined || args === ""
                ? all
                : `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${Math.round(color.a * 100) / 100})`;
        },
    );
}

/**
 * A rule that sets one color on one class (`.text-gray-900 { color: #111827 }`) is a use for each time markup uses the
 * class: the definition counted once, the rest are added here.
 */
export function weighClassRules(facts: Facts): void {
    for (const [key, rule] of facts.classRules) {
        const [name] = key.split("|") as [string];
        const count = (facts.classCount.get(name) ?? 0) - 1;

        for (const [hex, map] of [
            [rule.light, facts.colors],
            [rule.dark, facts.darkColors],
        ] as const) {
            const fact = hex === undefined ? undefined : map.get(hex);

            // A class on the page's own `<body>` or `<html>` styles the whole page.
            if (fact !== undefined && facts.rootClasses.has(name)) {
                fact[rule.kind === "bg" ? "root" : "body"] += rule.kind === "border" ? 0 : 1;
                fact[rule.kind] += rule.kind === "text" ? 2 : 0;
            }

            if (fact !== undefined && count > 0) {
                // Text is mostly set on the page, not by classes: a class adds to a text color a little.
                fact[rule.kind] +=
                    rule.kind === "bg" ? Math.min(count, 6) : rule.kind === "text" ? 1 : 0;
            }
        }
    }
}

/** Sizes computed from custom properties (`padding: calc(var(--gap) * 2)`) are uses of the sizes they come to. */
export function resolveDeferred(facts: Facts, prep: Prepared): void {
    const lookup = (name: string, kind: "scss" | "less" | "css") => {
        const target = prep.index.get(`${kind}:${name}`);

        return target === undefined ? undefined : follow(prep.index, target, "light")?.text;
    };

    for (const { prop, value, selector, scope, file, line } of facts.deferred.splice(0)) {
        let resolved = value.replace(/calc\(((?:[^()]|\([^()]*\))*)\)/g, (all, inner: string) => {
            return evalMath(inner, lookup) ?? all;
        });

        // `map-get($spacers, 3)` is the variable `spacers-3`; `space(3)` is the project's function with 3 for its argument.
        resolved = resolved.replace(
            /map[.-]get\(\s*\$([\w-]+)\s*,\s*['"]?([\w-]+)['"]?\s*\)/g,
            (all, map: string, key: string) => lookup(`${map}-${key}`, "scss") ?? all,
        );
        resolved = resolved.replace(
            /(?<![\w.-])([a-z][\w-]*)\(\s*(-?\d*\.?\d+)\s*\)/gi,
            (all, name: string, argument: string) => {
                const fn = facts.sassFunctions.get(name);

                return fn === undefined
                    ? all
                    : (evalMath(
                          fn.expression.replace(new RegExp(`\\$${fn.param}\\b`, "g"), argument),
                          lookup,
                      ) ?? all);
            },
        );

        // Sass color functions over variables: `rgba($black, .2)`, `darken($brand, 10%)`, `tint-color(#c5221f, 88%)`.
        resolved = sassColors(resolved, prep.index);

        // Arithmetic on lengths: `$unit * 2`, `$unit / 2`, `($a + 4px)`.
        resolved = resolved.replace(
            /(?:[$@][\w-]+|\d*\.?\d+[a-z%]*)(?:\s*[*/]\s*(?:[$@][\w-]+|\d*\.?\d+[a-z%]*)|\s+[+-]\s+(?:[$@][\w-]+|\d*\.?\d+[a-z%]*))+/g,
            (run) => evalMath(run, lookup) ?? run,
        );

        // A variable left on its own is its value.
        resolved = resolved.replace(/(?:[\w-]+\.)?[$@]([A-Za-z_][\w-]*)/g, (all, name: string) => {
            return lookup(name, "scss") ?? lookup(name, "less") ?? all;
        });

        if (!/calc\(|var\(|(?<![\w-])[$@][A-Za-z_]/.test(resolved)) {
            facts.file = file;
            ingest(facts, {
                prop,
                value: resolved,
                selector,
                at: [],
                scope,
                theme: false,
                inline: false,
                ...(line === undefined ? {} : { line }),
            });
        }
    }
}
