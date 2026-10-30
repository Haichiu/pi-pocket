/**
 * The owner's app icon colors (`frame.card.ring1.ring2.pi`, hex), kept in the data folder. A phone fetches the page and
 * the icon from a session of its own that has no cookies, so the cookie of the browser (`http/icon-route.ts`) is not
 * enough there: this is what such a request gets. It is the owner's choice for the whole server; a guest's browser
 * still gets its own colors from its cookie.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.ts";

const HEX = "(?:[0-9a-f]{3}|[0-9a-f]{6})";

/** `frame.card.ring1.ring2.pi`, five hex colors, else false. */
export const isIconColors = (value: unknown): value is string =>
    typeof value === "string" && new RegExp(`^${HEX}(?:\\.${HEX}){4}$`, "i").test(value);

const file = () => join(dataDir(), "app-icon.json");

export function storedIconColors(): string[] | null {
    if (!existsSync(file())) {
        return null;
    }

    try {
        const { colors } = JSON.parse(readFileSync(file(), "utf8")) as { colors?: unknown };

        return isIconColors(colors) ? colors.split(".") : null;
    } catch (error) {
        console.warn(
            "Pi Pocket: app-icon.json could not be read; the app's own icon is used.",
            error,
        );

        return null;
    }
}

export function storeIconColors(colors: unknown): void {
    if (!isIconColors(colors)) {
        throw new TypeError("Colors are five hex colors joined by dots");
    }

    if (storedIconColors()?.join(".") !== colors) {
        writeFileSync(file(), `${JSON.stringify({ colors })}\n`);
    }
}
