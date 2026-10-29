import { isObject, type Obj } from "./scan-import-convert.ts";
import {
    DARK,
    type Entry,
    LIGHT,
    LIMITS,
    Mode,
    flatten,
    hasWord,
    changesBetween,
    tokensOf,
    words,
} from "./scan-import-eval.ts";

export interface StudioSource {
    sets: Map<string, Obj>;
    order: string[];
    themes: unknown[];
}

export const looksLikeSets = (keys: string[]) =>
    keys.some((key) => hasWord(key, DARK) || hasWord(key, LIGHT));

interface Theme {
    name: string;
    group?: string;
    enabled: string[];
    source: string[];
}

function themesOf(themes: unknown[]): Theme[] {
    const out: Theme[] = [];

    for (const item of themes.slice(0, 40)) {
        if (!isObject(item) || !isObject(item.selectedTokenSets)) {
            continue;
        }

        const on = (status: string) =>
            Object.entries(item.selectedTokenSets as Obj)
                .filter(([, value]) => value === status || (status === "enabled" && value === true))
                .map(([name]) => name);

        out.push({
            name: String(item.name ?? item.id ?? "").slice(0, 60),
            ...(typeof item.group === "string" ? { group: item.group.slice(0, 60) } : {}),
            enabled: on("enabled"),
            source: on("source"),
        });
    }

    return out;
}

function pickModes(
    themes: Theme[],
    names: string[],
    notes: string[],
): { light: string[]; dark: string[] | undefined; extra: [string, string[]][] } {
    const order = (list: string[]) => names.filter((name) => list.includes(name));
    const setsOf = (list: Theme[]) =>
        order(list.flatMap((theme) => [...theme.source, ...theme.enabled]));
    const isDarkTheme = (theme: Theme) =>
        hasWord(theme.name, DARK) || theme.enabled.some((name) => hasWord(name, DARK));
    const stem = (theme: Theme) =>
        words(theme.name)
            .filter((word) => !DARK.has(word) && !LIGHT.has(word))
            .join(" ");
    const darkSets = names.filter((name) => hasWord(name, DARK));
    const lightSets = names.filter((name) => !hasWord(name, DARK) && hasWord(name, LIGHT));
    const baseSets = names.filter((name) => !hasWord(name, DARK) && !hasWord(name, LIGHT));
    let light: string[] | undefined;
    let dark: string[] | undefined;
    const extra: [string, string[]][] = [];

    if (themes.length > 0) {
        // Themes of different groups apply together (a mode group and a brand group): the first of each other group is
        // part of every mode, and the mode group gives the light theme and the dark one.
        const groups = new Map<string, Theme[]>();

        for (const theme of themes) {
            const key = theme.group ?? "";

            groups.set(key, [...(groups.get(key) ?? []), theme]);
        }

        const modeList =
            [...groups.values()].find((list) => list.some(isDarkTheme)) ?? [...groups.values()][0]!;
        const others = [...groups.values()]
            .filter((list) => list !== modeList)
            .map((list) => list[0]!);
        const lightTheme =
            modeList.find((theme) => !isDarkTheme(theme) && hasWord(theme.name, LIGHT)) ??
            modeList.find((theme) => !isDarkTheme(theme));
        const darkTheme =
            modeList.find(
                (theme) =>
                    isDarkTheme(theme) &&
                    lightTheme !== undefined &&
                    stem(theme) === stem(lightTheme),
            ) ?? modeList.find(isDarkTheme);

        if (lightTheme !== undefined) {
            light = setsOf([...others, lightTheme]);
        }

        if (darkTheme !== undefined) {
            dark = setsOf([...others, darkTheme]);
        }

        const spare =
            lightTheme === undefined
                ? []
                : modeList.filter((theme) => theme !== lightTheme && theme !== darkTheme);
        const modeOf = (theme: Theme) => words(theme.name).join("-");
        const used: Theme[] = [];

        for (const theme of spare.slice(0, 3)) {
            const mode = modeOf(theme);

            if (
                /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mode) &&
                mode !== "dark" &&
                mode !== "light" &&
                !extra.some(([name]) => name === mode)
            ) {
                extra.push([mode, setsOf([...others, theme])]);
                used.push(theme);
            }
        }

        const read = [...others, lightTheme, darkTheme, ...used].filter(
            (theme): theme is Theme => theme !== undefined,
        );

        if (read.length < themes.length) {
            notes.push(
                `Tokens Studio has ${themes.length} themes (${themes.map((theme) => theme.name).join(", ")}); the scan reads ${read.map((theme) => theme.name).join(", ")}.`,
            );
        }
    }

    if (light === undefined && dark === undefined) {
        light = darkSets.length > 0 ? [...baseSets, ...lightSets] : names;
        dark = darkSets.length > 0 ? [...baseSets, ...darkSets] : undefined;
    } else if (light === undefined) {
        light = dark;
        dark = undefined;
    } else if (dark === undefined && darkSets.length > 0) {
        dark = [
            ...light.filter((name) => !hasWord(name, LIGHT)),
            ...darkSets.filter((name) => !light!.includes(name)),
        ];
    }

    return { light: light ?? [], dark, extra };
}

export function studioTokens(input: StudioSource): {
    default: Obj;
    dark: Obj;
    extra: Record<string, Obj>;
    count: number;
    notes: string[];
} {
    const notes: string[] = [];
    const names = [
        ...input.order.filter((name) => input.sets.has(name)),
        ...[...input.sets.keys()].filter((name) => !input.order.includes(name)),
    ].slice(0, LIMITS.sets);
    const { light, dark, extra } = pickModes(themesOf(input.themes), names, notes);

    notes.push(
        `Tokens Studio sets: the default mode is ${light.join(" + ") || "none"}${dark === undefined ? "" : `; the dark mode is ${dark.join(" + ")}`}${extra.map(([mode, sets]) => `; ${mode} is ${sets.join(" + ")}`).join("")}.`,
    );

    const budget = { left: LIMITS.tokens };

    const read = (list: string[]) => {
        const entries = new Map<string, Entry>();

        for (const name of list) {
            const set = new Map<string, Entry>();

            flatten(input.sets.get(name)!, set, budget);
            set.forEach((entry, key) => entries.set(key, entry));
        }

        return new Mode(entries);
    };

    const first = tokensOf(read(light));
    const result = {
        default: first.tree,
        dark: {} as Obj,
        extra: {} as Record<string, Obj>,
        count: first.flat.size,
        notes,
    };

    const changes = (sets: string[], label: string): Obj => {
        const { tree, skipped } = changesBetween(first.flat, tokensOf(read(sets)).flat);

        if (skipped > 0) {
            notes.push(`${skipped} tokens that only the ${label} mode has were left out.`);
        }

        return tree;
    };

    if (dark !== undefined && dark.join("\n") !== light.join("\n")) {
        result.dark = changes(dark, "dark");
    }

    for (const [mode, sets] of extra) {
        result.extra[mode] = changes(sets, mode);
    }

    return result;
}
