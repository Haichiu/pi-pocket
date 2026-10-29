import { colorsIn, pageStyles, parseStyles, stripComments } from "./scan-parse.ts";
import { importTokens } from "./scan-import.ts";
import { bump, emptyKinds, type Facts, modeOf } from "./scan-facts.ts";
import { colorFact, ingestStyles } from "./scan-facts-use.ts";
import { tailwindConfig } from "./scan-tailwind.ts";

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

const SPACING_CLASS =
    /(?<![\w-])(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)(?![\w-])/g;

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

    if (extension === ".scss" || extension === ".less") {
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

    if (extension === ".json") {
        importTokens(facts.imported, rel, raw);

        return;
    }

    const isStyle = /^\.(?:css|scss|less|pcss|postcss)$/.test(extension);
    const isPage = /^\.(?:html|htm|vue|svelte|astro|mdx|php|erb|hbs|njk)$/.test(extension);
    const isScript = /^\.(?:[cm]?[jt]s|[jt]sx)$/.test(extension);

    if (isStyle) {
        ingestStyles(facts, rel, parseStyles(raw, 1));
    } else if (isPage) {
        const { blocks, inline } = pageStyles(raw);

        for (const block of blocks) {
            ingestStyles(facts, rel, parseStyles(block, lineOfBlock(raw, block)));
        }

        ingestStyles(facts, rel, inline);
    } else if (isScript && /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(rel)) {
        tailwindConfig(facts, rel, raw);
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
