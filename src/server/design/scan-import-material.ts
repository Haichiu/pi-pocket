/**
 * Material 3 exports (stream T): what the Material Theme Builder writes. CSS files per scheme (`light.css`, `dark.css`,
 * `light-mc.css`, `light-hc.css`...), or one file with a class for each (`.light`, `.dark-medium-contrast`), with
 * `--md-sys-color-*` custom properties and perhaps `--md-ref-palette-*`; and a JSON export,
 * `{ "schemes": { "light": { "primary": "#6750a4", "onPrimary": … }, "dark": … }, "palettes": { "primary": { "0": … } } }`.
 *
 * The roles of Material 3 take the names of this system: `surface` and `surface-container*` are surfaces, `on-surface` is
 * the text and `on-surface-variant` the quiet text, `outline` and `outline-variant` are the borders, `primary` is the accent
 * and `error` the danger. Material 3 has no warning or success color, and none is made up. Its secondary and tertiary colors
 * are `accent-2` and `accent-3` (`secondary` and `tertiary` name quiet text here). A scheme with medium or high contrast is a
 * mode of its own (`light-medium-contrast`), and a palette is a set of steps named by its hue, with the roles that point at
 * them. Shape, motion, and typeface properties become radius, duration, easing, and font tokens.
 */
import { parseColor, toOklch, type Rgba } from "./color.ts";
import { isObject, type Obj } from "./scan-import-convert.ts";
import { entryOf } from "./scan-color-base.ts";
import { stackOf } from "./scan-facts-use.ts";
import { family, paletteName } from "./scan-color-palette.ts";
import type { RoleName } from "./scan-color-base.ts";
import type { Inferred } from "./scan-scales.ts";

/** A text file that may hold Material 3 properties, or a parsed JSON export. */
export interface MaterialInput {
    css: { file: string; text: string }[];
    json: { file: string; root: Obj }[];
}

/** What the Material 3 files give: the default mode's colors, the other modes' changes, and what happened. */
export interface MaterialResult {
    /** The color tokens (palettes and roles), the radii, the motion, and the fonts, as a DTCG tree. */
    default: Obj;
    /** The changed roles of the dark mode, and of any other mode (`light-high-contrast`), by name. */
    modes: Record<string, Obj>;
    /** The name of the default mode (`light`, or `dark` for a project that has only a dark scheme). */
    defaultMode: string;
    /** The role colors of the default mode by our role (`bg.page`), for the report. */
    roles: Record<string, { token: string; source: string; value: string; dark?: string }>;
    count: number;
    notes: string[];
}

/** The path of each Material 3 color role, and what it is called in the report. */
const ROLES: Record<string, string[]> = {
    primary: ["accent", "default"],
    "on-primary": ["text", "on-accent"],
    "primary-container": ["accent", "container"],
    "on-primary-container": ["text", "on-accent-container"],
    "inverse-primary": ["accent", "inverse"],
    "surface-tint": ["accent", "tint"],
    secondary: ["accent-2", "default"],
    "on-secondary": ["text", "on-accent-2"],
    "secondary-container": ["accent-2", "container"],
    "on-secondary-container": ["text", "on-accent-2-container"],
    tertiary: ["accent-3", "default"],
    "on-tertiary": ["text", "on-accent-3"],
    "tertiary-container": ["accent-3", "container"],
    "on-tertiary-container": ["text", "on-accent-3-container"],
    error: ["danger", "default"],
    "on-error": ["text", "on-danger"],
    "error-container": ["danger", "container"],
    "on-error-container": ["text", "on-danger-container"],
    background: ["bg", "page"],
    "on-background": ["text", "on-page"],
    surface: ["bg", "surface"],
    "on-surface": ["text", "primary"],
    "surface-variant": ["bg", "surface-variant"],
    "on-surface-variant": ["text", "muted"],
    "surface-dim": ["bg", "surface-dim"],
    "surface-bright": ["bg", "surface-bright"],
    "surface-container-lowest": ["bg", "surface-container-lowest"],
    "surface-container-low": ["bg", "surface-container-low"],
    "surface-container": ["bg", "surface-container"],
    "surface-container-high": ["bg", "surface-container-high"],
    "surface-container-highest": ["bg", "surface-container-highest"],
    outline: ["border", "default"],
    "outline-variant": ["border", "subtle"],
    "inverse-surface": ["bg", "inverse"],
    "inverse-on-surface": ["text", "inverse"],
    shadow: ["shadow", "default"],
    scrim: ["bg", "scrim"],
    "primary-fixed": ["accent", "fixed"],
    "primary-fixed-dim": ["accent", "fixed-dim"],
    "on-primary-fixed": ["text", "on-accent-fixed"],
    "on-primary-fixed-variant": ["text", "on-accent-fixed-variant"],
    "secondary-fixed": ["accent-2", "fixed"],
    "secondary-fixed-dim": ["accent-2", "fixed-dim"],
    "on-secondary-fixed": ["text", "on-accent-2-fixed"],
    "on-secondary-fixed-variant": ["text", "on-accent-2-fixed-variant"],
    "tertiary-fixed": ["accent-3", "fixed"],
    "tertiary-fixed-dim": ["accent-3", "fixed-dim"],
    "on-tertiary-fixed": ["text", "on-accent-3-fixed"],
    "on-tertiary-fixed-variant": ["text", "on-accent-3-fixed-variant"],
};

/** The roles of this system that the report names, from the roles of Material 3. */
const REPORTED: Record<string, string> = {
    background: "bg.page",
    surface: "bg.surface",
    "on-surface": "text.primary",
    "on-surface-variant": "text.muted",
    outline: "border.default",
    primary: "accent.default",
    error: "danger.default",
};

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

// --- Which scheme a value is for ------------------------------------------------------------------------------------------

interface Scheme {
    base: "light" | "dark" | undefined;
    contrast: "" | "medium" | "high";
}

const wordsOf = (text: string) =>
    kebab(text)
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

/** The scheme that some text names (a selector, a file name, a variable's suffix): light or dark, and its contrast. */
function schemeIn(text: string): Scheme {
    const words = wordsOf(text);
    const has = (...list: string[]) => list.some((word) => words.includes(word));

    return {
        base: has("dark") ? "dark" : has("light") ? "light" : undefined,
        contrast: has("hc", "high") ? "high" : has("mc", "medium") ? "medium" : "",
    };
}

/** The scheme of the first text that names one; a contrast from any. */
function pickScheme(...texts: string[]): Scheme {
    let base: Scheme["base"];
    let contrast: Scheme["contrast"] = "";

    for (const text of texts) {
        const found = schemeIn(text);

        base ??= found.base;

        if (contrast === "") {
            contrast = found.contrast;
        }
    }

    return { base, contrast };
}

const modeName = (scheme: Scheme) =>
    `${scheme.base ?? "light"}${scheme.contrast === "" ? "" : `-${scheme.contrast}-contrast`}`;

// --- The text -------------------------------------------------------------------------------------------------------------

interface Declared {
    mode: string;
    name: string;
    value: string;
}

/** The suffix a variable may carry for its scheme: `--md-sys-color-primary-light`, `-dark-high-contrast`, `-light-mc`. */
const SUFFIX = /-(?:light|dark)(?:-(?:medium|high)-contrast|-mc|-hc)?$/;

/**
 * The `--md-*` declarations of a stylesheet, each with the scheme of its block: the block's selector (`.dark`,
 * `[data-theme=dark]`), a `prefers-color-scheme` media query around it, the file's name, or the variable's own suffix.
 */
function declarationsIn(file: string, source: string): Declared[] {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const out: Declared[] = [];
    const name = file
        .split("/")
        .at(-1)!
        .replace(/\.[^.]+$/, "");

    const declare = (declaration: string, context: string) => {
        const match = /^\s*(--md-[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);

        if (match === null) {
            return;
        }

        const variable = match[1]!;
        const scheme = pickScheme(
            variable.replace(/^--md-(?:sys|ref)-[a-z]+-/, "").match(SUFFIX)?.[0] ?? "",
            context,
            name,
        );

        out.push({ mode: modeName(scheme), name: variable.replace(SUFFIX, ""), value: match[2]! });
    };

    // A block is a selector or an at-rule and what is in it; the text before a `;` is a declaration.
    const walk = (body: string, context: string, depth: number) => {
        let buffer = "";
        let at = 0;

        while (at < body.length && out.length < 4000) {
            const char = body[at]!;

            if (char === "{") {
                let level = 1;
                let close = at + 1;

                while (close < body.length && level > 0) {
                    level += body[close] === "{" ? 1 : body[close] === "}" ? -1 : 0;
                    close += 1;
                }

                if (depth < 6) {
                    walk(body.slice(at + 1, close - 1), `${context} ${buffer.trim()}`, depth + 1);
                }

                buffer = "";
                at = close;
            } else if (char === ";") {
                declare(buffer, context);
                buffer = "";
                at += 1;
            } else {
                buffer += char;
                at += 1;
            }
        }

        declare(buffer, context);
    };

    walk(text, "", 0);

    return out;
}

// --- The build ------------------------------------------------------------------------------------------------------------

const hexOf = (color: Rgba) => {
    const byte = (value: number) =>
        Math.round(value * 255)
            .toString(16)
            .padStart(2, "0");

    return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${color.a < 1 ? byte(color.a) : ""}`;
};

/** The tokens of Material 3 exports, or undefined when the files hold fewer than eight color roles. */
export function materialTokens(input: MaterialInput): MaterialResult | undefined {
    // Color roles by mode, palettes by family and tone, and the other properties.
    const roles = new Map<string, Map<string, string>>();
    const palettes = new Map<string, Map<string, string>>();
    const radii = new Map<string, string>();
    const durations = new Map<string, string>();
    const easings = new Map<string, string>();
    const fonts = new Map<string, string>();

    const role = (mode: string, name: string, value: string) => {
        const map = roles.get(mode) ?? new Map<string, string>();

        map.set(name, value);
        roles.set(mode, map);
    };

    const palette = (family: string, tone: string, value: string) => {
        const map = palettes.get(family) ?? new Map<string, string>();

        map.set(tone, value);
        palettes.set(family, map);
    };

    const declaredIn = input.css.map(({ file, text }) => declarationsIn(file, text).slice(0, 4000));
    // A role that points at a palette step (`var(--md-ref-palette-primary40)`) has that step's color.
    const steps = new Map<string, string>();

    for (const declared of declaredIn.flat()) {
        if (/^--md-ref-palette-/.test(declared.name) && !declared.value.startsWith("var(")) {
            steps.set(declared.name, declared.value);
        }
    }

    for (const declared of declaredIn.flat()) {
        const via = /^var\(\s*(--md-ref-palette-[\w-]+)\s*(?:,[^)]*)?\)$/.exec(declared.value);

        if (via !== null) {
            declared.value = steps.get(via[1]!) ?? declared.value;
        }

        // A value that is a `var()` of another role (`-light` beside `.light { … var(…-light) }`) is that role's own line.
        if (declared.value.startsWith("var(")) {
            continue;
        }

        {
            const color = /^--md-sys-color-([a-z0-9-]+)$/.exec(declared.name);
            const ref = /^--md-ref-palette-([a-z-]+?)(\d+)$/.exec(declared.name);

            if (color !== null) {
                role(declared.mode, color[1]!, declared.value);
            } else if (ref !== null) {
                palette(ref[1]!, ref[2]!, declared.value);
            } else if (/^--md-sys-shape-corner-[a-z-]+$/.test(declared.name)) {
                radii.set(declared.name.replace("--md-sys-shape-corner-", ""), declared.value);
            } else if (/^--md-sys-motion-duration-[a-z0-9-]+$/.test(declared.name)) {
                durations.set(
                    declared.name.replace("--md-sys-motion-duration-", ""),
                    declared.value,
                );
            } else if (/^--md-sys-motion-easing-[a-z0-9-]+$/.test(declared.name)) {
                easings.set(declared.name.replace("--md-sys-motion-easing-", ""), declared.value);
            } else if (/^--md-ref-typeface-(?:brand|plain)$/.test(declared.name)) {
                fonts.set(declared.name.replace("--md-ref-typeface-", ""), declared.value);
            }
        }
    }

    for (const { root } of input.json) {
        const schemes = isObject(root.schemes) ? root.schemes : {};

        for (const [key, scheme] of Object.entries(schemes).slice(0, 12)) {
            if (!isObject(scheme)) {
                continue;
            }

            const mode = modeName(pickScheme(key));

            for (const [name, value] of Object.entries(scheme).slice(0, 80)) {
                if (typeof value === "string") {
                    role(mode, kebab(name), value);
                }
            }
        }

        for (const [name, tones] of Object.entries(
            isObject(root.palettes) ? root.palettes : {},
        ).slice(0, 12)) {
            for (const [tone, value] of Object.entries(isObject(tones) ? tones : {}).slice(0, 40)) {
                if (typeof value === "string") {
                    palette(kebab(name), tone, value);
                }
            }
        }
    }

    const modes = [...roles.keys()].filter((mode) => (roles.get(mode)?.size ?? 0) >= 1);
    const defaultMode = modes.includes("light")
        ? "light"
        : (modes.find((mode) => mode.startsWith("light")) ?? modes[0]);

    if (defaultMode === undefined || (roles.get(defaultMode)?.size ?? 0) < 8) {
        return undefined;
    }

    const notes: string[] = [];
    const tree: Obj = {};

    const put = (target: Obj, path: string[], node: Obj) => {
        let group = target;

        for (const part of path.slice(0, -1)) {
            const next = group[part];

            if (isObject(next)) {
                group = next;
            } else {
                const made: Obj = {};

                group[part] = made;
                group = made;
            }
        }

        group[path.at(-1)!] = node;
    };

    // The palettes: a family is named by the hue of its middle tone, and a second family of one hue gets a number.
    const taken = new Set<string>();
    const names = new Map<string, string>();
    /** The palette step that holds a color, by its hex: the first family that has it. */
    const stepOf = new Map<string, string[]>();

    for (const [name, tones] of palettes) {
        const sample = tones.get("40") ?? tones.get("50") ?? [...tones.values()][0];
        const color = sample === undefined ? undefined : parseColor(sample);
        const lch = color === undefined ? undefined : toOklch(color);
        // The neutral palettes keep their Material names; the others are named by their hue.
        const hue = /^neutral(?:-variant)?$/.test(name)
            ? name
            : lch === undefined
              ? "gray"
              : family(lch);
        let unique = hue;

        for (let at = 2; taken.has(unique); at++) {
            unique = `${hue}-${at}`;
        }

        taken.add(unique);
        names.set(name, unique);

        for (const [tone, value] of [...tones].sort((a, b) => Number(a[0]) - Number(b[0]))) {
            const parsed = parseColor(value);

            if (parsed !== undefined) {
                put(tree, ["color", unique, tone], { $value: value, $type: "color" });

                const key = hexOf(parsed);

                stepOf.set(key, [...(stepOf.get(key) ?? []), `color.${unique}.${tone}`]);
            }
        }
    }

    const used = new Set<string>([...stepOf.values()].flat());

    /**
     * A role's value: a reference to the palette step that holds the color. Without palettes, a color is a primitive of its
     * own in the default mode (named by hue and lightness, as the scan names its palette) and is written as it is in another
     * mode; with palettes, a color that no step has is written as it is.
     */
    const valueOf = (name: string, value: string, makes: boolean) => {
        const parsed = parseColor(value);

        if (parsed === undefined) {
            return undefined;
        }

        let steps = stepOf.get(hexOf(parsed));

        if (steps === undefined && makes) {
            const entry = entryOf(hexOf(parsed));

            if (entry !== undefined) {
                const path = paletteName(entry, used);

                used.add(path.join("."));
                put(tree, path, { $value: hexOf(parsed), $type: "color" });
                steps = [path.join(".")];
                stepOf.set(hexOf(parsed), steps);
            }
        }

        const own = [...names].find(([member]) =>
            name.includes(member.replace(/-variant$/, "")),
        )?.[1];

        // A role of the primary family points at the primary palette when the color is in more than one.
        const step =
            steps?.find((each) => own !== undefined && each.startsWith(`color.${own}.`)) ??
            steps?.[0];

        return step === undefined ? value : `{${step}}`;
    };

    const token = (name: string, value: string, makes: boolean) => {
        const path = ROLES[name] ?? ["md", name];
        const $value = valueOf(name, value, makes);

        return $value === undefined
            ? undefined
            : {
                  path: ["color", ...path],
                  node: { $value, $type: "color", $description: `Material 3 ${name}` },
              };
    };

    const result: MaterialResult = {
        default: tree,
        modes: {},
        defaultMode,
        roles: {},
        count: 0,
        notes,
    };
    const base = roles.get(defaultMode)!;
    const flat = new Map<string, string>();

    // Without a `background` role (a hand-made export), the surface is the page too.
    const withPage = (scheme: Map<string, string>) =>
        !scheme.has("background") && scheme.has("surface")
            ? new Map([...scheme, ["background", scheme.get("surface")!]])
            : scheme;

    for (const [name, value] of withPage(base)) {
        const made = token(name, value, palettes.size === 0);

        if (made !== undefined) {
            put(tree, made.path, made.node);
            flat.set(name, JSON.stringify(made.node.$value));
            result.count += 1;
        }
    }

    for (const mode of modes.filter((each) => each !== defaultMode).slice(0, 5)) {
        const changes: Obj = {
            $extensions: {
                "com.pi-pocket": { colorScheme: mode.startsWith("dark") ? "dark" : "light" },
            },
        };
        let changed = 0;

        for (const [name, value] of withPage(roles.get(mode)!)) {
            const made = token(name, value, false);

            if (made === undefined || !withPage(base).has(name)) {
                continue;
            }

            if (flat.get(name) !== JSON.stringify(made.node.$value)) {
                put(changes, made.path, made.node);
                changed += 1;
            }
        }

        result.modes[mode] = changes;
        result.count += changed;
    }

    // What the report names: the role of this system, its color in the default mode and in the dark mode.
    for (const [m3, ours] of Object.entries(REPORTED)) {
        const value = base.get(m3);
        const dark = roles.get("dark")?.get(m3);
        const hex = value === undefined ? undefined : parseColor(value);

        if (hex !== undefined) {
            result.roles[ours] = {
                token: `color.${ours}`,
                source: `md-sys-color-${m3}`,
                value: hexOf(hex),
                ...(dark !== undefined && parseColor(dark) !== undefined
                    ? { dark: hexOf(parseColor(dark)!) }
                    : {}),
            };
        }
    }

    // Shape, motion, and typefaces.
    for (const [name, value] of radii) {
        if (/^\d*\.?\d+(?:px|rem)$/.test(value.trim())) {
            put(tree, ["radius", name], { $value: value.trim(), $type: "dimension" });
        }
    }

    for (const [name, value] of durations) {
        if (/^\d*\.?\d+(?:ms|s)$/.test(value.trim())) {
            put(tree, ["duration", name], { $value: value.trim(), $type: "duration" });
        }
    }

    for (const [name, value] of easings) {
        const match =
            /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(
                value.trim(),
            );

        if (match !== null) {
            put(tree, ["ease", name], {
                $value: match.slice(1, 5).map(Number),
                $type: "cubicBezier",
            });
        }
    }

    for (const [name, value] of fonts) {
        put(tree, ["font", name], {
            $value: stackOf(value) ?? value,
            $type: "fontFamily",
        });
    }

    notes.push(
        `Material 3: ${roles.get(defaultMode)!.size} color roles in ${defaultMode}${modes.length > 1 ? `; modes: ${modes.filter((each) => each !== defaultMode).join(", ")}` : ""}${palettes.size > 0 ? `; ${palettes.size} palettes` : ""}. Material 3 has no warning or success color, so none was made up.`,
    );

    return result;
}

/** The roles of this system by the name that the report uses (`bg.page` is `background`). */
const REPORT_ROLE: Record<string, RoleName> = {
    "bg.page": "background",
    "bg.surface": "surface",
    "text.primary": "text",
    "text.muted": "muted",
    "border.default": "border",
    "accent.default": "accent",
    "danger.default": "danger",
};

/**
 * Puts the Material 3 colors in the scan's result: the project's own scan stays for everything else (spacing, type, radii
 * the project sets itself), and the color group and the color modes are Material 3's. A dark-first project (only a dark
 * scheme) has dark as its default mode.
 */
export function applyMaterial(result: Inferred, material: MaterialResult): Inferred {
    const tokens = result.draft.tokens as Obj;
    const dark = material.defaultMode.startsWith("dark");
    const modes: Record<string, Obj> = {};

    // The other modes of the scan keep what is not a color.
    for (const [mode, tree] of Object.entries(result.draft.modes)) {
        const { color: _color, ...rest } = tree as Obj;

        if (Object.keys(rest).filter((key) => !key.startsWith("$")).length > 0) {
            modes[mode] = rest;
        }
    }

    for (const [group, node] of Object.entries(material.default)) {
        tokens[group] =
            group === "color"
                ? mergeColors(tokens.color, node as Obj, material)
                : { ...((tokens[group] as Obj | undefined) ?? {}), ...(node as Obj) };
    }

    for (const [mode, tree] of Object.entries(material.modes)) {
        modes[mode] = { ...(modes[mode] ?? {}), ...tree };
    }

    if (dark) {
        const ext = (tokens.$extensions ??= {}) as Obj;

        ext["com.pi-pocket"] = {
            ...((ext["com.pi-pocket"] as Obj | undefined) ?? {}),
            mode: material.defaultMode,
        };
    }

    result.draft = { tokens, modes };
    result.roles = {};

    for (const [ours, info] of Object.entries(material.roles)) {
        const role = REPORT_ROLE[ours];

        if (role !== undefined) {
            result.roles[role] = {
                token: info.token,
                value: info.value,
                ...(info.dark === undefined ? {} : { dark: info.dark }),
                basis: "name",
                source: info.source,
                confidence: "high",
            };
        }
    }

    const others = Object.keys(material.modes);

    result.hasDark = others.some((mode) => mode.startsWith("dark")) || dark;
    const other = dark ? "light" : "dark";

    result.modes = {
        default: material.defaultMode,
        alt:
            others.find((mode) => mode === other) ??
            others.find((mode) => mode.startsWith(other)) ??
            others[0] ??
            other,
    };
    // The palette: each group of the color tree that has numbered steps, with its size.
    result.palette = Object.fromEntries(
        Object.entries((material.default.color as Obj | undefined) ?? {})
            .filter(
                ([, group]) =>
                    isObject(group) && Object.keys(group).some((key) => /^\d+(?:-\d+)?$/.test(key)),
            )
            .map(([name, group]) => [name, Object.keys(group as Obj).length]),
    );
    result.sources.push(...material.notes);

    return result;
}

/** The hex of every color that Material 3 gives: its palette steps and its roles that are not a reference. */
function hexesOf(tree: unknown, into = new Set<string>()): Set<string> {
    if (!isObject(tree)) {
        return into;
    }

    if (typeof tree.$value === "string") {
        const color = parseColor(tree.$value);

        if (color !== undefined) {
            into.add(hexOf(color));
        }

        return into;
    }

    Object.values(tree).forEach((child) => hexesOf(child, into));

    return into;
}

/**
 * The scan's colors and Material 3's: the groups that Material 3 defines (`bg`, `text`, `accent`, the palettes) are its
 * own, and a color of the project that Material 3 also has is not listed twice. What the project uses besides (a literal
 * in its own styles, a status color) stays.
 */
function mergeColors(scan: unknown, material: Obj, all: MaterialResult): Obj {
    const known = hexesOf(material);

    for (const tree of Object.values(all.modes)) {
        hexesOf(tree, known);
    }

    const prune = (node: unknown): unknown => {
        if (!isObject(node)) {
            return node;
        }

        if ("$value" in node) {
            const color = typeof node.$value === "string" ? parseColor(node.$value) : undefined;

            return color !== undefined && known.has(hexOf(color)) ? undefined : node;
        }

        const out: Obj = {};

        for (const [key, child] of Object.entries(node)) {
            const kept = key.startsWith("$") ? child : prune(child);

            if (kept !== undefined && !(isObject(kept) && Object.keys(kept).length === 0)) {
                out[key] = kept;
            }
        }

        return out;
    };

    const rest = (isObject(scan) ? (prune(scan) as Obj) : {}) as Obj;

    // The groups of roles are Material's own. A palette group (`indigo`, `gray`) keeps the project's steps that Material does
    // not have, and takes Material's where a step is in both.
    const roleGroups = new Set([...Object.values(ROLES).map((path) => path[0]!), "md"]);
    const out: Obj = { ...rest };

    for (const [group, node] of Object.entries(material)) {
        const mine = rest[group];

        out[group] =
            !roleGroups.has(group) && isObject(mine) && isObject(node)
                ? { ...mine, ...node }
                : node;
    }

    delete out.md;

    return out;
}
