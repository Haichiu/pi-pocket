// The app's icons in the colors in use: the tab's icon, the iPhone and iPad home-screen icon, and the icons in the web
// app manifest (Android's home screen and install). The files in this folder (`icon.svg` and its PNGs) stay as the first
// load's icons, and as what shows when this module cannot draw (no canvas, no fetch).

const SIZE = 512;
const PAD = 80;
const APPLE = 180;
const TARGETS = [
    { size: 192, maskable: false },
    { size: 512, maskable: false },
    { size: 512, maskable: true },
];

/**
 * The icon as SVG text, from the palette's variables (`themeVars`): the same drawing as `icon.svg`, in the palette's
 * colors. `maskable` fills the whole square and draws the artwork inside the safe zone, for icons the OS crops itself.
 */
export function iconSvg(vars, { maskable = false } = {}) {
    const outer = vars["--o-bg-darker"];
    const card = vars["--o-bg"];
    const art = `
        <rect x="40" y="40" width="432" height="432" rx="75" fill="${card}" stroke="url(#ring)" stroke-width="12" />
        <text x="256" y="350" font-family="Georgia, 'Times New Roman', serif" font-size="280" text-anchor="middle" fill="${vars["--o-orange"]}">π</text>`;
    const inset = (SIZE - 2 * PAD) / SIZE;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
        <defs>
            <linearGradient id="ring" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stop-color="${vars["--o-cyan"]}" />
                <stop offset="1" stop-color="${vars["--o-green"]}" />
            </linearGradient>
        </defs>
        <rect width="${SIZE}" height="${SIZE}" fill="${outer}" />
        ${maskable ? `<g transform="translate(${PAD} ${PAD}) scale(${inset})">${art}</g>` : art}
    </svg>`;
}

const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** The icon as a PNG data URL of `size` pixels, or null when this browser cannot draw it. */
async function iconPng(vars, size, maskable) {
    try {
        const image = new Image();

        image.src = svgUrl(iconSvg(vars, { maskable }));
        await image.decode();

        const canvas = document.createElement("canvas");

        canvas.width = size;
        canvas.height = size;
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);

        return canvas.toDataURL("image/png");
    } catch {
        return null;
    }
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

/**
 * The manifest as the server serves it, with this palette's icons and colors. Its addresses become absolute: a manifest
 * at a `blob:` address has no origin to resolve them against.
 */
async function manifestFor(vars, icons) {
    const response = await fetch("/manifest.webmanifest", { credentials: "include" });

    if (!response.ok) {
        return null;
    }

    const manifest = await response.json();
    const absolute = (path) => new URL(path, location.origin).href;

    return {
        ...manifest,
        id: absolute(manifest.id ?? manifest.start_url ?? "/"),
        start_url: absolute(manifest.start_url ?? "/"),
        scope: absolute(manifest.scope ?? "/"),
        background_color: vars["--o-bg-darker"],
        theme_color: vars["--o-bg"],
        ...(manifest.share_target
            ? {
                  share_target: {
                      ...manifest.share_target,
                      action: absolute(manifest.share_target.action),
                  },
              }
            : {}),
        icons,
    };
}

let applied = "";
let manifestUrl = "";

/**
 * Put the icons for `vars` on the page: the tab's at once, the home-screen and manifest ones when drawn. The same colors
 * again do nothing. A step that fails leaves the app's own icon in that place.
 */
export async function applyIcons(vars) {
    const key = JSON.stringify([
        vars["--o-bg"],
        vars["--o-bg-darker"],
        vars["--o-orange"],
        vars["--o-cyan"],
        vars["--o-green"],
    ]);

    if (key === applied) {
        return;
    }

    applied = key;
    setLink("icon", svgUrl(iconSvg(vars)), "image/svg+xml");

    const [apple, ...pngs] = await Promise.all([
        iconPng(vars, APPLE, false),
        ...TARGETS.map((target) => iconPng(vars, target.size, target.maskable)),
    ]);

    if (key !== applied) {
        return;
    }

    if (apple) {
        setLink("apple-touch-icon", apple);
    }

    if (pngs.some((png) => !png)) {
        return;
    }

    try {
        const manifest = await manifestFor(
            vars,
            TARGETS.map((target, at) => ({
                src: pngs[at],
                sizes: `${target.size}x${target.size}`,
                type: "image/png",
                ...(target.maskable ? { purpose: "maskable" } : {}),
            })),
        );

        if (manifest && key === applied) {
            const next = URL.createObjectURL(
                new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }),
            );

            document.querySelector('link[rel="manifest"]')?.setAttribute("href", next);

            if (manifestUrl) {
                URL.revokeObjectURL(manifestUrl);
            }

            manifestUrl = next;
        }
    } catch {
        // The server's own manifest stays.
    }
}
