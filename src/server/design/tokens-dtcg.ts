/**
 * The JSON files of `dist/` (stream T): `tokens.<mode>.resolved.json` (DTCG, the main JSON output), `tokens.studio.json`
 * (one file for Tokens Studio, with a token set for each mode and a `$themes` array), and `tokens.resolved.json` (a
 * compact summary for scripts). Pure functions of the resolved tokens, like the rest of the compiler.
 *
 * DTCG has two forms of its basic values. The 2021 to 2024 drafts, which Style Dictionary 4 and Tokens Studio read,
 * write a color as a string (`"#7aa2f7"`) and a dimension as a string (`"16px"`). The 2025.10 draft writes a color as
 * `{ colorSpace, components, alpha, hex }`, and a dimension or a duration as `{ value, unit }`. The default here is the
 * string form (`"2021"`); `$extensions["com.pi-pocket"].format: "2025.10"` in `tokens.json` gives the object form in
 * the per-mode files. Either way a file has one form throughout, whatever form the tokens were written in.
 */
import type { CompileInput } from "./tokens-compile.ts";
import { colorObjectCss, parseColor, toHex, type Rgba } from "./color.ts";
import type { ResolvedToken, TokenType } from "./system-types.ts";

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The `color-scheme` value of a mode. */
const schemeOf = (system: CompileInput, mode: string) => system.schemes[mode] ?? "light";

// --- The two forms of a color, a dimension, and a duration --------------------------------------------------------------

/** Four decimals, which is finer than 8 bits can tell apart. */
const round = (value: number) => Number(value.toFixed(4));

/** A color as `{ colorSpace, components, alpha, hex }` (sRGB); anything that is not a color stays as it is. */
function colorObject(value: unknown): unknown {
    if (isObject(value)) {
        if (typeof value.hex === "string" || !Object.hasOwn(value, "colorSpace")) {
            return value;
        }

        const css = colorObjectCss(value);
        const rgba = "css" in css ? parseColor(css.css) : undefined;

        return rgba === undefined ? value : { ...value, hex: toHex({ ...rgba, a: 1 }) };
    }

    const rgba: Rgba | undefined = typeof value === "string" ? parseColor(value) : undefined;

    return rgba === undefined
        ? value
        : {
              colorSpace: "srgb",
              components: [round(rgba.r), round(rgba.g), round(rgba.b)],
              alpha: round(rgba.a),
              hex: toHex({ ...rgba, a: 1 }),
          };
}

/** A color as a string: `#rrggbb`, `#rrggbbaa`, or the CSS function of its space. */
function colorString(value: unknown): unknown {
    if (!isObject(value)) {
        return value;
    }

    const css = colorObjectCss(value);

    return "css" in css ? css.css : value;
}

const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)$/i;
const TIME = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/i;

/** A `"16px"` or `"1.5rem"` as `{ value: 16, unit: "px" }`. DTCG 2025.10 has only px and rem; other units stay as text. */
function dimensionObject(value: unknown): unknown {
    const match = typeof value === "string" ? LENGTH.exec(value.trim()) : null;

    return match === null ? value : { value: Number(match[1]), unit: match[2]!.toLowerCase() };
}

/** A `"150ms"` or `"0.2s"` as `{ value: 150, unit: "ms" }`. */
function durationObject(value: unknown): unknown {
    const match = typeof value === "string" ? TIME.exec(value.trim()) : null;

    return match === null ? value : { value: Number(match[1]), unit: match[2]!.toLowerCase() };
}

/** `{ value: 16, unit: "px" }` as `"16px"`. */
const unitString = (value: unknown): unknown =>
    isObject(value) && typeof value.value === "number" && typeof value.unit === "string"
        ? `${value.value}${value.unit}`
        : value;

interface Forms {
    color: (value: unknown) => unknown;
    dimension: (value: unknown) => unknown;
    duration: (value: unknown) => unknown;
}

const STRINGS: Forms = { color: colorString, dimension: unitString, duration: unitString };
const OBJECTS: Forms = {
    color: colorObject,
    dimension: dimensionObject,
    duration: durationObject,
};

/** A token's value with its colors, dimensions, and durations in one form, also inside a shadow, a type style, and so on. */
function inForm(type: TokenType, value: unknown, forms: Forms): unknown {
    const members = (layer: unknown, map: Record<string, keyof Forms>) => {
        if (!isObject(layer)) {
            return layer;
        }

        const out: Obj = { ...layer };

        for (const [key, kind] of Object.entries(map)) {
            if (key in out) {
                out[key] = forms[kind](out[key]);
            }
        }

        return out;
    };

    switch (type) {
        case "color":
            return forms.color(value);
        case "dimension":
            return forms.dimension(value);
        case "duration":
            return forms.duration(value);

        case "shadow": {
            const layer = (each: unknown) =>
                members(each, {
                    color: "color",
                    offsetX: "dimension",
                    offsetY: "dimension",
                    blur: "dimension",
                    spread: "dimension",
                });

            return Array.isArray(value) ? value.map(layer) : layer(value);
        }

        case "typography":
            return members(value, { fontSize: "dimension", letterSpacing: "dimension" });
        case "border":
            return members(value, { color: "color", width: "dimension" });
        case "transition":
            return members(value, { duration: "duration", delay: "duration" });
        case "gradient":
            return Array.isArray(value)
                ? value.map((stop) => members(stop, { color: "color" }))
                : value;
        default:
            return value;
    }
}

// --- tokens.<mode>.resolved.json -----------------------------------------------------------------------------------------

/** A group, created on the way to a token's path. Defined, not assigned, so that a name such as `__proto__` is only a key. */
function groupAt(root: Obj, keys: readonly string[]): Obj {
    let group = root;

    for (const key of keys) {
        const next = group[key];

        if (isObject(next) && !("$value" in next)) {
            group = next;
        } else {
            const made: Obj = {};

            Object.defineProperty(group, key, {
                value: made,
                enumerable: true,
                writable: true,
                configurable: true,
            });
            group = made;
        }
    }

    return group;
}

function setKey(group: Obj, key: string, value: unknown): void {
    Object.defineProperty(group, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

/**
 * `tokens.<mode>.resolved.json`: the whole system in one mode as a DTCG file (the Design Tokens Community Group format
 * that Style Dictionary and Tokens Studio read). Groups nest by path; each token has `$type` and one `$value`, with
 * every reference followed; `$description` and `$deprecated` stay. The header says which draft the values follow.
 */
export function dtcgJson(system: CompileInput, mode: string): string {
    const draft = system.dtcgFormat ?? "2021";
    const root: Obj = {
        $description:
            draft === "2025.10"
                ? `${system.name}: every token in the ${mode} mode, references followed. DTCG draft 2025.10: a color is { colorSpace, components, alpha, hex }, a dimension or a duration is { value, unit }.`
                : `${system.name}: every token in the ${mode} mode, references followed. DTCG, the 2021 to 2024 drafts' string forms (the default): a color is "#7aa2f7", a dimension is "16px". Set "format": "2025.10" in tokens.json for the object forms.`,
        $extensions: {
            "com.pi-pocket": { mode, colorScheme: schemeOf(system, mode), format: draft },
        },
    };

    for (const token of system.tokens) {
        setKey(groupAt(root, token.path.slice(0, -1)), token.path.at(-1)!, {
            $type: token.type,
            $value: inForm(
                token.type,
                token.modes[mode]!.value,
                draft === "2025.10" ? OBJECTS : STRINGS,
            ),
            ...(token.description === undefined ? {} : { $description: token.description }),
            ...(token.deprecated === undefined ? {} : { $deprecated: token.deprecated }),
        });
    }

    return `${JSON.stringify(root, null, 2)}\n`;
}

// --- tokens.studio.json --------------------------------------------------------------------------------------------------

/** A token as Tokens Studio reads it: DTCG `$type` and `$value` (string forms), and a reference where the mode has one. */
function studioToken(token: ResolvedToken, mode: string): Obj {
    const value = token.modes[mode]!;

    return {
        $type: token.type,
        $value:
            value.alias === undefined
                ? inForm(token.type, value.value, STRINGS)
                : `{${value.alias}}`,
        ...(token.description === undefined ? {} : { $description: token.description }),
    };
}

/**
 * `tokens.studio.json`: one file in the single-file format of Tokens Studio. A token set for each mode (every token, so
 * that a set stands alone, with the references that the mode has), a `$themes` array with a theme for each mode that
 * turns on its set and turns off the others, and `$metadata.tokenSetOrder`. Always in the string forms, which Tokens
 * Studio reads.
 */
export function studioJson(system: CompileInput): string {
    const root: Obj = {};

    for (const mode of system.modes) {
        const set: Obj = {};

        for (const token of system.tokens) {
            setKey(
                groupAt(set, token.path.slice(0, -1)),
                token.path.at(-1)!,
                studioToken(token, mode),
            );
        }

        setKey(root, mode, set);
    }

    setKey(
        root,
        "$themes",
        system.modes.map((mode) => ({
            id: mode,
            name: mode,
            selectedTokenSets: Object.fromEntries(
                system.modes.map((each) => [each, each === mode ? "enabled" : "disabled"]),
            ),
        })),
    );
    setKey(root, "$metadata", { tokenSetOrder: [...system.modes] });

    return `${JSON.stringify(root, null, 2)}\n`;
}

// --- tokens.resolved.json ------------------------------------------------------------------------------------------------

/** The value of `get` for each mode: one value when every mode has the same, else a map by mode. */
function perMode<T>(
    modes: readonly string[],
    get: (mode: string) => T,
): { same: T } | { by: Record<string, T> } {
    const first = get(modes[0]!);
    const same = modes.every((mode) => JSON.stringify(get(mode)) === JSON.stringify(first));

    return same
        ? { same: first }
        : { by: Object.fromEntries(modes.map((mode) => [mode, get(mode)])) };
}

/**
 * `tokens.resolved.json`: a compact summary of the tokens with every reference followed, for scripts that want one
 * small file; it is secondary to `tokens.<mode>.resolved.json`, the DTCG files that other tools read. For each token its
 * type, tier, and variable, and its value as CSS (`value` when every mode has the same, else `values` by mode);
 * `alias` names the token it refers to; `parts` are a type style's members.
 */
export function compactJson(system: CompileInput): string {
    const tokens = system.tokens.map((token): [string, unknown] => {
        const entry: Record<string, unknown> = {
            type: token.type,
            tier: token.tier,
            cssVar: token.cssVar,
        };

        for (const key of ["description", "deprecated", "tailwind", "contrast"] as const) {
            if (token[key] !== undefined) {
                entry[key] = token[key];
            }
        }

        const value = perMode(
            system.modes,
            (mode) => token.modes[mode]!.literal ?? token.modes[mode]!.css,
        );
        const alias = perMode(system.modes, (mode) => token.modes[mode]!.alias);

        if ("same" in value) {
            entry.value = value.same;
        } else {
            entry.values = value.by;
        }

        if ("same" in alias ? alias.same !== undefined : true) {
            entry.alias = "same" in alias ? alias.same : alias.by;
        }

        if (token.type === "typography") {
            const parts = perMode(system.modes, (mode) => token.modes[mode]!.parts);

            entry.parts = "same" in parts ? parts.same : parts.by;
        }

        return [token.name, entry];
    });

    // One line for each token, so that the file is short and still diffs well.
    const head = {
        about: "A compact summary for scripts. The main JSON files are tokens.<mode>.resolved.json (DTCG) and tokens.studio.json (Tokens Studio).",
        name: system.name,
        ...(system.description === undefined ? {} : { description: system.description }),
        modes: system.modes,
        defaultMode: system.modes[0],
        schemes: system.schemes,
    };

    return `{\n${Object.entries(head)
        .map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
        .join(
            "\n",
        )}\n "tokens": {\n${tokens.map(([name, entry]) => `  ${JSON.stringify(name)}: ${JSON.stringify(entry)}`).join(",\n")}\n }\n}\n`;
}
