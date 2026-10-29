// Colors for the System view, as pure functions (no DOM, so a test can run them): read a DTCG color (the 2025.10 object
// form or a CSS string), write it as hex or OKLCH, and measure contrast the way WCAG 2.2 does. A color is `{ r, g, b, a }`:
// r, g, b in 0–255 (sRGB), a in 0–1.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const to255 = (value) => Math.round(clamp(value, 0, 1) * 255);

/** sRGB (0–1) from linear light (0–1), and back. */
const encode = (value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
const decode = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** A color from OKLab coordinates (the CSS Color 4 matrices), clipped to sRGB. */
function fromOklab(l, a, b, alpha = 1) {
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const lc = l_ ** 3;
    const mc = m_ ** 3;
    const sc = s_ ** 3;
    const r = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
    const g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
    const bl = -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc;

    return {
        r: to255(encode(clamp(r, 0, 1))),
        g: to255(encode(clamp(g, 0, 1))),
        b: to255(encode(clamp(bl, 0, 1))),
        a: clamp(alpha, 0, 1),
    };
}

function toOklab({ r, g, b }) {
    const lr = decode(r / 255);
    const lg = decode(g / 255);
    const lb = decode(b / 255);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

    return {
        l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    };
}

const fromOklch = (l, c, h, alpha) =>
    fromOklab(l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180), alpha);

/** OKLCH of a color: lightness 0–1, chroma, hue in degrees (0 for a gray). */
export function toOklch(color) {
    const { l, a, b } = toOklab(color);
    const c = Math.hypot(a, b);
    const h = c < 0.0004 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;

    return { l, c, h };
}

function fromHsl(h, s, l, alpha) {
    const hue = (((h % 360) + 360) % 360) / 360;
    const sat = clamp(s, 0, 100) / 100;
    const light = clamp(l, 0, 100) / 100;
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;

    const channel = (t) => {
        const x = (t + 1) % 1;

        return x < 1 / 6
            ? p + (q - p) * 6 * x
            : x < 0.5
              ? q
              : x < 2 / 3
                ? p + (q - p) * (2 / 3 - x) * 6
                : p;
    };

    return {
        r: to255(sat === 0 ? light : channel(hue + 1 / 3)),
        g: to255(sat === 0 ? light : channel(hue)),
        b: to255(sat === 0 ? light : channel(hue - 1 / 3)),
        a: clamp(alpha, 0, 1),
    };
}

/** A number or a percentage (`50%` → 0.5 × `full`), or undefined. */
function component(text, full = 1) {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|turn)?$/i.exec(text.trim());

    if (match === null) {
        return undefined;
    }

    const value = Number(match[1]);

    return match[2] === "%" ? (value / 100) * full : value;
}

/** The hue of `text` in degrees (a bare number, `deg`, `rad`, or `turn`). */
function hueOf(text) {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|turn)?$/i.exec(text.trim());

    if (match === null) {
        return undefined;
    }

    const value = Number(match[1]);
    const unit = (match[2] ?? "deg").toLowerCase();

    return unit === "rad" ? (value * 180) / Math.PI : unit === "turn" ? value * 360 : value;
}

const NAMED = {
    transparent: { r: 0, g: 0, b: 0, a: 0 },
    black: { r: 0, g: 0, b: 0, a: 1 },
    white: { r: 255, g: 255, b: 255, a: 1 },
};

/** The function-style color `name(...)`: the parts, split on commas, spaces, and a slash. */
function parts(body) {
    const [main, alpha] = body.split("/").map((each) => each.trim());
    const list = main.split(/[\s,]+/).filter(Boolean);

    if (alpha !== undefined) {
        list.push(alpha);
    }

    return list;
}

function parseString(input) {
    const text = input.trim().toLowerCase();

    if (Object.hasOwn(NAMED, text)) {
        return { ...NAMED[text] };
    }

    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);

    if (hex) {
        const digits =
            hex[1].length <= 4 ? [...hex[1]].map((each) => each + each).join("") : hex[1];

        return {
            r: parseInt(digits.slice(0, 2), 16),
            g: parseInt(digits.slice(2, 4), 16),
            b: parseInt(digits.slice(4, 6), 16),
            a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
        };
    }

    const call = /^([a-z-]+)\(\s*([^()]*)\)$/.exec(text);

    if (call === null) {
        return null;
    }

    const list = parts(call[2]);
    const name = call[1];
    const alpha = (index) =>
        list[index] === undefined ? 1 : clamp(component(list[index]) ?? NaN, 0, 1);

    if (name === "rgb" || name === "rgba") {
        const channels = list.slice(0, 3).map((each) => component(each, 255));

        if (channels.length < 3 || channels.some((each) => !finite(each)) || !finite(alpha(3))) {
            return null;
        }

        return {
            r: Math.round(clamp(channels[0], 0, 255)),
            g: Math.round(clamp(channels[1], 0, 255)),
            b: Math.round(clamp(channels[2], 0, 255)),
            a: alpha(3),
        };
    }

    if (name === "hsl" || name === "hsla") {
        const h = hueOf(list[0] ?? "");
        const s = component(list[1] ?? "", 100);
        const l = component(list[2] ?? "", 100);

        return finite(h) && finite(s) && finite(l) && finite(alpha(3))
            ? fromHsl(h, s, l, alpha(3))
            : null;
    }

    if (name === "oklch") {
        const l = component(list[0] ?? "", 1);
        const c = component(list[1] ?? "", 0.4);
        const h = hueOf(list[2] ?? "");

        return finite(l) && finite(c) && finite(h) && finite(alpha(3))
            ? fromOklch(l, c, h, alpha(3))
            : null;
    }

    if (name === "oklab") {
        const l = component(list[0] ?? "", 1);
        const a = component(list[1] ?? "", 0.4);
        const b = component(list[2] ?? "", 0.4);

        return finite(l) && finite(a) && finite(b) && finite(alpha(3))
            ? fromOklab(l, a, b, alpha(3))
            : null;
    }

    if (name === "color") {
        const space = list[0];
        const channels = list.slice(1, 4).map((each) => component(each, 1));

        if (
            space === "srgb" &&
            channels.length === 3 &&
            channels.every(finite) &&
            finite(alpha(4))
        ) {
            return {
                r: to255(channels[0]),
                g: to255(channels[1]),
                b: to255(channels[2]),
                a: alpha(4),
            };
        }
    }

    return null;
}

/** Display P3 (0–1) to sRGB, clipped: close enough to show and to measure. */
function fromP3(red, green, blue, alpha) {
    const lr = decode(red);
    const lg = decode(green);
    const lb = decode(blue);
    const r = 1.2249401 * lr - 0.2249402 * lg;
    const g = -0.0420569 * lr + 1.0420571 * lg;
    const b = -0.0196376 * lr - 0.0786507 * lg + 1.0982735 * lb;

    return {
        r: to255(encode(clamp(r, 0, 1))),
        g: to255(encode(clamp(g, 0, 1))),
        b: to255(encode(clamp(b, 0, 1))),
        a: clamp(alpha, 0, 1),
    };
}

function parseObject(input) {
    const alpha = finite(input.alpha) ? clamp(input.alpha, 0, 1) : 1;

    if (typeof input.hex === "string") {
        const color = parseString(input.hex);

        // The hex has no alpha of its own: the object's alpha is the color's.
        return color === null ? null : { ...color, a: finite(input.alpha) ? alpha : color.a };
    }

    const c = Array.isArray(input.components) ? input.components : [];

    if (c.length < 3 || !c.slice(0, 3).every((each) => finite(each) || each === "none")) {
        return null;
    }

    const [x, y, z] = c.map((each) => (each === "none" ? 0 : each));

    switch (input.colorSpace) {
        case "srgb":
            return { r: to255(x), g: to255(y), b: to255(z), a: alpha };
        case "srgb-linear":
            return {
                r: to255(encode(clamp(x, 0, 1))),
                g: to255(encode(clamp(y, 0, 1))),
                b: to255(encode(clamp(z, 0, 1))),
                a: alpha,
            };
        case "hsl":
            return fromHsl(x, y, z, alpha);
        case "oklch":
            return fromOklch(x, y, z, alpha);
        case "oklab":
            return fromOklab(x, y, z, alpha);
        case "display-p3":
            return fromP3(x, y, z, alpha);
        default:
            return null;
    }
}

/** A color from a DTCG value (object or string): `{ r, g, b, a }`, or null for what this cannot read. */
export function parseColor(input) {
    if (typeof input === "string") {
        return input.length > 200 ? null : parseString(input);
    }

    return typeof input === "object" && input !== null && !Array.isArray(input)
        ? parseObject(input)
        : null;
}

const hex2 = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");

export function toHex({ r, g, b, a = 1 }) {
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ""}`;
}

export function toOklchText(color) {
    const { l, c, h } = toOklch(color);
    const round = (value, digits) => String(Math.round(value * 10 ** digits) / 10 ** digits);
    const alpha = color.a < 1 ? ` / ${round(color.a, 2)}` : "";

    return `oklch(${round(l, 3)} ${round(c, 3)} ${round(h, 1)}${alpha})`;
}

export const toRgbText = ({ r, g, b, a = 1 }) =>
    `rgb(${r} ${g} ${b}${a < 1 ? ` / ${Math.round(a * 100) / 100}` : ""})`;

export function swatchCss(value) {
    const color = parseColor(value);

    return color === null ? "" : toRgbText(color);
}

/** The DTCG value for `color` in the same dialect as `like`: an object (2025.10) when `like` is one, else a hex string. */
export function writeColor(color, like) {
    if (typeof like === "object" && like !== null && !Array.isArray(like)) {
        const next = {
            colorSpace: "srgb",
            components: [color.r, color.g, color.b].map(
                (each) => Math.round((each / 255) * 10000) / 10000,
            ),
            hex: toHex({ ...color, a: 1 }),
        };

        return color.a < 1 ? { ...next, alpha: Math.round(color.a * 1000) / 1000 } : next;
    }

    return toHex(color);
}

export function luminance({ r, g, b }) {
    return 0.2126 * decode(r / 255) + 0.7152 * decode(g / 255) + 0.0722 * decode(b / 255);
}

export function over(top, bottom) {
    const a = top.a ?? 1;

    return {
        r: Math.round(top.r * a + bottom.r * (1 - a)),
        g: Math.round(top.g * a + bottom.g * (1 - a)),
        b: Math.round(top.b * a + bottom.b * (1 - a)),
        a: 1,
    };
}

/** The contrast ratio of `foreground` on `background` (WCAG 2.2): a see-through foreground is laid over the background first. */
export function contrast(foreground, background) {
    const ground =
        background.a < 1 ? over(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
    const ink = foreground.a < 1 ? over(foreground, ground) : foreground;
    const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a);

    return (hi + 0.05) / (lo + 0.05);
}

/** How a ratio fares against `min`: `pass` (≥ min), `fail`; and `level` for the usual steps. */
export function grade(ratio, min = 4.5) {
    return {
        ratio,
        min,
        pass: ratio >= min,
        level: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "Fail",
    };
}

/** A ratio for people: `7.1:1`, rounded down, so a 4.49 never reads as 4.5. */
export const ratioText = (ratio) => `${Math.floor(ratio * 10) / 10}:1`;
