/**
 * One token of a token file as a DTCG token (stream T). Style Dictionary (`value`, `type`), Tokens Studio (`value` and
 * `type` with `sizing`, `fontFamilies`, `boxShadow`, `lineHeights`, ...), and DTCG (`$value`, `$type`) are all read; a
 * value that has no unit gets the one its type implies, a font weight that is a name gets its number, and the members of
 * a type style, a shadow, and a border are put in the forms that the tokens engine reads.
 */
import { colorsIn } from "./scan-parse.ts";

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Tokens Studio and Style Dictionary type names to DTCG types.
const TYPES: Record<string, string> = {
    color: "color",
    dimension: "dimension",
    sizing: "dimension",
    spacing: "dimension",
    borderradius: "dimension",
    borderwidth: "dimension",
    fontsizes: "dimension",
    fontsize: "dimension",
    letterspacing: "dimension",
    paragraphspacing: "dimension",
    fontfamilies: "fontFamily",
    fontfamily: "fontFamily",
    fontweights: "fontWeight",
    fontweight: "fontWeight",
    lineheights: "number",
    lineheight: "number",
    opacity: "number",
    number: "number",
    boxshadow: "shadow",
    shadow: "shadow",
    typography: "typography",
    duration: "duration",
    cubicbezier: "cubicBezier",
    border: "border",
    transition: "transition",
    gradient: "gradient",
    strokestyle: "strokeStyle",
};

const LENGTH_TYPES = new Set([
    "sizing",
    "spacing",
    "borderradius",
    "borderwidth",
    "fontsizes",
    "fontsize",
    "letterspacing",
    "paragraphspacing",
    "dimension",
]);

/** The weights that Figma and CSS name, by the name with no space or hyphen, lowercase. */
const WEIGHTS: Record<string, number> = {
    thin: 100,
    hairline: 100,
    extralight: 200,
    ultralight: 200,
    light: 300,
    regular: 400,
    normal: 400,
    book: 400,
    medium: 500,
    semibold: 600,
    demibold: 600,
    bold: 700,
    extrabold: 800,
    ultrabold: 800,
    black: 900,
    heavy: 900,
};

/** A font weight as a number when it is a name (`Bold`, `Semi Bold`, `Bold Italic`) or a number in text. */
export function weightOf(value: unknown): unknown {
    if (typeof value === "number") {
        return value;
    }

    if (typeof value !== "string") {
        return value;
    }

    const text = value.trim();

    if (/^\d{3,4}$/.test(text)) {
        return Number(text);
    }

    if (text.startsWith("{") || text === "") {
        return value;
    }

    const name = text
        .toLowerCase()
        .replace(/\b(?:italic|oblique)\b/g, "")
        .replace(/[\s_-]+/g, "");

    return WEIGHTS[name] ?? value;
}

const px = (value: unknown): unknown =>
    typeof value === "number" ||
    (typeof value === "string" && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()))
        ? `${Number(value)}px`
        : value;

/** A letter spacing: a bare number is px, a percent is em (Figma's `-2%` is `-0.02em`). */
function trackingOf(value: unknown): unknown {
    if (typeof value === "string") {
        const percent = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*%\s*$/.exec(value);

        if (percent !== null) {
            return `${Number((Number(percent[1]) / 100).toFixed(4))}em`;
        }
    }

    return px(value);
}

/** A line height: a percent is a ratio, a bare number is a ratio (as Tokens Studio writes it), a length stays. */
function leadingOf(value: unknown): unknown {
    if (typeof value === "string") {
        const percent = /^\s*(\d+\.?\d*|\.\d+)\s*%\s*$/.exec(value);

        if (percent !== null) {
            return Number((Number(percent[1]) / 100).toFixed(4));
        }

        if (/^\s*(?:\d+\.?\d*|\.\d+)\s*$/.test(value)) {
            return Number(value);
        }
    }

    return value;
}

function shadowLayer(layer: unknown): unknown {
    if (!isObject(layer) || layer.x === undefined) {
        return layer;
    }

    const length = (value: unknown) =>
        typeof value === "number" || /^-?[\d.]+$/.test(String(value))
            ? `${value}px`
            : String(value);

    return {
        color: layer.color,
        offsetX: length(layer.x),
        offsetY: length(layer.y),
        blur: length(layer.blur ?? 0),
        ...(layer.spread === undefined ? {} : { spread: length(layer.spread) }),
        ...(layer.type === "innerShadow" ? { inset: true } : {}),
    };
}

/** A type style as the engine reads it: its five members, in their forms. Tokens Studio's other members are left out. */
function typographyOf(value: Obj): Obj {
    const out: Obj = {};
    const family = value.fontFamily ?? value.fontFamilies;
    const size = value.fontSize ?? value.fontSizes;
    const weight = value.fontWeight ?? value.fontWeights;
    const leading = value.lineHeight ?? value.lineHeights;

    if (family !== undefined) {
        out.fontFamily = family;
    }

    if (size !== undefined) {
        out.fontSize = px(size);
    }

    if (weight !== undefined) {
        out.fontWeight = weightOf(weight);
    }

    // Figma's `AUTO` is no number: the style has no line height of its own.
    if (leading !== undefined && !/^\s*(?:auto|normal)\s*$/i.test(String(leading))) {
        out.lineHeight = leadingOf(leading);
    }

    if (value.letterSpacing !== undefined) {
        out.letterSpacing = trackingOf(value.letterSpacing);
    }

    return out;
}

/** A border as the engine reads it: color, width, style. */
function borderOf(value: Obj): Obj {
    return {
        ...(value.color === undefined ? {} : { color: value.color }),
        ...(value.width === undefined ? {} : { width: px(value.width) }),
        ...(value.style === undefined ? {} : { style: value.style }),
    };
}

/** One token node as a DTCG token, or undefined when it is not one that the engine can hold. */
export function convert(node: Obj, inherited: string | undefined): Obj | undefined {
    const value = node.$value ?? node.value;

    if (value === undefined || (typeof value === "object" && value === null)) {
        return undefined;
    }

    const rawType = String(node.$type ?? node.type ?? inherited ?? "");
    const key = rawType.toLowerCase();
    const type =
        TYPES[key] ??
        (rawType === "" && typeof value === "string"
            ? colorsIn(value, true).length === 1 && colorsIn(value, true)[0]!.text === value.trim()
                ? "color"
                : undefined
            : undefined);
    let out: unknown = value;

    // A reference takes its type from the token it points at, and a mode file leaves the type to the default mode.
    const reference = typeof value === "string" && /^\{[^{}]+\}$/.test(value.trim());

    if (type === undefined && !reference) {
        return undefined;
    }

    if (typeof value === "string" && !value.startsWith("{")) {
        if (key === "letterspacing" && type === "dimension") {
            out = trackingOf(value);
        } else if (LENGTH_TYPES.has(key) && /^-?[\d.]+$/.test(value)) {
            out = `${value}px`;
        } else if (key.startsWith("lineheight") && /^[\d.]+%$/.test(value)) {
            out = Number.parseFloat(value) / 100;
        } else if (type === "number" && key === "opacity" && /^[\d.]+%$/.test(value)) {
            out = Number.parseFloat(value) / 100;
        } else if (type === "number" && /^-?[\d.]+$/.test(value)) {
            out = Number(value);
        } else if (type === "fontWeight") {
            out = weightOf(value);
        }
    } else if (typeof value === "number" && LENGTH_TYPES.has(key)) {
        out = `${value}px`;
    }

    if (type === "shadow") {
        out = Array.isArray(out) ? out.map(shadowLayer) : shadowLayer(out);
    } else if (type === "typography" && isObject(out)) {
        out = typographyOf(out);
    } else if (type === "border" && isObject(out)) {
        out = borderOf(out);
    }

    // A number that is not one (`AUTO`) is no token.
    if (type === "number" && typeof out === "string" && !out.trim().startsWith("{")) {
        return undefined;
    }

    const token: Obj = type === undefined ? { $value: out } : { $value: out, $type: type };
    const description = node.$description ?? node.description ?? node.comment;

    if (typeof description === "string" && description !== "") {
        token.$description = description.slice(0, 200);
    }

    return token;
}
