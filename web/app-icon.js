// The app's icons in the colors in use: the tab's icon (an SVG drawn here) and the home-screen icon (`apple-touch-icon`,
// which iOS and Android's "add to home screen" shortcut read; the server draws its PNG). The files in this folder
// (`icon.svg` and its PNGs) are the first load's icons, and stay where this module does not run. The web app manifest
// keeps its own icons: an installed Android app needs a manifest at an address the browser can fetch again, which a
// page cannot make per palette.

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

/**
 * The home-screen icon's address: the server draws the PNG (`src/server/icon-render.ts`). A phone fetches it when the
 * icon is added, and does not take a `data:` or `blob:` address for it.
 */
const homeIconUrl = (vars) => {
    const color = (name) => (vars[name] ?? DEFAULTS[name]).replace("#", "");
    const query = new URLSearchParams({
        frame: color("--o-bg-darker"),
        card: color("--o-bg"),
        ring1: color("--o-cyan"),
        ring2: color("--o-green"),
        pi: color("--o-orange"),
        size: String(APPLE),
    });

    return `/app-icon.png?${query}`;
};

/**
 * The colors in a cookie, `frame.card.ring1.ring2.pi` in hex: iOS may read the icon from the page as it is served, before
 * any script runs, so the server puts the address in the page from this cookie (`src/server/http/icon-route.ts`).
 */
const COOKIE = "pocket_icon";
const cookieValue = (vars) =>
    ["--o-bg-darker", "--o-bg", "--o-cyan", "--o-green", "--o-orange"]
        .map((name) => (vars[name] ?? DEFAULTS[name]).replace("#", ""))
        .join(".");

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

/** Put the icons for `vars` on the page: the tab's icon and the home-screen icon. The same colors again do nothing. */
export function applyIcons(vars) {
    const key = JSON.stringify(Object.keys(DEFAULTS).map((name) => vars[name]));

    if (key === applied) {
        return;
    }

    applied = key;
    setLink("icon", svgUrl(iconSvg(vars)), "image/svg+xml");
    setLink("apple-touch-icon", homeIconUrl(vars));
    document.cookie = `${COOKIE}=${cookieValue(vars)}; path=/; max-age=31536000; samesite=lax`;
}
