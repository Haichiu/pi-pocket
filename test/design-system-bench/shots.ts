/**
 * Screenshots of the design system view, for judges, and a check that every tab shows what it should.
 *
 *   node test/design-system-bench/shots.ts <out-dir> [--only harbor|flagship] [--port 8915] [--host 127.0.0.15]
 *   node test/design-system-bench/run.ts --shots [--out dir]        (the same, in the bench's report and folder)
 *
 * It starts a throwaway Pi Pocket (`test/serve-design-system.ts` of this checkout) and its own headless Chromium, saves
 * PNGs, and stops both. The first run uses the small test system (Harbor); the second swaps the flagship into the
 * session's folder and prefixes its files with `flagship-`. For every tab, at the desktop and the phone size, it
 * **asserts that the tab shows its tokens**: a token row, tile, or step for the token tabs, a card for each component, the
 * rendered Markdown for the guidelines. A tab that shows nothing (or an empty state while the system has tokens of that
 * kind) is a failure in the report, with the reason. One failed shot is logged and the run goes on.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Chromium } from "../../src/server/browser/cdp.ts";
import { findBrowser } from "../../src/server/browser/discovery.ts";
import { ROOT } from "./lib/modules.ts";
import { readFlat } from "./lib/system.ts";

export type Variant = "harbor" | "flagship";

/** What one tab showed. */
export interface TabResult {
    system: Variant;
    size: "desktop" | "phone";
    tab: string;
    /** The PNG, relative to the output folder. */
    file?: string;
    /** Token rows, tiles, or steps that were visible. */
    tokens: number;
    /** Component cards that were visible (the Components tab). */
    components: number;
    /** Visible Markdown elements (the Guidelines tab). */
    prose: number;
    /** How many tokens (or components) the system has of the kind that the tab shows. */
    expected: number;
    ok: boolean;
    reason?: string;
}

export interface ShotsReport {
    /** The folder with the PNGs. */
    folder: string;
    saved: string[];
    failed: string[];
    tabs: TabResult[];
    /** True when nothing failed and every tab showed its tokens. */
    ok: boolean;
}

export interface ShotsOptions {
    /** The checkout that holds `test/serve-design-system.ts` and `docs/examples/design-system/pocket`. Default: this one. */
    tree?: string;
    out: string;
    only?: Variant;
    port?: number;
    host?: string;
    log?: (line: string) => void;
}

const SLOW = 30_000;
const TABS = [
    "Colors",
    "Type",
    "Spacing",
    "Radii",
    "Shadows",
    "Motion",
    "Components",
    "Guidelines",
] as const;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const q = JSON.stringify;

// ─── The copy of Pi Pocket ──────────────────────────────────────────────────────

interface Copy {
    child: ChildProcess;
    root: string;
    owner: string;
    session: string;
    pid: number;
}

async function startCopy(tree: string, host: string, port: number): Promise<Copy> {
    const child = spawn("node", ["test/serve-design-system.ts", String(port), host], {
        cwd: tree,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (out += chunk));
    child.stderr!.on("data", (chunk: string) => (out += chunk));

    const started = Date.now();

    while (!/kill (\d+)/.test(out)) {
        if (Date.now() - started > 120_000) {
            child.kill("SIGTERM");

            throw new Error(`The copy did not start in time.\n${out.slice(-1500)}`);
        }

        if (child.exitCode !== null) {
            throw new Error(`The copy exited (${child.exitCode}).\n${out.slice(-1500)}`);
        }

        await sleep(200);
    }

    return {
        child,
        root: /data in (\S+)/.exec(out)![1]!,
        owner: /owner:\s+(\S+)/.exec(out)![1]!,
        session: /session:\s+(\S+)/.exec(out)![1]!,
        pid: Number(/kill (\d+)/.exec(out)![1]),
    };
}

async function stopCopy(copy: Copy) {
    if (copy.child.exitCode !== null) {
        return;
    }

    const done = new Promise<void>((resolveExit) => copy.child.once("exit", () => resolveExit()));

    try {
        process.kill(copy.pid, "SIGTERM");
    } catch {
        // Already gone.
    }

    await Promise.race([done, sleep(15_000)]);

    if (copy.child.exitCode === null) {
        copy.child.kill("SIGKILL");
    }
}

/** The system's source folder inside the copy's session folder. */
const designDir = (copy: Copy) => join(copy.root, "work", ".pi", "design");

/** The flagship, in the place where `serve-design-system.ts` wrote Harbor. */
function swapInFlagship(tree: string, copy: Copy) {
    rmSync(designDir(copy), { recursive: true, force: true });
    cpSync(join(tree, "docs/examples/design-system/pocket/.pi/design"), designDir(copy), {
        recursive: true,
    });
}

/** How many tokens of each kind the system has, from its own files and the bench's own reader. */
function expectedCounts(copy: Copy): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(TABS.map((tab) => [tab, 0]));

    try {
        const flat = readFlat(designDir(copy));

        for (const token of flat.tokens) {
            const words = token.name.toLowerCase().split(/[.\-_]/);
            const any = (list: string[]) => list.some((word) => words.includes(word));

            if (token.type === "color") {
                counts.Colors!++;
            } else if (token.type === "shadow") {
                counts.Shadows!++;
            } else if (["duration", "cubicBezier", "transition"].includes(token.type)) {
                counts.Motion!++;
            } else if (token.type === "dimension" && any(["radius", "radii"])) {
                counts.Radii!++;
            } else if (token.type === "dimension" && any(["space", "spacing"])) {
                counts.Spacing!++;
            } else if (
                ["fontFamily", "fontWeight", "typography"].includes(token.type) ||
                (token.type === "dimension" && any(["font", "text"]))
            ) {
                counts.Type!++;
            }
        }
    } catch {
        // No readable tokens: every count stays 0 and an empty tab is fine.
    }

    const components = join(designDir(copy), "components");

    counts.Components = existsSync(components)
        ? readdirSync(components).filter((file) => file.endsWith(".html")).length
        : 0;
    counts.Guidelines = existsSync(join(designDir(copy), "guidelines.md")) ? 1 : 0;

    return counts;
}

// ─── Chromium ───────────────────────────────────────────────────────────────────

interface Size {
    name: "desktop" | "phone";
    width: number;
    height: number;
    mobile: boolean;
    scale: number;
}

const SIZES: Size[] = [
    { name: "desktop", width: 1440, height: 900, mobile: false, scale: 1 },
    { name: "phone", width: 390, height: 844, mobile: true, scale: 2 },
];

interface Page {
    send: (method: string, params?: Record<string, unknown>, timeout?: number) => Promise<any>;
    ev: <T>(script: string) => Promise<T>;
    close: () => Promise<void>;
}

async function openPage(chromium: Chromium): Promise<Page> {
    const conn = chromium.connection;
    const { browserContextId } = await conn.send("Target.createBrowserContext");
    const { targetId } = await conn.send("Target.createTarget", {
        url: "about:blank",
        browserContextId,
    });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params: Record<string, unknown> = {}, timeout = 30_000) =>
        conn.send(method, params, sessionId, timeout);

    await send("Page.enable");
    await send("Runtime.enable");
    // The app's own dark theme follows the system's; motion is off so nothing is caught mid-way.
    await send("Emulation.setEmulatedMedia", {
        features: [
            { name: "prefers-color-scheme", value: "dark" },
            { name: "prefers-reduced-motion", value: "reduce" },
        ],
    });

    return {
        send,
        async ev<T>(script: string): Promise<T> {
            const answer = await send("Runtime.evaluate", {
                expression: `(async () => {\n${script}\n})()`,
                returnByValue: true,
                awaitPromise: true,
                userGesture: true,
            });

            if (answer.exceptionDetails) {
                throw new Error(
                    answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text,
                );
            }

            return answer.result.value as T;
        },
        async close() {
            await conn.send("Target.closeTarget", { targetId }).catch(() => {});
            await conn.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        },
    };
}

async function setSize(chromium: Chromium, page: Page, size: Size) {
    await page.send("Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor: size.scale,
        mobile: size.mobile,
    });
    await page.send("Emulation.setTouchEmulationEnabled", {
        enabled: size.mobile,
        maxTouchPoints: size.mobile ? 5 : 1,
    });

    if (size.mobile) {
        const version = await chromium.connection.send("Browser.getVersion");

        await page.send("Emulation.setUserAgentOverride", {
            userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${/Chrome\/([\d.]+)/.exec(version.userAgent)?.[1] ?? "130.0.0.0"} Mobile Safari/537.36`,
        });
    } else {
        await page.send("Emulation.setUserAgentOverride", { userAgent: chromium.userAgent });
    }
}

// ─── Page helpers ───────────────────────────────────────────────────────────────

async function waitFor<T = unknown>(
    page: Page,
    what: string,
    script: string,
    limit = SLOW,
): Promise<T> {
    const started = Date.now();
    let last = "";

    while (Date.now() - started < limit) {
        try {
            const value = JSON.parse((await page.ev<string>(script)) ?? "null");

            if (value !== null && value !== false && value !== undefined) {
                return value as T;
            }
        } catch (error) {
            last = (error as Error).message;
        }

        await sleep(100);
    }

    throw new Error(`Timed out waiting for ${what}${last ? ` (${last})` : ""}`);
}

/** A DOM click on the first element that matches (and has `text`). */
async function press(page: Page, selector: string, text?: string) {
    const answer = await page.ev<string>(`
        const matches = [...document.querySelectorAll(${q(selector)})].filter(
            (each) => ${text === undefined ? "true" : `each.textContent.includes(${q(text)})`},
        );
        if (matches.length === 0) { return "none"; }
        matches[0].click();
        return "ok";
    `);

    if (answer !== "ok") {
        throw new Error(`No ${selector}${text ? ` with "${text}"` : ""} to press`);
    }
}

const has = (selector: string) =>
    `return JSON.stringify(Boolean(document.querySelector(${q(selector)})))`;

/** Let fonts and layout settle: two frames, and the fonts. */
async function settle(page: Page) {
    await page.ev(`
        await document.fonts.ready;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return "null";
    `);
    await sleep(250);
}

/** The Design panel's box, in CSS pixels: the whole panel with its header, not the page around it. */
async function panelBox(page: Page) {
    return page.ev<{ x: number; y: number; width: number; height: number }>(`
        const inner = document.querySelector(".dsn, .dsy-main, .dsy-empty-system");
        const panel = inner?.closest(".ext-panel, aside, [role=dialog], .panel, .sheet") ?? inner?.parentElement;
        const rect = (panel ?? document.documentElement).getBoundingClientRect();
        const x = Math.max(0, Math.floor(rect.left));
        const y = Math.max(0, Math.floor(rect.top));
        return {
            x,
            y,
            width: Math.min(innerWidth - x, Math.ceil(rect.width)),
            height: Math.min(innerHeight - y, Math.ceil(rect.height)),
        };
    `);
}

async function openSession(page: Page, base: string, session: string) {
    await page.send("Page.navigate", { url: `${base}${new URL(session).pathname}` });
    await waitFor(
        page,
        "the session",
        `const { store } = await import("/store.js");
        return JSON.stringify(Boolean(store.state.view.conversation) && Boolean(document.querySelector(".composer textarea")))`,
    );
}

async function openDesign(page: Page) {
    await page.ev(`
        const { openExtPanel } = await import("/extension-ui.js");
        openExtPanel("design", "design");
        return "null";
    `);
    await waitFor(page, "the workspace", has(".dsn-bar, .dsy-empty-system, .dsy-main"));
}

/** The System view, open, through the picker's pinned "Design system" item. */
async function openSystem(page: Page) {
    if (!(await page.ev<boolean>(`return Boolean(document.querySelector(".dsy-main"))`))) {
        await press(page, ".dsn-picker");
        await waitFor(page, "the picker", has(".dsy-pinned"));
        await press(page, ".dsy-pinned");
    }

    await waitFor(
        page,
        "the system",
        `return JSON.stringify(Boolean(document.querySelector(".dsy-scroll")) && !document.querySelector(".dsy-scroll .loader") && Boolean(document.querySelector(".dsy-rows, .dsy-tabs")))`,
    );

    if (await page.ev<boolean>(`return document.querySelectorAll(".dsy-savebar").length > 0`)) {
        await press(page, ".dsy-savebar button", "Discard");
    }
}

/** Open a tab and wait until it has stopped loading. Throws when the tab is not offered. */
async function section(page: Page, name: string) {
    await press(page, ".dsy-tabs [role=tab]", name);
    await waitFor(
        page,
        `the ${name} section`,
        `return JSON.stringify(Boolean(document.querySelector(".dsy-tabs [role=tab].on")?.textContent.includes(${q(name)})) && Boolean(document.querySelector(".dsy-scroll > *:not(.loader), .dsy-scroll .dsy-rows")))`,
    );
    await waitFor(
        page,
        `content in ${name}`,
        `const scroll = document.querySelector(".dsy-scroll"); return JSON.stringify(Boolean(scroll) && !scroll.querySelector(".loader") && (scroll.innerText?.trim().length ?? 0) > 0)`,
    );
    await page.ev(`document.querySelector(".dsy-scroll")?.scrollTo(0, 0); return "null"`);
}

/** What the open tab shows: visible token rows, tiles and steps; component cards; rendered Markdown; an empty state. */
async function census(page: Page) {
    return page.ev<Census>(`
        const scroll = document.querySelector(".dsy-scroll");
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest(".dsy-editor, .dsy-ramp-editor"); };
        const count = (selector) => scroll ? [...scroll.querySelectorAll(selector)].filter(visible).length : 0;
        return {
            tokens: count("[data-token]"),
            components: count(".dsy-component"),
            prose: count(".dsy-prose h1, .dsy-prose h2, .dsy-prose h3, .dsy-prose h4, .dsy-prose p, .dsy-prose li"),
            blank: Boolean(scroll?.querySelector(".dsy-blank")),
        };
    `);
}

/** Put the mode switch on `which`: a button by its label, or the select of a system with many modes. */
async function mode(page: Page, which: "Light" | "Dark" | "Both") {
    const labels = which === "Both" ? ["Both", "All", "Side by side"] : [which];
    const answer = await page.ev<string>(`
        const labels = ${q(labels)};
        for (const button of document.querySelectorAll(".dsy-modes button")) {
            if (labels.includes(button.getAttribute("aria-label"))) { button.click(); return "ok"; }
        }
        const select = document.querySelector(".dsy-modeselect");
        if (select) {
            const option = [...select.options].find((each) => labels.includes(each.textContent.trim()) || each.value === ${q(which.toLowerCase())});
            if (option) {
                const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
                set.call(select, option.value);
                select.dispatchEvent(new Event("change", { bubbles: true }));
                return "ok";
            }
        }
        return "none";
    `);

    if (answer !== "ok") {
        throw new Error(`No mode switch for ${which}`);
    }

    await waitFor(
        page,
        `${which} mode`,
        `
        const on = document.querySelector(".dsy-modes button.on, .dsy-modeselect");
        if (!on) { return JSON.stringify(false); }
        if (on.tagName === "SELECT") { return JSON.stringify(true); }
        const labels = ${q(which === "Both" ? ["Both", "All"] : [which])};
        return JSON.stringify(labels.includes(on.getAttribute("aria-label")));
    `,
    );
}

async function focusMode(page: Page, on: boolean) {
    const now = await page.ev<boolean>(
        `return document.documentElement.hasAttribute("data-dsn-focus")`,
    );

    if (now !== on) {
        await press(
            page,
            `.dsn-bars button[aria-label="${on ? "Hide" : "Show"} the conversation"]`,
        );
        await waitFor(
            page,
            "focus",
            `return JSON.stringify(document.documentElement.hasAttribute("data-dsn-focus") === ${on})`,
        );
    }
}

// ─── One run: one system, both sizes ────────────────────────────────────────────

async function run(
    chromium: Chromium,
    out: string,
    variant: Variant,
    copy: Copy,
    base: string,
    report: ShotsReport,
    log: (line: string) => void,
) {
    const prefix = variant === "flagship" ? "flagship-" : "";
    const page = await openPage(chromium);
    const counts = expectedCounts(copy);

    /** Save a PNG of the Design panel. */
    async function shoot(
        size: Size,
        name: string,
        take: () => Promise<void>,
    ): Promise<string | undefined> {
        const file = `${variant}-${size.name}-${name}.png`;

        try {
            await take();
            await settle(page);
            const box = await panelBox(page);
            const shot = await page.send("Page.captureScreenshot", {
                format: "png",
                clip: { ...box, scale: 1 },
            });

            writeFileSync(join(out, file), Buffer.from(shot.data as string, "base64"));
            report.saved.push(file);
            log(`ok    ${file}`);

            return file;
        } catch (error) {
            report.failed.push(file);
            log(`FAIL  ${file}: ${(error as Error).message.split("\n")[0]}`);

            return undefined;
        }
    }

    try {
        await page.send("Page.navigate", {
            url: `${base}/login?token=${new URL(copy.owner).searchParams.get("token")}`,
        });
        await sleep(500);

        for (const size of SIZES) {
            log(`--- ${prefix || "harbor-"}${size.name}`);
            await setSize(chromium, page, size);

            try {
                await openSession(page, base, copy.session);
                await openDesign(page);
                await openSystem(page);
                await mode(page, "Light").catch(() => {});
            } catch (error) {
                report.failed.push(`${variant}-${size.name}-*`);
                log(
                    `FAIL  ${variant}-${size.name} setup: ${(error as Error).message.split("\n")[0]}`,
                );

                for (const tab of TABS) {
                    report.tabs.push({
                        system: variant,
                        size: size.name,
                        tab,
                        tokens: 0,
                        components: 0,
                        prose: 0,
                        expected: counts[tab]!,
                        ok: false,
                        reason: "the System view did not open",
                    });
                }

                continue;
            }

            for (const tab of TABS) {
                const result: TabResult = {
                    system: variant,
                    size: size.name,
                    tab,
                    tokens: 0,
                    components: 0,
                    prose: 0,
                    expected: counts[tab]!,
                    ok: false,
                };

                result.file = await shoot(size, `system-${tab.toLowerCase()}`, async () => {
                    await openSystem(page);
                    await section(page, tab);

                    const seen = await census(page);

                    result.tokens = seen.tokens;
                    result.components = seen.components;
                    result.prose = seen.prose;

                    // The assertion: the tab shows what the system has, not some text.
                    result.reason = judgeTab(tab, result.expected, seen);
                    result.ok = result.reason === undefined;
                });

                if (result.file === undefined) {
                    result.reason = result.reason ?? "the tab could not be opened";
                    result.ok = false;
                }

                if (!result.ok) {
                    log(`FAIL  ${variant}-${size.name}-${tab}: ${result.reason}`);
                }

                report.tabs.push(result);
            }

            await shoot(size, "system-mode-dark", async () => {
                await openSystem(page);
                await section(page, "Colors");
                await mode(page, "Dark");
            });
            await shoot(size, "system-mode-both", async () => {
                await mode(page, "Both");
            });
            await mode(page, "Light").catch(() => {});

            await shoot(size, "system-editor", async () => {
                await openSystem(page);
                await section(page, "Colors");
                await mode(page, "Both").catch(() => {});
                const name = await page.ev<string>(`
                    const wanted = document.querySelector('[data-token="color.accent.default"]');
                    const row = wanted ?? document.querySelector('[data-token^="color."]');
                    return row?.getAttribute("data-token") ?? "";
                `);

                if (!name) {
                    throw new Error("no color token row");
                }

                await press(
                    page,
                    `[data-token="${name}"] .dsy-row-main, button[data-token="${name}"]`,
                );
                await waitFor(page, "the editor", has(".dsy-editor"));
                await page.ev(
                    `document.querySelector(".dsy-editor")?.scrollIntoView({ block: "center" }); return "null";`,
                );
            });
            await mode(page, "Light").catch(() => {});

            if (!size.mobile) {
                await shoot(size, "system-focus", async () => {
                    await openSystem(page);
                    await section(page, "Colors");
                    await focusMode(page, true);
                    await waitFor(
                        page,
                        "the open design beside the view",
                        `return JSON.stringify(Boolean(document.querySelector(".dsy-preview .dsn-frame, .dsy-preview iframe")))`,
                    );
                    await sleep(1500);
                });
                await focusMode(page, false).catch(() => {});
            }

            await shoot(size, "check", async () => {
                await openDesign(page);
                await press(page, ".dsn-picker");
                await waitFor(page, "the picker", has(".dsn-list"));
                await press(page, ".dsn-list-item", "Ferry booking");
                await waitFor(
                    page,
                    "Ferry booking open",
                    `return JSON.stringify(document.querySelector(".dsn-picker-title")?.textContent === "Ferry booking")`,
                );
                await press(page, '.dsn-tabs button[title="Check"]');
                await waitFor(page, "the check dock", has('.dsn-dock[data-dock="check"]'));
                // "Run the check", or "Check again" when the dock already holds a report.
                await waitFor(page, "the check button", has(".dsy-check-foot button"));
                await press(page, ".dsy-check-foot button:last-child");
                await waitFor(page, "the report", has(".dsy-check-summary"), 60_000);
                await waitFor(
                    page,
                    "the findings",
                    `return JSON.stringify(document.querySelectorAll(".dsy-finding").length > 0 || Boolean(document.querySelector(".dsy-check-summary")))`,
                );
            });
        }
    } finally {
        await page.close();
    }
}

/** What a tab showed: see `census`. */
export interface Census {
    tokens: number;
    components: number;
    prose: number;
    /** An empty-state panel was on screen. */
    blank: boolean;
}

/**
 * Whether a tab shows what the system has, by what was rendered and not by how much text there is. `expected` is how many
 * tokens (or components) the system has of the kind that the tab shows. Returns why not, or `undefined` when it does.
 */
export function judgeTab(tab: string, expected: number, seen: Census): string | undefined {
    const shown =
        tab === "Components" ? seen.components : tab === "Guidelines" ? seen.prose : seen.tokens;
    const what =
        tab === "Components"
            ? "component card"
            : tab === "Guidelines"
              ? "rendered guideline"
              : "token row or tile";

    if (expected > 0 && shown === 0) {
        return `the tab shows no ${what}${seen.blank ? " (an empty state)" : ""}, and the system has ${expected}`;
    }

    if (tab === "Components" && expected > 0 && shown < expected) {
        return `the tab shows ${shown} of ${expected} component cards`;
    }

    if (expected === 0 && shown === 0 && !seen.blank) {
        return "the tab shows nothing at all, not even an empty state";
    }

    return undefined;
}

/** Take the screenshots and make the report. Never throws: a failure is in the report. */
export async function runShots(options: ShotsOptions): Promise<ShotsReport> {
    const tree = resolve(options.tree ?? ROOT);
    const host = options.host ?? "127.0.0.15";
    const port = options.port ?? 8915;
    const log = options.log ?? (() => {});
    const folder = resolve(options.out);
    const report: ShotsReport = { folder, saved: [], failed: [], tabs: [], ok: false };

    mkdirSync(folder, { recursive: true });

    const executable = findBrowser();

    if (executable === undefined) {
        report.failed.push("No Chromium-based browser on this machine.");

        return report;
    }

    const profileRoot = mkdtempSync(join(tmpdir(), "pocket-bench-shots-"));
    const chromium = await Chromium.launch(executable, join(profileRoot, "profile"), []).catch(
        (error: Error) => {
            report.failed.push(`Chromium did not start: ${error.message.split("\n")[0]}`);

            return undefined;
        },
    );

    if (chromium === undefined) {
        rmSync(profileRoot, { recursive: true, force: true });

        return report;
    }

    let current: Copy | undefined;

    try {
        for (const variant of ["harbor", "flagship"] as const) {
            if (options.only !== undefined && options.only !== variant) {
                continue;
            }

            log(`=== ${variant}`);

            try {
                current = await startCopy(tree, host, port);

                if (variant === "flagship") {
                    swapInFlagship(tree, current);
                }

                await run(
                    chromium,
                    folder,
                    variant,
                    current,
                    `http://${host}:${port}`,
                    report,
                    log,
                );
            } catch (error) {
                report.failed.push(`${variant}: ${(error as Error).message.split("\n")[0]}`);
                log(`FAIL  ${variant}: ${(error as Error).message}`);
            } finally {
                if (current !== undefined) {
                    await stopCopy(current);
                    current = undefined;
                }
            }
        }
    } finally {
        chromium.kill();
        await chromium.exited;
        rmSync(profileRoot, { recursive: true, force: true });
    }

    report.ok =
        report.failed.length === 0 && report.tabs.length > 0 && report.tabs.every((tab) => tab.ok);

    return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const value = (flag: string) =>
        args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const out = args.find(
        (each, index) =>
            !each.startsWith("--") &&
            !["--only", "--port", "--host"].includes(args[index - 1] ?? ""),
    );

    if (out === undefined) {
        console.error(
            "usage: node test/design-system-bench/shots.ts <out-dir> [--only harbor|flagship] [--port 8915] [--host 127.0.0.15]",
        );
        process.exit(2);
    }

    const report = await runShots({
        out,
        only: value("--only") as Variant | undefined,
        port: value("--port") === undefined ? undefined : Number(value("--port")),
        host: value("--host"),
        log: (line) => console.error(line),
    });

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
}
