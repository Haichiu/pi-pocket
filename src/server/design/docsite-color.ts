/**
 * Color math for the design-system documentation page (docsite.ts): parse the values a resolved token can hold (a hex or
 * functional string, or a DTCG color object), mix alpha over a ground, and rate text contrast with WCAG 2.2's formula.
 * Everything here is pure and treats its input as data: a value that does not parse is `undefined`, never an error.
 */

/** A color in sRGB: channels 0 to 255, alpha 0 to 1. */
export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const NAMED: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    transparent: "#00000000",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    gray: "#808080",
    grey: "#808080",
    yellow: "#ffff00",
    orange: "#ffa500",
    purple: "#800080",
    cyan: "#00ffff",
    magenta: "#ff00ff",
};

function parseHex(text: string): Rgba | undefined {
    const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);

    if (match === null) {
        return undefined;
    }

    let digits = match[1]!;

    if (digits.length <= 4) {
        digits = [...digits].map((digit) => digit + digit).join("");
    }

    const byte = (at: number) => parseInt(digits.slice(at, at + 2), 16);

    return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
}

/** One channel of a functional color: a number, or a percentage of `scale`. */
function channel(text: string, scale: number): number | undefined {
    const value = text.trim();
    const number = Number.parseFloat(value);

    if (!Number.isFinite(number)) {
        return undefined;
    }

    return value.endsWith("%") ? (number / 100) * scale : number;
}

function alphaOf(text: string | undefined): number {
    if (text === undefined) {
        return 1;
    }

    return clamp(channel(text, 1) ?? 1, 0, 1);
}

function fromHsl(h: number, s: number, l: number, a: number): Rgba {
    const sat = clamp(s, 0, 100) / 100;
    const light = clamp(l, 0, 100) / 100;
    const hue = ((h % 360) + 360) % 360;
    const k = (n: number) => (n + hue / 30) % 12;
    const f = (n: number) =>
        light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));

    return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a };
}

function fromOklab(l: number, a: number, b: number, alpha: number): Rgba {
    const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
        4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
        -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
        -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
    ].map((v) => {
        const c = clamp(v, 0, 1);

        return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
    });

    return { r: lin[0]!, g: lin[1]!, b: lin[2]!, a: alpha };
}

function parseFunctional(text: string): Rgba | undefined {
    const match = /^([a-z]+)\(\s*([^)]*)\)$/i.exec(text);

    if (match === null) {
        return undefined;
    }

    const name = match[1]!.toLowerCase();
    const [body, slashAlpha] = match[2]!.split("/").map((part) => part.trim());
    const parts = body!.split(/[\s,]+/).filter(Boolean);
    const alpha = parts.length === 4 ? parts[3] : slashAlpha;

    if (parts.length < 3) {
        return undefined;
    }

    if (name === "rgb" || name === "rgba") {
        const rgb = parts.slice(0, 3).map((part) => channel(part, 255));

        if (rgb.some((value) => value === undefined)) {
            return undefined;
        }

        return { r: rgb[0]!, g: rgb[1]!, b: rgb[2]!, a: alphaOf(alpha) };
    }

    if (name === "hsl" || name === "hsla") {
        const h = Number.parseFloat(parts[0]!);
        const s = Number.parseFloat(parts[1]!);
        const l = Number.parseFloat(parts[2]!);

        return [h, s, l].every(Number.isFinite) ? fromHsl(h, s, l, alphaOf(alpha)) : undefined;
    }

    if (name === "oklch" || name === "oklab") {
        const l = channel(parts[0]!, 1);
        const second = channel(parts[1]!, 0.4);
        const third = Number.parseFloat(parts[2]!);

        if (l === undefined || second === undefined || !Number.isFinite(third)) {
            return undefined;
        }

        if (name === "oklab") {
            return fromOklab(l, second, channel(parts[2]!, 0.4) ?? third, alphaOf(alpha));
        }

        const radians = (third * Math.PI) / 180;

        return fromOklab(l, second * Math.cos(radians), second * Math.sin(radians), alphaOf(alpha));
    }

    return undefined;
}

/**
 * Reads a color: a hex string (3, 4, 6, or 8 digits), `rgb()`, `hsl()`, `oklch()`, `oklab()`, a few names, or a DTCG
 * object (`{ colorSpace, components, alpha, hex }`). Anything else gives `undefined`.
 */
export function parseColor(value: unknown): Rgba | undefined {
    if (typeof value === "string") {
        const text = value.trim();

        return parseHex(text) ?? parseFunctional(text) ?? parseHex(NAMED[text.toLowerCase()] ?? "");
    }

    if (value !== null && typeof value === "object") {
        const object = value as { hex?: unknown; components?: unknown; colorSpace?: unknown };
        const alpha =
            typeof (object as { alpha?: unknown }).alpha === "number"
                ? (object as { alpha: number }).alpha
                : 1;

        if (typeof object.hex === "string") {
            const parsed = parseHex(object.hex);

            return parsed === undefined ? undefined : { ...parsed, a: alpha * parsed.a };
        }

        if (Array.isArray(object.components) && object.components.length >= 3) {
            const [x, y, z] = object.components as unknown[];

            if ([x, y, z].every((item) => typeof item === "number")) {
                const space = String(object.colorSpace ?? "srgb").toLowerCase();

                if (space === "srgb") {
                    return {
                        r: (x as number) * 255,
                        g: (y as number) * 255,
                        b: (z as number) * 255,
                        a: alpha,
                    };
                }

                if (space === "hsl") {
                    return fromHsl(x as number, y as number, z as number, alpha);
                }

                if (space === "oklch") {
                    const radians = ((z as number) * Math.PI) / 180;

                    return fromOklab(
                        x as number,
                        (y as number) * Math.cos(radians),
                        (y as number) * Math.sin(radians),
                        alpha,
                    );
                }

                if (space === "oklab") {
                    return fromOklab(x as number, y as number, z as number, alpha);
                }
            }
        }
    }

    return undefined;
}

const hex2 = (value: number) =>
    Math.round(clamp(value, 0, 255))
        .toString(16)
        .padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when the color is not opaque. */
export function toHex(color: Rgba): string {
    const base = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;

    return color.a < 0.999 ? `${base}${hex2(color.a * 255)}` : base;
}

/** The color laid over an opaque ground. */
export function over(color: Rgba, ground: Rgba): Rgba {
    const a = clamp(color.a, 0, 1);

    return {
        r: color.r * a + ground.r * (1 - a),
        g: color.g * a + ground.g * (1 - a),
        b: color.b * a + ground.b * (1 - a),
        a: 1,
    };
}

/** Relative luminance (WCAG): 0 for black, 1 for white. */
export function luminance(color: Rgba): number {
    const [r, g, b] = [color.r, color.g, color.b].map((value) => {
        const unit = clamp(value, 0, 255) / 255;

        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The contrast ratio of a color on a ground (WCAG 2.2), counting the color's alpha. */
export function contrastRatio(foreground: Rgba, ground: Rgba): number {
    const base = ground.a < 1 ? over(ground, { r: 255, g: 255, b: 255, a: 1 }) : ground;
    const a = luminance(over(foreground, base));
    const b = luminance(base);

    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** How a ratio rates for normal text: AAA from 7, AA from 4.5, AA large (and UI parts) from 3, else fail. */
export function rating(ratio: number): "AAA" | "AA" | "AA large" | "fail" {
    if (ratio >= 7) {
        return "AAA";
    }

    if (ratio >= 4.5) {
        return "AA";
    }

    return ratio >= 3 ? "AA large" : "fail";
}

/** Black or white, whichever reads better on the color. */
export function readableOn(color: Rgba): "#000000" | "#ffffff" {
    const ground = over(color, { r: 128, g: 128, b: 128, a: 1 });

    return contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, ground) >=
        contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, ground)
        ? "#000000"
        : "#ffffff";
}

/** The color in OKLCH, as CSS text such as `oklch(72% 0.14 262)`, for the detail line of a swatch. */
export function toOklchText(color: Rgba): string {
    const lin = [color.r, color.g, color.b].map((value) => {
        const unit = clamp(value, 0, 255) / 255;

        return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * lin[0]! + 0.5363325363 * lin[1]! + 0.0514459929 * lin[2]!);
    const m = Math.cbrt(0.2119034982 * lin[0]! + 0.6806995451 * lin[1]! + 0.1073969566 * lin[2]!);
    const s = Math.cbrt(0.0883024619 * lin[0]! + 0.2817188376 * lin[1]! + 0.6299787005 * lin[2]!);
    const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const chroma = Math.hypot(a, b);
    const hue = chroma < 0.002 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
    const alpha = color.a < 0.999 ? ` / ${Math.round(color.a * 100)}%` : "";

    return `oklch(${Math.round(lightness * 100)}% ${chroma.toFixed(3)} ${Math.round((hue + 360) % 360)}${alpha})`;
}
