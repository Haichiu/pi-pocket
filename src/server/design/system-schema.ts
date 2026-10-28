/**
 * The types of the `design_system` tool's values (stream T). The tool's top-level schema stays one object, because some
 * providers refuse a top-level union; the values inside it are typed here, so that a model sees what a token value is
 * (a string, a number, or one of the DTCG object forms) instead of "unknown". The schemas are as open as the tokens
 * engine is: they say what to write, and the engine, which checks every change, says what is wrong with it. They stay
 * small, because the schema is in the prompt of every turn.
 */
import { Type, type TSchema } from "@earendil-works/pi-ai";

/** A color as the DTCG 2025.10 object: `{ "colorSpace": "srgb", "components": [0.48, 0.64, 0.97], "alpha": 1 }`. */
const ColorObject = Type.Object({
    colorSpace: Type.String(),
    components: Type.Array(Type.Union([Type.Number(), Type.Literal("none")]), {
        minItems: 3,
        maxItems: 3,
    }),
    alpha: Type.Optional(Type.Number()),
    hex: Type.Optional(Type.String()),
});

/** A length or a time as the DTCG 2025.10 object: `{ "value": 16, "unit": "px" }`. */
const QuantityObject = Type.Object({ value: Type.Number(), unit: Type.String() });

/** One member of a shadow layer, a type style, a border, or a transition: text, a number, a font stack, or an object form. */
const Member = Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Array(Type.Union([Type.String(), Type.Number()])),
    ColorObject,
    QuantityObject,
]);

/** A shadow layer, a type style, a border, a transition, or a gradient stop: members by name, each a `Member`. */
const Composite = Type.Record(Type.String(), Member);

/**
 * What a `$value` is: a string (a color `"#7aa2f7"`, a length `"16px"`, a time `"150ms"`, a font family, a reference
 * `"{color.blue.500}"`), a number (a font weight, a ratio), a list (a font stack of names, a cubic-bezier of four numbers,
 * a shadow of layers, a gradient of stops), or an object: a color `{ colorSpace, components }`, a quantity `{ value, unit }`,
 * or the members of a shadow layer, a type style, a border, or a transition.
 */
export const TokenValue: TSchema = Type.Union([
    Type.String(),
    Type.Number(),
    Type.Array(Type.Union([Type.String(), Type.Number(), Composite])),
    ColorObject,
    QuantityObject,
    Composite,
]);

/** What `changes[].value` takes: a value, or a whole token `{ "$value": …, "$type": "color" }`. */
export const valueOrToken = (description: string): TSchema =>
    Type.Union(
        [
            TokenValue,
            Type.Object({
                $value: Type.Unknown({ description: "A value, as above." }),
                $type: Type.Optional(Type.String()),
                $description: Type.Optional(Type.String()),
                $extensions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            }),
        ],
        { description },
    );

/** A DTCG file's content: groups and tokens, as one object. */
export const DtcgTree = Type.Record(Type.String(), Type.Unknown());
