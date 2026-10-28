/**
 * Color math for the design system (stream T): parses every CSS color syntax and the DTCG color object into sRGB,
 * writes hex, and computes the WCAG 2.2 contrast ratio. Pure functions, no I/O.
 *
 * Wide-gamut colors (display-p3, oklch, lab...) are converted to sRGB and clipped per channel. That is exact for the
 * contrast check (WCAG defines luminance in sRGB) and close enough for a swatch.
 */

/** A color in sRGB: channels 0 to 1, alpha 0 to 1. */
export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** The CSS named colors, as `name:hex` pairs (the `transparent` keyword is handled apart). */
const NAMES =
    "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";

/** The named colors, by name, as `#rrggbb`. */
export const NAMED_COLORS: ReadonlyMap<string, string> = new Map(
    NAMES.split(",").map((pair) => {
        const [name, hex] = pair.split(":");

        return [name!, `#${hex!}`];
    }),
);

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));

type Matrix = readonly [number, number, number, number, number, number, number, number, number];

const multiply = (
    m: Matrix,
    [x, y, z]: readonly [number, number, number],
): [number, number, number] => [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
];

// Linear RGB of each space to XYZ (D65), and back to sRGB; the D50 to D65 adaptation. From CSS Color 4.
const XYZ_TO_SRGB: Matrix = [
    3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796,
    1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652,
    1.0569715142428786,
];
const P3_TO_XYZ: Matrix = [
    0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488,
    0.6917385218365064, 0.079286914093745, 0.0, 0.04511338185890264, 1.043944368900976,
];
const A98_TO_XYZ: Matrix = [
    0.5766690429101305, 0.1855582379065463, 0.1882286462349947, 0.29734497525053605,
    0.6273635662554661, 0.0752914584939978, 0.02703136138641234, 0.07068885253582723,
    0.9913375368376388,
];
const REC2020_TO_XYZ: Matrix = [
    0.6369580483012914, 0.14461690358620832, 0.1688809751641721, 0.2627002120112671,
    0.6779980715188708, 0.05930171646986196, 0.0, 0.028072693049087428, 1.060985057710791,
];
const D50_TO_D65: Matrix = [
    0.9554734527042182, -0.023098536874261423, 0.0632593086610217, -0.028369706963208136,
    1.0099954580058226, 0.021041398966943008, 0.012314001688319899, -0.020507696433477912,
    1.3303659366080753,
];
const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585] as const;

// The transfer functions: sRGB's (also Display P3's), and the pure gamma of Adobe RGB and Rec. 2020's.
const decodeSrgb = (v: number) =>
    Math.sign(v) *
    (Math.abs(v) <= 0.04045 ? Math.abs(v) / 12.92 : ((Math.abs(v) + 0.055) / 1.055) ** 2.4);
const encodeSrgb = (v: number) =>
    Math.sign(v) *
    (Math.abs(v) <= 0.0031308 ? 12.92 * Math.abs(v) : 1.055 * Math.abs(v) ** (1 / 2.4) - 0.055);
const decodeA98 = (v: number) => Math.sign(v) * Math.abs(v) ** (563 / 256);
const ALPHA2020 = 1.09929682680944;
const BETA2020 = 0.018053968510807;
const decodeRec2020 = (v: number) =>
    Math.sign(v) *
    (Math.abs(v) < BETA2020 * 4.5
        ? Math.abs(v) / 4.5
        : ((Math.abs(v) + ALPHA2020 - 1) / ALPHA2020) ** (1 / 0.45));

/** Linear sRGB (not clipped) to an `Rgba`: encode, then clip to the gamut. */
function fromLinear([r, g, b]: readonly [number, number, number], a: number): Rgba {
    return {
        r: clamp(encodeSrgb(r)),
        g: clamp(encodeSrgb(g)),
        b: clamp(encodeSrgb(b)),
        a: clamp(a),
    };
}

/** XYZ (D65) to an `Rgba`. */
const fromXyz = (xyz: readonly [number, number, number], a: number): Rgba =>
    fromLinear(multiply(XYZ_TO_SRGB, xyz), a);

/** Oklab to an `Rgba` (Björn Ottosson's matrices). */
export function fromOklab(l: number, a: number, b: number, alpha: number): Rgba {
    const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

    return fromLinear(
        [
            4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp,
            -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp,
            -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp,
        ],
        alpha,
    );
}

/** CIE Lab (D50, as CSS defines it) to an `Rgba`. */
function fromLab(l: number, a: number, b: number, alpha: number): Rgba {
    const kappa = 24389 / 27;
    const epsilon = 216 / 24389;
    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const cube = (f: number) => (f ** 3 > epsilon ? f ** 3 : (116 * f - 16) / kappa);
    const xyz50: [number, number, number] = [
        cube(fx) * D50_WHITE[0],
        (l > kappa * epsilon ? fy ** 3 : l / kappa) * D50_WHITE[1],
        cube(fz) * D50_WHITE[2],
    ];

    return fromXyz(multiply(D50_TO_D65, xyz50), alpha);
}

function fromHsl(h: number, s: number, l: number, alpha: number): Rgba {
    const hue = (((h % 360) + 360) % 360) / 30;
    const sat = clamp(s);
    const light = clamp(l);
    const amount = sat * Math.min(light, 1 - light);

    const channel = (n: number) => {
        const k = (n + hue) % 12;

        return light - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };

    return { r: clamp(channel(0)), g: clamp(channel(8)), b: clamp(channel(4)), a: clamp(alpha) };
}

function fromHwb(h: number, w: number, b: number, alpha: number): Rgba {
    const total = w + b;
    const white = total > 1 ? w / total : w;
    const black = total > 1 ? b / total : b;
    const base = fromHsl(h, 1, 0.5, alpha);
    const mix = (value: number) => clamp(value * (1 - white - black) + white);

    return { r: mix(base.r), g: mix(base.g), b: mix(base.b), a: base.a };
}

/** The color spaces of `color()` and the DTCG color object that this module converts. */
const SPACES = [
    "srgb",
    "srgb-linear",
    "display-p3",
    "a98-rgb",
    "rec2020",
    "xyz",
    "xyz-d65",
    "xyz-d50",
] as const;

/** A color given in one of the `color()` spaces, 0 to 1 per channel (XYZ unbounded). */
function fromSpace(space: string, c: readonly [number, number, number], alpha: number): Rgba {
    switch (space) {
        case "srgb":
            return { r: clamp(c[0]), g: clamp(c[1]), b: clamp(c[2]), a: clamp(alpha) };
        case "srgb-linear":
            return fromLinear(c, alpha);
        case "display-p3":
            return fromXyz(
                multiply(P3_TO_XYZ, [decodeSrgb(c[0]), decodeSrgb(c[1]), decodeSrgb(c[2])]),
                alpha,
            );
        case "a98-rgb":
            return fromXyz(
                multiply(A98_TO_XYZ, [decodeA98(c[0]), decodeA98(c[1]), decodeA98(c[2])]),
                alpha,
            );
        case "rec2020":
            return fromXyz(
                multiply(REC2020_TO_XYZ, [
                    decodeRec2020(c[0]),
                    decodeRec2020(c[1]),
                    decodeRec2020(c[2]),
                ]),
                alpha,
            );
        case "xyz-d50":
            return fromXyz(multiply(D50_TO_D65, c), alpha);
        default:
            return fromXyz(c, alpha);
    }
}

/** An angle in degrees: a bare number, or one with `deg`, `grad`, `rad`, or `turn`. */
function angle(token: string): number | undefined {
    if (token === "none") {
        return 0;
    }

    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/.exec(token);

    if (match === null) {
        return undefined;
    }

    const value = Number(match[1]);

    switch (match[2]) {
        case "grad":
            return value * 0.9;
        case "rad":
            return (value * 180) / Math.PI;
        case "turn":
            return value * 360;
        default:
            return value;
    }
}

/** A number or a percentage of `scale`; `none` is 0. Anything else (a `calc()`, a `var()`) is undefined. */
function amount(token: string, scale: number): number | undefined {
    if (token === "none") {
        return 0;
    }

    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/.exec(token);

    if (match === null) {
        return undefined;
    }

    return match[2] === "%" ? (Number(match[1]) / 100) * scale : Number(match[1]);
}

/** A saturation, lightness, whiteness, or blackness: `50%` or `50` (both mean half), as 0 to 1. */
function percentage(token: string): number | undefined {
    const value = amount(token.replace(/%$/, ""), 100);

    return value === undefined ? undefined : value / 100;
}

function parseHex(text: string): Rgba | undefined {
    const digits = text.slice(1);

    if (!/^[0-9a-f]+$/.test(digits) || ![3, 4, 6, 8].includes(digits.length)) {
        return undefined;
    }

    const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
    const byte = (at: number) => parseInt(full.slice(at, at + 2), 16) / 255;

    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) : 1 };
}

/**
 * Parses a CSS color: hex (3, 4, 6, 8 digits), `rgb()`/`rgba()`, `hsl()`/`hsla()`, `hwb()`, `lab()`, `lch()`,
 * `oklab()`, `oklch()`, `color()` in the spaces above, a name, or `transparent`. Undefined for anything else,
 * including `currentColor`, `var()`, and `color-mix()`, which have no value of their own.
 */
export function parseColor(input: string): Rgba | undefined {
    const text = input.trim().toLowerCase();

    if (text.startsWith("#")) {
        return parseHex(text);
    }

    if (text === "transparent") {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    const named = NAMED_COLORS.get(text);

    if (named !== undefined) {
        return parseHex(named);
    }

    const call = /^([a-z]+)\(\s*([^()]*?)\s*\)$/.exec(text);

    if (call === null) {
        return undefined;
    }

    const [, name, args] = call as unknown as [string, string, string];
    const [main = "", slash] = args.split("/");
    const parts = main
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    let alphaToken = slash?.trim();

    // The legacy form carries alpha as a fourth comma-separated part.
    if (alphaToken === undefined && parts.length === 4 && name !== "color") {
        alphaToken = parts.pop();
    }

    const alpha = alphaToken === undefined ? 1 : amount(alphaToken, 1);

    if (alpha === undefined) {
        return undefined;
    }

    if (name === "color") {
        const space = parts.shift();

        if (
            space === undefined ||
            !(SPACES as readonly string[]).includes(space) ||
            parts.length !== 3
        ) {
            return undefined;
        }

        const values = parts.map((part) => amount(part, 1));

        return values.includes(undefined)
            ? undefined
            : fromSpace(space, values as unknown as [number, number, number], alpha);
    }

    if (parts.length !== 3) {
        return undefined;
    }

    const [x, y, z] = parts as [string, string, string];

    switch (name) {
        case "rgb":

        case "rgba": {
            const [r, g, b] = [amount(x, 255), amount(y, 255), amount(z, 255)];

            return r === undefined || g === undefined || b === undefined
                ? undefined
                : { r: clamp(r / 255), g: clamp(g / 255), b: clamp(b / 255), a: clamp(alpha) };
        }

        case "hsl":

        case "hsla": {
            const [h, s, l] = [angle(x), percentage(y), percentage(z)];

            return h === undefined || s === undefined || l === undefined
                ? undefined
                : fromHsl(h, s, l, alpha);
        }

        case "hwb": {
            const [h, w, b] = [angle(x), percentage(y), percentage(z)];

            return h === undefined || w === undefined || b === undefined
                ? undefined
                : fromHwb(h, w, b, alpha);
        }

        case "lab": {
            const [l, a, b] = [amount(x, 100), amount(y, 125), amount(z, 125)];

            return l === undefined || a === undefined || b === undefined
                ? undefined
                : fromLab(l, a, b, alpha);
        }

        case "lch": {
            const [l, c, h] = [amount(x, 100), amount(y, 150), angle(z)];

            if (l === undefined || c === undefined || h === undefined) {
                return undefined;
            }

            const rad = (h * Math.PI) / 180;

            return fromLab(l, c * Math.cos(rad), c * Math.sin(rad), alpha);
        }

        case "oklab": {
            const [l, a, b] = [amount(x, 1), amount(y, 0.4), amount(z, 0.4)];

            return l === undefined || a === undefined || b === undefined
                ? undefined
                : fromOklab(l, a, b, alpha);
        }

        case "oklch": {
            const [l, c, h] = [amount(x, 1), amount(y, 0.4), angle(z)];

            if (l === undefined || c === undefined || h === undefined) {
                return undefined;
            }

            const rad = (h * Math.PI) / 180;

            return fromOklab(l, c * Math.cos(rad), c * Math.sin(rad), alpha);
        }

        default:
            return undefined;
    }
}

/** A number for CSS: at most `digits` decimals, no trailing zeros, no `-0`. */
export function num(value: number, digits = 4): string {
    const text = String(Number(value.toFixed(digits)));

    return text === "-0" ? "0" : text;
}

/** `#rrggbb`, or `#rrggbbaa` when the color is not opaque. */
export function toHex(color: Rgba): string {
    const byte = (value: number) =>
        Math.round(clamp(value) * 255)
            .toString(16)
            .padStart(2, "0");
    const base = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;

    return color.a < 1 ? `${base}${byte(color.a)}` : base;
}

/** The color over an opaque `backdrop` (alpha compositing). The result is opaque when the backdrop is. */
export function over(color: Rgba, backdrop: Rgba): Rgba {
    const a = color.a + backdrop.a * (1 - color.a);

    if (a === 0) {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    const mix = (top: number, bottom: number) =>
        (top * color.a + bottom * backdrop.a * (1 - color.a)) / a;

    return {
        r: mix(color.r, backdrop.r),
        g: mix(color.g, backdrop.g),
        b: mix(color.b, backdrop.b),
        a,
    };
}

/** The WCAG 2.2 relative luminance of the color's rgb channels, 0 (black) to 1 (white). */
export function luminance(color: Rgba): number {
    return (
        0.2126 * decodeSrgb(color.r) + 0.7152 * decodeSrgb(color.g) + 0.0722 * decodeSrgb(color.b)
    );
}

/**
 * The WCAG 2.2 contrast ratio, 1 to 21, of `foreground` on `background`. A translucent foreground is composited over
 * the background; a translucent background over `page` (white by default), as the page behind it would show.
 */
export function contrastRatio(
    foreground: Rgba,
    background: Rgba,
    page: Rgba = { r: 1, g: 1, b: 1, a: 1 },
): number {
    const back = over(background, page);
    const front = over(foreground, back);
    const [high, low] = [luminance(front), luminance(back)].sort((a, b) => b - a) as [
        number,
        number,
    ];

    return (high + 0.05) / (low + 0.05);
}

/** The color in Oklab: lightness 0 to 1, and the green-red and blue-yellow axes. */
export function toOklab(color: Rgba): { l: number; a: number; b: number } {
    const { l, c, h } = toOklch(color);
    const rad = (h * Math.PI) / 180;

    return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
}

/** The color as Oklch: lightness 0 to 1, chroma (about 0 to 0.4), hue in degrees (0 when the color is gray). */
export function toOklch(color: Rgba): { l: number; c: number; h: number } {
    const r = decodeSrgb(color.r);
    const g = decodeSrgb(color.g);
    const b = decodeSrgb(color.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const chroma = Math.hypot(a, bb);
    const hue = chroma < 0.0004 ? 0 : ((((Math.atan2(bb, a) * 180) / Math.PI) % 360) + 360) % 360;

    return { l: lightness, c: chroma, h: hue };
}

/** The `oklch()` CSS text of a color: `oklch(0.72 0.12 264)`, with `/ alpha` when not opaque. */
export function toOklchCss(color: Rgba): string {
    const { l, c, h } = toOklch(color);

    return `oklch(${num(l, 3)} ${num(c, 3)} ${num(h, 1)}${color.a < 1 ? ` / ${num(color.a, 3)}` : ""})`;
}

/** The color spaces of the DTCG color object, and the CSS function or `color()` space that writes each. */
const OBJECT_SPACES: Record<string, { css: string; scale: readonly string[] }> = {
    srgb: { css: "srgb", scale: ["", "", ""] },
    "srgb-linear": { css: "srgb-linear", scale: ["", "", ""] },
    hsl: { css: "hsl", scale: ["", "%", "%"] },
    hwb: { css: "hwb", scale: ["", "%", "%"] },
    lab: { css: "lab", scale: ["", "", ""] },
    lch: { css: "lch", scale: ["", "", ""] },
    oklab: { css: "oklab", scale: ["", "", ""] },
    oklch: { css: "oklch", scale: ["", "", ""] },
    "display-p3": { css: "display-p3", scale: ["", "", ""] },
    "a98-rgb": { css: "a98-rgb", scale: ["", "", ""] },
    rec2020: { css: "rec2020", scale: ["", "", ""] },
    "xyz-d65": { css: "xyz-d65", scale: ["", "", ""] },
    "xyz-d50": { css: "xyz-d50", scale: ["", "", ""] },
};

/** The color spaces that a DTCG color object may name. */
export const COLOR_SPACES = Object.keys(OBJECT_SPACES);

/**
 * A DTCG 2025.10 color object (`{ colorSpace, components, alpha?, hex? }`) as CSS text, or an error message that says
 * how to fix it. `srgb` without alpha is written as hex; the other spaces as their CSS function.
 */
export function colorObjectCss(value: unknown): { css: string } | { error: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { error: "a color object must be { colorSpace, components, alpha? }" };
    }

    const { colorSpace, components, alpha, hex } = value as Record<string, unknown>;
    const space = typeof colorSpace === "string" ? OBJECT_SPACES[colorSpace] : undefined;

    if (typeof colorSpace !== "string" || space === undefined) {
        return {
            error: `colorSpace must be one of ${COLOR_SPACES.join(", ")}${typeof colorSpace === "string" ? ` (got "${colorSpace.slice(0, 30)}")` : ""}`,
        };
    }

    if (
        !Array.isArray(components) ||
        components.length !== 3 ||
        !components.every((c) => c === "none" || (typeof c === "number" && Number.isFinite(c)))
    ) {
        return { error: `components must be an array of 3 numbers (or "none") for ${colorSpace}` };
    }

    if (alpha !== undefined && (typeof alpha !== "number" || !(alpha >= 0 && alpha <= 1))) {
        return { error: "alpha must be a number from 0 to 1" };
    }

    if (
        hex !== undefined &&
        (typeof hex !== "string" || parseHex(hex.toLowerCase()) === undefined)
    ) {
        return { error: "hex must be a color such as #7aa2f7" };
    }

    const parts = components.map((c, at) =>
        c === "none" ? "none" : `${num(c as number)}${space.scale[at]}`,
    );
    const tail = alpha === undefined || alpha === 1 ? "" : ` / ${num(alpha)}`;

    if (colorSpace === "srgb") {
        const [r, g, b] = components.map((c) => (c === "none" ? 0 : (c as number)));

        if (tail === "") {
            return { css: toHex({ r: r!, g: g!, b: b!, a: 1 }) };
        }

        const byte = (value: number) => Math.round(clamp(value) * 255);

        return { css: `rgb(${byte(r!)} ${byte(g!)} ${byte(b!)}${tail})` };
    }

    if (["hsl", "hwb", "lab", "lch", "oklab", "oklch"].includes(colorSpace)) {
        return { css: `${colorSpace}(${parts.join(" ")}${tail})` };
    }

    return { css: `color(${space.css} ${parts.join(" ")}${tail})` };
}

/**
 * `color-mix()` of two colors in `space`, as CSS Color 5 defines it for the rectangular spaces: the components are mixed
 * premultiplied by alpha. `srgb` mixes the encoded channels; every other space (`oklab`, `oklch`, `lab`...) is mixed in
 * Oklab, which is close for a draft. A percentage left out is the rest of 100%; if both add to less than 100%, the mix
 * is translucent by the difference.
 */
export function mixColors(
    space: string,
    first: { color: Rgba; percent?: number },
    second: { color: Rgba; percent?: number },
): Rgba {
    const p1 = first.percent ?? (second.percent === undefined ? 50 : 100 - second.percent);
    const p2 = second.percent ?? (first.percent === undefined ? 50 : 100 - first.percent);

    const total = p1 + p2;

    if (total <= 0) {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    const w1 = p1 / total;
    const w2 = p2 / total;
    const alpha = (first.color.a * w1 + second.color.a * w2) * Math.min(1, total / 100);
    const a1 = first.color.a * w1;
    const a2 = second.color.a * w2;
    const sum = a1 + a2;

    if (sum === 0) {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    if (space === "srgb" || space === "srgb-linear") {
        const mix = (x: number, y: number) =>
            space === "srgb"
                ? (x * a1 + y * a2) / sum
                : encodeSrgb((decodeSrgb(x) * a1 + decodeSrgb(y) * a2) / sum);

        return {
            r: clamp(mix(first.color.r, second.color.r)),
            g: clamp(mix(first.color.g, second.color.g)),
            b: clamp(mix(first.color.b, second.color.b)),
            a: clamp(alpha),
        };
    }

    const x = toOklab(first.color);
    const y = toOklab(second.color);

    return fromOklab(
        (x.l * a1 + y.l * a2) / sum,
        (x.a * a1 + y.a * a2) / sum,
        (x.b * a1 + y.b * a2) / sum,
        alpha,
    );
}
