import { DARK, hasWord, LIGHT, segment } from "./scan-import-eval.ts";
import { closeOf, openAround, topLevelAt, topLevelValue } from "./scan-braces.ts";

export interface SdConfig {
    /** The folder of the config: its globs are relative to it, or to the project's root. */
    dir: string;
    include: string[];
    source: string[];
    mode?: string;
}

export const SD_CONFIG_NAME =
    /^(?:[\w.-]*[.-])?(?:config|build)(?:[.-][\w-]+)?$|^\.styledictionaryrc$|^(?:style-?dictionary|sd)(?:[.-][\w-]+)?$/i;

const NOT_MODES = new Set([
    "base",
    "default",
    "main",
    "common",
    "shared",
    "global",
    "web",
    "css",
    "scss",
    "sass",
    "less",
    "js",
    "ts",
    "json",
    "mjs",
    "cjs",
    "ios",
    "android",
    "swift",
    "kotlin",
    "compose",
    "flutter",
    "dart",
    "native",
    "react",
    "node",
    "docs",
    "dev",
    "prod",
    "production",
    "development",
    "test",
    "ci",
    "local",
    "build",
    "tokens",
    "style",
    "dictionary",
    "styledictionary",
    "sd",
    "config",
    "esm",
    "umd",
    "legacy",
    "next",
    "v3",
    "v4",
]);

export function modeName(word: string): string | undefined {
    const name = segment(word).toLowerCase();

    if (name === "" || NOT_MODES.has(name)) {
        return undefined;
    }

    return hasWord(name, DARK) ? "dark" : hasWord(name, LIGHT) ? "light" : name;
}

export function modeOfConfigFile(file: string): string | undefined {
    const parts = file.split("/");
    const base = parts.at(-1)!.replace(/\.(?:json|[cm]?[jt]s)$/i, "");
    const words = base.split(/[.-]/).filter((word) => word !== "");
    const at = words.findIndex((word) => /^(?:config|build)$/i.test(word));

    // `config.dark`, `sd.config.dark`, `config-acme`: the word after `config`; `dark.config`, `acme-config`: the word before.
    const named =
        at === -1
            ? undefined
            : (words
                  .slice(at + 1)
                  .map(modeName)
                  .find((name) => name !== undefined) ??
              words
                  .slice(0, at)
                  .map(modeName)
                  .findLast((name) => name !== undefined));

    if (named !== undefined) {
        return named;
    }

    const folder = parts.at(-2);
    const grand = parts.at(-3);

    if (folder !== undefined && at !== -1 && words.length === 1) {
        if (hasWord(folder, DARK) || hasWord(folder, LIGHT)) {
            return modeName(folder);
        }

        if (
            grand !== undefined &&
            /^(?:brands?|themes?|modes?|skins?|variants?|schemes?)$/i.test(grand)
        ) {
            return modeName(folder);
        }
    }

    return undefined;
}

function modeOfGlobs(globs: string[]): string | undefined {
    for (const glob of globs) {
        const parts = glob.replace(/^\.\//, "").split("/");
        const at = parts.findIndex(
            (part, index) =>
                index < parts.length - 1 &&
                /^(?:brands?|themes?|modes?|skins?|variants?|schemes?)$/i.test(part),
        );
        const named = at !== -1 ? parts[at + 1] : parts.find((part) => hasWord(part, DARK));

        if (named !== undefined && !/[*?{]/.test(named.replace(/\.[^.]+$/, ""))) {
            const mode = modeName(named.replace(/\.[^.]+$/, ""));

            if (mode !== undefined) {
                return mode;
            }
        }
    }

    return undefined;
}

const made = (
    dir: string,
    include: string[],
    source: string[],
    mode: string | undefined,
): SdConfig => ({
    dir,
    include,
    source,
    ...(mode === undefined ? {} : { mode }),
});

const stringsIn = (text: string) =>
    [...text.matchAll(/["'`]([^"'`\n]{1,200})["'`]/g)].map((match) => match[1]!).slice(0, 40);

function listValues(text: string, list: string): string[] {
    const literal = list.startsWith("[")
        ? list
        : (new RegExp(
              String.raw`(?:const|let|var)\s+${list.replace(/\W/g, "")}\s*(?::[^=\n]{1,60})?=\s*(\[[^\]]{0,600}\])`,
          ).exec(text)?.[1] ?? "");

    return stringsIn(literal).filter((value) => /^[\w.-]{1,40}$/.test(value));
}

function valuesOf(text: string, rawName: string, at: number): string[] {
    const name = rawName.replace(/[$]/g, "\\$&");
    // A name starts where a name can start (`(?<![\w$])`): from every letter of a long one, the search ran to its end.
    const list = String.raw`(\[[^\]]{0,600}\]|(?<![\w$])[A-Za-z_$][\w$]*)`;
    const found = new Set<string>();
    const add = (values: string[]) => values.forEach((value) => found.add(value));

    for (const match of text.matchAll(
        new RegExp(String.raw`for\s*\(\s*(?:const|let|var)\s+${name}\s+of\s+${list}`, "g"),
    )) {
        add(listValues(text, match[1]!));
    }

    for (const match of text.matchAll(
        new RegExp(
            String.raw`${list}\s*\.\s*(?:forEach|map|flatMap)\(\s*(?:async\s*)?\(?\s*${name}\b`,
            "g",
        ),
    )) {
        add(listValues(text, match[1]!));
    }

    const before = text.slice(Math.max(0, at - 1200), at);
    const fn = [
        ...before.matchAll(
            new RegExp(
                String.raw`(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*${name}\b|function\s+([A-Za-z_$][\w$]*)\s*\(\s*${name}\b)`,
                "g",
            ),
        ),
    ].at(-1);
    const fnName = (fn?.[1] ?? fn?.[2])?.replace(/[$]/g, "\\$&");

    if (fnName !== undefined) {
        for (const call of text.matchAll(
            new RegExp(String.raw`\b${fnName}\(\s*["'\`]([\w.-]{1,40})["'\`]`, "g"),
        )) {
            found.add(call[1]!);
        }

        for (const each of text.matchAll(
            new RegExp(
                String.raw`${list}\s*\.\s*(?:forEach|map|flatMap)\(\s*(?:${fnName}\s*\)|[^)]{0,80}\b${fnName}\()`,
                "g",
            ),
        )) {
            add(listValues(text, each[1]!));
        }
    }

    if (found.size === 0) {
        for (const plural of [`${name}s`, `${name}List`, `${name}Names`]) {
            add(listValues(text, plural));
        }
    }

    return [...found].slice(0, 8);
}

const MODE_NAME = /theme|mode|brand|scheme|variant|skin|palette|appearance|tenant|flavor|color/i;

function configsOfObject(
    dir: string,
    file: string,
    text: string,
    open: number,
    end: number,
): SdConfig[] {
    const listAt = (key: string) => {
        const at = topLevelAt(text, open, end, key);

        if (at === undefined || text[at] !== "[") {
            return [];
        }

        const close = closeOf(text, at);

        return close === undefined ? [] : stringsIn(text.slice(at, close));
    };

    const include = listAt("include");
    const source = listAt("source");

    if (source.length === 0) {
        return [];
    }

    const own = ["theme", "mode", "brand", "scheme", "variant", "colorScheme"]
        .map((key) =>
            /^\s*["'`]([\w.-]{1,40})["'`]/.exec(topLevelValue(text, open, end, key) ?? ""),
        )
        .find((match) => match !== null && match !== undefined)?.[1];
    const mode = (own === undefined ? undefined : modeName(own)) ?? modeOfConfigFile(file);
    const globs = [...include, ...source];
    const names = [
        ...new Set(
            globs.flatMap((glob) =>
                [...glob.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((m) => m[1]!),
            ),
        ),
    ];

    if (names.length === 0) {
        return [made(dir, include, source, mode ?? modeOfGlobs(globs))];
    }

    const name = names.find((each) => MODE_NAME.test(each)) ?? names[0]!;
    const values = valuesOf(text, name, open).filter(
        (value) => MODE_NAME.test(name) || hasWord(value, DARK) || hasWord(value, LIGHT),
    );

    if (values.length === 0) {
        return [made(dir, include, source, mode)];
    }

    const fill = (glob: string, value: string) =>
        glob.replace(new RegExp(String.raw`\$\{\s*${name.replace(/\$/g, "\\$")}\s*\}`, "g"), value);

    return values.map((value) =>
        made(
            dir,
            include.map((glob) => fill(glob, value)),
            source.map((glob) => fill(glob, value)),
            modeName(value) ?? mode,
        ),
    );
}

export function sdConfigsIn(dir: string, file: string, text: string): SdConfig[] {
    if (!/\bplatforms\b/.test(text)) {
        return [];
    }

    const out: SdConfig[] = [];
    const seen = new Set<number>();
    let tried = 0;

    for (const match of text.matchAll(/(?<![\w$.])["']?source["']?\s*:\s*(?=\[)/g)) {
        // Bounded: a file can repeat `source: [` thousands of times.
        if (out.length >= 8 || ++tried > 40) {
            break;
        }

        const open = openAround(text, match.index);
        const end = open === undefined ? undefined : closeOf(text, open);

        if (open === undefined || end === undefined || seen.has(open)) {
            continue;
        }

        seen.add(open);

        // A config has `platforms`: an object that only has a `source` list is not one.
        if (topLevelAt(text, open, end, "platforms") !== undefined) {
            out.push(...configsOfObject(dir, file, text, open, end));
        }
    }

    return out.slice(0, 8);
}

export function sdConfigOfJson(dir: string, file: string, root: Record<string, unknown>): SdConfig {
    const list = (value: unknown) =>
        Array.isArray(value)
            ? value.filter((each): each is string => typeof each === "string").slice(0, 40)
            : [];
    const include = list(root.include);
    const source = list(root.source);
    const own = ["theme", "mode", "brand", "scheme", "variant"]
        .map((key) => root[key])
        .find((value): value is string => typeof value === "string");
    const mode = (own === undefined ? undefined : modeName(own)) ?? modeOfConfigFile(file);

    return made(dir, include, source, mode ?? modeOfGlobs([...include, ...source]));
}
