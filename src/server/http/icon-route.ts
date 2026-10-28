/** `/app-icon.png?frame=&card=&ring1=&ring2=&pi=&size=`: the app icon in those colors (hex, no `#`), as `icon-render.ts` draws it. */
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

    const png = renderIcon(colors, Number(url.searchParams.get("size") ?? 180));

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

/**
 * The home-screen icon's address for the colors in the request's `pocket_icon` cookie (`frame.card.ring1.ring2.pi`, which
 * `web/app-icon.js` keeps), or null without one. iOS may read the icon from the page as served, so the page carries it.
 */
export function iconAddress(request: IncomingMessage): string | null {
    const value = COOKIE.exec(request.headers.cookie ?? "")?.[1];

    if (value === undefined) {
        return null;
    }

    const [frame, card, ring1, ring2, pi] = value.split(".");
    const query = new URLSearchParams({ frame, card, ring1, ring2, pi, size: "180" } as Record<
        string,
        string
    >);

    return `/app-icon.png?${query}`;
}
