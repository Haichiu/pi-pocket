/** `/app-icon.png?frame=&card=&ring1=&ring2=&pi=&size=&maskable=1`: the app icon in those colors (hex, no `#`), as `icon-render.ts` draws it. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../errors.ts";
import { APP_ICON, type IconColors, renderIcon } from "../icon-render.ts";

export function iconRoute(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    const colors = { ...APP_ICON };

    for (const name of Object.keys(colors) as (keyof IconColors)[]) {
        const value = url.searchParams.get(name);

        if (value !== null) {
            colors[name] = `#${value}`;
        }
    }

    const png = renderIcon(
        colors,
        Number(url.searchParams.get("size") ?? 180),
        url.searchParams.get("maskable") === "1",
    );

    if (png === null) {
        throw new HttpError(400, "Colors are 3 or 6 hex digits");
    }

    // The colors are in the address, so a copy never goes stale.
    response.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "public, max-age=31536000, immutable",
    });
    response.end(request.method === "HEAD" ? undefined : png);
}

const HEX = "(?:[0-9a-f]{3}|[0-9a-f]{6})";
const COOKIE = new RegExp(`(?:^|;\\s*)pocket_icon=(${HEX}(?:\\.${HEX}){4})(?:;|$)`, "i");

/** The colors in the request's `pocket_icon` cookie (`frame.card.ring1.ring2.pi`, which `web/app-icon.js` keeps), or null. */
function cookieColors(request: IncomingMessage): string[] | null {
    return COOKIE.exec(request.headers.cookie ?? "")?.[1]?.split(".") ?? null;
}

const address = (colors: string[], size: number, maskable = false) => {
    const [frame, card, ring1, ring2, pi] = colors as [string, string, string, string, string];
    const query = new URLSearchParams({ frame, card, ring1, ring2, pi, size: String(size) });

    if (maskable) {
        query.set("maskable", "1");
    }

    return `/app-icon.png?${query}`;
};

/**
 * The home-screen icon's address for the colors in the cookie, or null without one. iOS may read the icon from the page
 * as served, so the page carries it.
 */
export function iconAddress(request: IncomingMessage): string | null {
    const colors = cookieColors(request);

    return colors === null ? null : address(colors, 180);
}

/**
 * The web app manifest with the icons and colors of the cookie, or null without one (the file is served as it is).
 * iOS and Android read the manifest's icons too, and an icon there that is not the page's own wins over it.
 */
export function manifestFor(request: IncomingMessage, file: string): string | null {
    const colors = cookieColors(request);

    if (colors === null) {
        return null;
    }

    const manifest = JSON.parse(file) as Record<string, unknown>;
    const icon = (size: number, maskable: boolean) => ({
        src: address(colors, size, maskable),
        sizes: `${size}x${size}`,
        type: "image/png",
        ...(maskable ? { purpose: "maskable" } : {}),
    });

    return JSON.stringify({
        ...manifest,
        background_color: `#${colors[0]}`,
        theme_color: `#${colors[0]}`,
        icons: [icon(192, false), icon(512, false), icon(512, true)],
    });
}
