// The walk is bounded and follows no link. It goes into `dist` and `build`, which the style scan leaves out, because a built page is what the browser can show.
import { lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { readHead } from "./scan-files.ts";

export interface PageAsset {
    name: string;
    type: string;
    bytes: Buffer;
}

export type DarkToggle = { class: string } | { attr: string; value: string };

export interface RenderPlan {
    pages: string[];
    assets: PageAsset[];
    vars: string[];
    toggles: DarkToggle[];
    /** True when a page is only a shell that a script fills (a bundler's `index.html` with no sources built). */
    notes: string[];
}

const LIMITS = {
    entries: 12_000,
    depth: 7,
    pages: 3,
    assets: 300,
    bytes: 12_000_000,
    file: 1_500_000,
    html: 400_000,
};

const NEVER =
    /^(?:node_modules|\.git|\.hg|\.svn|vendor|vendors|bower_components|third[-_]?party|coverage|__pycache__|\.venv|venv|target|\.yarn|\.pnpm-store)$/i;

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

const extensionOf = (name: string) => /\.[a-z0-9]+$/i.exec(name)?.[0].toLowerCase() ?? "";

function pageScore(rel: string, text: string): number {
    const parts = rel.split("/");
    const name = parts.at(-1)!.toLowerCase();
    let score = 20 - parts.length * 3;

    if (name === "index.html" || name === "index.htm") {
        score += 14;
    } else if (name === "iframe.html") {
        score += 12;
    }

    if (
        /(?:^|\/)(?:dist|build|out|public|docs?|www|site|_site|storybook-static|static|web|html)\//i.test(
            rel,
        )
    ) {
        score += 10;
    }

    if (
        /(?:^|\/)(?:test|tests|__tests__|fixtures?|e2e|coverage|cypress|playwright)\//i.test(rel) ||
        /^(?:404|500|error)\./.test(name)
    ) {
        score -= 25;
    }

    if (!/<(?:body|html|!doctype)/i.test(text.slice(0, 4000))) {
        score -= 30;
    }

    if ((text.match(/\{\{|\{%|<%|<\?php|@yield|@section/g)?.length ?? 0) > 3) {
        score -= 25;
    }

    const bodyText = text
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");

    if (bodyText.trim().length < 40 && !/<script[^>]+src=/i.test(text)) {
        score -= 20;
    }

    return score;
}

function relink(html: string, page: string, has: (path: string) => boolean): string {
    const dir = posix.dirname(page);

    return html.replace(
        /\b(src|href|poster|data-src|data-href)\s*=\s*(["'])\/(?!\/)([^"'#?]*)([^"']*)\2/gi,
        (whole, attribute: string, quote: string, path: string, rest: string) => {
            for (let base = dir; ; base = posix.dirname(base)) {
                const candidate = base === "." ? path : posix.join(base, path);

                if (has(candidate)) {
                    const relative = posix.relative(dir === "." ? "" : dir, candidate) || ".";

                    return `${attribute}=${quote}${relative}${rest}${quote}`;
                }

                if (base === "." || base === "/") {
                    break;
                }
            }

            return whole;
        },
    );
}

function togglesIn(texts: string[]): DarkToggle[] {
    const classes = new Map<string, number>();
    const attrs = new Map<string, number>();
    const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

    for (const text of texts) {
        for (const match of text.matchAll(/\.([\w-]*(?:dark|night)[\w-]*)(?![\w\\-])/gi)) {
            count(classes, match[1]!);
        }

        for (const match of text.matchAll(
            /\[\s*([\w:-]+)\s*[~|^$*]?=\s*["']?([\w-]*(?:dark|night)[\w-]*)["']?\s*\]/gi,
        )) {
            count(attrs, `${match[1]}=${match[2]}`);
        }

        for (const match of text.matchAll(
            /classList\.(?:add|toggle|replace)\(\s*["']([\w-]*(?:dark|night)[\w-]*)["']/gi,
        )) {
            count(classes, match[1]!);
        }

        for (const match of text.matchAll(
            /setAttribute\(\s*["']([\w:-]+)["']\s*,\s*["']([\w-]*(?:dark|night)[\w-]*)["']/gi,
        )) {
            count(attrs, `${match[1]}=${match[2]}`);
        }

        for (const match of text.matchAll(
            /dataset\.(\w+)\s*=\s*["']([\w-]*(?:dark|night)[\w-]*)["']/gi,
        )) {
            count(attrs, `data-${match[1]!.replace(/([A-Z])/g, "-$1").toLowerCase()}=${match[2]}`);
        }
    }

    const top = (map: Map<string, number>) =>
        [...map]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([key]) => key);
    const toggles: DarkToggle[] = [
        ...top(classes).map((name) => ({ class: name })),
        ...top(attrs).flatMap((pair) => {
            const at = pair.indexOf("=");

            return [{ attr: pair.slice(0, at), value: pair.slice(at + 1) }];
        }),
    ];

    for (const fixed of [
        { class: "dark" },
        { attr: "data-theme", value: "dark" },
        { attr: "data-bs-theme", value: "dark" },
        { attr: "data-mantine-color-scheme", value: "dark" },
        { attr: "data-mode", value: "dark" },
        { attr: "data-color-mode", value: "dark" },
        { attr: "data-color-scheme", value: "dark" },
        { class: "dark-mode" },
        { class: "theme-dark" },
        { class: "dark-theme" },
    ] as DarkToggle[]) {
        if (!toggles.some((each) => JSON.stringify(each) === JSON.stringify(fixed))) {
            toggles.push(fixed);
        }
    }

    return toggles.slice(0, 12);
}

export function planRender(root: string): RenderPlan | undefined {
    const files: { rel: string; size: number }[] = [];
    let seen = 0;

    const walk = (dir: string, depth: number) => {
        let entries;

        try {
            entries = readdirSync(join(root, dir), { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++seen > LIMITS.entries) {
                return;
            }

            const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;

            if (entry.isDirectory()) {
                if (
                    depth < LIMITS.depth &&
                    !NEVER.test(entry.name) &&
                    !entry.name.startsWith(".")
                ) {
                    walk(rel, depth + 1);
                }
            } else if (entry.isFile() && TYPES[extensionOf(entry.name)] !== undefined) {
                try {
                    files.push({ rel, size: lstatSync(join(root, rel)).size });
                } catch {}
            }
        }
    };

    walk("", 0);

    const htmlFiles = files.filter(
        (file) => /\.html?$/i.test(file.rel) && file.size > 0 && file.size < LIMITS.html,
    );

    if (htmlFiles.length === 0) {
        return undefined;
    }

    const texts = new Map<string, string>();

    const read = (rel: string, limit: number) => {
        if (!texts.has(rel)) {
            try {
                texts.set(rel, readHead(join(root, ...rel.split("/")), limit));
            } catch {
                texts.set(rel, "");
            }
        }

        return texts.get(rel)!;
    };

    const ranked = htmlFiles
        .slice(0, 120)
        .map((file) => ({ rel: file.rel, score: pageScore(file.rel, read(file.rel, LIMITS.html)) }))
        .filter((page) => page.score > -5)
        .sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
    const pages: string[] = [];

    // Pages of different folders first (an `index.html` and a `dist/index.html` say more than two pages of one site).
    for (const page of ranked) {
        if (
            pages.length < LIMITS.pages &&
            !pages.some((each) => posix.dirname(each) === posix.dirname(page.rel))
        ) {
            pages.push(page.rel);
        }
    }

    for (const page of ranked) {
        if (pages.length < LIMITS.pages && !pages.includes(page.rel)) {
            pages.push(page.rel);
        }
    }

    if (pages.length === 0) {
        return undefined;
    }

    const near = (rel: string) =>
        Math.max(
            ...pages.map((page) => {
                const a = posix.dirname(page).split("/");
                const b = posix.dirname(rel).split("/");
                let same = 0;

                while (same < a.length && same < b.length && a[same] === b[same]) {
                    same += 1;
                }

                return same;
            }),
        );
    const chosen = files
        .filter(
            (file) =>
                file.size <= LIMITS.file &&
                (pages.includes(file.rel) || !/\.html?$/i.test(file.rel) || near(file.rel) > 0),
        )
        .sort(
            (a, b) =>
                Number(pages.includes(b.rel)) - Number(pages.includes(a.rel)) ||
                near(b.rel) - near(a.rel) ||
                a.rel.localeCompare(b.rel),
        );
    const names = new Set(chosen.map((file) => file.rel));
    const assets: PageAsset[] = [];
    let total = 0;

    for (const file of chosen) {
        if (assets.length >= LIMITS.assets || total + file.size > LIMITS.bytes) {
            continue;
        }

        const text = read(file.rel, LIMITS.file);
        const body = pages.includes(file.rel)
            ? relink(text, file.rel, (path) => names.has(path))
            : text;
        const bytes = Buffer.from(body, "utf8");

        total += bytes.length;
        assets.push({ name: file.rel, type: TYPES[extensionOf(file.rel)]!, bytes });
    }

    const styleText = assets
        .filter((asset) => asset.type.startsWith("text/css") || asset.type.startsWith("text/html"))
        .map((asset) => asset.bytes.toString("utf8"));
    const names2 = new Map<string, number>();

    for (const text of styleText) {
        for (const match of text.matchAll(/(?<![\w-])(--[A-Za-z][\w-]*)\s*:/g)) {
            names2.set(match[1]!, (names2.get(match[1]!) ?? 0) + 1);
        }
    }

    return {
        pages,
        assets,
        vars: [...names2]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 800)
            .map(([name]) => name),
        toggles: togglesIn(
            assets
                .filter((asset) => !asset.type.startsWith("image"))
                .map((asset) => asset.bytes.toString("utf8")),
        ),
        notes: [],
    };
}
