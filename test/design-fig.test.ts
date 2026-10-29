// Figma `.fig` files in the design system scan: the file's container (a ZIP or a bare `fig-kiwi` container), its kiwi
// schema and message, its variables (collections, modes, aliases) and its text, effect, and paint styles as a DTCG draft,
// and the bounds that keep a corrupted or hostile file to a note instead of an error.
//
// `test/fixtures/design/minimal.fig` comes from JimLiu/baoyu-design (MIT), under
// `skills/baoyu-design/agents/tests/fixtures/minimal.fig`. The other files are built in this test, by its own encoder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync, zstdCompressSync } from "node:zlib";
import { decodeFig, readFigBytes } from "../src/server/design/scan-fig-container.ts";
import { FigError } from "../src/server/design/scan-fig-kiwi.ts";
import { scanReport, scanRoot, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const MINIMAL = fileURLToPath(new URL("./fixtures/design/minimal.fig", import.meta.url));
const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string | Buffer>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-fig-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

/** The draft as a loaded system; it must have no error, which also checks every reference and every token type. */
function load(scan: TokenScan): DesignSystem {
    const system = buildSystem({
        folder: "scan",
        tokens: scan.draft.tokens,
        modes: new Map(Object.entries(scan.draft.modes)),
        components: new Map(),
        guidelines: "",
        problems: [],
    });

    assert.deepEqual(
        system.problems.filter((problem) => problem.level === "error"),
        [],
        "the draft has no error",
    );

    return system;
}

const token = (system: DesignSystem, name: string) =>
    system.tokens.find((each) => each.name === name);

/** The tokens of a scan's draft, by name: the draft's own, without the file's `$` keys. */
const statusOf = (scan: TokenScan) =>
    Object.keys(scan.draft.tokens).filter((key) => !key.startsWith("$"));

// --- A Figma file, built here ---------------------------------------------------------------------------------------

type Field = [name: string, type: string, array?: boolean];

interface Def {
    name: string;
    kind: "STRUCT" | "MESSAGE";
    fields: Field[];
}

const NATIVE = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];
const guid = (sessionID: number, localID: number) => ({ sessionID, localID });

/** A color as Figma holds it: four floats, 0 to 1. */
const color = (hex: string) => ({
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
    a: hex.length >= 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1,
});

/** The definitions of the test's own schema: the field names that a Figma file uses, and no others. */
const DEFS: Def[] = [
    {
        name: "Guid",
        kind: "STRUCT",
        fields: [
            ["sessionID", "uint"],
            ["localID", "uint"],
        ],
    },
    {
        name: "Vec2",
        kind: "STRUCT",
        fields: [
            ["x", "float"],
            ["y", "float"],
        ],
    },
    {
        name: "Color",
        kind: "STRUCT",
        fields: [
            ["r", "float"],
            ["g", "float"],
            ["b", "float"],
            ["a", "float"],
        ],
    },
    { name: "VariableAlias", kind: "STRUCT", fields: [["guid", "Guid"]] },
    {
        name: "VariableSetMode",
        kind: "MESSAGE",
        fields: [
            ["id", "Guid"],
            ["name", "string"],
        ],
    },
    { name: "VariableSetID", kind: "MESSAGE", fields: [["guid", "Guid"]] },
    {
        name: "VariableDataValue",
        kind: "MESSAGE",
        fields: [
            ["colorValue", "Color"],
            ["floatValue", "float"],
            ["textValue", "string"],
            ["alias", "VariableAlias"],
        ],
    },
    { name: "VariableData", kind: "MESSAGE", fields: [["value", "VariableDataValue"]] },
    {
        name: "VariableDataEntry",
        kind: "MESSAGE",
        fields: [
            ["modeID", "Guid"],
            ["variableData", "VariableData"],
        ],
    },
    {
        name: "VariableDataValues",
        kind: "MESSAGE",
        fields: [["entries", "VariableDataEntry", true]],
    },
    {
        name: "FontName",
        kind: "MESSAGE",
        fields: [
            ["family", "string"],
            ["style", "string"],
        ],
    },
    {
        name: "LineHeight",
        kind: "MESSAGE",
        fields: [
            ["value", "float"],
            ["units", "string"],
        ],
    },
    {
        name: "LetterSpacing",
        kind: "MESSAGE",
        fields: [
            ["value", "float"],
            ["units", "string"],
        ],
    },
    {
        name: "Effect",
        kind: "MESSAGE",
        fields: [
            ["type", "string"],
            ["color", "Color"],
            ["offset", "Vec2"],
            ["radius", "float"],
            ["spread", "float"],
            ["visible", "bool"],
        ],
    },
    {
        name: "Paint",
        kind: "MESSAGE",
        fields: [
            ["type", "string"],
            ["color", "Color"],
            ["visible", "bool"],
        ],
    },
    {
        name: "Node",
        kind: "MESSAGE",
        fields: [
            ["guid", "Guid"],
            ["name", "string"],
            ["type", "string"],
            ["variableSetModes", "VariableSetMode", true],
            ["variableSetID", "VariableSetID"],
            ["variableDataValues", "VariableDataValues"],
            ["variableResolvedType", "string"],
            ["styleType", "string"],
            ["fontName", "FontName"],
            ["fontSize", "float"],
            ["lineHeight", "LineHeight"],
            ["letterSpacing", "LetterSpacing"],
            ["effects", "Effect", true],
            ["fillPaints", "Paint", true],
        ],
    },
    { name: "Message", kind: "MESSAGE", fields: [["nodeChanges", "Node", true]] },
];

/** A variable-length unsigned integer, as kiwi writes it: 7 bits a byte. */
function varUint(out: number[], value: number): void {
    let left = value >>> 0;

    do {
        const byte = left & 127;

        left >>>= 7;
        out.push(left === 0 ? byte : byte | 128);
    } while (left !== 0);
}

/** The zigzag form of a signed integer: the low bit is the sign. */
function varInt(out: number[], value: number): void {
    varUint(out, value < 0 ? (~value << 1) | 1 : value << 1);
}

function text(out: number[], value: string): void {
    out.push(...Buffer.from(value, "utf8"), 0);
}

/** A float in kiwi's compressed form: 0 as one zero byte, else 4 bytes with the bits rotated. */
function float(out: number[], value: number): void {
    const bytes = Buffer.alloc(4);

    bytes.writeFloatLE(value, 0);
    const rotated = ((bytes.readUInt32LE(0) >>> 23) | (bytes.readUInt32LE(0) << 9)) >>> 0;

    if ((rotated & 255) === 0) {
        out.push(0);

        return;
    }

    out.push(rotated & 255, (rotated >>> 8) & 255, (rotated >>> 16) & 255, (rotated >>> 24) & 255);
}

/** The code of a type in a schema: a native type is negative, a definition is its place. */
function codeOf(type: string): number {
    const native = NATIVE.indexOf(type);

    return native >= 0 ? ~native : DEFS.findIndex((def) => def.name === type);
}

function schemaBytes(defs: Def[]): Buffer {
    const out: number[] = [];

    varUint(out, defs.length);

    for (const def of defs) {
        text(out, def.name);
        out.push(def.kind === "MESSAGE" ? 2 : 1);
        varUint(out, def.fields.length);

        for (const [index, [name, type, array]] of def.fields.entries()) {
            text(out, name);
            varInt(out, codeOf(type));
            out.push(array === true ? 1 : 0);
            varUint(out, index + 1);
        }
    }

    return Buffer.from(out);
}

function writeValue(out: number[], type: string, value: unknown): void {
    const native = NATIVE.indexOf(type);

    if (native === 0) {
        out.push(value === true ? 1 : 0);
    } else if (native === 1) {
        out.push(Number(value) & 255);
    } else if (native === 2) {
        varInt(out, Number(value));
    } else if (native === 3) {
        varUint(out, Number(value));
    } else if (native === 4) {
        float(out, Number(value));
    } else if (native === 5) {
        text(out, String(value));
    } else {
        const def = DEFS.find((each) => each.name === type);

        assert.ok(def !== undefined, `the schema has ${type}`);

        writeDef(out, def!, value as Record<string, unknown>);
    }
}

function writeDef(out: number[], def: Def, value: Record<string, unknown>): void {
    if (def.kind === "STRUCT") {
        for (const [name, type] of def.fields) {
            // A struct has no tags: every field is written, in order, so a missing one would shift the rest.
            assert.ok(value[name] !== undefined, `the struct ${def.name} has ${name}`);

            writeValue(out, type, value[name]);
        }

        return;
    }

    for (const [index, [name, type, array]] of def.fields.entries()) {
        const held = value[name];

        if (held === undefined) {
            continue;
        }

        varUint(out, index + 1);

        if (array === true) {
            varUint(out, (held as unknown[]).length);

            for (const item of held as unknown[]) {
                writeValue(out, type, item);
            }
        } else {
            writeValue(out, type, held);
        }
    }

    out.push(0);
}

function chunk(bytes: Buffer): Buffer {
    const length = Buffer.alloc(4);

    length.writeUInt32LE(bytes.length, 0);

    return Buffer.concat([length, bytes]);
}

/** A bare `fig-kiwi` container: the header, a version, the schema chunk, and the data chunk. */
function figFile(message: Record<string, unknown>, zstd = false): Buffer {
    const schema = schemaBytes(DEFS);
    const out: number[] = [];

    writeDef(out, DEFS.at(-1)!, message);

    const data = Buffer.from(out);

    return Buffer.concat([
        Buffer.from("fig-kiwi", "latin1"),
        Buffer.from([1, 0, 0, 0]),
        chunk(zstd ? zstdCompressSync(schema) : deflateRawSync(schema)),
        chunk(zstd ? zstdCompressSync(data) : deflateRawSync(data)),
    ]);
}

/** A ZIP with one entry, whose central directory may claim any size: what a zip bomb is made of. */
function zipOf(name: string, body: Buffer, claimed: number): Buffer {
    const label = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(body);
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);
    const end = Buffer.alloc(22);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(claimed, 22);
    local.writeUInt16LE(label.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(claimed, 24);
    central.writeUInt16LE(label.length, 28);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(46 + label.length, 12);
    end.writeUInt32LE(30 + label.length + deflated.length, 16);

    return Buffer.concat([local, label, deflated, central, label, end]);
}

// --- The fixture from JimLiu/baoyu-design (MIT) ----------------------------------------------------------------------

// The fixture holds layers only, so the tokens it can give are none: what it proves is the container, the schema, the
// message, and the one value form that is easy to get wrong (a float).
test("the fixture decodes: a ZIP container, its nodes, and no variables", () => {
    const fig = decodeFig(readFigBytes(MINIMAL));

    assert.equal(fig.container, "zip");
    assert.deepEqual(fig.entries, ["canvas.fig", "meta.json"]);
    assert.deepEqual(
        fig.nodes.map((node) => node.type),
        ["DOCUMENT", "CANVAS", "FRAME", "SYMBOL"],
    );
    // Floats are the one value form of the format that is not obvious: a wrong rotation would give a wrong size.
    assert.deepEqual(
        fig.nodes.filter((node) => node.type === "FRAME").map((node) => node.size),
        [{ x: 240, y: 120 }],
    );
    assert.deepEqual(
        fig.nodes.filter((node) => node.type === "VARIABLE"),
        [],
    );
});

test("the fixture alone gives no tokens, and the report says what it held", () => {
    const dir = project({ "minimal.fig": readFileSync(MINIMAL) });
    const scan = scanTokens(dir);
    const report = scanReport(scan);

    assert.deepEqual(scan.files, ["minimal.fig"]);
    assert.deepEqual(statusOf(scan), []);
    assert.match(report, /Figma: read minimal\.fig: 0 collections, 0 variables, 0 styles/);
    assert.match(report, /Not imported: 4 layers \(1 frame, 1 component\)/);
    assert.match(report, /no images/);
});

// --- Variables, modes, aliases, and styles --------------------------------------------------------------------------

const LIGHT = guid(10, 1);
const DARK = guid(10, 2);
const CONTRAST = guid(11, 2);
const HIGH = guid(11, 3);

const held = (value: Record<string, unknown>) => ({ value });
const entry = (modeID: ReturnType<typeof guid>, value: Record<string, unknown>) => ({
    modeID,
    variableData: held(value),
});

/** A file of two collections (Light and Dark, then Default and High contrast), an alias, and three styles. */
function designFile(): Buffer {
    const base = guid(1, 10);
    const primary = guid(1, 11);
    const ink = guid(1, 12);
    const spacing = guid(2, 1);

    return figFile({
        nodeChanges: [
            { guid: guid(0, 0), name: "Document", type: "DOCUMENT" },
            { guid: guid(0, 1), name: "Page 1", type: "CANVAS" },
            {
                guid: guid(1, 1),
                name: "Colors",
                type: "VARIABLE_SET",
                variableSetModes: [
                    { id: LIGHT, name: "Light" },
                    { id: DARK, name: "Dark" },
                ],
            },
            {
                guid: guid(1, 2),
                name: "Space",
                type: "VARIABLE_SET",
                variableSetModes: [
                    { id: CONTRAST, name: "Default" },
                    { id: HIGH, name: "High contrast" },
                ],
            },
            {
                guid: base,
                name: "Colors/Brand/Base",
                type: "VARIABLE",
                variableSetID: { guid: guid(1, 1) },
                variableResolvedType: "COLOR",
                variableDataValues: {
                    entries: [
                        entry(LIGHT, { colorValue: color("#1a1b26") }),
                        entry(DARK, { colorValue: color("#c0caf5") }),
                    ],
                },
            },
            {
                guid: primary,
                name: "Colors/Brand/Primary",
                type: "VARIABLE",
                variableSetID: { guid: guid(1, 1) },
                variableResolvedType: "COLOR",
                variableDataValues: {
                    entries: [
                        entry(LIGHT, { colorValue: color("#7aa2f7") }),
                        entry(DARK, { colorValue: color("#bb9af7") }),
                    ],
                },
            },
            {
                guid: ink,
                name: "Colors/Text/Primary",
                type: "VARIABLE",
                variableSetID: { guid: guid(1, 1) },
                variableResolvedType: "COLOR",
                variableDataValues: {
                    entries: [
                        entry(LIGHT, { alias: { guid: base } }),
                        entry(DARK, { alias: { guid: base } }),
                    ],
                },
            },
            {
                guid: spacing,
                name: "Spacing/Base",
                type: "VARIABLE",
                variableSetID: { guid: guid(1, 2) },
                variableResolvedType: "FLOAT",
                variableDataValues: {
                    entries: [entry(CONTRAST, { floatValue: 4 }), entry(HIGH, { floatValue: 8 })],
                },
            },
            { guid: guid(3, 1), name: "Card", type: "FRAME" },
            {
                guid: guid(4, 1),
                name: "Typography/Heading/Large",
                type: "STYLE",
                styleType: "TEXT",
                fontName: { family: "Inter", style: "Bold" },
                fontSize: 32,
                lineHeight: { value: 40, units: "PIXELS" },
                letterSpacing: { value: -2, units: "PERCENT" },
            },
            {
                guid: guid(4, 2),
                name: "Elevation/Card",
                type: "STYLE",
                styleType: "EFFECT",
                effects: [
                    {
                        type: "DROP_SHADOW",
                        color: color("#00000040"),
                        offset: { x: 0, y: 4 },
                        radius: 12,
                        spread: 0,
                        visible: true,
                    },
                ],
            },
            {
                guid: guid(4, 3),
                name: "Swatch/Cool",
                type: "STYLE",
                styleType: "FILL",
                fillPaints: [{ type: "SOLID", color: color("#9ece6a"), visible: true }],
            },
        ],
    });
}

test("its variables become tokens: collections, the dark mode, another mode, and an alias", () => {
    const dir = project({ "design.fig": designFile() });
    const scan = scanTokens(dir);
    const system = load(scan);

    // The names are the file's own, as dotted paths of safe slugs.
    assert.deepEqual(
        Object.keys(scan.draft.tokens).filter((key) => !key.startsWith("$")),
        ["color", "space", "type", "shadow"],
    );
    assert.equal(token(system, "color.brand.primary")?.modes.light?.hex, "#7aa2f7");
    // The first mode of each collection is the default; a mode named for dark is the dark mode.
    assert.equal(token(system, "color.brand.primary")?.modes.dark?.hex, "#bb9af7");
    assert.equal(token(system, "color.brand.base")?.modes.dark?.hex, "#c0caf5");
    // An alias is a reference, and it follows the mode it is in.
    assert.equal(token(system, "color.text.primary")?.modes.light?.literal, "#1a1b26");
    assert.equal(token(system, "color.text.primary")?.modes.dark?.literal, "#c0caf5");
    // A number in a group of spacings is a px length; another mode of its collection is a mode of its own.
    assert.equal(token(system, "space.base")?.modes.light?.literal, "4px");
    assert.equal(token(system, "space.base")?.modes["high-contrast"]?.literal, "8px");
});

test("its styles become typography, shadow, and color tokens", () => {
    const dir = project({ "design.fig": designFile() });
    const system = load(scanTokens(dir));
    const type = scanTokens(dir).draft.tokens;

    assert.equal(token(system, "type.heading.large")?.type, "typography");
    assert.deepEqual(
        (type.type as Record<string, Record<string, Record<string, unknown>>>).heading!.large!
            .$value,
        {
            fontFamily: "Inter",
            fontSize: "32px",
            fontWeight: 700,
            lineHeight: "40px",
            letterSpacing: "-0.02em",
        },
    );
    assert.equal(token(system, "shadow.card")?.type, "shadow");
    assert.equal(token(system, "color.swatch.cool")?.modes.light?.hex, "#9ece6a");
});

test("the report says what it read, and what it did not import", () => {
    const scan = scanTokens(project({ "design.fig": designFile() }));
    const report = scanReport(scan);

    assert.match(
        report,
        /Figma: read design\.fig: 2 collections, 4 variables \(3 colors, 1 number\), 3 styles \(1 typography, 1 shadow, 1 color\)/,
    );
    assert.match(report, /Modes: Light, Dark, Default, High contrast/);
    assert.match(report, /Not imported: 3 layers \(1 frame\) and no images/);
    assert.match(report, /reference to another variable/);
});

test("a mode named for dark first makes the file dark first", () => {
    const dir = project({
        "night.fig": figFile({
            nodeChanges: [
                {
                    guid: guid(1, 1),
                    name: "Colors",
                    type: "VARIABLE_SET",
                    variableSetModes: [
                        { id: DARK, name: "Dark" },
                        { id: LIGHT, name: "Light" },
                    ],
                },
                {
                    guid: guid(1, 2),
                    name: "Colors/Paper",
                    type: "VARIABLE",
                    variableSetID: { guid: guid(1, 1) },
                    variableResolvedType: "COLOR",
                    variableDataValues: {
                        entries: [
                            entry(DARK, { colorValue: color("#1a1b26") }),
                            entry(LIGHT, { colorValue: color("#ffffff") }),
                        ],
                    },
                },
            ],
        }),
    });
    const scan = scanTokens(dir);
    const system = load(scan);

    assert.deepEqual((scan.draft.tokens.$extensions as Record<string, unknown>)["com.pi-pocket"], {
        mode: "dark",
    });
    assert.equal(token(system, "color.paper")?.modes.dark?.hex, "#1a1b26");
    assert.equal(token(system, "color.paper")?.modes.light?.hex, "#ffffff");
    assert.match(scanReport(scan), /The file is dark first/);
});

test("a text variable, a switch, and an alias of a variable outside the file are left out, and counted", () => {
    const dir = project({
        "edge.fig": figFile({
            nodeChanges: [
                {
                    guid: guid(1, 1),
                    name: "Colors",
                    type: "VARIABLE_SET",
                    variableSetModes: [{ id: LIGHT, name: "Light" }],
                },
                {
                    guid: guid(1, 2),
                    name: "Colors/Ink",
                    type: "VARIABLE",
                    variableSetID: { guid: guid(1, 1) },
                    variableResolvedType: "COLOR",
                    variableDataValues: {
                        entries: [entry(LIGHT, { colorValue: color("#111111") })],
                    },
                },
                {
                    guid: guid(1, 3),
                    name: "Note",
                    type: "VARIABLE",
                    variableSetID: { guid: guid(1, 1) },
                    variableResolvedType: "STRING",
                    variableDataValues: { entries: [entry(LIGHT, { textValue: "a sentence" })] },
                },
                {
                    guid: guid(1, 4),
                    name: "On",
                    type: "VARIABLE",
                    variableSetID: { guid: guid(1, 1) },
                    variableResolvedType: "BOOLEAN",
                },
                {
                    guid: guid(1, 5),
                    name: "Colors/From library",
                    type: "VARIABLE",
                    variableSetID: { guid: guid(1, 1) },
                    variableResolvedType: "COLOR",
                    variableDataValues: {
                        entries: [entry(LIGHT, { alias: { guid: guid(9, 9) } })],
                    },
                },
                {
                    guid: guid(1, 6),
                    name: "Fonts/Body",
                    type: "VARIABLE",
                    variableSetID: { guid: guid(1, 1) },
                    variableResolvedType: "STRING",
                    variableDataValues: { entries: [entry(LIGHT, { textValue: "Inter" })] },
                },
            ],
        }),
    });
    const scan = scanTokens(dir);
    const report = scanReport(scan);

    // The text variable named for a font is a family; the sentence is not a token, and neither is the switch.
    assert.equal(token(load(scan), "font.body")?.modes.light?.literal, "Inter");
    assert.match(report, /2 text or switch variables could not become a token/);
    assert.match(report, /1 variable had no value in the default mode/);
});

// --- Bounds: a hostile or broken file is a note, never an error -------------------------------------------------------

const broken: [string, Buffer][] = [
    ["nothing.fig", Buffer.alloc(0)],
    ["words.fig", Buffer.from("this is not a figma export")],
    ["cut.fig", readFileSync(MINIMAL).subarray(0, 120)],
    [
        "claim.fig",
        (() => {
            const file = Buffer.concat([
                Buffer.from("fig-kiwi", "latin1"),
                Buffer.from([1, 0, 0, 0]),
                Buffer.from([0xf0, 0xff, 0xff, 0xff]),
                Buffer.alloc(8),
            ]);

            return file;
        })(),
    ],
    ["bomb.fig", zipOf("canvas.fig", Buffer.alloc(2048), 200_000_000)],
    [
        "deep.fig",
        (() => {
            // A schema whose one struct holds itself, so a decoder without a depth limit would never come back.
            const out: number[] = [];

            varUint(out, 2);
            text(out, "Loop");
            out.push(1);
            varUint(out, 1);
            text(out, "self");
            out.push(0, 0, 1);
            text(out, "Message");
            out.push(2);
            varUint(out, 1);
            text(out, "deep");
            out.push(0, 0, 1);

            return Buffer.concat([
                Buffer.from("fig-kiwi", "latin1"),
                Buffer.from([1, 0, 0, 0]),
                chunk(deflateRawSync(Buffer.from(out))),
                chunk(deflateRawSync(Buffer.from([1]))),
            ]);
        })(),
    ],
];

/** Why each broken file is refused: a reason for a person, not a crash. */
const reasons: Record<string, RegExp> = {
    "nothing.fig": /the file is empty/,
    "words.fig": /not a Figma file/,
    "cut.fig": /ZIP without a central directory/,
    "claim.fig": /a chunk claims 4294967280 bytes/,
    "bomb.fig": /claims 200000000 bytes after decompression/,
    "deep.fig": /nests deeper than 32 levels/,
};

for (const [name, bytes] of broken) {
    test(`a file that cannot be read is a note: ${name}`, () => {
        const dir = project({ [name]: bytes, "a.css": ":root{--bg:#ffffff;--ink:#111111}" });
        const scan = scanTokens(dir);
        const note = scan.skipped.find((each) => each.path === name);

        assert.ok(note !== undefined, "the note is in the report");
        // Each one is refused for its own reason: the bounds, not a crash on the way.
        assert.match(note!.why, reasons[name]!);
        // The scan goes on: the stylesheet beside it still drafts.
        assert.ok(scan.draft.tokens.color !== undefined);
        assert.match(scanReport(scan), new RegExp(`${name.replace(".", "\\.")}`));
    });
}

test("a file of a long, hostile length is refused at the count, not read", () => {
    const schema = (() => {
        const out: number[] = [];

        varUint(out, 1);
        text(out, "Message");
        out.push(2, 1);
        text(out, "nodeChanges");
        varInt(out, ~NATIVE.indexOf("uint"));
        out.push(1, 1);

        return Buffer.from(out);
    })();
    const data = Buffer.from([1, 0xff, 0xff, 0x7f]);
    const file = Buffer.concat([
        Buffer.from("fig-kiwi", "latin1"),
        Buffer.from([1, 0, 0, 0]),
        chunk(deflateRawSync(schema)),
        chunk(deflateRawSync(data)),
    ]);

    assert.throws(
        () => decodeFig(file),
        (error: unknown) => {
            assert.ok(error instanceof FigError);
            assert.match(error.message, /claims a list of 2097151 values/);

            return true;
        },
    );
});

// --- The scan's paths ----------------------------------------------------------------------------------------------

test("the scan takes a .fig file as its path, and refuses another file", () => {
    const dir = project({ "brand.fig": designFile(), "theme.css": ":root{--brand:#ff5500}" });

    assert.equal(scanRoot(dir, "brand.fig"), join(scanRoot(dir, undefined), "brand.fig"));
    assert.throws(() => scanRoot(dir, "theme.css"), /must be a folder or a Figma \.fig file/);
    // The whole file is scanned: the tokens are the file's own.
    assert.ok(
        token(load(scanTokens(scanRoot(dir, "brand.fig"))), "color.brand.primary") !== undefined,
    );
});

test("a folder with a .fig and a stylesheet reads both", () => {
    const dir = project({
        "minimal.fig": readFileSync(MINIMAL),
        "theme.css": `:root{--bg:#ffffff;--ink:#111111;--brand:#ff5500;--gap:8px;--radius:8px}
body{background:var(--bg);color:var(--ink);font-family:Inter, sans-serif}
a{color:var(--brand);border-radius:var(--radius);padding:var(--gap)}`,
    });
    const scan = scanTokens(dir);
    const report = scanReport(scan);
    const system = load(scan);

    assert.deepEqual(scan.files, ["minimal.fig", "theme.css"]);
    // The Figma file holds no variables, so the stylesheet drafts the tokens; both are in the report.
    assert.match(report, /Figma: read minimal\.fig: 0 collections/);
    assert.equal(token(system, "color.bg.page")?.modes.light?.hex, "#ffffff");
    assert.equal(token(system, "color.accent.default")?.modes.light?.hex, "#ff5500");
    assert.equal(token(system, "space.base")?.modes.light?.literal, "8px");
});

test("a .fig with variables is a token source of its own, over the stylesheets", () => {
    const dir = project({
        "design.fig": designFile(),
        "theme.css": ":root{--brand:#ff5500;--gap:12px}body{background:#ffffff}",
    });
    const scan = scanTokens(dir);
    const report = scanReport(scan);

    assert.deepEqual(scan.files, ["design.fig", "theme.css"]);
    assert.match(report, /Used the 7 tokens from design\.fig as they are/);
    // The stylesheet's values are not drafted over the file's own names.
    assert.equal(token(load(scan), "color.brand.primary")?.modes.light?.hex, "#7aa2f7");
    assert.match(report, /colors were not drafted|styles were not guessed/);
});

test("a zstd data chunk decodes, as a Figma file writes it", () => {
    const fig = decodeFig(
        figFile({ nodeChanges: [{ guid: guid(0, 0), name: "Document", type: "DOCUMENT" }] }, true),
    );

    assert.deepEqual(
        fig.nodes.map((node) => node.type),
        ["DOCUMENT"],
    );
});
