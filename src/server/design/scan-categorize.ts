/** What a variable holds, from its value's syntax and its name (stream T): a shadow, a duration, an easing, a radius, a font stack. */
import { commaParts, px } from "./scan-parse.ts";
import { parseColor } from "./color.ts";
import { type Category, type Facts, namespaceOf } from "./scan-facts.ts";
import { channelColor, type Variable } from "./scan-variables.ts";
import { SASS_COLOR } from "./scan-sass-colors.ts";

export const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|ch|pt)?$/;

const FONT_WORDS =
    /sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-monospace|ui-serif|cursive/i;

/** What a variable holds, from where it is set, its value, and then its name. */
const COLOR_TOKEN =
    /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var|light-dark)\(.*\)|transparent|currentcolor|[a-z]{3,20})$/i;

/**
 * Whether a value is a `box-shadow`: one or more comma-separated layers, each with two to four lengths (offsets, blur,
 * spread), at most one color (first or last), and perhaps `inset`.
 */
export function looksLikeShadow(text: string): boolean {
    const layers = commaParts(text.trim());

    if (
        layers.length === 0 ||
        layers.length > 8 ||
        /^(?:none|inherit|initial|unset)$/i.test(text.trim())
    ) {
        return false;
    }

    return layers.every((layer) => {
        const tokens = layer.match(/(?:[^\s(]|\([^)]*(?:\([^)]*\)[^)]*)*\))+/g) ?? [];
        const lengths = tokens.filter((token) => /^-?(?:\d*\.?\d+)(?:px|rem|em)?$/i.test(token));
        const others = tokens.filter(
            (token) =>
                !/^-?(?:\d*\.?\d+)(?:px|rem|em)?$/i.test(token) && token.toLowerCase() !== "inset",
        );

        return (
            lengths.length >= 2 &&
            lengths.length <= 4 &&
            others.length === 1 &&
            COLOR_TOKEN.test(others[0]!) &&
            tokens.length ===
                lengths.length +
                    others.length +
                    (tokens.some((token) => token.toLowerCase() === "inset") ? 1 : 0)
        );
    });
}

export function categorize(
    variable: Variable,
    text: string,
    layouts?: Facts["varLayout"],
): Category | undefined {
    if (variable.hint !== undefined) {
        return variable.hint;
    }

    const name = variable.name.toLowerCase();
    const space = namespaceOf(name);

    if (space !== undefined && variable.kind === "theme") {
        return space.category;
    }

    if (
        channelColor(text, name) !== undefined ||
        parseColor(text) !== undefined ||
        /^color-mix\(/i.test(text) ||
        // Sass and Less color functions over a variable: `rgba($black, .87)`, `darken($brand, 10%)`.
        (variable.kind !== "css" &&
            variable.kind !== "theme" &&
            /^([a-z][a-z-]*)\(\s*[$@\w#]/i.test(text) &&
            SASS_COLOR.has(/^([a-z][a-z-]*)/i.exec(text)![1]!.toLowerCase()))
    ) {
        return "color";
    }

    if (/^\d*\.?\d+(?:ms|s)$/.test(text)) {
        return "duration";
    }

    if (
        /^cubic-bezier\(|^(?:ease|ease-in|ease-out|ease-in-out|linear)$/.test(text) ||
        (/ease|easing|curve|timing/.test(name) && /\(/.test(text))
    ) {
        return "ease";
    }

    // A path or an address is not a font stack, whatever the variable is called (`--fa-font-path: "../fonts"`).
    if (
        !/[/\\]|\.(?:woff2?|ttf|otf|eot)\b|^url\(|^https?:/i.test(text) &&
        (FONT_WORDS.test(text) || (/font|family|typeface/.test(name) && /[,"']/.test(text)))
    ) {
        return "font";
    }

    if (/shadow|elevation/.test(name) && /\d/.test(text)) {
        return "shadow";
    }

    // Layers of offsets, a blur, a color, and `inset`, whatever the variable is called (`--drop-2`, `--lift`, `--z1`).
    if (looksLikeShadow(text)) {
        return "shadow";
    }

    if (/^\d{3}$/.test(text) && /weight|fw\b/.test(name)) {
        return "weight";
    }

    if (/^-?\d*\.?\d+$/.test(text)) {
        if (/leading|line-height|lh\b/.test(name)) {
            return "leading";
        }

        if (/^z|z-?index|layer/.test(name)) {
            return "z";
        }

        return /opacity|alpha/.test(name) ? "opacity" : undefined;
    }

    if (LENGTH.test(text)) {
        if (/radius|rounded|corner/.test(name)) {
            return "radius";
        }

        if (/tracking|letter/.test(name)) {
            return "tracking";
        }

        if (/breakpoint|screen|^bp-/.test(name)) {
            return "breakpoint";
        }

        if (/space|spacing|gap|gutter|pad|margin|inset/.test(name)) {
            return "space";
        }

        // A line height written as a length is not a size.
        if (/line-height|leading|(?:^|-)lh$/.test(name)) {
            return undefined;
        }

        if (/font-size|typescale|type-scale|^text-|-text-|^fs-|^type-|(?:^|-)step-\d/.test(name)) {
            return px(text) !== undefined && px(text)! >= 8 && px(text)! <= 160 ? "text" : "size";
        }

        // A length with a neutral name (`--size-4`) is what the properties that take it say it is.
        // The numbered family decides (`--size-1` to `--size-8`), since not every step is used.
        const stem = (each: string) => each.replace(/[-_]?\d+$/, "");
        const layout = { space: 0, text: 0, radius: 0, box: 0 };

        for (const [each, counts] of layouts ?? []) {
            if (
                each === variable.name ||
                (/\d$/.test(variable.name) && stem(each) === stem(variable.name))
            ) {
                layout.space += counts.space;
                layout.text += counts.text;
                layout.radius += counts.radius;
                layout.box += counts.box;
            }
        }

        const most = Math.max(layout.space, layout.text, layout.radius, layout.box);

        if (most > 0 && layout.box < most) {
            return layout.space === most ? "space" : layout.radius === most ? "radius" : "text";
        }

        return "size";
    }

    return undefined;
}
