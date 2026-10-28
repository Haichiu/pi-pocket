/**
 * Phases 4 and 5 — contrast of the declared pairs in every mode, and the documentation page: rendered at 390×844 and
 * 1440×900 in light and dark (the PNGs go to `--out` for the judges), with checks that a person would make by eye.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignSystem } from "../../../src/server/design/system-types.ts";
import { BenchBrowser, serveFiles, typeOf, type BenchPage, type FileEntry } from "./chromium.ts";
import type { Modules } from "./modules.ts";
import { decodePng, distinctColors } from "./png.ts";
import { contrastPairs, impliedPairs } from "./system.ts";

export interface ContrastPhase {
    /** `flagship` or `bench` (the bench's own system, until the flagship is in the tree). */
    system: string;
    modes: string[];
    declared: number;
    passing: number;
    /** The share of declared pairs that pass in every mode. 0 when none are declared. */
    passRate: number;
    failing: {
        token: string;
        on: string;
        min: number;
        ratios: Record<string, number | undefined>;
    }[];
    /** Pairs that declare `exempt` ("disabled", "decorative"): WCAG 1.4.3 leaves them out. Shown with their ratios, never a failure, and not in `declared`. */
    exempt: {
        token: string;
        on: string;
        min: number;
        exempt: string;
        ratios: Record<string, number | undefined>;
    }[];
    /** Text over fill pairs that the names imply, declared or not. */
    implied: { pairs: number; passing: number; passRate: number };
    score: number;
}

export function contrastPhase(
    system: DesignSystem | undefined,
    label: string,
    counts = true,
): ContrastPhase {
    if (system === undefined) {
        return {
            system: label,
            modes: [],
            declared: 0,
            passing: 0,
            passRate: 0,
            failing: [],
            exempt: [],
            implied: { pairs: 0, passing: 0, passRate: 0 },
            score: 0,
        };
    }

    const all = contrastPairs(system.tokens, system.modes);
    // An exempt pair is reported apart, with its ratio. It is not a failure and not in the pass rate.
    const pairs = all.filter((pair) => pair.exempt === undefined);
    const round = (ratios: Record<string, number | undefined>) =>
        Object.fromEntries(
            Object.entries(ratios).map(([mode, ratio]) => [
                mode,
                ratio === undefined ? undefined : Math.round(ratio * 100) / 100,
            ]),
        );
    const implied = impliedPairs(system.tokens, system.modes);
    const passing = pairs.filter((pair) => pair.passesEverywhere).length;
    const impliedPassing = implied.filter((pair) => pair.failing.length === 0).length;
    const passRate = pairs.length === 0 ? 0 : passing / pairs.length;

    return {
        system: label,
        modes: system.modes,
        declared: pairs.length,
        passing,
        passRate: Math.round(passRate * 1000) / 1000,
        failing: pairs
            .filter((pair) => !pair.passesEverywhere)
            .map((pair) => ({
                token: pair.token,
                on: pair.on,
                min: pair.min,
                ratios: round(pair.ratios),
            })),
        exempt: all
            .filter((pair) => pair.exempt !== undefined)
            .map((pair) => ({
                token: pair.token,
                on: pair.on,
                min: pair.min,
                exempt: pair.exempt!,
                ratios: round(pair.ratios),
            })),
        implied: {
            pairs: implied.length,
            passing: impliedPassing,
            passRate:
                implied.length === 0
                    ? 0
                    : Math.round((impliedPassing / implied.length) * 1000) / 1000,
        },
        // The bench's own system is shown for reference but earns nothing: only the flagship can.
        score: counts ? Math.round(passRate * 1000) / 1000 : 0,
    };
}

export interface DocsShot {
    viewport: string;
    scheme: "light" | "dark";
    /** The first tile: the first screen. */
    file?: string;
    /** Every tile, in page order: `docs-<viewport>-<scheme>-<NN>-<section>.png`, each at most 2,000 px high, at scale 1. */
    tiles?: string[];
    height?: number;
    /** Wider than the viewport: a horizontal scroll. */
    overflowX?: boolean;
    /** The component frames of the page (`iframe.comp-frame`): how many, and how many had text and painted. */
    frames?: { count: number; withText: number; painted: number; blank: string[] };
    errors: string[];
    external: string[];
    failed: string[];
}

export interface DocsPhase {
    available: boolean;
    system: string;
    htmlBytes: number;
    assets: number;
    shots: DocsShot[];
    checks: Record<string, boolean>;
    /** Which of the expected sections have a heading. */
    sections: Record<string, boolean>;
    score: number;
    error?: string;
}

/** The sections that a design-system documentation page has. Matched against its headings, case-insensitive. */
export const SECTIONS: Record<string, RegExp> = {
    colors: /colou?rs?|palette/i,
    type: /typograph|type scale|typeface|\bfonts?\b/i,
    spacing: /spacing|space\b/i,
    radii: /radi(us|i)|corner/i,
    shadows: /shadow|elevation/i,
    motion: /motion|animation|duration|easing/i,
    components: /components?/i,
};

const VIEWPORTS = [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
] as const;

/** The tallest tile. Judges read images up to 2,000 × 2,000 px. */
export const TILE_HEIGHT = 2000;
const MAX_TILES = 80;

/**
 * The rectangles to photograph: the first screen, then each top-level section of the page (the `section` elements
 * of `main`, else every `section` with an id, else the parents of the `h2` headings), cut into parts of at most 2,000 px.
 */
export async function tileRects(
    page: BenchPage,
    viewport: { width: number; height: number },
): Promise<{ name: string; y: number; height: number }[]> {
    const page_ = await page.evaluate<{
        total: number;
        sections: { name: string; y: number; height: number }[];
    }>(`(() => {
        const top = (el) => el.getBoundingClientRect().top + window.scrollY;
        let nodes = Array.from(document.querySelectorAll('main > section, [role=main] > section'));
        if (nodes.length === 0) nodes = Array.from(document.querySelectorAll('section[id]')).filter((el) => !el.parentElement.closest('section'));
        if (nodes.length === 0) nodes = Array.from(document.querySelectorAll('h2')).map((h) => h.closest('section, article') ?? h.parentElement);
        const seen = new Set();
        const sections = nodes.filter((el) => el && !seen.has(el) && seen.add(el)).map((el, index) => {
            const heading = el.querySelector('h1,h2,h3,[role=heading]')?.textContent ?? '';
            const label = el.id || heading || 'section-' + (index + 1);
            const rect = el.getBoundingClientRect();
            return { name: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section', y: Math.max(0, Math.floor(top(el))), height: Math.ceil(rect.height) };
        }).filter((item) => item.height > 8);
        return { total: Math.ceil(document.documentElement.scrollHeight), sections };
    })()`);
    const out: { name: string; y: number; height: number }[] = [
        { name: "first-screen", y: 0, height: Math.min(viewport.height, TILE_HEIGHT, page_.total) },
    ];
    const sections =
        page_.sections.length > 0 ? page_.sections : [{ name: "page", y: 0, height: page_.total }];

    for (const section of sections) {
        const parts = Math.max(1, Math.ceil(section.height / TILE_HEIGHT));

        for (let part = 0; part < parts && out.length < MAX_TILES; part++) {
            const y = section.y + part * TILE_HEIGHT;

            out.push({
                name: parts === 1 ? section.name : `${section.name}-part-${part + 1}`,
                y,
                height: Math.min(TILE_HEIGHT, section.y + section.height - y, page_.total - y),
            });
        }
    }

    return out.filter((tile) => tile.height > 0);
}

/** A frame needs this many different colors in its screenshot to count as painted: one flat color is blank. */
export const PAINTED_COLORS = 3;
const FRAME_CLASS = "comp-frame";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Put the page in the scheme through its own switch (so that its frames hear of it), else on `data-theme`. */
async function switchScheme(page: BenchPage, scheme: "light" | "dark"): Promise<void> {
    await page.evaluate(`(() => {
        const theme = ${JSON.stringify(scheme)};
        for (const button of document.querySelectorAll('button[data-theme]')) {
            if (button.getAttribute('data-theme') === theme) { button.click(); return; }
        }
        const select = document.querySelector('.modesel');
        const option = select ? Array.from(select.options).find((item) => item.getAttribute('data-theme') === theme) : undefined;
        if (select && option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); return; }
        document.documentElement.setAttribute('data-theme', theme);
    })()`);
    await pause(400);
}

/** Two frames and a short wait: what painting needs after a scroll. */
async function settle(page: BenchPage): Promise<void> {
    await page.evaluate(
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    await pause(200);
}

/** The vertical extent of each component frame on the page (page coordinates). */
const frameRects = (page: BenchPage) =>
    page.evaluate<{ left: number; top: number; width: number; height: number }[]>(
        `Array.from(document.querySelectorAll('iframe.${FRAME_CLASS}'), (frame) => { const r = frame.getBoundingClientRect(); return { left: Math.max(0, Math.round(r.left)), top: Math.round(r.top + scrollY), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })`,
    );

/** Wait until the frames at `indexes` have a body with text (they load after the page, and only near the viewport). */
async function waitForFrames(page: BenchPage, indexes: number[], limitMs = 6000): Promise<void> {
    const started = Date.now();

    while (indexes.length > 0 && Date.now() - started < limitMs) {
        const texts = await page.frameTexts(FRAME_CLASS);

        if (indexes.every((index) => (texts[index]?.text.length ?? 0) > 0)) {
            return;
        }

        await pause(150);
    }
}

/**
 * Photograph every component frame on its own, in view, and say whether it has text and is not one color. A frame that
 * is outside the viewport is not painted, so the page is scrolled to each frame first.
 */
export async function checkFrames(
    page: BenchPage,
    width: number,
): Promise<NonNullable<DocsShot["frames"]>> {
    const result = { count: 0, withText: 0, painted: 0, blank: [] as string[] };
    const rects = await frameRects(page);

    result.count = rects.length;

    for (const [index, rect] of rects.entries()) {
        await page.evaluate(
            `document.querySelectorAll('iframe.${FRAME_CLASS}')[${index}].scrollIntoView({ block: 'start', behavior: 'instant' })`,
        );
        await waitForFrames(page, [index]);
        await settle(page);

        const texts = await page.frameTexts(FRAME_CLASS);
        const now = (await frameRects(page))[index] ?? rect;
        const title = texts[index]?.title || `frame ${index + 1}`;
        const hasText = (texts[index]?.text.length ?? 0) > 0;
        let painted = false;

        try {
            const top = await page.evaluate<number>(`window.scrollY`);

            painted =
                distinctColors(
                    decodePng(
                        await page.clipInView(
                            now.left,
                            Math.max(top, now.top),
                            Math.max(1, Math.min(now.width, width - now.left)),
                            Math.min(now.height, TILE_HEIGHT - 1),
                        ),
                    ),
                ) >= PAINTED_COLORS;
        } catch {
            painted = false;
        }

        result.withText += hasText ? 1 : 0;
        result.painted += painted ? 1 : 0;

        if (!hasText || !painted) {
            result.blank.push(`${title}${hasText ? " (one color)" : " (no text)"}`);
        }
    }

    return result;
}

export async function docsPhase(
    modules: Modules,
    browser: BenchBrowser | undefined,
    system: DesignSystem | undefined,
    label: string,
    outDir: string,
): Promise<DocsPhase> {
    const phase: DocsPhase = {
        available: modules.doc !== undefined,
        system: label,
        htmlBytes: 0,
        assets: 0,
        shots: [],
        checks: {},
        sections: {},
        score: 0,
    };

    if (modules.doc === undefined) {
        return phase;
    }

    if (system === undefined) {
        phase.error = "There is no system to document.";

        return phase;
    }

    if (browser === undefined) {
        phase.error = "No Chromium to render the page.";

        return phase;
    }

    let doc: ReturnType<NonNullable<Modules["doc"]>>;

    try {
        doc = modules.doc(system);
    } catch (error) {
        phase.error = `renderSystemDoc threw: ${String((error as Error).message).split("\n")[0]}`;

        return phase;
    }

    if (typeof doc?.html !== "string") {
        phase.error = "renderSystemDoc did not return { html, assets }.";

        return phase;
    }

    doc.assets = Array.isArray(doc.assets) ? doc.assets : [];
    phase.htmlBytes = Buffer.byteLength(doc.html);
    phase.assets = doc.assets.length;

    const files = new Map<string, FileEntry>([
        ["index.html", { type: typeOf("index.html"), body: doc.html }],
    ]);

    for (const asset of doc.assets) {
        files.set(asset.name, { type: typeOf(asset.name), body: asset.content });
    }

    const served = await serveFiles(files);
    const shots = join(outDir, "docs");

    mkdirSync(shots, { recursive: true });

    const hashes = new Map<string, string>();
    let text = "";
    let headings: string[] = [];
    let navs = 0;

    try {
        for (const viewport of VIEWPORTS) {
            for (const scheme of ["light", "dark"] as const) {
                const page = await browser.page(served.url);
                const shot: DocsShot = {
                    viewport: viewport.name,
                    scheme,
                    errors: [],
                    external: [],
                    failed: [],
                };

                try {
                    await page.open(served.url, {
                        width: viewport.width,
                        height: viewport.height,
                        colorScheme: scheme,
                    });

                    // The page's own switch, so that its component frames hear of the scheme too.
                    await switchScheme(page, scheme);

                    shot.overflowX =
                        (await page.evaluate<number>(`document.documentElement.scrollWidth`)) >
                        viewport.width;
                    shot.height = await page.evaluate<number>(
                        `document.documentElement.scrollHeight`,
                    );

                    // The whole page is taken only to tell light from dark; the files are tiles (below).
                    const png = await page.screenshot(true);
                    const prefix = `docs-${viewport.name}-${scheme}`;

                    const save = async (name: string, bytes: Buffer) => {
                        const file = `${prefix}-${String(shot.tiles!.length).padStart(2, "0")}-${name}.png`;

                        writeFileSync(join(shots, file), bytes);
                        shot.tiles!.push(join("docs", file));
                    };

                    shot.tiles = [];

                    // The first screen, at the size of the screen.
                    await save(
                        "first-screen",
                        await page.clipInView(0, 0, viewport.width, viewport.height),
                    );

                    // The rest as tiles of at most 2,000 px. A frame outside the viewport is not painted, so the viewport is
                    // made as tall as a tile, each tile is scrolled to the top of it, and the frames in it are waited for.
                    await page.resize(viewport.width, TILE_HEIGHT);
                    await page.evaluate(
                        `document.querySelectorAll('*').forEach((el) => { if (getComputedStyle(el).position === 'sticky') el.style.position = 'relative'; })`,
                    );
                    await settle(page);

                    const rects = await frameRects(page);

                    for (const tile of (await tileRects(page, viewport)).slice(1)) {
                        await page.evaluate(
                            `window.scrollTo({ top: ${tile.y}, left: 0, behavior: 'instant' })`,
                        );
                        await waitForFrames(
                            page,
                            rects.flatMap((rect, index) =>
                                rect.top < tile.y + tile.height && rect.top + rect.height > tile.y
                                    ? [index]
                                    : [],
                            ),
                        );
                        await settle(page);
                        await save(
                            tile.name,
                            await page.clipInView(0, tile.y, viewport.width, tile.height),
                        );
                    }

                    shot.frames = await checkFrames(page, viewport.width);
                    shot.file = shot.tiles[0];
                    hashes.set(
                        `${viewport.name}-${scheme}`,
                        `${png.length}:${png.subarray(0, 4096).toString("base64").slice(0, 64)}:${png.subarray(png.length >> 1, (png.length >> 1) + 512).toString("base64")}`,
                    );

                    if (viewport.name === "desktop" && scheme === "light") {
                        const read = await page.evaluate<{
                            text: string;
                            headings: string[];
                            navs: number;
                        }>(
                            `({ text: document.body.innerText.slice(0, 20000), headings: Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]'), h => h.textContent.trim()).slice(0, 200), navs: document.querySelectorAll('nav,[role=navigation]').length })`,
                        );

                        ({ text, headings, navs } = read);
                    }
                } catch (error) {
                    shot.errors.push(String((error as Error).message).split("\n")[0]!);
                }

                shot.errors.push(...page.errors.slice(0, 5));
                shot.external = page.external.slice(0, 5);
                shot.failed = page.failed.slice(0, 5);
                phase.shots.push(shot);
                await page.close();
            }
        }
    } finally {
        await served.close();
    }

    const rendered = phase.shots.every((shot) => shot.file !== undefined);

    for (const [name, pattern] of Object.entries(SECTIONS)) {
        phase.sections[name] = headings.some((heading) => pattern.test(heading));
    }

    const sectionRate =
        Object.values(phase.sections).filter(Boolean).length / Object.keys(SECTIONS).length;

    // Every component of the system has a frame, and every frame has a body with text and is not one flat color.
    const expectedFrames = system.components.length;
    const frames = (
        ok: (shot: DocsShot & { frames: NonNullable<DocsShot["frames"]> }) => boolean,
    ) =>
        rendered &&
        phase.shots.every(
            (shot) =>
                shot.frames !== undefined &&
                shot.frames.count >= expectedFrames &&
                ok(shot as DocsShot & { frames: NonNullable<DocsShot["frames"]> }),
        );

    phase.checks = {
        rendered,
        noScriptErrors: rendered && phase.shots.every((shot) => shot.errors.length === 0),
        selfContained:
            rendered &&
            phase.shots.every((shot) => shot.external.length === 0 && shot.failed.length === 0),
        noHorizontalScrollOnPhone: phase.shots
            .filter((shot) => shot.viewport === "mobile")
            .every((shot) => shot.file !== undefined && shot.overflowX === false),
        darkDiffersFromLight: ["mobile", "desktop"].every(
            (name) =>
                hashes.get(`${name}-light`) !== undefined &&
                hashes.get(`${name}-light`) !== hashes.get(`${name}-dark`),
        ),
        hasNavigation: navs > 0,
        isSubstantial:
            text.length > 1500 &&
            phase.shots.some((shot) => shot.viewport === "desktop" && (shot.height ?? 0) > 1800),
        componentFramesHaveText: frames((shot) => shot.frames.withText === shot.frames.count),
        componentFramesPainted: frames((shot) => shot.frames.painted === shot.frames.count),
        namesTokens:
            system.tokens
                .slice(0, 40)
                .filter((token) => text.includes(token.cssVar) || text.includes(token.name))
                .length >= 5,
    };

    const checks = Object.values(phase.checks);

    phase.score =
        Math.round(
            ((checks.filter(Boolean).length + sectionRate * 3) / (checks.length + 3)) * 1000,
        ) / 1000;

    return phase;
}
