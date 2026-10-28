/**
 * Ant Design themes (stream T): a `ThemeConfig`, `{ token: { colorPrimary, colorBgContainer, fontSize, borderRadius, … },
 * components: { … }, algorithm: theme.darkAlgorithm }`, in a file of its own (`light.ts`, `dark.ts`), as a `theme` prop of
 * `ConfigProvider`, or in one object with the algorithm switched at run time. The seed tokens are read as variables named
 * for what they are (`colorBgLayout` is the page, `colorBgContainer` a surface, `colorText`, `colorTextSecondary`,
 * `colorBorder`, `colorPrimary` the accent, `colorError` the danger), numbers are pixels, and an object whose algorithm is
 * the dark one (or whose name or file says dark) holds the dark mode. The tokens of one component are left out: they are
 * that component's own, not the design's.
 */
import { readLiteral, type Literal, type Scope } from "./scan-parse.ts";
import { addVar, type Category, type Facts } from "./scan-facts.ts";
import { modeOf } from "./scan-facts-lists.ts";
import { closeOf, openAround, topLevelValue } from "./scan-braces.ts";

/** How a seed token is read: the name of the variable, and what it is. */
function seed(
    key: string,
    value: Literal,
): { name: string; value: string; hint: Category } | undefined {
    const kebab = key
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
        .toLowerCase()
        .replace(/^motion-(?=duration|ease)/, "");
    const number =
        typeof value === "number"
            ? value
            : /^-?\d+(?:\.\d+)?$/.test(String(value))
              ? Number(value)
              : undefined;

    if (typeof value !== "string" && number === undefined) {
        return undefined;
    }

    if (/^color/.test(key)) {
        return typeof value === "string" && /^(?:#|rgba?\(|hsla?\(|oklch\(|[a-z]+$)/i.test(value)
            ? { name: kebab, value, hint: "color" }
            : undefined;
    }

    // `fontFamily` as a string is read with the other theme scalars; the code family is a name of its own.
    if (key === "fontFamilyCode") {
        return typeof value === "string" ? { name: kebab, value, hint: "font" } : undefined;
    }

    if (/^fontSize/.test(key) && number !== undefined) {
        return { name: kebab, value: `${number}px`, hint: "text" };
    }

    // `borderRadius` itself is read with the other theme scalars; its sizes (`borderRadiusSM`) are read here.
    if (/^borderRadius./.test(key) && number !== undefined) {
        return { name: kebab, value: `${number}px`, hint: "radius" };
    }

    if (key === "lineHeight" && number !== undefined) {
        return { name: kebab, value: String(number), hint: "leading" };
    }

    if (/^(?:boxShadow)/.test(key) && typeof value === "string") {
        return { name: kebab, value, hint: "shadow" };
    }

    if (/^motionDuration/.test(key) && typeof value === "string") {
        return { name: kebab, value, hint: "duration" };
    }

    if (/^motionEase/.test(key) && typeof value === "string") {
        return { name: kebab, value, hint: "ease" };
    }

    return undefined;
}

/** Whether a file has an Ant Design theme: it uses Ant Design and sets `token`. */
export const hasAntdTheme = (text: string) =>
    USES_ANTD.test(text) && /(?<![\w$.])token\s*:\s*\{/.test(text);

/** Whether a file uses Ant Design: an import from it, a `ThemeConfig`, or one of its algorithms. */
const USES_ANTD =
    /from\s+["']antd["']|ThemeConfig|ConfigProvider|@ant-design|\b(?:dark|default|compact)Algorithm\b/;

/** The spans of `components: { … }` in a file that uses Ant Design: what is in them is one component's own. */
export function antdComponentSpans(text: string): { at: number; end: number }[] {
    if (!USES_ANTD.test(text)) {
        return [];
    }

    return [...text.matchAll(/(?<![\w$.])components\s*:\s*(?=\{)/g)]
        .slice(0, 6)
        .flatMap((match) => {
            const end = closeOf(text, match.index + match[0].length);

            return end === undefined ? [] : [{ at: match.index, end }];
        });
}

/** Reads the Ant Design theme objects of a file into `facts`. `scopeAt` says which mode the name of an object stands for. */
export function antdTheme(
    facts: Facts,
    file: string,
    text: string,
    env: ReadonlyMap<string, Literal>,
    scopeAt: (index: number) => Scope,
): void {
    if (!USES_ANTD.test(text)) {
        return;
    }

    let seen = 0;

    for (const match of text.matchAll(/(?<![\w$.])token\s*:\s*(?=\{)/g)) {
        if (++seen > 12) {
            break;
        }

        const literal = readLiteral(text, match.index + match[0].length, env);

        if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
            continue;
        }

        // The object around `token`: its algorithm decides the mode (`darkAlgorithm` is dark; a choice between the two is both).
        const open = openAround(text, match.index);
        const end = open === undefined ? undefined : closeOf(text, open);
        const algorithm =
            open === undefined || end === undefined
                ? undefined
                : topLevelValue(text, open, end, "algorithm");
        const dark =
            algorithm !== undefined &&
            /darkAlgorithm/.test(algorithm) &&
            !/defaultAlgorithm/.test(algorithm);
        const named = scopeAt(match.index);
        // A file named for the dark mode (`dark.ts`, `theme/dark/index.ts`) holds it, whatever its objects are called.
        const fileMode = file
            .replace(/\.[^./]+$/, "")
            .split("/")
            .some((part) => modeOf(part) === "dark")
            ? "dark"
            : undefined;
        const scope: Scope = dark ? "dark" : named !== "default" ? named : (fileMode ?? named);

        // The tokens of a component are inside `components`, not here; `token` is the seed and the map.
        let unit: number | undefined;

        for (const [key, value] of Object.entries(literal).slice(0, 220)) {
            if (key === "sizeUnit" && typeof value === "number") {
                unit = value;
            }

            const found = seed(key, value);

            if (found !== undefined) {
                addVar(facts, { ...found, scope, kind: "js", file });
            }
        }

        // `sizeUnit` is the base of the spacing: the unit and its steps.
        if (unit !== undefined && unit > 0) {
            addVar(facts, {
                name: "spacing",
                value: `${unit}px`,
                scope,
                kind: "js",
                file,
                hint: "space",
            });
        }
    }
}
