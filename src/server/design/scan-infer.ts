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
    entryOf,
    merge as mergeFact,
    mergeColors,
    nameScore,
    nearColors,
    paletteName,
    words,
} from "./scan-colors.ts";
import {
    type Category,
    type Facts,
    type Kinds,
    type VarFact,
    colorFact,
    ingest,
    namespaceOf,
    stackOf,
} from "./scan-facts.ts";
import { TAILWIND_3_COLORS, TAILWIND_4_COLORS } from "./scan-tailwind.ts";
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

const kebab = (name: string) =>
    name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");

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
    /** It holds the other mode's value of another variable (`--dark-bg` beside `--bg`). */
    twin?: boolean;
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

    pairModeTwins(map, alt);

    return [...map.values()].filter(
        (variable) => variable.light !== undefined || variable.dark !== undefined,
    );
}

/**
 * Variables that a project keeps for the other mode under their own names (`--dark-bg`, `--bg-dark`, `$night-ink`) are
 * the other mode's value of the plain variable (`--bg`): they are not colors of their own. A dark-named variable that the
 * plain one points at in the dark scope (`--bg: var(--dark-bg)`) is one for sure; without that, three pairs make a scheme,
 * and a name that has a `-light` or `-main` sibling (`primary-dark` beside `primary-light`) is a shade, not a mode.
 */
function pairModeTwins(map: Map<string, Variable>, alt: "dark" | "light"): void {
    const mode = alt === "dark" ? /^(?:dark|night)$/ : /^(?:light|day)$/;
    const plain = (name: string) => kebab(name).replace(/^(?:color|colour|clr)-/, "");
    const byName = new Map<string, Variable>();

    for (const [key, variable] of map) {
        if (
            key.startsWith("css:") ||
            key.startsWith("scss:") ||
            key.startsWith("less:") ||
            key.startsWith("js:")
        ) {
            byName.set(`${variable.kind}:${plain(variable.name)}`, variable);
        }
    }

    const pairs: { twin: Variable; base: Variable; sure: boolean }[] = [];

    for (const variable of map.values()) {
        const words = plain(variable.name).split("-");
        const at = words.findIndex((word) => mode.test(word));

        if (at === -1 || words.length < 2 || variable.light === undefined) {
            continue;
        }

        const base = byName.get(
            `${variable.kind}:${words.filter((_, index) => index !== at).join("-")}`,
        );

        if (base === undefined || base === variable) {
            continue;
        }

        const target = new RegExp(String.raw`var\(\s*--${variable.name}\s*[,)]`);
        const sure = base.dark !== undefined && target.test(base.dark.value);
        const shade =
            at === words.length - 1 &&
            [...map.values()].some(
                (other) =>
                    /^(?:light|main|base|default)$/.test(
                        plain(other.name).slice(words.slice(0, at).join("-").length + 1),
                    ) && plain(other.name).startsWith(`${words.slice(0, at).join("-")}-`),
            );

        if (sure || !shade) {
            pairs.push({ twin: variable, base, sure });
        }
    }

    if (pairs.length < 3 && !pairs.some((pair) => pair.sure)) {
        return;
    }

    for (const { twin, base } of pairs) {
        base.dark ??= { ...twin.light!, scope: alt };
        twin.twin = true;
    }
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

    // SCSS and Less arithmetic (`$space-1 * 3`), and CSS `calc()` over custom properties (`calc(var(--radius) - 2px)`).
    const calc = /^calc\((.*)\)$/s.exec(text.trim());

    if (
        (/[$@][A-Za-z_]/.test(text) && /[*/+()]|\s-\s/.test(text)) ||
        (calc !== null && /var\(/.test(text))
    ) {
        const math = evalMath(calc === null ? text : calc[1]!, (name, kind) => {
            const target = index.get(`${kind}:${name}`);

            return target === undefined ? undefined : follow(index, target, scope)?.text;
        });

        if (math !== undefined) {
            text = math;
        }
    }

    return { text: text.trim(), via };
}

/** `$a * 3`, `($a + 4px) / 2`: arithmetic on lengths, with variables looked up by `value`. Undefined if it cannot. */
function evalMath(
    text: string,
    value: (name: string, kind: "scss" | "less" | "css") => string | undefined,
): string | undefined {
    const tokens = text.match(/var\(\s*--[\w-]+\s*\)|\$[\w-]+|@[\w-]+|\d*\.?\d+[a-z%]*|[()+*/-]/g);
    let at = 0;

    if (tokens === null || tokens.join("").length < text.replace(/\s/g, "").length) {
        return undefined;
    }

    interface Quantity {
        n: number;
        unit: string;
    }

    const operand = (token: string): Quantity | undefined => {
        const source = token.startsWith("var(")
            ? value(/--([\w-]+)/.exec(token)![1]!, "css")
            : /^[$@]/.test(token)
              ? value(token.slice(1), token[0] === "$" ? "scss" : "less")
              : token;
        const match = source === undefined ? null : /^(-?\d*\.?\d+)([a-z%]*)$/.exec(source.trim());

        return match === null ? undefined : { n: Number(match[1]), unit: match[2]! };
    };

    const factor = (): Quantity | undefined => {
        const token = tokens[at++];

        if (token === undefined) {
            return undefined;
        }

        if (token === "(") {
            const inner = sum();

            return tokens[at++] === ")" ? inner : undefined;
        }

        if (token === "-") {
            const inner = factor();

            return inner === undefined ? undefined : { n: -inner.n, unit: inner.unit };
        }

        return operand(token);
    };

    const product = (): Quantity | undefined => {
        let left = factor();

        while (left !== undefined && (tokens[at] === "*" || tokens[at] === "/")) {
            const op = tokens[at++];
            const right = factor();

            if (right === undefined || (op === "/" && right.n === 0)) {
                return undefined;
            }

            left =
                op === "*"
                    ? { n: left.n * right.n, unit: left.unit || right.unit }
                    : { n: left.n / right.n, unit: left.unit === right.unit ? "" : left.unit };
        }

        return left;
    };

    const sum = (): Quantity | undefined => {
        let left = product();

        while (left !== undefined && (tokens[at] === "+" || tokens[at] === "-")) {
            const op = tokens[at++];
            let right = product();

            // rem and em are 16px when a sum mixes them with pixels (`0.5rem - 2px`).
            if (right !== undefined && left.unit !== right.unit) {
                const pixels = (quantity: Quantity): Quantity =>
                    quantity.unit === "rem" || quantity.unit === "em"
                        ? { n: quantity.n * 16, unit: "px" }
                        : quantity;

                if (
                    ["px", "rem", "em"].includes(left.unit) &&
                    ["px", "rem", "em"].includes(right.unit)
                ) {
                    left = pixels(left);
                    right = pixels(right);
                }
            }

            if (
                right === undefined ||
                (left.unit !== right.unit && left.unit !== "" && right.unit !== "")
            ) {
                return undefined;
            }

            left = {
                n: op === "+" ? left.n + right.n : left.n - right.n,
                unit: left.unit || right.unit,
            };
        }

        return left;
    };

    const result = sum();

    return result === undefined || at !== tokens.length || !Number.isFinite(result.n)
        ? undefined
        : `${Math.round(result.n * 1000) / 1000}${result.unit}`;
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
function categorize(
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

        {
            const most = Math.max(layout.space, layout.text, layout.radius, layout.box);

            if (most > 0 && layout.box < most) {
                return layout.space === most ? "space" : layout.radius === most ? "radius" : "text";
            }
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

/** Words that name a role, or its colors (`hover`-ed or `dark`-ened): such a color is nested, not a role of its own. */
const ROLE_WORDS = new Set(
    "accent brand primary link highlight danger error destructive critical negative warning warn caution success positive valid ok bg background canvas page surface card panel elevated raised popover layer text fg foreground ink content muted subtle dim faint quiet tertiary border divider outline stroke line separator hairline".split(
        " ",
    ),
);

/** The token path of a project variable: its group, and its name without the group's own prefix. */
function nameOf(variable: Variable, category: Category): string {
    // `borderRadius` and `border-radius` are one name.
    const stripped = variable.name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(PREFIX[category], "");

    return slug(stripped.replace(/\.+/g, "-"));
}

function pathOf(variable: Variable, category: Category): string[] {
    const name = nameOf(variable, category);
    const [first, ...tail] = name.split("-");

    // `--accent-hover` is `color.accent.hover`, beside `color.accent.default`; `--primary` is `color.primary.default`.
    // A color with a role word in its name sits one level down, so that it never takes the place of the role's own token.
    if (category === "color" && name !== "" && words(name).some((word) => ROLE_WORDS.has(word))) {
        return tail.length > 0 ? ["color", first!, tail.join("-")] : ["color", first!, "default"];
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
    index: Map<string, Variable>;
    classified: Classified[];
    /** The other mode: `dark` in most projects, `light` in a dark-first one. */
    alt: "dark" | "light";
    /** Colors kept for the other mode under names of their own (`$dark-text`), as the roles they stand for. */
    others: { role: string; entry: Classified }[];
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

    // A Sass or Less variable (`$black`, `v.$dark-text`, `@primary`).
    const sassVar = /^(?:[\w-]+\.)?[$@]([\w-]+)$/.exec(trimmed);

    if (sassVar !== null) {
        const target = index.get(`scss:${sassVar[1]}`) ?? index.get(`less:${sassVar[1]}`);
        const value = (
            mode === "dark" ? (target?.dark ?? target?.light) : (target?.light ?? target?.dark)
        )?.value;

        return value === undefined
            ? undefined
            : evalColor(value, sassVar[1]!, mode, index, depth + 1);
    }

    const call = /^([a-z][a-z-]*)\(([\s\S]*)\)$/i.exec(trimmed);

    if (call !== null && SASS_COLOR.has(call[1]!.toLowerCase())) {
        const args = commaParts(call[2]!);
        const color =
            args[0] === undefined ? undefined : evalColor(args[0], name, mode, index, depth + 1);
        const amount = (text: string | undefined) => {
            const match = /^(-?\d*\.?\d+)(%?)$/.exec((text ?? "").trim());

            return match === null
                ? undefined
                : match[2] === "%"
                  ? Number(match[1]) / 100
                  : Number(match[1]);
        };

        if (color !== undefined) {
            return sassColor(call[1]!.toLowerCase(), color, args.slice(1), amount, (arg) =>
                evalColor(arg, name, mode, index, depth + 1),
            );
        }
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

const SASS_COLOR = new Set([
    "rgba",
    "rgb",
    "darken",
    "lighten",
    "saturate",
    "desaturate",
    "fade-in",
    "fade-out",
    "transparentize",
    "opacify",
    "mix",
    "tint-color",
    "shade-color",
    "shift-color",
    "adjust-hue",
]);

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));

/** HSL of an sRGB color: hue in degrees, saturation and lightness 0 to 1. */
function toHsl({ r, g, b }: Rgba): [number, number, number] {
    const [x, y, z] = [r / 255, g / 255, b / 255];
    const high = Math.max(x, y, z);
    const low = Math.min(x, y, z);
    const lightness = (high + low) / 2;
    const delta = high - low;

    if (delta === 0) {
        return [0, 0, lightness];
    }

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    const hue =
        high === x ? ((y - z) / delta) % 6 : high === y ? (z - x) / delta + 2 : (x - y) / delta + 4;

    return [(hue * 60 + 360) % 360, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number, a: number): Rgba {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const h = (((hue % 360) + 360) % 360) / 60;
    const second = chroma * (1 - Math.abs((h % 2) - 1));
    const [r, g, b] =
        h < 1
            ? [chroma, second, 0]
            : h < 2
              ? [second, chroma, 0]
              : h < 3
                ? [0, chroma, second]
                : h < 4
                  ? [0, second, chroma]
                  : h < 5
                    ? [second, 0, chroma]
                    : [chroma, 0, second];
    const offset = lightness - chroma / 2;

    return {
        r: Math.round((r + offset) * 255),
        g: Math.round((g + offset) * 255),
        b: Math.round((b + offset) * 255),
        a,
    };
}

/** The Sass color functions that change one color or mix two (`rgba($c, .5)`, `darken($c, 10%)`, `mix(a, b, 30%)`). */
function sassColor(
    fn: string,
    color: Rgba,
    rest: string[],
    amount: (text: string | undefined) => number | undefined,
    other: (text: string) => Rgba | undefined,
): Rgba | undefined {
    const value = amount(rest[0]);
    const mixWith = (target: Rgba, weight: number): Rgba => ({
        r: Math.round(color.r * weight + target.r * (1 - weight)),
        g: Math.round(color.g * weight + target.g * (1 - weight)),
        b: Math.round(color.b * weight + target.b * (1 - weight)),
        a: color.a * weight + target.a * (1 - weight),
    });
    const [hue, saturation, lightness] = toHsl(color);

    switch (fn) {
        case "rgba":
        case "rgb":
            return value === undefined ? undefined : { ...color, a: clamp(value) };

        case "fade-in":
        case "opacify":
            return value === undefined ? undefined : { ...color, a: clamp(color.a + value) };

        case "fade-out":
        case "transparentize":
            return value === undefined ? undefined : { ...color, a: clamp(color.a - value) };

        case "darken":
            return value === undefined
                ? undefined
                : fromHsl(hue, saturation, clamp(lightness - value), color.a);

        case "lighten":
            return value === undefined
                ? undefined
                : fromHsl(hue, saturation, clamp(lightness + value), color.a);

        case "saturate":
            return value === undefined
                ? undefined
                : fromHsl(hue, clamp(saturation + value), lightness, color.a);

        case "desaturate":
            return value === undefined
                ? undefined
                : fromHsl(hue, clamp(saturation - value), lightness, color.a);

        case "adjust-hue":
            return value === undefined
                ? undefined
                : fromHsl(
                      hue + value * (rest[0]?.includes("%") ? 1 : 1),
                      saturation,
                      lightness,
                      color.a,
                  );

        case "mix": {
            const second = rest[0] === undefined ? undefined : other(rest[0]);
            const weight = rest[1] === undefined ? 0.5 : amount(rest[1]);

            return second === undefined || weight === undefined
                ? undefined
                : mixWith(second, clamp(weight));
        }

        // Bootstrap: `tint-color($c, 20%)` mixes in white, `shade-color($c, 20%)` mixes in black.
        case "tint-color":
            return value === undefined
                ? undefined
                : fromMix(color, { r: 255, g: 255, b: 255, a: 1 }, value);

        case "shade-color":
            return value === undefined
                ? undefined
                : fromMix(color, { r: 0, g: 0, b: 0, a: 1 }, value);

        case "shift-color":
            return value === undefined
                ? undefined
                : value >= 0
                  ? fromMix(color, { r: 0, g: 0, b: 0, a: 1 }, value)
                  : fromMix(color, { r: 255, g: 255, b: 255, a: 1 }, -value);

        default:
            return undefined;
    }
}

/** `weight` of `target` mixed into `color` (Bootstrap's `mix($target, $color, $weight)`). */
function fromMix(color: Rgba, target: Rgba, weight: number): Rgba {
    const w = clamp(weight);

    return {
        r: Math.round(target.r * w + color.r * (1 - w)),
        g: Math.round(target.g * w + color.g * (1 - w)),
        b: Math.round(target.b * w + color.b * (1 - w)),
        a: color.a,
    };
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
        // `--text-hero--line-height` belongs to `--text-hero`; it is not a token of its own. A variable that holds the
        // other mode's value of another one (`--dark-bg`) is not either.
        if (variable.name.includes("--") || variable.twin === true) {
            continue;
        }

        const fluid = (found: { text: string; via?: Variable } | undefined) => {
            const clamp =
                found === undefined ? null : /^clamp\(\s*([^,()]+),/i.exec(found.text.trim());

            return found === undefined || clamp === null || px(clamp[1]!) === undefined
                ? found
                : { ...found, text: clamp[1]!.trim() };
        };
        const light = fluid(follow(index, variable, "light"));
        const dark =
            variable.dark === undefined ? undefined : fluid(follow(index, variable, "dark"));
        const sample = light?.text ?? dark?.text;

        if (
            sample === undefined ||
            /^(?:inherit|initial|unset|none|auto|currentcolor|transparent)$/i.test(sample)
        ) {
            continue;
        }

        const category = categorize(variable, sample, facts.varLayout);

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

    // `$dark-background`, `$dark-text-muted`: when a project keeps a few colors for the other mode under names that are
    // roles with a mode word before them, they are that mode's roles, not colors of their own. (`$dark-blue` is a shade.)
    const mode = alt === "dark" ? /^(?:dark|night)$/ : /^(?:light|day)$/;
    const loose = classified.flatMap((entry) => {
        const parts = kebab(entry.variable.name)
            .replace(/^(?:color|colour|clr)-/, "")
            .split("-");
        const at = parts.findIndex((part) => mode.test(part));
        const rest = parts.filter((_, index) => index !== at);
        const role =
            entry.category === "color" && at !== -1 && rest.length > 0
                ? (["background", "surface", "text", "muted", "border"] as const).find(
                      (each) => nameScore(each, words(rest.join("-"))) >= 60,
                  )
                : undefined;

        return role === undefined ? [] : [{ role, entry, rest: rest.join("-") }];
    });
    const others: Prepared["others"] = [];

    // A project that sets the other mode's values on its variables already has that mode (`--color-text` in the dark scope).
    const sets = facts.vars.some((fact) => fact.scope === alt);

    if (!sets && loose.length >= 2 && new Set(loose.map((item) => item.role)).size >= 2) {
        for (const item of loose) {
            others.push({ role: item.rest, entry: item.entry });
            item.entry.variable.twin = true;
        }
    }

    return {
        index,
        classified: classified.filter((entry) => entry.variable.twin !== true),
        alt,
        others,
    };
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

/**
 * The colors that Tailwind's utility classes name without the project defining them (`bg-slate-200`, `text-white`) are
 * uses of those colors. A name the project defines itself (its own `blue-500`) is its own, not the default.
 */
function useDefaultColors(facts: Facts): void {
    if (!facts.tailwind || facts.classColors.size === 0) {
        return;
    }

    const table = facts.tailwindVersion === 4 ? TAILWIND_4_COLORS : TAILWIND_3_COLORS;
    const own = new Set(facts.vars.map((variable) => variable.name.replace(/^color-/, "")));

    for (const [name, kinds] of facts.classColors) {
        const color = own.has(name) ? undefined : parseColor(table.get(name) ?? "");

        if (color === undefined) {
            continue;
        }

        const fact = colorFact(facts.colors, toHex(color), table.get(name)!);

        for (const kind of Object.keys(kinds) as (keyof Kinds)[]) {
            fact[kind] += kinds[kind];
        }
    }
}

/** Sizes computed from custom properties (`padding: calc(var(--gap) * 2)`) are uses of the sizes they come to. */
function resolveDeferred(facts: Facts, prep: Prepared): void {
    const lookup = (name: string, kind: "scss" | "less" | "css") => {
        const target = prep.index.get(`${kind}:${name}`);

        return target === undefined ? undefined : follow(prep.index, target, "light")?.text;
    };

    for (const { prop, value, selector } of facts.deferred.splice(0)) {
        let resolved = value.replace(/calc\(((?:[^()]|\([^()]*\))*)\)/g, (all, inner: string) => {
            return evalMath(inner, lookup) ?? all;
        });

        // Sass color functions over variables: `rgba($black, .2)`, `darken($brand, 10%)`.
        resolved = resolved.replace(
            /(?<![\w-])([a-z][a-z-]*)\(((?:[^()]|\([^()]*\))*)\)/gi,
            (all, fn: string) => {
                if (!SASS_COLOR.has(fn.toLowerCase()) || !/[$@]/.test(all)) {
                    return all;
                }

                const color = evalColor(all, "", "light", prep.index);

                return color === undefined
                    ? all
                    : `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.round(color.a * 100) / 100})`;
            },
        );

        // Arithmetic on lengths: `$unit * 2`, `$unit / 2`, `($a + 4px)`.
        resolved = resolved.replace(
            /(?:[$@][\w-]+|\d*\.?\d+[a-z%]*)(?:\s*[*/]\s*(?:[$@][\w-]+|\d*\.?\d+[a-z%]*)|\s+[+-]\s+(?:[$@][\w-]+|\d*\.?\d+[a-z%]*))+/g,
            (run) => evalMath(run, lookup) ?? run,
        );

        // A variable left on its own is its value.
        resolved = resolved.replace(/(?:[\w-]+\.)?[$@]([A-Za-z_][\w-]*)/g, (all, name: string) => {
            return lookup(name, "scss") ?? lookup(name, "less") ?? all;
        });

        if (!/calc\(|var\(|(?<![\w-])[$@][A-Za-z_]/.test(resolved)) {
            ingest(facts, {
                prop,
                value: resolved,
                selector,
                at: [],
                scope: "default",
                theme: false,
                inline: false,
            });
        }
    }
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

    resolveDeferred(facts, prep);

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
    const darkDefined = [
        ...colorVars.flatMap((entry) => {
            const hex = hexOf(entry.darkColor);

            return hex === undefined ? [] : [{ hex, text: entry.darkColor! }];
        }),
        ...prep.others.flatMap(({ entry }) => {
            const hex = hexOf(entry.lightColor);

            return hex === undefined ? [] : [{ hex, text: entry.lightColor! }];
        }),
    ];

    useDefaultColors(facts);

    const lightColors = mergeColors(lightDefined, facts.colors);
    const darkColors = mergeColors(darkDefined, alt === "dark" ? facts.darkColors : new Map());
    const namedLight = colorVars.flatMap((entry) => {
        const hex = hexOf(entry.lightColor);
        const kinds = facts.varKinds.get(entry.variable.name);

        return hex === undefined
            ? []
            : [
                  {
                      name: entry.variable.name,
                      hex,
                      uses: uses(entry.variable),
                      ...(kinds === undefined ? {} : { kinds }),
                  },
              ];
    });
    const namedDark = [
        ...colorVars.flatMap((entry) => {
            const hex = hexOf(entry.darkColor);

            return hex === undefined
                ? []
                : [{ name: entry.variable.name, hex, uses: uses(entry.variable) }];
        }),
        ...prep.others.flatMap(({ role, entry }) => {
            const hex = hexOf(entry.lightColor);

            return hex === undefined ? [] : [{ name: role, hex, uses: uses(entry.variable) }];
        }),
    ];

    for (const each of namedLight) {
        const entry = lightColors.get(each.hex);

        entry?.names.push({ name: each.name, uses: each.uses });

        // What the variables that hold a color are used for is a use of the color.
        if (entry !== undefined && each.kinds !== undefined) {
            entry.fact = mergeFact(
                entry.fact,
                { ...each.kinds, hex: each.hex, forms: new Map(), order: 0 },
                each.hex,
            );
            entry.uses +=
                each.kinds.bg +
                each.kinds.text +
                each.kinds.border +
                each.kinds.fill +
                each.kinds.other;
        }
    }

    const lightRoles = chooseRoles(lightColors, namedLight);

    // A project with one background color, called a surface, has no other page color: the surface is the page too.
    if (lightRoles.background === undefined && lightRoles.surface?.basis === "name") {
        lightRoles.background = { ...lightRoles.surface, role: "background" };
        delete lightRoles.surface;
    }

    const hasDarkVars = classified.some((entry) => entry.variable.dark !== undefined);

    result.hasDark =
        hasDarkVars || prep.others.length > 0 || (alt === "dark" && facts.darkColors.size > 0);

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

    // A role that the way its color is used decided may be held by a variable that has a dark value: that is its dark.
    for (const [role, choice] of Object.entries(lightRoles) as [RoleName, RoleChoice][]) {
        if (choice.basis !== "use") {
            continue;
        }

        const holder = colorVars
            .filter((entry) => hexOf(entry.lightColor) === choice.hex)
            .sort((a, b) => uses(b.variable) - uses(a.variable))[0];
        const dark = hexOf(holder?.darkColor);

        if (holder !== undefined && dark !== undefined && dark !== choice.hex) {
            darkRoles[role] = {
                role,
                hex: dark,
                basis: "name",
                source: holder.variable.name,
                score: choice.score,
            };
        }
    }

    // A brand or status color that a dark mode merely uses in another hue (links turn light blue, buttons stay brown) is
    // not that role's dark value: a role keeps its hue across modes.
    for (const role of ["accent", "danger", "warning", "success"] as const) {
        const lightHex = lightRoles[role]?.hex;
        const light = lightHex === undefined ? undefined : entryOf(lightHex);
        const dark = darkRoles[role];
        const other = dark?.basis === "use" ? entryOf(dark.hex) : undefined;

        if (light !== undefined && other !== undefined && light.c >= 0.05 && other.c >= 0.05) {
            const gap = Math.abs(((light.h - other.h + 540) % 360) - 180);

            if (gap > 40) {
                delete darkRoles[role];
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
    const pendingDark: { path: string[]; hex: string }[] = [];
    // The light color each color token holds, so that two files that name one token agree on which color it is.
    const lightHexOf = new Map<string, string>();
    // The default-mode colors that a dark-first project keeps on its roles as they are, so the palette skips them.
    const changing = new Set<string>();
    const lightAlias = (hex: string) =>
        changing.has(hex)
            ? asValue(hex, lightColors)
            : `{${palette(hex, asValue(hex, lightColors)).join(".")}}`;

    for (const role of Object.keys(ROLE_PATHS) as RoleName[]) {
        const light = lightRoles[role];

        if (light === undefined) {
            continue;
        }

        const path = ROLE_PATHS[role];
        const dark = darkRoles[role];
        // A dark-first project keeps the colors that change as they are in the default mode: its light mode is the file
        // that changes them, and a palette of dark-only grays would show up in the light mode.
        const changes = dark !== undefined && dark.hex !== light.hex;

        if (alt === "light" && changes) {
            changing.add(light.hex);
        }

        const node: Obj = { $value: lightAlias(light.hex), $type: "color" };

        const source = colorVars.find((entry) => entry.variable.name === light.source);

        if (light.basis === "name") {
            roleVars.add(light.source);
        }

        book.add(path, node);
        lightHexOf.set(path.join("."), light.hex);

        if (source !== undefined) {
            aliasOf.set(vkey(source.variable), path);
        }

        if (dark !== undefined && dark.hex !== light.hex) {
            pendingDark.push({ path, hex: dark.hex });
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
        // Text on the accent is a color the project already has: its page, its text, white, or black.
        const poolOf = (
            roles: Partial<Record<RoleName, RoleChoice>>,
            entries: Map<string, ColorEntry>,
        ) => {
            const given = new Set(
                Object.values(roles)
                    .map((role) => role?.hex)
                    .filter((hex): hex is string => hex !== undefined),
            );
            // A gray that the mode uses only as text (a dark label on a light button) is a color the project has too.
            const labels = [...entries.values()]
                .filter(
                    (each) =>
                        !given.has(each.hex) &&
                        each.c < 0.06 &&
                        each.rgba.a > 0.9 &&
                        (each.fact?.text ?? 0) > 0 &&
                        (each.fact?.bg ?? 0) === 0 &&
                        (each.fact?.border ?? 0) === 0,
                )
                .map((each) => each.hex);

            return [
                ...[roles.background?.hex, roles.text?.hex, "#ffffff", "#000000"].filter(
                    (hex): hex is string => hex !== undefined && entries.has(hex),
                ),
                ...labels,
            ];
        };

        // White is what a project already puts on its accent when it uses white as a text color and it reads well enough.
        const whiteText =
            (facts.colors.get("#ffffff")?.text ?? 0) > 0 && lightColors.has("#ffffff");

        const pick = (
            accentColor: ColorEntry,
            entries: Map<string, ColorEntry>,
            roles: Partial<Record<RoleName, RoleChoice>>,
            preferWhite: boolean,
        ) => {
            const pool = poolOf(roles, entries);
            const best = topBy(
                pool,
                (hex) => {
                    const color = entries.get(hex)?.rgba;

                    return color === undefined ? 0 : contrastRatio(color, accentColor.rgba);
                },
                1,
            )[0];

            return preferWhite && contrastRatio(parseColor("#ffffff")!, accentColor.rgba) >= 3
                ? "#ffffff"
                : best;
        };

        const onLight = pick(accent, lightColors, lightRoles, whiteText);
        const path = ["color", "text", "on-accent"];

        if (onLight !== undefined) {
            book.add(path, {
                $value: lightAlias(onLight),
                $type: "color",
            });
        }

        const darkAccent =
            darkRoles.accent === undefined ? undefined : darkColors.get(darkRoles.accent.hex);

        if (darkAccent !== undefined) {
            const onDark = pick(darkAccent, darkColors, darkRoles, false);

            if (onLight !== undefined && onDark !== undefined && onDark !== onLight) {
                pendingDark.push({ path, hex: onDark });
            }
        }
    }

    // The colors the project uses most that no variable or role holds yet.
    const known = [...hexPath.keys()].map((hex) => lightColors.get(hex) ?? entryOf(hex)!);
    const extra = topBy(
        [...lightColors.values()].filter(
            (entry) =>
                !hexPath.has(entry.hex) &&
                !changing.has(entry.hex) &&
                entry.rgba.a > 0.05 &&
                entry.uses >= 1 &&
                known.every((other) => !nearColors(other, entry)),
        ),
        (entry) => entry.uses,
        16,
    );

    for (const entry of extra) {
        palette(entry.hex, asValue(entry.hex, lightColors));
    }

    // The rest of the project's own color variables, under their own names, as aliases of the palette.
    const roleNames = new Set([...roleVars].map(kebab));
    const rest = classified.filter(
        (entry) =>
            entry.category === "color" &&
            !scaleVars.has(entry) &&
            !roleVars.has(entry.variable.name) &&
            // The same variable from another file (`inkSubtle` in a theme, `--ink-subtle` in a stylesheet).
            !roleNames.has(kebab(entry.variable.name)),
    );

    for (const entry of topBy(rest, (each) => uses(each.variable) + 0.01, 40)) {
        const hex = hexOf(entry.lightColor);
        const path = pathOf(entry.variable, "color");

        if (hex === undefined) {
            continue;
        }

        if (book.has(path)) {
            // The same name from another file (a stylesheet variable and a theme object): it may know the dark value.
            const darkHex = hexOf(entry.darkColor);

            if (
                darkHex !== undefined &&
                darkHex !== hex &&
                lightHexOf.get(path.join(".")) === hex &&
                !book.dark.has(path.join("."))
            ) {
                pendingDark.push({ path, hex: darkHex });
            }

            continue;
        }

        const target = entry.via === undefined ? undefined : aliasOf.get(vkey(entry.via));
        const primitive = target ?? palette(hex, asValue(hex, lightColors));

        book.add(path, { $value: `{${primitive.join(".")}}`, $type: "color" });
        lightHexOf.set(path.join("."), hex);
        aliasOf.set(vkey(entry.variable), path);

        const darkHex = hexOf(entry.darkColor);

        if (darkHex !== undefined && darkHex !== hex) {
            pendingDark.push({ path, hex: darkHex });
        }
    }

    // A chromatic color that only the dark mode uses (links turn light blue) is the dark value of the light color of its
    // hue that has none yet.
    if (result.hasDark) {
        const taken = new Set(pendingDark.map((each) => each.hex));
        const changed = () =>
            new Set([...book.dark.keys(), ...pendingDark.map((each) => each.path.join("."))]);

        for (const dark of [...darkColors.values()].sort((a, b) => b.uses - a.uses).slice(0, 12)) {
            if (dark.c < 0.05 || taken.has(dark.hex) || hexPath.has(dark.hex)) {
                continue;
            }

            const moved = changed();
            const twin = [...hexPath]
                .map(([hex, path]) => ({ entry: lightColors.get(hex), path }))
                .filter(
                    (each): each is { entry: ColorEntry; path: string[] } =>
                        each.entry !== undefined &&
                        each.entry.c >= 0.05 &&
                        !moved.has(each.path.join(".")) &&
                        Math.abs(((each.entry.h - dark.h + 540) % 360) - 180) <= 25,
                )
                .sort((a, b) => b.entry.uses - a.entry.uses)[0];

            if (twin !== undefined) {
                pendingDark.push({ path: twin.path, hex: dark.hex });
                taken.add(dark.hex);
            }
        }
    }

    // The other mode's colors: a palette color the light mode already has is referenced; any other is written as it is,
    // in the mode's file, so the default mode holds only the colors it uses.
    const changes = new Set([
        ...book.dark.keys(),
        ...pendingDark.map((each) => each.path.join(".")),
    ]);

    for (const { path, hex } of pendingDark) {
        // A color of the light palette that is itself different in the dark is no stand-in for this one.
        const found = hexPath.get(hex);
        const known = found !== undefined && !changes.has(found.join(".")) ? found : undefined;

        book.addDark(path, {
            $value: known === undefined ? asValue(hex, darkColors) : `{${known.join(".")}}`,
            $type: "color",
        });
    }

    // 4. The other categories: the project's own variables first.
    const explicit = new Set<Category>();

    // A bare `--radius` has no name of its own: it takes the fallback after the variables that are named (`--radius-md`).
    const named = [
        ...classified.filter((entry) => nameOf(entry.variable, entry.category) !== ""),
        ...classified.filter((entry) => nameOf(entry.variable, entry.category) === ""),
    ];

    for (const entry of named) {
        if (entry.category === "color" || entry.light === undefined) {
            continue;
        }

        const node = nodeFor(entry.category, entry.light);
        let path = pathOf(entry.variable, entry.category);

        if (nameOf(entry.variable, entry.category) === "" && book.has(path)) {
            path = [path[0]!, "base"];
        }

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
    dedupeScales(book);

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

/**
 * Two names for one size (`radius.lg` and `radius.base`, both 8px) are one step of the scale: the plainer name stays, and
 * the `base` that only names where a scale starts goes.
 */
function dedupeScales(book: Book): void {
    for (const group of ["text", "space", "radius", "breakpoint"]) {
        const seen = new Map<number, string>();

        for (const [key, entry] of [...book.tokens]) {
            const size = entry.path[0] === group ? px(String(entry.node.$value)) : undefined;

            if (size === undefined || size === 0) {
                continue;
            }

            const known = seen.get(size);

            if (known === undefined) {
                seen.set(size, key);

                continue;
            }

            const drop = book.tokens.get(known)!.path.at(-1) === "base" ? known : key;

            book.tokens.delete(drop);
            book.dark.delete(drop);
            seen.set(size, drop === known ? key : known);
        }
    }
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
