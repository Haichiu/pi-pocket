import {
    colorsIn,
    indentedToBraces,
    objectStyles,
    pageStyles,
    parseStyles,
    stripComments,
    templateStyles,
} from "./scan-parse.ts";
import { hasAntdTheme } from "./scan-facts-antd.ts";
import { importConfig, importMaterial, importTokens } from "./scan-import.ts";
import { bump, emptyKinds, type Facts } from "./scan-facts.ts";
import { colorFact, ingestStyles } from "./scan-facts-use.ts";
import { modeOf } from "./scan-facts-lists.ts";
import { themeVars } from "./scan-facts-theme.ts";
import { wordpressNames, wordpressTheme } from "./scan-facts-wordpress.ts";

const CLASS_USE =
    /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|from|to|via|divide|decoration|accent|caret|placeholder|shadow)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g;

const DEFAULT_COLOR_CLASS =
    /(?<![\w-])(bg|text|border|ring|outline|fill|stroke|divide|from|to|via|decoration|accent|caret|placeholder)-((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|white|black)(?:\/\d+)?(?![\w-])/g;

const CLASS_KIND: Record<string, "bg" | "text" | "border" | "fill"> = {
    bg: "bg",
    from: "bg",
    to: "bg",
    via: "bg",
    text: "text",
    placeholder: "text",
    decoration: "text",
    caret: "text",
    accent: "text",
    border: "border",
    ring: "border",
    outline: "border",
    divide: "border",
    fill: "fill",
    stroke: "fill",
};

const TEXT_CLASS = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;

const ROUNDED_CLASS = /(?<![\w-])rounded(?:-(none|xs|sm|md|lg|xl|2xl|3xl|full))?(?![\w-])/g;

const WEIGHT_CLASS =
    /(?<![\w-])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])/g;

const SPACING_CLASS =
    /(?<![\w-])(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w-])/g;

// A script that writes styles: styled-components, Emotion, Stitches, makeStyles, a style prop or an `sx` prop.
const STYLED =
    /\bstyled\s*[.(]|\bcss\s*`|createGlobalStyle|keyframes\s*`|makeStyles|createUseStyles|\bsx\s*=|style\s*=\s*\{|\bcva\s*\(|\bglobalStyle\b|StyleSheet\.create|\bstyle\s*:\s*\{|\bstyles\s*:\s*\[?\s*`/;

// A script that holds a theme whatever its name: `colors: {` / `palette: {` / `themes: {` with a few color values.
const THEME_CONTENT =
    /\b(?:colors|colours|palette|themes?)\s*:\s*\{[^]{0,2500}?#[0-9a-fA-F]{3,8}\b[^]{0,1500}?#[0-9a-fA-F]{3,8}\b/;

const THEMEISH =
    /(?:^|\/)(?:tailwind\.config|[^/]*(?:theme|tokens?|colors?|palette|design|variables|styles?|constants?|config)[^/]*)\.(?:[cm]?[jt]s|tsx?)$|(?:^|\/)(?:theme|themes|tokens|design-tokens|styles|design|constants)\/(?:[^/]+\/)*[^/]+\.[cm]?[jt]sx?$|(?:^|\/)[^/]*(?:tokens|theme|design)[^/]*\/(?:[^/]+\/)*[^/]+\.[cm]?[jt]sx?$/i;

function lineOfBlock(raw: string, block: string): number | undefined {
    const at = raw.indexOf(block);

    return at === -1 ? undefined : 1 + (raw.slice(0, at).match(/\n/g)?.length ?? 0);
}

export function ingestFile(facts: Facts, rel: string, extension: string, raw: string): void {
    const text = stripComments(raw);
    const parts = rel.split("/");
    const named = modeOf(parts.at(-1)!.replace(/\.[^.]+$/, ""));
    const mode = named ?? (parts.length > 1 ? modeOf(parts.at(-2)!) : undefined);

    facts.fileMode = mode === "dark" || mode === "light" ? mode : undefined;
    facts.file = rel;

    // WordPress names its variables `--wp--preset--color--primary`; the scan reads them as `--color-primary`.
    // A stylesheet that is read before theme.json is renamed too: the files come in the order of their rank.
    if (facts.wordpress || /--wp--(?:preset|custom)--/.test(raw)) {
        raw = wordpressNames(raw);
    }

    if (extension === ".scss" || extension === ".sass") {
        for (const match of text.matchAll(
            /@function\s+([\w-]+)\s*\(\s*\$([\w-]+)[^)]*\)\s*\{\s*@return\s+([^;]+);/g,
        )) {
            if (facts.sassFunctions.size < 40) {
                facts.sassFunctions.set(match[1]!, {
                    param: match[2]!,
                    expression: match[3]!.trim(),
                });
            }
        }
    }

    if (extension === ".scss" || extension === ".sass" || extension === ".less") {
        for (const match of text.matchAll(/[$@]([A-Za-z_][\w-]*)(?!\s*:)/g)) {
            bump(facts.varUse, match[1]!);
        }
    }

    for (const match of text.matchAll(/var\(\s*--([\w-]+)/g)) {
        bump(facts.varUse, match[1]!);
    }

    if (
        /@import\s+["']tailwindcss|@tailwind\s+base|@theme\b|tailwind\.config/.test(text) ||
        /(?:^|\/)tailwind\.config\./.test(rel)
    ) {
        facts.tailwind = true;
    }

    if (/@import\s+["']tailwindcss|@theme\b/.test(text)) {
        facts.tailwindVersion = 4;
    }

    importMaterial(facts.imported, rel, raw);

    if (
        /^\.(?:[cm]?[jt]s)$/.test(extension) &&
        /\bplatforms\b/.test(raw) &&
        /\bsource\b/.test(raw)
    ) {
        // The raw text: a glob (`tokens/**/*.json`) holds `/**/`, which the comment stripper takes for a comment.
        importConfig(facts.imported, rel, raw);
    }

    if (extension === ".json") {
        if (!wordpressTheme(facts, rel, raw)) {
            importTokens(facts.imported, rel, raw);
        }

        if (hasAntdTheme(raw)) {
            themeVars(facts, rel, raw);
        }

        return;
    }

    const isStyle = /^\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/.test(extension);
    const isPage = /^\.(?:html|htm|vue|svelte|astro|mdx|php|erb|hbs|njk)$/.test(extension);
    const isScript = /^\.(?:[cm]?[jt]s|[jt]sx)$/.test(extension);

    if (isStyle) {
        // Indented Sass and Stylus have no braces: they are turned into some first.
        const source = /^\.(?:sass|styl|stylus)$/.test(extension) ? indentedToBraces(raw) : raw;

        ingestStyles(facts, rel, parseStyles(source, 1, facts.darkMixins));
    } else if (isPage) {
        const { blocks, inline } = pageStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block, lineOfBlock(raw, block), facts.darkMixins));
        }

        ingestStyles(facts, rel, inline);
    } else if (
        isScript &&
        (THEMEISH.test(rel) ||
            THEME_CONTENT.test(raw) ||
            hasAntdTheme(raw) ||
            !/^\.(?:[cm]?[jt]s)$/.test(extension) ||
            STYLED.test(raw))
    ) {
        const blocks = templateStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block, lineOfBlock(raw, block), facts.darkMixins));
        }

        if (THEMEISH.test(rel) || THEME_CONTENT.test(raw) || hasAntdTheme(raw)) {
            // A theme object holds values, not styles in use: `border: "#2d3640"` there is a token, not a border.
            themeVars(facts, rel, raw);
        } else {
            ingestStyles(facts, rel, objectStyles(raw));
        }
    }

    if (isPage || isScript) {
        let seen = 0;

        for (const match of text.matchAll(DEFAULT_COLOR_CLASS)) {
            if (++seen > 8000) {
                break;
            }

            const kinds = facts.classColors.get(match[2]!) ?? emptyKinds();
            const kind = CLASS_KIND[match[1]!] ?? "other";

            kinds[kind] += 1;
            facts.classColors.set(match[2]!, kinds);
        }

        seen = 0;

        for (const match of text.matchAll(
            /(?<![\w-])(bg|text|border|fill|stroke|ring|outline|from|to|via)-\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\([^\])]*\))\]/g,
        )) {
            if (++seen > 2000) {
                break;
            }

            const kind =
                (
                    {
                        bg: "bg",
                        text: "text",
                        fill: "fill",
                        stroke: "fill",
                        from: "bg",
                        to: "bg",
                        via: "bg",
                    } as Record<string, "bg" | "text" | "fill" | "border">
                )[match[1]!] ?? "border";

            for (const color of colorsIn(match[2]!.replace(/_/g, " "))) {
                colorFact(facts.colors, color.hex, color.text)[kind] += 1;
            }
        }

        seen = 0;

        for (const match of text.matchAll(
            /<(?:body|html)\b[^>]*?\bclass(?:Name)?\s*=\s*["'`{]+([^"'`}]*)/gi,
        )) {
            for (const name of match[1]!.split(/\s+/).slice(0, 20)) {
                if (/^[\w-]{1,40}$/.test(name)) {
                    facts.rootClasses.add(name);
                }
            }
        }

        seen = 0;

        // Every class name used in markup, to weigh the rules that set a color by how often their class is used.
        for (const match of text.matchAll(
            /\bclass(?:Name)?\s*=\s*(?:["'`]|\{\s*["'`])([^"'`}]*)/g,
        )) {
            if (++seen > 4000) {
                break;
            }

            for (const name of match[1]!.split(/\s+/).slice(0, 40)) {
                if (/^[\w-]{1,40}$/.test(name)) {
                    bump(facts.classCount, name);
                }
            }
        }

        seen = 0;

        for (const match of text.matchAll(CLASS_USE)) {
            if (++seen > 8000) {
                break;
            }

            bump(facts.classUse, match[1]!);
        }

        seen = 0;

        for (const match of text.matchAll(SPACING_CLASS)) {
            if (++seen > 8000) {
                break;
            }

            bump(facts.classSpacing, Number(match[1]) * 4);
        }

        for (const [pattern, map] of [
            [TEXT_CLASS, facts.classText],
            [ROUNDED_CLASS, facts.classRadius],
            [WEIGHT_CLASS, facts.classWeight],
        ] as const) {
            seen = 0;

            for (const match of text.matchAll(pattern)) {
                if (++seen > 8000) {
                    break;
                }

                bump(map, match[1] ?? "default");
            }
        }
    }
}
