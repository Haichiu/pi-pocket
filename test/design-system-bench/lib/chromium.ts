/**
 * A small headless Chromium for the bench: its own process and profile (never the shared browser people watch), a local
 * server for a bundle of files, and pages with a size, a color scheme, screenshots and `evaluate`. It uses only
 * `src/server/browser/` (discovery and the DevTools pipe), so a change in the design renderer cannot break it.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chromium, type Json } from "../../../src/server/browser/cdp.ts";
import { findBrowser, profileFolder } from "../../../src/server/browser/discovery.ts";

export interface FileEntry {
    type: string;
    body: string | Buffer;
}

export interface Served {
    /** The address of the root, ending in `/`. */
    url: string;
    close(): Promise<void>;
}

const TYPES: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    woff2: "font/woff2",
};

/** The content type for a file name (an unknown extension is plain bytes). */
export const typeOf = (name: string) =>
    TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";

/** Serve some files on a loopback port, under a random path, until closed. */
export async function serveFiles(files: Map<string, FileEntry>): Promise<Served> {
    const prefix = `/${randomBytes(16).toString("hex")}/`;
    const server: Server = createServer((request, response) => {
        const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
        const name = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
        const file = name === undefined ? undefined : files.get(name === "" ? "index.html" : name);

        if (file === undefined) {
            response.writeHead(404).end();

            return;
        }

        response.writeHead(200, {
            "content-type": file.type,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        });
        response.end(file.body);
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
        throw new Error("The bench server did not start.");
    }

    return {
        url: `http://127.0.0.1:${address.port}${prefix}`,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

export interface PageOptions {
    width: number;
    height: number;
    colorScheme?: "light" | "dark";
}

/** One page in its own browser context. */
export class BenchPage {
    readonly errors: string[] = [];
    /** Requests that left the loopback server. They are all refused: a design system page must be self-contained. */
    readonly external: string[] = [];
    readonly failed: string[] = [];
    readonly #browser: Chromium;
    readonly #session: string;
    readonly #context: string;
    readonly #origin: string;
    /** The DevTools session of each frame that runs in a process of its own, by frame id. */
    readonly #frames = new Map<string, string>();

    constructor(browser: Chromium, session: string, context: string, origin: string) {
        this.#browser = browser;
        this.#session = session;
        this.#context = context;
        this.#origin = origin;
        browser.connection.listen(session, (method, params) => this.#event(method, params));
    }

    #event(method: string, params: Json, session = this.#session): void {
        if (method === "Fetch.requestPaused") {
            const url = String(params.request.url);
            const favicon = /\/favicon\.ico$/.test(url);
            const allowed =
                url.startsWith(this.#origin) ||
                url.startsWith("data:") ||
                url.startsWith("blob:") ||
                url.startsWith("about:");

            if (!allowed && !favicon) {
                this.external.push(url.slice(0, 200));
            }

            // The answer goes to the session that asked: the page, or a frame that runs in a process of its own.
            const reply = (name: string, body: Record<string, unknown>) =>
                this.#browser.connection.send(name, body, session, 20_000);
            const action = allowed
                ? reply("Fetch.continueRequest", { requestId: params.requestId })
                : reply("Fetch.failRequest", {
                      requestId: params.requestId,
                      errorReason: "BlockedByClient",
                  });

            action.catch(() => {});
        } else if (method === "Target.attachedToTarget") {
            // A sandboxed frame has no page to share with its parent: it comes as a target of its own.
            const child = String(params.sessionId);

            this.#frames.set(String(params.targetInfo?.targetId), child);
            // The frame is held to the same rule as the page: no address but the bench's own.
            this.#browser.connection.listen(child, (name, body) => this.#event(name, body, child));
            this.#browser.connection
                .send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child, 5000)
                .catch(() => {});
            this.#browser.connection
                .send("Runtime.runIfWaitingForDebugger", {}, child, 5000)
                .catch(() => {});
        } else if (method === "Target.detachedFromTarget") {
            for (const [id, session] of this.#frames) {
                if (session === params.sessionId) {
                    this.#frames.delete(id);
                }
            }
        } else if (method === "Runtime.exceptionThrown") {
            this.errors.push(
                String(
                    params.exceptionDetails?.exception?.description ??
                        params.exceptionDetails?.text,
                ).slice(0, 500),
            );
        } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
            this.errors.push(
                (params.args ?? [])
                    .map((arg: Json) => String(arg.value ?? arg.description ?? arg.type))
                    .join(" ")
                    .slice(0, 500),
            );
        } else if (method === "Network.responseReceived" && params.response?.status >= 400) {
            this.failed.push(
                `${params.response.status} ${String(params.response.url).slice(0, 200)}`,
            );
        }
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<Json> {
        return this.#browser.connection.send(method, params, this.#session, 20_000);
    }

    async evaluate<T = unknown>(expression: string): Promise<T> {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: 15_000,
        });

        if (result.exceptionDetails !== undefined) {
            throw new Error(
                String(result.exceptionDetails.exception?.description ?? "The page script failed."),
            );
        }

        return result.result?.value as T;
    }

    /** Set the size and the preferred color scheme, then load the address and wait until it is settled. */
    async open(url: string, options: PageOptions): Promise<void> {
        await this.send("Emulation.setDeviceMetricsOverride", {
            width: options.width,
            height: options.height,
            deviceScaleFactor: 1,
            mobile: options.width < 500,
        });
        await this.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: options.colorScheme ?? "light" }],
        });
        const result = await this.send("Page.navigate", { url });

        if (result.errorText) {
            throw new Error(String(result.errorText));
        }

        for (let attempt = 0; attempt < 60; attempt++) {
            if ((await this.evaluate("document.readyState")) === "complete") {
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        await this.evaluate(
            `Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 2000))]).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`,
        );
    }

    /** A PNG of the page: the viewport, or the whole page up to `maxHeight`. */
    async screenshot(fullPage: boolean, maxHeight = 12_000): Promise<Buffer> {
        let clip: Record<string, number> | undefined;

        if (fullPage) {
            const metrics = await this.send("Page.getLayoutMetrics");
            const size = metrics.cssContentSize ?? metrics.contentSize;

            clip = {
                x: 0,
                y: 0,
                width: Math.ceil(size.width),
                height: Math.min(maxHeight, Math.ceil(size.height)),
                scale: 1,
            };
        }

        const result = await this.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: fullPage,
            ...(clip === undefined ? {} : { clip }),
        });

        return Buffer.from(String(result.data), "base64");
    }

    /** A PNG of one rectangle of the page (CSS pixels from the top left of the page), at scale 1. */
    async clip(x: number, y: number, width: number, height: number): Promise<Buffer> {
        const result = await this.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { x, y, width, height, scale: 1 },
        });

        return Buffer.from(String(result.data), "base64");
    }

    /**
     * A PNG of one rectangle of the page (CSS pixels, from the page's top left), taken from what is **on screen**. A frame
     * (an `iframe`, above all a sandboxed one) that is outside the viewport is not painted, so `clip` shows it blank: scroll
     * the rectangle into the viewport first, and make the viewport tall enough to hold it.
     */
    async clipInView(x: number, y: number, width: number, height: number): Promise<Buffer> {
        const result = await this.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
            clip: { x, y, width, height, scale: 1 },
        });

        return Buffer.from(String(result.data), "base64");
    }

    /** Set the size of the page. Everything laid out again, at scale 1. */
    async resize(width: number, height: number): Promise<void> {
        await this.send("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: width < 500,
        });
    }

    /**
     * The text inside each `iframe` with `className`, in page order, read through the DevTools protocol (a sandboxed frame
     * is a page of its own, so the page cannot see in). A frame that runs in its own process is asked through its own
     * session; one that runs inside this page is read from its document. Script and style text is left out.
     */
    async frameTexts(className: string): Promise<{ title: string; text: string }[]> {
        const root = await this.send("DOM.getDocument", { depth: 0 });
        const found = await this.send("DOM.querySelectorAll", {
            nodeId: root.root.nodeId,
            selector: `iframe.${className}`,
        });
        const out: { title: string; text: string }[] = [];

        for (const nodeId of found.nodeIds ?? []) {
            const described = await this.send("DOM.describeNode", {
                nodeId,
                depth: -1,
                pierce: true,
            });
            const node = described.node as Json;
            const attributes: string[] = node.attributes ?? [];
            const title = attributes[attributes.indexOf("title") + 1] ?? "";
            const session = this.#frames.get(String(node.frameId));
            let text = "";

            if (session !== undefined) {
                const answer = await this.#browser.connection
                    .send(
                        "Runtime.evaluate",
                        {
                            expression: "document.body ? document.body.innerText : ''",
                            returnByValue: true,
                        },
                        session,
                        5000,
                    )
                    .catch(() => undefined);

                text = String(answer?.result?.value ?? "");
            } else if (node.contentDocument !== undefined) {
                const into: string[] = [];

                const walk = (item: Json) => {
                    if (item.nodeName === "SCRIPT" || item.nodeName === "STYLE") {
                        return;
                    }

                    if (item.nodeType === 3) {
                        into.push(String(item.nodeValue ?? ""));
                    }

                    for (const child of item.children ?? []) {
                        walk(child);
                    }
                };

                walk(node.contentDocument);
                text = into.join(" ");
            }

            out.push({ title, text: text.replace(/\s+/g, " ").trim() });
        }

        return out;
    }

    async close(): Promise<void> {
        this.#browser.connection.unlisten(this.#session);
        await this.#browser.connection
            .send("Target.disposeBrowserContext", { browserContextId: this.#context })
            .catch(() => {});
    }
}

/** A Chromium process that the bench owns. `undefined` from `launch` means no browser is installed. */
export class BenchBrowser {
    readonly #chromium: Chromium;
    readonly #folder: string;

    private constructor(chromium: Chromium, folder: string) {
        this.#chromium = chromium;
        this.#folder = folder;
    }

    static async launch(): Promise<BenchBrowser | undefined> {
        const executable = findBrowser();

        if (executable === undefined) {
            return undefined;
        }

        const folder = await mkdtemp(join(tmpdir(), "pocket-bench-"));
        const chromium = await Chromium.launch(executable, profileFolder(executable, folder), []);

        return new BenchBrowser(chromium, folder);
    }

    /** A new page in a fresh context. `origin` is the only address it may load; everything else is refused. */
    async page(origin: string): Promise<BenchPage> {
        const context = await this.#chromium.connection.send("Target.createBrowserContext");
        const target = await this.#chromium.connection.send("Target.createTarget", {
            url: "about:blank",
            browserContextId: context.browserContextId,
        });
        const attached = await this.#chromium.connection.send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
        });
        const page = new BenchPage(
            this.#chromium,
            attached.sessionId,
            context.browserContextId,
            origin,
        );

        await Promise.all([
            page.send("Page.enable"),
            page.send("Runtime.enable"),
            page.send("Network.enable"),
            page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
            page.send("Target.setAutoAttach", {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true,
            }),
        ]);

        return page;
    }

    async close(): Promise<void> {
        this.#chromium.kill();
        await this.#chromium.exited;
        await rm(this.#folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}
