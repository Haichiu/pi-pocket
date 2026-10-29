import { commaParts } from "./scan-parse.ts";
import { mixColors, parseColor, type Rgba } from "./color.ts";
import { channelColor, type Variable } from "./scan-variables.ts";
import { clamp } from "./scan-util.ts";

export function evalColor(
    text: string,
    name: string,
    mode: "light" | "dark",
    index: Map<string, Variable>,
    depth = 0,
): Rgba | undefined {
    const trimmed = text.trim();
    const direct = parseColor(channelColor(trimmed, name) ?? trimmed);

    if (direct !== undefined || depth > 6) {
        return direct;
    }

    const sassVar = /^(?:[\w-]+\.)?[$@]([\w-]+)$/.exec(trimmed);

    if (sassVar !== null) {
        const target = index.get(`scss:${sassVar[1]}`) ?? index.get(`less:${sassVar[1]}`);

        // Bootstrap and Sass libraries define these; a project that imports them does not repeat them.
        if (target === undefined && (sassVar[1] === "black" || sassVar[1] === "white")) {
            return parseColor(sassVar[1]);
        }

        const value = (
            mode === "dark" ? (target?.dark ?? target?.light) : (target?.light ?? target?.dark)
        )?.value;

        return value === undefined
            ? undefined
            : evalColor(value, sassVar[1]!, mode, index, depth + 1);
    }

    const call = /^([a-z][a-z-]*)\(([\s\S]*)\)$/i.exec(trimmed);

    if (call !== null && SASS_COLOR.has(call[1]!.toLowerCase())) {
        const args = commaParts(call[2]!);
        const color =
            args[0] === undefined ? undefined : evalColor(args[0], name, mode, index, depth + 1);

        const amount = (text: string | undefined) => {
            const match = /^(-?\d*\.?\d+)(%?)$/.exec((text ?? "").trim());

            return match === null
                ? undefined
                : match[2] === "%"
                  ? Number(match[1]) / 100
                  : Number(match[1]);
        };

        if (color !== undefined) {
            return sassColor(call[1]!.toLowerCase(), color, args.slice(1), amount, (arg) =>
                evalColor(arg, name, mode, index, depth + 1),
            );
        }
    }

    const reference = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(trimmed);

    if (reference !== null) {
        const target = index.get(`css:${reference[1]}`);
        const value = (
            mode === "dark" ? (target?.dark ?? target?.light) : (target?.light ?? target?.dark)
        )?.value;
        const next = value ?? reference[2];

        return next === undefined
            ? undefined
            : evalColor(next, reference[1]!, mode, index, depth + 1);
    }

    const mix =
        /^color-mix\(\s*in\s+([a-z0-9-]+)(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?\s*,([\s\S]*)\)$/i.exec(
            trimmed,
        );

    if (mix === null) {
        return undefined;
    }

    const args = commaParts(mix[2]!);

    if (args.length !== 2) {
        return undefined;
    }

    const operands = args.map((arg) => {
        const match = /^(?:(\d*\.?\d+)%\s+([\s\S]+)|([\s\S]+?)\s+(\d*\.?\d+)%)$/.exec(arg.trim());
        const colorText = match === null ? arg : (match[2] ?? match[3]!);
        const percent = match === null ? undefined : Number(match[1] ?? match[4]);
        const color = evalColor(colorText, name, mode, index, depth + 1);

        return color === undefined
            ? undefined
            : { color, ...(percent === undefined ? {} : { percent }) };
    });

    return operands[0] === undefined || operands[1] === undefined
        ? undefined
        : mixColors(mix[1]!.toLowerCase(), operands[0], operands[1]);
}

export const SASS_COLOR = new Set([
    "rgba",
    "rgb",
    "darken",
    "lighten",
    "saturate",
    "desaturate",
    "fade-in",
    "fade-out",
    "transparentize",
    "opacify",
    "mix",
    "tint-color",
    "shade-color",
    "shift-color",
    "adjust-hue",
]);

function toHsl({ r, g, b }: Rgba): [number, number, number] {
    const [x, y, z] = [r, g, b];
    const high = Math.max(x, y, z);
    const low = Math.min(x, y, z);
    const lightness = (high + low) / 2;
    const delta = high - low;

    if (delta === 0) {
        return [0, 0, lightness];
    }

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    const hue =
        high === x ? ((y - z) / delta) % 6 : high === y ? (z - x) / delta + 2 : (x - y) / delta + 4;

    return [(hue * 60 + 360) % 360, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number, a: number): Rgba {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const h = (((hue % 360) + 360) % 360) / 60;
    const second = chroma * (1 - Math.abs((h % 2) - 1));
    const [r, g, b] =
        h < 1
            ? [chroma, second, 0]
            : h < 2
              ? [second, chroma, 0]
              : h < 3
                ? [0, chroma, second]
                : h < 4
                  ? [0, second, chroma]
                  : h < 5
                    ? [second, 0, chroma]
                    : [chroma, 0, second];
    const offset = lightness - chroma / 2;

    return { r: r + offset, g: g + offset, b: b + offset, a };
}

function sassColor(
    fn: string,
    color: Rgba,
    rest: string[],
    amount: (text: string | undefined) => number | undefined,
    other: (text: string) => Rgba | undefined,
): Rgba | undefined {
    const value = amount(rest[0]);
    const mixWith = (target: Rgba, weight: number): Rgba => ({
        r: color.r * weight + target.r * (1 - weight),
        g: color.g * weight + target.g * (1 - weight),
        b: color.b * weight + target.b * (1 - weight),
        a: color.a * weight + target.a * (1 - weight),
    });
    const [hue, saturation, lightness] = toHsl(color);

    switch (fn) {
        case "rgba":
        case "rgb":
            return value === undefined ? undefined : { ...color, a: clamp(value) };

        case "fade-in":
        case "opacify":
            return value === undefined ? undefined : { ...color, a: clamp(color.a + value) };

        case "fade-out":
        case "transparentize":
            return value === undefined ? undefined : { ...color, a: clamp(color.a - value) };

        case "darken":
            return value === undefined
                ? undefined
                : fromHsl(hue, saturation, clamp(lightness - value), color.a);

        case "lighten":
            return value === undefined
                ? undefined
                : fromHsl(hue, saturation, clamp(lightness + value), color.a);

        case "saturate":
            return value === undefined
                ? undefined
                : fromHsl(hue, clamp(saturation + value), lightness, color.a);

        case "desaturate":
            return value === undefined
                ? undefined
                : fromHsl(hue, clamp(saturation - value), lightness, color.a);

        case "adjust-hue":
            return value === undefined
                ? undefined
                : fromHsl(
                      hue + value * (rest[0]?.includes("%") ? 1 : 1),
                      saturation,
                      lightness,
                      color.a,
                  );

        case "mix": {
            const second = rest[0] === undefined ? undefined : other(rest[0]);
            const weight = rest[1] === undefined ? 0.5 : amount(rest[1]);

            return second === undefined || weight === undefined
                ? undefined
                : mixWith(second, clamp(weight));
        }

        case "tint-color":
            return value === undefined
                ? undefined
                : fromMix(color, { r: 1, g: 1, b: 1, a: 1 }, value);

        case "shade-color":
            return value === undefined
                ? undefined
                : fromMix(color, { r: 0, g: 0, b: 0, a: 1 }, value);

        case "shift-color":
            return value === undefined
                ? undefined
                : value >= 0
                  ? fromMix(color, { r: 0, g: 0, b: 0, a: 1 }, value)
                  : fromMix(color, { r: 1, g: 1, b: 1, a: 1 }, -value);

        default:
            return undefined;
    }
}

function fromMix(color: Rgba, target: Rgba, weight: number): Rgba {
    const w = clamp(weight);

    return {
        r: target.r * w + color.r * (1 - w),
        g: target.g * w + color.g * (1 - w),
        b: target.b * w + color.b * (1 - w),
        a: color.a,
    };
}
