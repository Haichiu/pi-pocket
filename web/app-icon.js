// The app's icons in the colors in use: the tab's icon and the home-screen icon (`apple-touch-icon`, which iOS and
// Android's "add to home screen" shortcut read). The files in this folder (`icon.svg` and its PNGs) stay as the first
// load's icons, and as what shows when this module cannot draw (no canvas, no decoding). The web app manifest keeps its
// own icons: an installed Android app needs a manifest at an address the browser can fetch again, which a page cannot
// make per palette.

const SIZE = 512;
const APPLE = 180;
// What a palette lacks keeps the app's own icon color.
const DEFAULTS = {
    "--o-bg": "#1a1b26",
    "--o-bg-darker": "#13141c",
    "--o-orange": "#ff9e64",
    "--o-cyan": "#33ccff",
    "--o-green": "#00ff99",
};

/** The icon as SVG text, from the palette's variables (`themeVars`): the drawing of `icon.svg` in the palette's colors. */
export function iconSvg(vars) {
    const color = (name) => vars[name] ?? DEFAULTS[name];

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
        <defs>
            <linearGradient id="ring" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stop-color="${color("--o-cyan")}" />
                <stop offset="1" stop-color="${color("--o-green")}" />
            </linearGradient>
        </defs>
        <rect width="${SIZE}" height="${SIZE}" fill="${color("--o-bg-darker")}" />
        <rect x="40" y="40" width="432" height="432" rx="75" fill="${color("--o-bg")}" stroke="url(#ring)" stroke-width="12" />
        <text x="256" y="350" font-family="Georgia, 'Times New Roman', serif" font-size="280" text-anchor="middle" fill="${color("--o-orange")}">π</text>
    </svg>`;
}

const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** The icon as a PNG data URL of `size` pixels. */
async function iconPng(vars, size) {
    const image = new Image();

    image.src = svgUrl(iconSvg(vars));
    await image.decode();

    const canvas = document.createElement("canvas");

    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d").drawImage(image, 0, 0, size, size);

    return canvas.toDataURL("image/png");
}

function setLink(rel, href, type) {
    let link = document.querySelector(`link[rel="${rel}"]`);

    if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        document.head.append(link);
    }

    if (type) {
        link.type = type;
    }

    link.href = href;
}

let applied = "";

/**
 * Put the icons for `vars` on the page: the tab's at once, the home-screen one when drawn. The same colors again do
 * nothing. A home-screen icon that cannot be drawn leaves the app's own, and is tried again with the next call.
 */
export async function applyIcons(vars) {
    const key = JSON.stringify(Object.keys(DEFAULTS).map((name) => vars[name]));

    if (key === applied) {
        return;
    }

    applied = key;
    setLink("icon", svgUrl(iconSvg(vars)), "image/svg+xml");

    try {
        const apple = await iconPng(vars, APPLE);

        if (key === applied) {
            setLink("apple-touch-icon", apple);
        }
    } catch (error) {
        console.warn("Pi Pocket: the home-screen icon could not be drawn in these colors.", error);

        if (key === applied) {
            applied = "";
        }
    }
}
