/**
 * Phases 4 and 5 — contrast of the declared pairs in every mode, and the documentation page: rendered at 390×844 and
 * 1440×900 in light and dark (the PNGs go to `--out` for the judges), with checks that a person would make by eye.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignSystem } from "../../../src/server/design/system-types.ts";
import { BenchBrowser, serveFiles, typeOf, type FileEntry } from "./chromium.ts";
import type { Modules } from "./modules.ts";
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
            implied: { pairs: 0, passing: 0, passRate: 0 },
            score: 0,
        };
    }

    const pairs = contrastPairs(system.tokens, system.modes);
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
                ratios: Object.fromEntries(
                    Object.entries(pair.ratios).map(([mode, ratio]) => [
                        mode,
                        ratio === undefined ? undefined : Math.round(ratio * 100) / 100,
                    ]),
                ),
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
    file?: string;
    height?: number;
    /** Wider than the viewport: a horizontal scroll. */
    overflowX?: boolean;
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

                    // A page with its own switch reads `data-theme`; one that follows the system already has the scheme.
                    await page.evaluate(
                        `document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)})`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, 150));

                    shot.overflowX =
                        (await page.evaluate<number>(`document.documentElement.scrollWidth`)) >
                        viewport.width;
                    shot.height = await page.evaluate<number>(
                        `document.documentElement.scrollHeight`,
                    );

                    const png = await page.screenshot(true);
                    const file = `docs-${viewport.name}-${scheme}.png`;

                    writeFileSync(join(shots, file), png);
                    shot.file = join("docs", file);
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
