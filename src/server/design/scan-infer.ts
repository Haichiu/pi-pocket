/**
 * The inference of the design system scan (stream T): turns the facts about a project into a DTCG draft. It keeps the
 * project's own variables (named by what they hold), decides the color roles, names a palette by hue and lightness, and
 * reads the type scale, the spacing scale, the radii, the shadows, and the motion from how the project uses them. The
 * draft is run through the tokens engine, and any token it rejects is dropped, so the result always loads.
 */
import { commaParts, px } from "./scan-parse.ts";
import { type Rgba, contrastRatio, luminance, mixColors, parseColor, toHex } from "./color.ts";
import {
    type ColorEntry,
    type RoleChoice,
    type RoleName,
    ROLE_PATHS,
    chooseRoles,
    distance,
    entryOf,
    mergeColors,
    nameScore,
    paletteName,
    words,
} from "./scan-colors.ts";
import { type Category, type Facts, type VarFact, namespaceOf, stackOf } from "./scan-facts.ts";
import {
    Book,
    type Draft,
    type Inferred,
    bezier,
    breakpointScale,
    detailScales,
    fontScale,
    motionScale,
    radiusScale,
    shadowScale,
    shadowValue,
    sizeScale,
    spacingScale,
    topBy,
} from "./scan-scales.ts";
import { buildSystem } from "./tokens-model.ts";

/** A list of words from one string. */
const w = (text: string) => text.split(" ");

type Obj = Record<string, unknown>;

export type { Draft, Inferred };

/** A variable's identity: where it is set, what it holds, and its name. */
const vkey = (variable: { kind: VarFact["kind"]; hint?: Category; name: string }) =>
    `${variable.kind === "theme" ? "css" : variable.kind}:${variable.hint ?? ""}:${variable.name}`;

const slug = (text: string) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);

// --- Variables -----------------------------------------------------------------------------------------------------

interface Variable {
    name: string;
    kind: VarFact["kind"];
    light?: VarFact;
    dark?: VarFact;
    /** A value from the other mode's scope, used only when the default scope has none. */
    spare?: VarFact;
    hint?: Category;
}

/** The winning declaration of each variable in each scope: the best ranked file, and the last in that file. */
function variables(facts: Facts, alt: "dark" | "light"): Variable[] {
    const map = new Map<string, Variable>();
    const better = (a: VarFact | undefined, b: VarFact) =>
        a === undefined || b.rank < a.rank || (b.rank === a.rank && b.order > a.order);

    for (const fact of facts.vars) {
        const key = vkey(fact);
        const variable = map.get(key) ?? { name: fact.name, kind: fact.kind, hint: fact.hint };

        // The default scope is the page's own values; `alt` is the other mode. The scope that is neither (the
        // opposite mode of the project) only fills in what the default scope does not set.
        if (fact.scope === "default" && better(variable.light, fact)) {
            variable.light = fact;
        } else if (fact.scope === alt && better(variable.dark, fact)) {
            variable.dark = fact;
        } else if (
            fact.scope === (alt === "dark" ? "light" : "dark") &&
            variable.light === undefined
        ) {
            variable.spare = fact;
        }

        if (fact.hint !== undefined) {
            variable.hint = fact.hint;
        }

        map.set(key, variable);
    }

    for (const variable of map.values()) {
        variable.light ??= variable.spare;
    }

    return [...map.values()].filter(
        (variable) => variable.light !== undefined || variable.dark !== undefined,
    );
}

/** A variable's value with its references followed. `via` is the variable it points at first. */
function follow(
    index: Map<string, Variable>,
    start: Variable,
    scope: "light" | "dark",
): { text: string; via?: Variable } | undefined {
    const find = (name: string, kind: Variable["kind"]) => index.get(`${kind}:${name}`);
    let current = start;
    let text = (
        scope === "dark" ? (current.dark ?? current.light) : (current.light ?? current.dark)
    )?.value;
    let via: Variable | undefined;

    for (let hop = 0; hop < 8 && text !== undefined; hop++) {
        const css = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(text);
        const scss = /^\$([\w-]+)$/.exec(text);
        const less = /^@([\w-]+)$/.exec(text);
        const next =
            css !== null
                ? find(css[1]!, "css")
                : scss !== null
                  ? find(scss[1]!, "scss")
                  : less !== null
                    ? find(less[1]!, "less")
                    : undefined;

        if (css === null && scss === null && less === null) {
            break;
        }

        if (next === undefined) {
            if (css?.[2] !== undefined) {
                text = css[2].trim();

                continue;
            }

            return undefined;
        }

        via ??= next;
        current = next;
        text = (scope === "dark" ? (next.dark ?? next.light) : (next.light ?? next.dark))?.value;
    }

    if (text === undefined) {
        return undefined;
    }

    return { text: text.trim(), via };
}

/** The channels of a color written without its function: `222.2 47.4% 11.2%` (HSL) is how shadcn writes them. */
function channelColor(text: string, name: string): string | undefined {
    if (
        /^\d+(?:\.\d+)?(?:deg)?[ ,]+\d+(?:\.\d+)?%[ ,]+\d+(?:\.\d+)?%(?:\s*\/\s*[\d.]+%?)?$/.test(
            text,
        )
    ) {
        return `hsl(${text})`;
    }

    if (/-rgb$/.test(name) && /^\d{1,3}[ ,]+\d{1,3}[ ,]+\d{1,3}$/.test(text)) {
        return `rgb(${text})`;
    }

    return undefined;
}

const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|ch|pt)?$/;
const FONT_WORDS =
    /sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-monospace|ui-serif|cursive/i;

/** What a variable holds, from where it is set, its value, and then its name. */
function categorize(variable: Variable, text: string): Category | undefined {
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
        /^color-mix\(/i.test(text)
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

    if (FONT_WORDS.test(text) || (/font|family|typeface/.test(name) && /[,"']/.test(text))) {
        return "font";
    }

    if (/shadow|elevation/.test(name) && /\d/.test(text)) {
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

        if (/font-size|^text-|-text-|^fs-|^type-|(?:^|-)step-\d/.test(name)) {
            return px(text) !== undefined && px(text)! >= 8 && px(text)! <= 160 ? "text" : "size";
        }

        return "size";
    }

    return undefined;
}

const GROUPS: Record<Category, string> = {
    color: "color",
    font: "font",
    text: "text",
    space: "space",
    radius: "radius",
    shadow: "shadow",
    duration: "duration",
    ease: "ease",
    breakpoint: "breakpoint",
    weight: "weight",
    leading: "leading",
    tracking: "tracking",
    z: "z",
    opacity: "opacity",
    size: "size",
};

const PREFIX: Record<Category, RegExp> = {
    color: /^(?:theme-)?(?:colou?rs?|clr)-?/,
    font: /^(?:font(?:-family)?|family|typeface)-?/,
    text: /^(?:font-size|text|fs|size|type|step)-?/,
    space: /^(?:spacing|spacers?|space|gap|gutter)-?/,
    radius: /^(?:border-)?(?:radius|rounded|corner)-?/,
    shadow: /^(?:box-)?shadow-?|^elevation-?/,
    duration: /^(?:transition-)?(?:duration|time|speed)-?/,
    ease: /^(?:transition-)?(?:ease|easing|timing|curve)-?/,
    breakpoint: /^(?:breakpoint|screen|bp)-?/,
    weight: /^(?:font-weight|weight|fw)-?/,
    leading: /^(?:leading|line-height|lh)-?/,
    tracking: /^(?:tracking|letter-spacing)-?/,
    z: /^(?:z-index|z|layer)-?/,
    opacity: /^opacity-?/,
    size: /^(?:size|container|blur)-?/,
};

const FALLBACK_NAME: Record<Category, string> = {
    color: "base",
    font: "sans",
    text: "base",
    space: "base",
    radius: "md",
    shadow: "md",
    duration: "base",
    ease: "base",
    breakpoint: "base",
    weight: "base",
    leading: "base",
    tracking: "base",
    z: "base",
    opacity: "base",
    size: "base",
};

const ROLE_GROUPS = ["accent", "danger", "warning", "success", "bg", "text", "border"];

/** The token path of a project variable: its group, and its name without the group's own prefix. */
function pathOf(variable: Variable, category: Category): string[] {
    const stripped = variable.name.replace(PREFIX[category], "");
    const name = slug(stripped.replace(/\.+/g, "-"));
    const [first, ...tail] = name.split("-");

    // `--accent-hover` is `color.accent.hover`, beside `color.accent.default`.
    if (category === "color" && ROLE_GROUPS.includes(first!) && tail.length > 0) {
        return ["color", first!, tail.join("-")];
    }

    return [GROUPS[category], name === "" ? FALLBACK_NAME[category] : name];
}

// --- Values --------------------------------------------------------------------------------------------------------

/** The DTCG node for a variable's value in a category, or undefined when the value does not fit. */
function nodeFor(category: Category, text: string, colorText?: string): Obj | undefined {
    switch (category) {
        case "color":
            return colorText === undefined ? undefined : { $value: colorText, $type: "color" };

        case "font": {
            const stack = stackOf(text);

            return stack === undefined ? undefined : { $value: stack, $type: "fontFamily" };
        }

        case "weight": {
            const weight = Number(text);

            return Number.isFinite(weight) && weight >= 1 && weight <= 1000
                ? { $value: weight, $type: "fontWeight" }
                : undefined;
        }

        case "duration":
            return /^\d*\.?\d+(?:ms|s)$/.test(text)
                ? { $value: text, $type: "duration" }
                : undefined;

        case "ease": {
            const value = bezier(text);

            return value === undefined ? undefined : { $value: value, $type: "cubicBezier" };
        }

        case "shadow": {
            const value = shadowValue(text);

            return { $value: value, $type: "shadow" };
        }

        case "z":
        case "opacity":

        case "leading": {
            const value = Number(text);

            return Number.isFinite(value) ? { $value: value, $type: "number" } : undefined;
        }

        default: {
            // A dimension: text, space, radius, breakpoint, tracking, size.
            if (!LENGTH.test(text)) {
                return undefined;
            }

            const unitless = /^-?\d*\.?\d+$/.test(text);

            return {
                $value: unitless && Number(text) !== 0 ? `${text}px` : text,
                $type: "dimension",
            };
        }
    }
}

// --- The draft -----------------------------------------------------------------------------------------------------

/** Nested objects from flat tokens. A token that is also a group (`color.primary` and `color.primary.foreground`) becomes `….default`. */
function assemble(entries: { path: string[]; node: Obj }[], renamed: Map<string, string>): Obj {
    const paths = new Set(entries.map((entry) => entry.path.join(".")));
    const root: Obj = {};

    for (const entry of entries) {
        const name = entry.path.join(".");
        let path = entry.path;

        if ([...paths].some((other) => other.startsWith(`${name}.`))) {
            path = [...entry.path, paths.has(`${name}.default`) ? "base" : "default"];
            renamed.set(name, path.join("."));
        }

        let node = root;

        for (const key of path.slice(0, -1)) {
            node[key] ??= {};
            node = node[key] as Obj;
        }

        node[path.at(-1)!] = entry.node;
    }

    return root;
}

/** Hoists a `$type` shared by every token of a top-level group onto the group. */
function hoistTypes(root: Obj): void {
    for (const group of Object.values(root)) {
        if (typeof group !== "object" || group === null || "$value" in group) {
            continue;
        }

        const types = new Set<string>();

        const visit = (node: Obj) => {
            for (const [key, child] of Object.entries(node)) {
                if (key.startsWith("$") || typeof child !== "object" || child === null) {
                    continue;
                }

                if ("$value" in child) {
                    types.add(String((child as Obj).$type));
                } else {
                    visit(child as Obj);
                }
            }
        };

        visit(group as Obj);

        if (types.size === 1) {
            const [type] = types;

            const strip = (node: Obj) => {
                for (const [key, child] of Object.entries(node)) {
                    if (!key.startsWith("$") && typeof child === "object" && child !== null) {
                        if ("$value" in child) {
                            delete (child as Obj).$type;
                        } else {
                            strip(child as Obj);
                        }
                    }
                }
            };

            strip(group as Obj);

            // `$type` first, so the file reads naturally.
            const rest = { ...(group as Obj) };

            for (const key of Object.keys(group as Obj)) {
                delete (group as Obj)[key];
            }

            Object.assign(group as Obj, { $type: type }, rest);
        }
    }
}

/** A mode file needs no `$type`: a token takes it from the default mode. */
function dropTypes(node: Obj): Obj {
    for (const [key, child] of Object.entries(node)) {
        if (
            typeof child === "object" &&
            child !== null &&
            !Array.isArray(child) &&
            !key.startsWith("$")
        ) {
            if ("$value" in child) {
                delete (child as Obj).$type;
            } else {
                dropTypes(child as Obj);
            }
        }
    }

    return node;
}

/** Rewrites `{name}` references to tokens that were renamed. */
function rewrite(node: unknown, renamed: Map<string, string>): unknown {
    if (typeof node === "string") {
        return node.replace(/\{([^{}]+)\}/g, (all, name: string) =>
            renamed.has(name) ? `{${renamed.get(name)}}` : all,
        );
    }

    if (Array.isArray(node)) {
        return node.map((item) => rewrite(item, renamed));
    }

    if (typeof node === "object" && node !== null) {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [key, rewrite(value, renamed)]),
        );
    }

    return node;
}

/** A variable sorted into a category, with its value in the default scope and in the other mode. */
interface Classified {
    variable: Variable;
    category: Category;
    light?: string;
    dark?: string;
    lightColor?: string;
    darkColor?: string;
    via?: Variable;
}

interface Prepared {
    classified: Classified[];
    /** The other mode: `dark` in most projects, `light` in a dark-first one. */
    alt: "dark" | "light";
}

/**
 * A color from CSS text: a color, a channel triple, a `var()`, or a `color-mix()` of those. A variable is looked up in
 * the mode being read, and in the default scope where the mode does not set it.
 */
function evalColor(
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
        // `color 40%` or `40% color`.
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

/** Sorts the project's variables into categories and reads their values in both modes. */
function prepare(facts: Facts, alt: "dark" | "light"): Prepared {
    const all = variables(facts, alt);
    const index = new Map<string, Variable>();

    for (const variable of all) {
        if (variable.kind !== "js") {
            index.set(
                `${variable.kind === "theme" ? "css" : variable.kind}:${variable.name}`,
                variable,
            );
        }
    }

    const classified: Classified[] = [];

    for (const variable of all) {
        // `--text-hero--line-height` belongs to `--text-hero`; it is not a token of its own.
        if (variable.name.includes("--")) {
            continue;
        }

        const light = follow(index, variable, "light");
        const dark = variable.dark === undefined ? undefined : follow(index, variable, "dark");
        const sample = light?.text ?? dark?.text;

        if (
            sample === undefined ||
            /^(?:inherit|initial|unset|none|auto|currentcolor|transparent)$/i.test(sample)
        ) {
            continue;
        }

        const category = categorize(variable, sample);

        if (category === undefined) {
            continue;
        }

        const entry: Classified = {
            variable,
            category,
            light: light?.text,
            dark: dark?.text,
            via: light?.via,
        };

        if (category === "color") {
            // What the author wrote when it is a color; the computed color when it is a `color-mix()` or a `var()`.
            const asColor = (text: string | undefined, mode: "light" | "dark") => {
                if (text === undefined) {
                    return undefined;
                }

                const direct = channelColor(text, variable.name) ?? text;

                if (parseColor(direct) !== undefined) {
                    return direct;
                }

                const computed = evalColor(text, variable.name, mode, index);

                return computed === undefined ? undefined : toHex(computed);
            };

            entry.lightColor = asColor(light?.text, "light");
            entry.darkColor = asColor(dark?.text, "dark");

            if (entry.lightColor === undefined && entry.darkColor === undefined) {
                continue;
            }
        }

        classified.push(entry);
    }

    return { classified, alt };
}

/** Whether the project's page background (in the default scope) is dark. */
function pageIsDark(prep: Prepared): boolean {
    let best: { score: number; color: Rgba } | undefined;

    for (const entry of prep.classified) {
        const color = entry.lightColor === undefined ? undefined : parseColor(entry.lightColor);
        const score = nameScore("background", words(entry.variable.name));

        if (
            entry.category === "color" &&
            color !== undefined &&
            score >= 60 &&
            (best === undefined || score > best.score)
        ) {
            best = { score, color };
        }
    }

    return best !== undefined && luminance(best.color) < 0.2;
}

/** Runs the scan's inference. `folder` names the system. */
export function infer(facts: Facts, folder: string): Inferred {
    const result: Inferred = {
        draft: { tokens: {}, modes: {} },
        roles: {},
        palette: {},
        typeScale: { sizes: [] },
        fonts: {},
        spacing: { steps: [], off: [] },
        radii: [],
        shadows: 0,
        motion: { durations: [], easings: [] },
        breakpoints: [],
        hasDark: false,
        modes: { default: "light", alt: "dark" },
        notes: [],
        imported: 0,
        dropped: [],
    };
    const meta = { $extensions: { "com.pi-pocket": { name: folder } } };

    // A project that already keeps tokens in a token file: use them.
    if (facts.imported.count >= 8) {
        result.imported = facts.imported.count;
        result.draft = {
            tokens: { ...meta, ...(facts.imported.default as Obj) },
            modes:
                Object.keys(facts.imported.dark).length > 0
                    ? { dark: facts.imported.dark as Obj }
                    : {},
        };
        result.hasDark = Object.keys(facts.imported.dark).length > 0;
        result.notes.push(
            `Used the ${facts.imported.count} tokens from ${facts.imported.files.join(", ")} as they are; styles were not guessed.`,
        );

        return validate(result);
    }

    let prep = prepare(facts, "dark");

    // A project whose default scope is dark and that names a light scope is dark first: light is its other mode.
    if (facts.vars.some((fact) => fact.scope === "light") && pageIsDark(prep)) {
        prep = prepare(facts, "light");
    }

    const { classified, alt } = prep;

    result.modes =
        alt === "dark" ? { default: "light", alt: "dark" } : { default: "dark", alt: "light" };
    const book = new Book();
    const aliasOf = new Map<string, string[]>();
    const uses = (variable: Variable) =>
        (facts.varUse.get(variable.name) ?? 0) +
        (variable.kind === "theme" || variable.kind === "css"
            ? (facts.classUse.get(variable.name.replace(/^color-/, "")) ?? 0)
            : 0);

    const colorVars = classified.filter((entry) => entry.category === "color");

    // 2. Colors: the variables' values and the literal uses, merged; then the roles.
    const hexOf = (text: string | undefined) => {
        const color = text === undefined ? undefined : parseColor(text);

        return color === undefined ? undefined : toHex(color);
    };

    const lightDefined = colorVars.flatMap((entry) => {
        const hex = hexOf(entry.lightColor);

        return hex === undefined ? [] : [{ hex, text: entry.lightColor! }];
    });
    const darkDefined = colorVars.flatMap((entry) => {
        const hex = hexOf(entry.darkColor);

        return hex === undefined ? [] : [{ hex, text: entry.darkColor! }];
    });
    const lightColors = mergeColors(lightDefined, facts.colors);
    const darkColors = mergeColors(darkDefined, alt === "dark" ? facts.darkColors : new Map());
    const namedLight = colorVars.flatMap((entry) => {
        const hex = hexOf(entry.lightColor);

        return hex === undefined
            ? []
            : [{ name: entry.variable.name, hex, uses: uses(entry.variable) }];
    });
    const namedDark = colorVars.flatMap((entry) => {
        const hex = hexOf(entry.darkColor);

        return hex === undefined
            ? []
            : [{ name: entry.variable.name, hex, uses: uses(entry.variable) }];
    });

    for (const each of namedLight) {
        lightColors.get(each.hex)?.names.push({ name: each.name, uses: each.uses });
    }

    const lightRoles = chooseRoles(lightColors, namedLight);

    // A project with one background color, called a surface, has no other page color: the surface is the page too.
    if (lightRoles.background === undefined && lightRoles.surface?.basis === "name") {
        lightRoles.background = { ...lightRoles.surface, role: "background" };
        delete lightRoles.surface;
    }

    const hasDarkVars = classified.some((entry) => entry.variable.dark !== undefined);

    result.hasDark = hasDarkVars || (alt === "dark" && facts.darkColors.size > 0);

    // Names paired with the light roles first: the same variable's dark value is the dark role.
    const darkRoles: Partial<Record<RoleName, RoleChoice>> = result.hasDark
        ? chooseRoles(darkColors, namedDark)
        : {};

    for (const [role, choice] of Object.entries(lightRoles) as [RoleName, RoleChoice][]) {
        if (choice.basis === "name") {
            const source = colorVars.find((entry) => entry.variable.name === choice.source);
            const dark = hexOf(source?.darkColor);

            if (dark !== undefined) {
                darkRoles[role] = {
                    role,
                    hex: dark,
                    basis: "name",
                    source: choice.source,
                    score: choice.score,
                };
            }
        }
    }

    // 3. The palette: scales the project names, then the role colors, then the colors it uses most.
    const scales = new Map<string, Classified[]>();

    for (const entry of colorVars) {
        const match =
            /^(?:color-|colour-|clr-)?([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d{1,3})$/i.exec(
                entry.variable.name,
            );

        if (
            match !== null &&
            !w(
                "bg background surface text fg foreground border layer base space spacing size step",
            ).includes(match[1]!.toLowerCase())
        ) {
            const list = scales.get(match[1]!.toLowerCase()) ?? [];

            list.push(entry);
            scales.set(match[1]!.toLowerCase(), list);
        }
    }

    const hexPath = new Map<string, string[]>();

    const palette = (hex: string, text: string): string[] => {
        const known = hexPath.get(hex);

        if (known !== undefined) {
            return known;
        }

        const entry = lightColors.get(hex) ?? darkColors.get(hex) ?? entryOf(hex, text)!;
        const path = paletteName(entry, book.taken());

        book.add(path, { $value: text, $type: "color" });
        hexPath.set(hex, path);
        result.palette[path[1]!] = (result.palette[path[1]!] ?? 0) + 1;

        return path;
    };

    const asValue = (hex: string, entries: Map<string, ColorEntry>) => {
        const entry = entries.get(hex);

        return entry === undefined
            ? hex
            : entry.text.startsWith("#") ||
                /^[a-z]/i.test(entry.text) ||
                /^(?:rgb|hsl|oklch|oklab|lab|lch|hwb)/i.test(entry.text)
              ? normalizeColor(entry.text)
              : hex;
    };

    const scaleVars = new Set<Classified>();

    for (const [family, list] of scales) {
        if (
            list.length < 2 &&
            !w(
                "gray grey red orange yellow green blue indigo purple pink teal cyan lime amber emerald sky violet fuchsia rose slate zinc stone neutral",
            ).includes(family)
        ) {
            continue;
        }

        for (const entry of list) {
            const step = /(\d{1,3})$/.exec(entry.variable.name)![1]!;
            const path = ["color", slug(family === "grey" ? "gray" : family), step];
            const hex = hexOf(entry.lightColor ?? entry.darkColor);

            if (hex === undefined || book.has(path)) {
                continue;
            }

            const value = normalizeColor((entry.lightColor ?? entry.darkColor)!);

            book.add(path, { $value: value, $type: "color" });
            scaleVars.add(entry);
            aliasOf.set(vkey(entry.variable), path);
            hexPath.set(hex, hexPath.get(hex) ?? path);
            result.palette[path[1]!] = (result.palette[path[1]!] ?? 0) + 1;

            const darkHex = hexOf(entry.darkColor);

            if (darkHex !== undefined && darkHex !== hex) {
                book.addDark(path, { $value: normalizeColor(entry.darkColor!), $type: "color" });
            }
        }
    }

    // Roles.
    const roleVars = new Set<string>();
    const lightAlias = (hex: string) => `{${palette(hex, asValue(hex, lightColors)).join(".")}}`;

    for (const role of Object.keys(ROLE_PATHS) as RoleName[]) {
        const light = lightRoles[role];

        if (light === undefined) {
            continue;
        }

        const path = ROLE_PATHS[role];
        const dark = darkRoles[role];
        const node: Obj = { $value: lightAlias(light.hex), $type: "color" };

        const source = colorVars.find((entry) => entry.variable.name === light.source);

        if (light.basis === "name") {
            roleVars.add(light.source);
        }

        book.add(path, node);

        if (source !== undefined) {
            aliasOf.set(vkey(source.variable), path);
        }

        if (dark !== undefined && dark.hex !== light.hex) {
            const target = palette(dark.hex, asValue(dark.hex, darkColors));

            book.addDark(path, { $value: `{${target.join(".")}}`, $type: "color" });
        }

        result.roles[role] = {
            token: path.join("."),
            value: light.hex,
            ...(dark !== undefined && dark.hex !== light.hex ? { dark: dark.hex } : {}),
            basis: light.basis,
            source: light.source,
        };
    }

    // Text on the accent color: whichever of the page, the text, white, and black reads best.
    const accent =
        lightRoles.accent === undefined ? undefined : lightColors.get(lightRoles.accent.hex);

    if (accent !== undefined) {
        const pool = [
            lightRoles.background?.hex,
            lightRoles.text?.hex,
            "#ffffff",
            "#000000",
        ].filter((hex): hex is string => hex !== undefined);
        // White is what a project already puts on its accent when it uses white as a text color and it reads well enough.
        const whiteText = (facts.colors.get("#ffffff")?.text ?? 0) > 0;

        const pick = (accentColor: ColorEntry, entries: Map<string, ColorEntry>) => {
            const best = topBy(
                pool,
                (hex) => {
                    const color = entries.get(hex)?.rgba ?? parseColor(hex);

                    return color === undefined ? 0 : contrastRatio(color, accentColor.rgba);
                },
                1,
            )[0]!;

            return whiteText && contrastRatio(parseColor("#ffffff")!, accentColor.rgba) >= 3
                ? "#ffffff"
                : best;
        };

        const onLight = pick(accent, lightColors);
        const path = ["color", "text", "on-accent"];

        book.add(path, {
            $value: `{${palette(onLight, asValue(onLight, lightColors)).join(".")}}`,
            $type: "color",
        });

        const darkAccent =
            darkRoles.accent === undefined ? undefined : darkColors.get(darkRoles.accent.hex);

        if (darkAccent !== undefined) {
            const onDark = pick(darkAccent, darkColors);

            if (onDark !== onLight) {
                book.addDark(path, {
                    $value: `{${palette(onDark, asValue(onDark, darkColors)).join(".")}}`,
                    $type: "color",
                });
            }
        }
    }

    // The colors the project uses most that no variable or role holds yet.
    const known = [...hexPath.keys()].map((hex) => lightColors.get(hex) ?? entryOf(hex)!);
    const extra = topBy(
        [...lightColors.values()].filter(
            (entry) =>
                !hexPath.has(entry.hex) &&
                entry.rgba.a > 0.05 &&
                entry.uses >= 2 &&
                known.every((other) => distance(other, entry) > 0.02),
        ),
        (entry) => entry.uses,
        8,
    );

    for (const entry of extra) {
        palette(entry.hex, asValue(entry.hex, lightColors));
    }

    // The rest of the project's own color variables, under their own names, as aliases of the palette.
    const rest = classified.filter(
        (entry) =>
            entry.category === "color" &&
            !scaleVars.has(entry) &&
            !roleVars.has(entry.variable.name),
    );

    for (const entry of topBy(rest, (each) => uses(each.variable) + 0.01, 40)) {
        const hex = hexOf(entry.lightColor);
        const path = pathOf(entry.variable, "color");

        if (hex === undefined || book.has(path)) {
            continue;
        }

        const target = entry.via === undefined ? undefined : aliasOf.get(vkey(entry.via));
        const primitive = target ?? palette(hex, asValue(hex, lightColors));

        book.add(path, { $value: `{${primitive.join(".")}}`, $type: "color" });
        aliasOf.set(vkey(entry.variable), path);

        const darkHex = hexOf(entry.darkColor);

        if (darkHex !== undefined && darkHex !== hex) {
            const darkPrimitive = palette(darkHex, asValue(darkHex, darkColors));

            book.addDark(path, { $value: `{${darkPrimitive.join(".")}}`, $type: "color" });
        }
    }

    // 4. The other categories: the project's own variables first.
    const explicit = new Set<Category>();

    for (const entry of classified) {
        if (entry.category === "color" || entry.light === undefined) {
            continue;
        }

        const node = nodeFor(entry.category, entry.light);
        const path = pathOf(entry.variable, entry.category);

        if (node === undefined || book.has(path)) {
            continue;
        }

        book.add(path, node);
        explicit.add(entry.category);
        aliasOf.set(vkey(entry.variable), path);

        const dark =
            entry.dark === undefined || entry.dark === entry.light
                ? undefined
                : nodeFor(entry.category, entry.dark);

        if (dark !== undefined) {
            book.addDark(path, dark);
        }
    }

    // 5. What the project does not name, read from how it uses it.
    fontScale(facts, book, explicit, result);
    sizeScale(facts, book, explicit, result);
    detailScales(facts, book, explicit);
    spacingScale(facts, book, explicit, result);
    radiusScale(facts, book, explicit, result);
    shadowScale(facts, book, explicit, result);
    motionScale(facts, book, explicit, result);
    breakpointScale(facts, book, explicit, result);

    // 6. Assemble, add the contrast pairs, and keep only what the engine accepts.
    const renamed = new Map<string, string>();
    const tokens = assemble([...book.tokens.values()], renamed);
    const darkTree = assemble([...book.dark.values()], renamed);

    pair(tokens, ["color", "text", "primary"], "{color.bg.page}");
    pair(tokens, ["color", "text", "muted"], "{color.bg.page}");
    pair(tokens, ["color", "text", "on-accent"], "{color.accent.default}");
    hoistTypes(tokens);
    // A dark-first project names its default mode: the light mode is the file that changes it.
    const extension = alt === "light" ? { name: folder, mode: "dark" } : { name: folder };
    const other = dropTypes(rewrite(darkTree, renamed) as Obj);

    result.draft = {
        tokens: rewrite({ $extensions: { "com.pi-pocket": extension }, ...tokens }, renamed) as Obj,
        modes:
            Object.keys(darkTree).length > 0
                ? {
                      [alt]: {
                          $extensions: { "com.pi-pocket": { colorScheme: alt } },
                          ...other,
                      },
                  }
                : {},
    };

    return validate(result);
}

/** The color as `#hex` or a function, trimmed, for a token's value. */
function normalizeColor(text: string): string {
    const trimmed = text.trim();

    return trimmed.startsWith("#") ? trimmed.toLowerCase() : trimmed.replace(/\s+/g, " ");
}

/** Adds a contrast pair to a token of the tree, if both exist. */
function pair(tree: Obj, path: string[], on: string): void {
    let node: unknown = tree;

    for (const key of path) {
        node = typeof node === "object" && node !== null ? (node as Obj)[key] : undefined;
    }

    if (typeof node !== "object" || node === null || !("$value" in node)) {
        return;
    }

    const target = on.slice(1, -1).split(".");
    let found: unknown = tree;

    for (const key of target) {
        found = typeof found === "object" && found !== null ? (found as Obj)[key] : undefined;
    }

    if (typeof found === "object" && found !== null && "$value" in found) {
        (node as Obj).$extensions = { "com.pi-pocket": { contrast: { on, min: 4.5 } } };
    }
}

// --- Validation ----------------------------------------------------------------------------------------------------

/** Runs the draft through the tokens engine; a token it refuses is dropped, so the result always loads. */
function validate(result: Inferred): Inferred {
    for (let pass = 0; pass < 4; pass++) {
        const system = buildSystem({
            folder: "draft",
            tokens: result.draft.tokens,
            modes: new Map(Object.entries(result.draft.modes)),
            components: new Map(),
            guidelines: "",
            problems: [],
        });
        const bad = new Set(
            system.problems
                .filter((problem) => problem.level === "error" && problem.token !== undefined)
                .map((problem) => problem.token!),
        );

        if (bad.size === 0) {
            break;
        }

        for (const name of bad) {
            result.dropped.push(name);
            remove(result.draft.tokens, name.split("."));

            for (const mode of Object.values(result.draft.modes)) {
                remove(mode, name.split("."));
            }
        }
    }

    return result;
}

function remove(tree: Obj, path: string[]): void {
    const chain: Obj[] = [tree];
    let node = tree;

    for (const key of path.slice(0, -1)) {
        const child = node[key];

        if (typeof child !== "object" || child === null) {
            return;
        }

        node = child as Obj;
        chain.push(node);
    }

    delete node[path.at(-1)!];

    for (let at = chain.length - 1; at > 0; at--) {
        if (Object.keys(chain[at]!).filter((key) => !key.startsWith("$")).length > 0) {
            break;
        }

        delete chain[at - 1]![path[at - 1]!];
    }
}
