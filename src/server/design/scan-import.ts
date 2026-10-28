/**
 * Imports tokens that a project already keeps in a token file (stream T): W3C DTCG (`$value`), Style Dictionary
 * (`value`), and Tokens Studio (`value` and `type`, with `sizing`, `fontFamilies`, `boxShadow`...). The scan uses them
 * as they are: a project that has tokens does not need them guessed from its CSS.
 */
import { colorsIn } from "./scan-parse.ts";

type Obj = Record<string, unknown>;

/** Tokens found in token files: the default mode, the dark mode, and how many there are. */
export interface Imported {
    default: Obj;
    dark: Obj;
    count: number;
    files: string[];
}

const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** A file that may hold tokens: by its name, so `package.json` and `tsconfig.json` are never read as tokens. */
export const TOKEN_FILE =
    /(?:^|\/)(?:[^/]*tokens?[^/]*|theme[^/]*)\.json$|(?:^|\/)(?:design-)?tokens\/[^/]+\.json$/i;

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
]);

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

/** One token node as a DTCG token, or undefined when it is not one that the engine can hold. */
function convert(node: Obj, inherited: string | undefined): Obj | undefined {
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
        if (LENGTH_TYPES.has(key) && /^-?[\d.]+$/.test(value)) {
            out = `${value}px`;
        } else if (key.startsWith("lineheight") && /^[\d.]+%$/.test(value)) {
            out = Number.parseFloat(value) / 100;
        } else if (type === "number" && /^-?[\d.]+$/.test(value)) {
            out = Number(value);
        }
    } else if (typeof value === "number" && LENGTH_TYPES.has(key)) {
        out = `${value}px`;
    }

    if (type === "shadow") {
        out = Array.isArray(out) ? out.map(shadowLayer) : shadowLayer(out);
    }

    const token: Obj = type === undefined ? { $value: out } : { $value: out, $type: type };
    const description = node.$description ?? node.description ?? node.comment;

    if (typeof description === "string" && description !== "") {
        token.$description = description.slice(0, 200);
    }

    return token;
}

/** Reads a token file into `into`. Anything that is not a token file is ignored. */
export function importTokens(into: Imported, file: string, source: string): void {
    if (!TOKEN_FILE.test(file)) {
        return;
    }

    let root: unknown;

    try {
        root = JSON.parse(source);
    } catch {
        return;
    }

    if (!isObject(root)) {
        return;
    }

    const target = /(?:^|[^a-z])dark(?:[^a-z]|$)/i.test(file.split("/").at(-1) ?? "")
        ? into.dark
        : into.default;
    let added = 0;

    const visit = (node: Obj, out: Obj, inherited: string | undefined, depth: number) => {
        const type =
            typeof node.$type === "string"
                ? node.$type
                : typeof node.type === "string" && !("value" in node) && !("$value" in node)
                  ? node.type
                  : inherited;

        for (const [key, child] of Object.entries(node)) {
            if (
                key.startsWith("$") ||
                key === "__proto__" ||
                key === "constructor" ||
                key === "prototype" ||
                !isObject(child) ||
                depth > 12 ||
                !/^[\w-]{1,64}$/.test(key)
            ) {
                continue;
            }

            if ("$value" in child || "value" in child) {
                const token = convert(child, type);

                if (token !== undefined && added < 5000) {
                    out[key] = token;
                    added += 1;
                }
            } else {
                const group: Obj = {};

                visit(child, group, type, depth + 1);

                if (Object.keys(group).length > 0) {
                    out[key] = group;
                }
            }
        }
    };

    visit(root, target, undefined, 0);

    if (added > 0) {
        into.count += added;
        into.files.push(file);
    }
}
