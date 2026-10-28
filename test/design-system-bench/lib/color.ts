/**
 * Color math for the bench: parse the CSS and DTCG color forms, ΔE 2000, and WCAG contrast. The bench keeps its own
 * copy so a mistake in the code it scores cannot hide behind a shared helper.
 */

/** sRGB in 0–255 (floats), with alpha in 0–1. */
export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

const NAMED: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    orange: "#ffa500",
    purple: "#800080",
    gray: "#808080",
    grey: "#808080",
    silver: "#c0c0c0",
    maroon: "#800000",
    navy: "#000080",
    teal: "#008080",
    lime: "#00ff00",
    aqua: "#00ffff",
    fuchsia: "#ff00ff",
    olive: "#808000",
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The gamma-encoded value (0–1) of a linear one. */
const encode = (linear: number) =>
    linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * Math.abs(linear) ** (1 / 2.4) * Math.sign(linear) - 0.055;

/** The linear value (0–1) of a gamma-encoded one. */
const decode = (value: number) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

function fromLinear(r: number, g: number, b: number, a = 1): Rgba {
    return {
        r: clamp(encode(r), 0, 1) * 255,
        g: clamp(encode(g), 0, 1) * 255,
        b: clamp(encode(b), 0, 1) * 255,
        a: clamp(a, 0, 1),
    };
}

function fromOklab(l: number, a: number, b: number, alpha = 1): Rgba {
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const [lc, mc, sc] = [l_ ** 3, m_ ** 3, s_ ** 3];

    return fromLinear(
        4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
        -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
        -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
        alpha,
    );
}

function fromXyz(x: number, y: number, z: number, alpha = 1): Rgba {
    return fromLinear(
        3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
        -0.969266 * x + 1.8760108 * y + 0.041556 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
        alpha,
    );
}

function fromLab(l: number, a: number, b: number, alpha = 1): Rgba {
    // CIE Lab with the D65 white point (the sRGB default).
    const fy = (l + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const inverse = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

    return fromXyz(
        0.95047 * inverse(fx),
        l > 8 ? fy ** 3 : l / (24389 / 27),
        1.08883 * inverse(fz),
        alpha,
    );
}

function fromHsl(h: number, s: number, l: number, alpha = 1): Rgba {
    const hue = (((h % 360) + 360) % 360) / 30;
    const k = (n: number) => (n + hue) % 12;
    const amount = s * Math.min(l, 1 - l);
    const channel = (n: number) =>
        (l - amount * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255;

    return { r: channel(0), g: channel(8), b: channel(4), a: clamp(alpha, 0, 1) };
}

function fromHwb(h: number, w: number, b: number, alpha = 1): Rgba {
    if (w + b >= 1) {
        const gray = (w / (w + b)) * 255;

        return { r: gray, g: gray, b: gray, a: alpha };
    }

    const base = fromHsl(h, 1, 0.5, alpha);
    const mix = (value: number) => (value / 255) * (1 - w - b) * 255 + w * 255;

    return { r: mix(base.r), g: mix(base.g), b: mix(base.b), a: base.a };
}

function fromP3(r: number, g: number, b: number, alpha = 1): Rgba {
    const [lr, lg, lb] = [decode(r), decode(g), decode(b)];

    return fromXyz(
        0.4865709 * lr + 0.2656677 * lg + 0.1982173 * lb,
        0.2289746 * lr + 0.6917385 * lg + 0.0792869 * lb,
        0 * lr + 0.0451134 * lg + 1.0439444 * lb,
        alpha,
    );
}

/** A number or a percentage (of `scale`) from a CSS component; `none` is 0. */
function component(text: string | undefined, scale = 1): number {
    if (text === undefined || text === "none") {
        return 0;
    }

    return text.endsWith("%") ? (Number.parseFloat(text) / 100) * scale : Number.parseFloat(text);
}

/** An angle in degrees from `210`, `210deg`, `0.5turn`, `3.14rad`. */
function angle(text: string | undefined): number {
    if (text === undefined || text === "none") {
        return 0;
    }

    const value = Number.parseFloat(text);

    if (text.endsWith("turn")) {
        return value * 360;
    }

    if (text.endsWith("grad")) {
        return value * 0.9;
    }

    return text.endsWith("rad") ? (value * 180) / Math.PI : value;
}

/** Parse a CSS color string. Returns `undefined` for anything that is not a plain, static color. */
export function parseColor(input: string): Rgba | undefined {
    const text = input.trim().toLowerCase();

    if (text === "transparent") {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    if (Object.hasOwn(NAMED, text)) {
        return parseColor(NAMED[text]!);
    }

    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);

    if (hex !== null) {
        let digits = hex[1]!;

        if (digits.length <= 4) {
            digits = [...digits].map((digit) => digit + digit).join("");
        }

        const byte = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);

        return {
            r: byte(0),
            g: byte(2),
            b: byte(4),
            a: digits.length === 8 ? byte(6) / 255 : 1,
        };
    }

    const call = /^([a-z-]+)\(\s*([^)]*)\)$/.exec(text);

    if (call === null) {
        return undefined;
    }

    const name = call[1]!;
    let body = call[2]!.trim();
    let alphaText: string | undefined;
    const slash = body.indexOf("/");

    if (slash !== -1) {
        alphaText = body.slice(slash + 1).trim();
        body = body.slice(0, slash).trim();
    }

    // The legacy comma form puts the alpha last: `rgba(0, 0, 0, 0.5)`.
    const parts = body.split(/[\s,]+/).filter((part) => part !== "");

    if (slash === -1 && parts.length === 4) {
        alphaText = parts.pop();
    }

    const alpha = alphaText === undefined ? 1 : clamp(component(alphaText, 1), 0, 1);

    if (
        parts.length < 3 ||
        parts.some((part) => Number.isNaN(Number.parseFloat(part)) && part !== "none")
    ) {
        return undefined;
    }

    if (name === "rgb" || name === "rgba") {
        const channel = (part: string) => clamp(component(part, 255), 0, 255);

        return { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: alpha };
    }

    // CSS Color 4 reads `50%` and a bare `50` alike for the saturation, lightness, whiteness and blackness.
    const percent = (part: string | undefined) =>
        part === "none" ? 0 : Number.parseFloat(part ?? "0") / 100;

    if (name === "hsl" || name === "hsla") {
        return fromHsl(angle(parts[0]), percent(parts[1]), percent(parts[2]), alpha);
    }

    if (name === "hwb") {
        return fromHwb(angle(parts[0]), percent(parts[1]), percent(parts[2]), alpha);
    }

    if (name === "oklab") {
        return fromOklab(
            component(parts[0], 1),
            component(parts[1], 0.4),
            component(parts[2], 0.4),
            alpha,
        );
    }

    if (name === "oklch") {
        const chroma = component(parts[1], 0.4);
        const hue = (angle(parts[2]) * Math.PI) / 180;

        return fromOklab(
            component(parts[0], 1),
            chroma * Math.cos(hue),
            chroma * Math.sin(hue),
            alpha,
        );
    }

    if (name === "lab") {
        return fromLab(
            component(parts[0], 100),
            component(parts[1], 125),
            component(parts[2], 125),
            alpha,
        );
    }

    if (name === "lch") {
        const chroma = component(parts[1], 150);
        const hue = (angle(parts[2]) * Math.PI) / 180;

        return fromLab(
            component(parts[0], 100),
            chroma * Math.cos(hue),
            chroma * Math.sin(hue),
            alpha,
        );
    }

    return undefined;
}

/** A DTCG 2025.10 color object (`{ colorSpace, components, alpha?, hex? }`) or any CSS string. */
export function colorOf(value: unknown): Rgba | undefined {
    if (typeof value === "string") {
        return parseColor(value);
    }

    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const object = value as {
        colorSpace?: unknown;
        components?: unknown;
        alpha?: unknown;
        hex?: unknown;
    };
    const alpha = typeof object.alpha === "number" ? object.alpha : 1;

    if (
        Array.isArray(object.components) &&
        object.components.every((item) => typeof item === "number" || item === "none")
    ) {
        const [x, y, z] = object.components.map((item) => (item === "none" ? 0 : (item as number)));

        switch (object.colorSpace) {
            case "srgb":
                return {
                    r: clamp(x! * 255, 0, 255),
                    g: clamp(y! * 255, 0, 255),
                    b: clamp(z! * 255, 0, 255),
                    a: alpha,
                };
            case "srgb-linear":
                return fromLinear(x!, y!, z!, alpha);
            case "hsl":
                return fromHsl(x!, y! / 100, z! / 100, alpha);
            case "hwb":
                return fromHwb(x!, y! / 100, z! / 100, alpha);
            case "lab":
                return fromLab(x!, y!, z!, alpha);
            case "lch":
                return fromLab(
                    x!,
                    y! * Math.cos((z! * Math.PI) / 180),
                    y! * Math.sin((z! * Math.PI) / 180),
                    alpha,
                );
            case "oklab":
                return fromOklab(x!, y!, z!, alpha);
            case "oklch":
                return fromOklab(
                    x!,
                    y! * Math.cos((z! * Math.PI) / 180),
                    y! * Math.sin((z! * Math.PI) / 180),
                    alpha,
                );
            case "display-p3":
                return fromP3(x!, y!, z!, alpha);
            case "xyz-d65":
            case "xyz":
                return fromXyz(x!, y!, z!, alpha);
            default:
                break;
        }
    }

    // An unknown color space: the object's own sRGB fallback, when it has one.
    return typeof object.hex === "string" ? parseColor(object.hex) : undefined;
}

/** `#rrggbb`, or `#rrggbbaa` when the color is not opaque. */
export function toHex(color: Rgba): string {
    const byte = (value: number) =>
        Math.round(clamp(value, 0, 255))
            .toString(16)
            .padStart(2, "0");
    const base = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;

    return color.a < 0.995 ? base + byte(color.a * 255) : base;
}

/** CIE Lab (D65) of an sRGB color, ignoring alpha. */
export function toLab(color: Rgba): [number, number, number] {
    const [r, g, b] = [decode(color.r / 255), decode(color.g / 255), decode(color.b / 255)];
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const [fx, fy, fz] = [f(x), f(y), f(z)];

    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 between two colors (alpha ignored). 1 is barely visible, about 2.3 is a just-noticeable difference. */
export function deltaE(first: Rgba, second: Rgba): number {
    const [l1, a1, b1] = toLab(first);
    const [l2, a2, b2] = toLab(second);
    const rad = Math.PI / 180;
    const c1 = Math.hypot(a1, b1);
    const c2 = Math.hypot(a2, b2);
    const cBar = (c1 + c2) / 2;
    const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
    const [ap1, ap2] = [(1 + g) * a1, (1 + g) * a2];
    const [cp1, cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
    const hue = (b: number, a: number) =>
        b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360;
    const [hp1, hp2] = [hue(b1, ap1), hue(b2, ap2)];
    const dl = l2 - l1;
    const dc = cp2 - cp1;
    let dh = 0;

    if (cp1 * cp2 !== 0) {
        dh = hp2 - hp1;

        if (dh > 180) {
            dh -= 360;
        } else if (dh < -180) {
            dh += 360;
        }
    }

    const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh * rad) / 2);
    const lBar = (l1 + l2) / 2;
    const cpBar = (cp1 + cp2) / 2;
    let hBar = hp1 + hp2;

    if (cp1 * cp2 === 0) {
        hBar = hp1 + hp2;
    } else if (Math.abs(hp1 - hp2) <= 180) {
        hBar = (hp1 + hp2) / 2;
    } else {
        hBar = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
    }

    const t =
        1 -
        0.17 * Math.cos((hBar - 30) * rad) +
        0.24 * Math.cos(2 * hBar * rad) +
        0.32 * Math.cos((3 * hBar + 6) * rad) -
        0.2 * Math.cos((4 * hBar - 63) * rad);
    const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
    const sc = 1 + 0.045 * cpBar;
    const sh = 1 + 0.015 * cpBar * t;
    const rt =
        -2 *
        Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7)) *
        Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad);

    return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

/** Whether two colors are the same within `tolerance` (ΔE 2000) and `alphaTolerance`. */
export function sameColor(
    first: Rgba,
    second: Rgba,
    tolerance = 2,
    alphaTolerance = 0.03,
): boolean {
    return Math.abs(first.a - second.a) <= alphaTolerance && deltaE(first, second) <= tolerance;
}

/** The relative luminance of an opaque sRGB color (WCAG 2.x). */
export function luminance(color: Rgba): number {
    return (
        0.2126 * decode(color.r / 255) +
        0.7152 * decode(color.g / 255) +
        0.0722 * decode(color.b / 255)
    );
}

/** `color` over an opaque `backdrop`. */
export function composite(color: Rgba, backdrop: Rgba): Rgba {
    const a = color.a;

    return {
        r: color.r * a + backdrop.r * (1 - a),
        g: color.g * a + backdrop.g * (1 - a),
        b: color.b * a + backdrop.b * (1 - a),
        a: 1,
    };
}

/** The WCAG contrast ratio of a foreground over a background (the foreground blended over it when translucent). */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
    const base =
        background.a < 1 ? composite(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
    const top = foreground.a < 1 ? composite(foreground, base) : foreground;
    const [high, low] = [luminance(top), luminance(base)].sort((a, b) => b - a) as [number, number];

    return (high + 0.05) / (low + 0.05);
}
