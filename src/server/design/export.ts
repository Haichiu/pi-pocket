/** Portable bundle, screenshot, print, and image-slide presentation exports. */
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";
import { pptx } from "./pptx.ts";
import { type DesignViewport, viewportOf, withRender } from "./render.ts";
import { zip } from "./zip.ts";

export type ExportFormat = "png" | "pdf" | "pptx" | "html";
export const EXPORT_TYPES = {
    png: { extension: "png", mime: "image/png" },
    pdf: { extension: "pdf", mime: "application/pdf" },
    pptx: {
        extension: "pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    html: { extension: "zip", mime: "application/zip" },
} as const;

export async function exportDesign(
    bundle: DesignBundle,
    format: ExportFormat,
    viewport: string | DesignViewport | undefined,
    host: PocketHost,
    signal?: AbortSignal,
): Promise<Buffer> {
    signal?.throwIfAborted();

    if (format === "html") {
        const names = new Set(bundle.assets.map((asset) => asset.name));
        let entry = "index.html";
        let suffix = 0;

        while (names.has(entry)) {
            entry = `pocket-design${suffix === 0 ? "" : `-${suffix}`}.html`;
            suffix++;
        }

        return zip([{ name: entry, bytes: Buffer.from(bundle.content) }, ...bundle.assets]);
    }

    return withRender(bundle, host, signal, async (page) => {
        const size = format === "pptx" ? { width: 1280, height: 720 } : viewportOf(viewport);

        await page.load(size);
        await page.evaluate(`document.title = ${JSON.stringify(bundle.meta.title)}`);

        if (format === "png") {
            const deck = await page.isDeck();

            if (deck) {
                await page.showSlide(1);
            }

            return Buffer.from(
                await page.screenshot(deck ? { width: 1280, height: 720 } : size, !deck),
                "base64",
            );
        }

        if (format === "pdf") {
            return Buffer.from(await page.pdf(), "base64");
        }

        const texts = await page.slides();
        const slides: { image: Buffer; text: string }[] = [];
        let total = 0;

        for (const [index, text] of texts.entries()) {
            await page.showSlide(index + 1);
            const image = Buffer.from(await page.screenshot(size), "base64");

            total += image.length;

            if (total > 100_000_000) {
                throw new Error("The presentation images exceed 100 MB.");
            }

            slides.push({ image, text });
        }

        return pptx(slides);
    });
}
