import {
    encodeSrgb,
    fromHsl as unitHsl,
    luminance as unitLuminance,
    NAMED_COLORS,
    oklabOf,
    oklabToLinear,
    parseHex as unitHex,
    type Rgba,
} from "./color.ts";

// Channels here run from 0 to 255, not from 0 to 1 as in color.ts.
export type { Rgba };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const toBytes = (color: Rgba): Rgba => ({
    r: color.r * 255,
    g: color.g * 255,
    b: color.b * 255,
    a: color.a,
});

const toUnits = (color: Rgba): Rgba => ({
    r: clamp(color.r, 0, 255) / 255,
    g: clamp(color.g, 0, 255) / 255,
    b: clamp(color.b, 0, 255) / 255,
    a: color.a,
});

const NAMES = new Set([
    "black",
    "white",
    "red",
    "green",
    "blue",
    "gray",
    "grey",
    "yellow",
    "orange",
    "purple",
    "cyan",
    "magenta",
]);

function parseHex(text: string): Rgba | undefined {
    const color = text.startsWith("#") ? unitHex(text.toLowerCase()) : undefined;

    return color === undefined ? undefined : toBytes(color);
}

function parseName(text: string): Rgba | undefined {
    const name = text.toLowerCase();

    if (name === "transparent") {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    return NAMES.has(name) ? parseHex(NAMED_COLORS.get(name)!) : undefined;
}

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

const fromHsl = (h: number, s: number, l: number, a: number): Rgba => ({
    ...toBytes(unitHsl(h, s / 100, l / 100, 1)),
    a,
});

function fromOklab(l: number, a: number, b: number, alpha: number): Rgba {
    const channels = oklabToLinear(l, a, b).map((value) => encodeSrgb(clamp(value, 0, 1)) * 255);

    return { r: channels[0]!, g: channels[1]!, b: channels[2]!, a: alpha };
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

export function parseColor(value: unknown): Rgba | undefined {
    if (typeof value === "string") {
        const text = value.trim();

        return parseHex(text) ?? parseFunctional(text) ?? parseName(text);
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

export function toHex(color: Rgba): string {
    const base = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;

    return color.a < 0.999 ? `${base}${hex2(color.a * 255)}` : base;
}

export function over(color: Rgba, ground: Rgba): Rgba {
    const a = clamp(color.a, 0, 1);

    return {
        r: color.r * a + ground.r * (1 - a),
        g: color.g * a + ground.g * (1 - a),
        b: color.b * a + ground.b * (1 - a),
        a: 1,
    };
}

export const luminance = (color: Rgba): number => unitLuminance(toUnits(color));

export function contrastRatio(foreground: Rgba, ground: Rgba): number {
    const base = ground.a < 1 ? over(ground, { r: 255, g: 255, b: 255, a: 1 }) : ground;
    const a = luminance(over(foreground, base));
    const b = luminance(base);

    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function rating(ratio: number): "AAA" | "AA" | "AA large" | "fail" {
    if (ratio >= 7) {
        return "AAA";
    }

    if (ratio >= 4.5) {
        return "AA";
    }

    return ratio >= 3 ? "AA large" : "fail";
}

export function readableOn(color: Rgba): "#000000" | "#ffffff" {
    const ground = over(color, { r: 128, g: 128, b: 128, a: 1 });

    return contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, ground) >=
        contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, ground)
        ? "#000000"
        : "#ffffff";
}

export function toOklchText(color: Rgba): string {
    const [lightness, a, b] = oklabOf(toUnits(color));
    const chroma = Math.hypot(a, b);
    const hue = chroma < 0.002 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
    const alpha = color.a < 0.999 ? ` / ${Math.round(color.a * 100)}%` : "";

    return `oklch(${Math.round(lightness * 100)}% ${chroma.toFixed(3)} ${Math.round((hue + 360) % 360)}${alpha})`;
}
