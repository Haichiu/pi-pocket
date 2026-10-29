// The tool's top-level schema stays one object, because some providers refuse a top-level union; the values inside it are typed here.
// They stay small, because the schema is in the prompt of every turn.
import { Type, type TSchema } from "@earendil-works/pi-ai";

const ColorObject = Type.Object({
    colorSpace: Type.String(),
    components: Type.Array(Type.Union([Type.Number(), Type.Literal("none")]), {
        minItems: 3,
        maxItems: 3,
    }),
    alpha: Type.Optional(Type.Number()),
    hex: Type.Optional(Type.String()),
});

const QuantityObject = Type.Object({ value: Type.Number(), unit: Type.String() });

const Member = Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Array(Type.Union([Type.String(), Type.Number()])),
    ColorObject,
    QuantityObject,
]);

const Composite = Type.Record(Type.String(), Member);

export const TokenValue: TSchema = Type.Union([
    Type.String(),
    Type.Number(),
    Type.Array(Type.Union([Type.String(), Type.Number(), Composite])),
    ColorObject,
    QuantityObject,
    Composite,
]);

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

export const DtcgTree = Type.Record(Type.String(), Type.Unknown());
