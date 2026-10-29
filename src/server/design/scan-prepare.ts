import { commaParts, px } from "./scan-parse.ts";
import { luminance, mixColors, parseColor, type Rgba, toHex } from "./color.ts";
import { nameScore, words } from "./scan-colors.ts";
import { type Category, type Facts, type Kinds } from "./scan-facts.ts";
import { colorFact, ingest } from "./scan-facts-use.ts";
import { TAILWIND_3_COLORS, TAILWIND_4_COLORS } from "./scan-tailwind.ts";
import { kebab } from "./scan-util.ts";
import { channelColor, evalMath, follow, type Variable, variables } from "./scan-variables.ts";
import { categorize } from "./scan-categorize.ts";

export interface Classified {
    variable: Variable;
    category: Category;
    light?: string;
    dark?: string;
    lightColor?: string;
    darkColor?: string;
    via?: Variable;
    darkVia?: Variable;
}

export interface Prepared {
    index: Map<string, Variable>;
    classified: Classified[];
    alt: "dark" | "light";
    /** Colors kept for the other mode under names of their own (`$dark-text`), as the roles they stand for. */
    others: { role: string; entry: Classified }[];
}

export function prepare(facts: Facts, alt: "dark" | "light"): Prepared {
    const all = variables(facts, alt);
    const index = new Map<string, Variable>();

    for (const variable of all) {
        index.set(
            `${variable.kind === "theme" ? "css" : variable.kind}:${variable.name}`,
            variable,
        );
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

            const text = found.text;
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

// A name the project defines itself (its own `blue-500`) is its own, not Tailwind's default.
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

export function weighClassRules(facts: Facts): void {
    for (const [key, rule] of facts.classRules) {
        const [name] = key.split("|") as [string];
        const count = (facts.classCount.get(name) ?? 0) - 1;

        for (const [hex, map] of [
            [rule.light, facts.colors],
            [rule.dark, facts.darkColors],
        ] as const) {
            const fact = hex === undefined ? undefined : map.get(hex);

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

export function resolveDeferred(facts: Facts, prep: Prepared): void {
    const lookup = (name: string, kind: "scss" | "less" | "css") => {
        const target = prep.index.get(`${kind}:${name}`);

        return target === undefined ? undefined : follow(prep.index, target, "light")?.text;
    };

    for (const { prop, value, selector, scope, file, line } of facts.deferred.splice(0)) {
        let resolved = value.replace(/calc\(((?:[^()]|\([^()]*\))*)\)/g, (all, inner: string) => {
            return evalMath(inner, lookup) ?? all;
        });

        resolved = resolved.replace(/rgba?\(\s*[$@][\w-]+\s*,\s*\d*\.?\d+%?\s*\)/gi, (all) => {
            const color = evalColor(all, "", "light", prep.index);

            return color === undefined ? all : toHex(color);
        });
        resolved = resolved.replace(
            /(?:[$@][\w-]+|\d*\.?\d+[a-z%]*)(?:\s*[*/]\s*(?:[$@][\w-]+|\d*\.?\d+[a-z%]*)|\s+[+-]\s+(?:[$@][\w-]+|\d*\.?\d+[a-z%]*))+/g,
            (run) => evalMath(run, lookup) ?? run,
        );

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

/** A color that a variable or `color-mix()` makes: what the browser computes, for the forms a draft needs. */
function evalColor(
    text: string,
    name: string,
    mode: "light" | "dark",
    index: Map<string, Variable>,
    depth = 0,
): Rgba | undefined {
    const trimmed = text.trim();
    const direct = parseColor(channelColor(trimmed, name) ?? trimmed);

    if (direct !== undefined || depth > 6) {
        return direct;
    }

    const valueOf = (key: string) => {
        const target = index.get(key);

        return (mode === "dark" ? (target?.dark ?? target?.light) : (target?.light ?? target?.dark))
            ?.value;
    };

    // `rgba($black, 0.87)`: Sass and Less write a variable's color with an alpha so.
    const faded = /^rgba?\(\s*([$@][\w-]+)\s*,\s*(\d*\.?\d+)(%?)\s*\)$/i.exec(trimmed);

    if (faded !== null) {
        const color = evalColor(faded[1]!, name, mode, index, depth + 1);
        const alpha = Number(faded[2]) / (faded[3] === "%" ? 100 : 1);

        return color === undefined ? undefined : { ...color, a: Math.min(1, alpha) * color.a };
    }

    const sassVar = /^[$@]([\w-]+)$/.exec(trimmed);

    if (sassVar !== null) {
        const value = valueOf(`scss:${sassVar[1]}`) ?? valueOf(`less:${sassVar[1]}`);

        return value === undefined
            ? undefined
            : evalColor(value, sassVar[1]!, mode, index, depth + 1);
    }

    const reference = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(trimmed);

    if (reference !== null) {
        const next = valueOf(`css:${reference[1]}`) ?? reference[2];

        return next === undefined
            ? undefined
            : evalColor(next, reference[1]!, mode, index, depth + 1);
    }

    const mix =
        /^color-mix\(\s*in\s+([a-z0-9-]+)(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?\s*,([\s\S]*)\)$/i.exec(
            trimmed,
        );
    const args = mix === null ? [] : commaParts(mix[2]!);

    if (args.length !== 2) {
        return undefined;
    }

    const operands = args.map((arg) => {
        const match = /^(?:(\d*\.?\d+)%\s+([\s\S]+)|([\s\S]+?)\s+(\d*\.?\d+)%)$/.exec(arg.trim());
        const color = evalColor(
            match === null ? arg : (match[2] ?? match[3]!),
            name,
            mode,
            index,
            depth + 1,
        );
        const percent = match === null ? undefined : Number(match[1] ?? match[4]);

        return color === undefined
            ? undefined
            : { color, ...(percent === undefined ? {} : { percent }) };
    });

    return operands[0] === undefined || operands[1] === undefined
        ? undefined
        : mixColors(mix![1]!.toLowerCase(), operands[0], operands[1]);
}
