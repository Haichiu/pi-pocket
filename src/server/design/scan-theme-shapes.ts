import { parseColor } from "./color.ts";
import { addVar, type Category, type Facts } from "./scan-facts.ts";
import { hasAntdTheme } from "./scan-facts-antd.ts";
import { leaves, modeOf, THEME_KEYS } from "./scan-facts-lists.ts";
import { JsProject } from "./scan-js-eval.ts";
import { isDarkSelector, type Literal, type Scope, UNKNOWN } from "./scan-parse.ts";

const CANDIDATES = 160;

const ROLE_WORDS = new Set(
    "bg background surface card panel paper canvas layer elevated text foreground fg ink content muted subtle secondary tertiary border divider outline stroke line primary accent brand danger error warning success info link positive negative destructive caution neutral base main inverse hover active focus disabled placeholder overlay field input page".split(
        " ",
    ),
);

const wordsOf = (key: string) =>
    key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([a-z])(\d)/gi, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== "");

const isObject = (value: Literal | undefined): value is { [key: string]: Literal } =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isColor = (value: Literal | undefined): value is string =>
    typeof value === "string" &&
    /^\s*(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(.*\))\s*$/i.test(value) &&
    parseColor(value) !== undefined;

/** A color word that a role may be (`white`, `black`, `transparent` are not looked for in a ramp). */
const isNamedColor = (value: Literal | undefined): value is string =>
    typeof value === "string" && /^(?:white|black)$/i.test(value);

const isShade = (value: Literal | undefined) => isColor(value) || isNamedColor(value);

function isColorGroup(value: Literal | undefined): boolean {
    if (!isObject(value)) {
        return false;
    }

    const colors = Object.values(value).filter((each) => isColor(each) || isNamedColor(each));

    return colors.length >= 1 && colors.length >= Object.keys(value).length / 2;
}

function isRoleObject(value: { [key: string]: Literal }): boolean {
    let roles = 0;

    for (const [key, child] of Object.entries(value)) {
        if (
            wordsOf(key).some((word) => ROLE_WORDS.has(word)) &&
            (isShade(child) || isColorGroup(child))
        ) {
            roles += 1;
        }
    }

    return roles >= 3;
}

const stepKey = (key: string) => /^\d{1,4}$/.test(key);

function isRampArray(value: Literal[]): boolean {
    return value.length >= 5 && value.length <= 13 && value.every((each) => isColor(each));
}

function isRampObject(value: { [key: string]: Literal }): boolean {
    const entries = Object.entries(value);
    const steps = entries.filter(([key, child]) => stepKey(key) && isColor(child));

    return steps.length >= 5 && steps.length >= entries.length * 0.7;
}

function modeOfKey(key: string): Scope | undefined {
    if (/^(?::root|html|body|\.|\[|@media|&)/.test(key) || /[.[#:]/.test(key)) {
        return isDarkSelector(key)
            ? "dark"
            : /^(?::root|html|body)$/i.test(key.trim())
              ? "default"
              : undefined;
    }

    return modeOf(key);
}

const GENERIC = new Set([
    "colors",
    "colours",
    "color",
    "palette",
    "palettes",
    "ramps",
    "shades",
    "scale",
    "scales",
    "theme",
    "themes",
    "tokens",
    "default",
    "base",
    "export",
]);

export function shapeThemes(facts: Facts, root: string, files: string[]): void {
    const scripts = files.filter(
        (rel) => /\.(?:[cm]?[jt]sx?|json)$/i.test(rel) && !/\.d\.[cm]?ts$/.test(rel),
    );

    if (scripts.length === 0) {
        return;
    }

    const project = new JsProject(root, scripts);
    const seen = new Set<string>();
    let candidates = 0;

    for (const rel of scripts
        .filter((each) =>
            /typograph|(?:^|\/)(?:fonts?|type|text)[\w.-]*\.[cm]?[jt]sx?$/i.test(each),
        )
        .slice(0, 12)) {
        for (const [name, binding] of project.exportsOf(rel)) {
            const value = binding.value();
            const family = /^(?:families|fontFamil(?:y|ies)|fontStacks?|typefaces?|fonts?)$/i.test(
                name,
            );
            const size = /^(?:sizes?|fontSizes?|typeScale|textSizes?|fontScale)$/i.test(name);

            if (
                (family || size) &&
                value !== UNKNOWN &&
                typeof value === "object" &&
                value !== null
            ) {
                const entries: [string, Literal][] = Array.isArray(value)
                    ? value.map((each, at) => [String(at), each])
                    : Object.entries(value);

                for (const [key, child] of entries.slice(0, 40)) {
                    const text =
                        typeof child === "number"
                            ? `${child}px`
                            : typeof child === "string"
                              ? child
                              : undefined;

                    if (text !== undefined && (family ? !/^\d/.test(text) : /^\d/.test(text))) {
                        addVar(facts, {
                            name: family ? key : `text-${key}`,
                            value: text,
                            scope: "default",
                            kind: "js",
                            file: rel,
                            hint: family ? "font" : "text",
                        });
                    }
                }
            }
        }
    }

    for (const rel of scripts) {
        if (candidates >= CANDIDATES) {
            break;
        }

        const text = project.textOf(rel);

        if (text === undefined || !looksLikeTheme(rel, text)) {
            continue;
        }

        candidates += 1;

        const emit: Emit = (name, value, scope, hint = "color") => {
            const key = `${rel}|${scope}|${name}|${value}`;

            // A scale the theme reader of the file already took (the same value in the same file) is not taken twice.
            const twice =
                hint !== "color" &&
                facts.vars.some(
                    (each) =>
                        each.file === rel &&
                        each.hint === hint &&
                        each.value === value &&
                        each.name !== name,
                );

            if (!seen.has(key) && !twice && seen.size < 6000) {
                seen.add(key);
                addVar(facts, { name, value, scope, kind: "js", file: rel, hint });
            }
        };

        const antd = hasAntdTheme(text);
        const fileMode: Scope | undefined = rel
            .replace(/\.[^./]+$/, "")
            .split("/")
            .some((part) => modeOf(part) === "dark")
            ? "dark"
            : undefined;

        let exported = 0;

        flatOff = antd;
        walkBudget = 5000;
        walkVisits = new Map();

        for (const [name, binding] of project.exportsOf(rel)) {
            if (++exported > 80) {
                break;
            }

            let value: Literal;

            try {
                value = binding.value();
            } catch {
                continue;
            }

            if (value === UNKNOWN || typeof value !== "object" || value === null) {
                continue;
            }

            walk(
                value,
                name === "default" ? [] : [name],
                modeOf(name) ?? fileMode ?? "default",
                0,
                emit,
            );
        }
    }
}

function looksLikeTheme(rel: string, text: string): boolean {
    if (
        /(?:^|\/)(?:package|package-lock|tsconfig[\w.-]*|jsconfig|composer|manifest|\.eslintrc|babel\.config|vercel|netlify)\.json$/.test(
            rel,
        )
    ) {
        return false;
    }

    // A token file in a format the scan reads on its own: its leaves have `$value` or `value` with a `type`; a WordPress
    // `theme.json`; a Figma export.
    if (
        rel.endsWith(".json") &&
        /"\$value"|"value"\s*:|schemas\.wp\.org|"variableCollections"|"settings"\s*:\s*\{[\s\S]{0,400}"color"/.test(
            text,
        )
    ) {
        return false;
    }

    const colors =
        text.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(\s*[\d.]/g)?.length ?? 0;
    const roles =
        text.match(
            /\b(?:background|surface|primary|secondary|danger|error|warning|success|border|textMuted|accent|brand|foreground|muted)\b["']?\s*:/g,
        )?.length ?? 0;

    return colors >= 3 || roles >= 4;
}

let flatOff = false;

type Emit = (name: string, value: string, scope: Scope, hint?: Category) => void;

// A shared constant makes a tree of millions of objects to walk: one file takes an object at most 16 times, and at most 5,000 objects in all.
let walkBudget = 0;
let walkVisits = new Map<object, number>();

function walk(node: Literal, path: string[], mode: Scope, depth: number, emit: Emit): void {
    const visits = typeof node === "object" && node !== null ? (walkVisits.get(node) ?? 0) : 0;

    if (depth > 7 || visits >= 16 || --walkBudget < 0) {
        return;
    }

    if (typeof node === "object" && node !== null) {
        walkVisits.set(node, visits + 1);
    }

    if (Array.isArray(node)) {
        if (isRampArray(node)) {
            ramp(
                path,
                node.map((each, at) => [String(at), each as string]),
                mode,
                emit,
            );
        } else if (depth < 3) {
            node.slice(0, 12).forEach((child, at) => {
                if (isObject(child)) {
                    walk(child, [...path, String(at)], mode, depth + 1, emit);
                }
            });
        }

        return;
    }

    if (!isObject(node)) {
        return;
    }

    const entries = Object.entries(node);

    if (typeof node.primaryColor === "string" && isObject(node.colors)) {
        const chosen = node.colors[node.primaryColor];
        const shade = node.primaryShade;

        const pick = (list: Literal | undefined, step: number): string | undefined => {
            const value = Array.isArray(list)
                ? list[step]
                : isObject(list)
                  ? list[String(step)]
                  : undefined;

            return isColor(value) ? value : undefined;
        };

        const light = pick(
            chosen,
            typeof shade === "number"
                ? shade
                : isObject(shade) && typeof shade.light === "number"
                  ? shade.light
                  : 6,
        );
        const dark = pick(
            chosen,
            typeof shade === "number"
                ? shade
                : isObject(shade) && typeof shade.dark === "number"
                  ? shade.dark
                  : 8,
        );

        if (light !== undefined) {
            emit("primary", light, "default");
        }

        if (dark !== undefined && dark !== light) {
            emit("primary", dark, "dark");
        }
    }

    const properties = entries.filter(
        ([key, child]) =>
            key.startsWith("--") && (typeof child === "string" || typeof child === "number"),
    );

    if (properties.length >= 2) {
        for (const [key, child] of properties) {
            emit(key.slice(2), String(child), mode);
        }

        return;
    }

    const containers = entries.filter(
        ([key, child]) => modeOfKey(key) !== undefined && isObject(child),
    );

    if (containers.length >= 1 && (containers.length >= 2 || entries.length <= 3)) {
        for (const [key, child] of entries) {
            const inner = modeOfKey(key);

            if (inner !== undefined && isObject(child)) {
                walk(child, path, inner === "default" ? mode : inner, depth + 1, emit);
            } else if (isObject(child) || Array.isArray(child)) {
                walk(child, [...path, key], mode, depth + 1, emit);
            }
        }

        return;
    }

    const declared =
        typeof node.mode === "string"
            ? modeOf(node.mode)
            : typeof node.colorScheme === "string"
              ? modeOf(node.colorScheme)
              : undefined;
    const here: Scope = declared ?? mode;

    if (isRoleObject(node)) {
        roles(node, here, emit);
        flat(node, path, here, emit);

        for (const [key, child] of entries) {
            if ((isObject(child) && !isColorGroup(child)) || Array.isArray(child)) {
                walk(child, [...path, key], here, depth + 1, emit);
            } else if (isObject(child) && isRampObject(child)) {
                ramp(
                    [...path, key],
                    Object.entries(child).filter(([step]) => stepKey(step)) as [string, string][],
                    here,
                    emit,
                );
            }
        }

        return;
    }

    if (isRampObject(node)) {
        ramp(
            path,
            Object.entries(node).filter(([key]) => stepKey(key)) as [string, string][],
            here,
            emit,
        );

        return;
    }

    flat(node, path, here, emit);

    for (const key of ["headings", "typography"]) {
        const block = node[key];
        const sizes = isObject(block) && isObject(block.sizes) ? block.sizes : block;

        if (isObject(sizes)) {
            for (const [variant, child] of Object.entries(sizes)) {
                if (
                    isObject(child) &&
                    (typeof child.fontSize === "string" || typeof child.fontSize === "number")
                ) {
                    emit(
                        variant,
                        typeof child.fontSize === "number" ? `${child.fontSize}px` : child.fontSize,
                        here,
                        "text",
                    );
                }
            }
        }
    }

    for (const [key, child] of entries) {
        const category = THEME_KEYS[key];

        if (
            category !== undefined &&
            SCALES.has(category) &&
            !/^(?:typography|headings|other)$/.test(key) &&
            (isObject(child) || Array.isArray(child))
        ) {
            scale(child, [...path, key], category, here, emit);
        } else if (isObject(child) || Array.isArray(child)) {
            walk(child, [...path, key], modeOf(key) ?? here, depth + 1, emit);
        }
    }
}

const SCALES = new Set<Category>(["font", "text", "space", "radius", "shadow", "duration", "ease"]);

function scale(node: Literal, path: string[], category: Category, mode: Scope, emit: Emit): void {
    const found: { path: string[]; value: string }[] = [];

    leaves(node, [], found, category);

    for (const leaf of found.slice(0, 60)) {
        const unitless = category === "text" || category === "space" || category === "radius";
        const value =
            unitless && /^-?\d+(?:\.\d+)?$/.test(leaf.value) ? `${leaf.value}px` : leaf.value;

        emit([path.at(-1)!, ...leaf.path].join("-"), value, mode, category);
    }
}

function ramp(path: string[], steps: [string, string][], mode: Scope, emit: Emit): void {
    const family = [...path]
        .reverse()
        .find((part) => !GENERIC.has(part.toLowerCase()) && !/^\d+$/.test(part));

    if (family === undefined) {
        return;
    }

    for (const [step, value] of steps) {
        if (isColor(value)) {
            emit(`${family}-${step}`, value, mode);
        }
    }
}

function roles(node: { [key: string]: Literal }, mode: Scope, emit: Emit): void {
    const found: { path: string[]; value: string }[] = [];

    for (const [key, child] of Object.entries(node)) {
        if (!wordsOf(key).some((word) => ROLE_WORDS.has(word))) {
            continue;
        }

        if (isShade(child)) {
            found.push({ path: [key], value: child as string });
        } else if (isColorGroup(child)) {
            const inner: { path: string[]; value: string }[] = [];

            leaves(child, [key], inner, "color");
            found.push(...inner);
        }
    }

    for (const leaf of found) {
        if (isShade(leaf.value)) {
            emit(leaf.path.join("-"), leaf.value, mode);
        }
    }
}

function flat(node: { [key: string]: Literal }, path: string[], mode: Scope, emit: Emit): void {
    if (flatOff) {
        return;
    }

    const prefix = path.length > 1 ? `${path.at(-1)}-` : "";

    for (const [key, value] of Object.entries(node)) {
        if (typeof value !== "string" && typeof value !== "number") {
            continue;
        }

        const words = wordsOf(key);
        const text = typeof value === "number" ? `${value}px` : value;

        // A shadow's own parts (`shadowRadius: 8`, `shadowColor: '#000'`) are not a radius or a shadow.
        if (words.includes("shadow") && !/^(?:inset\s+)?-?[\d.]+(?:px|rem|em)?\s/.test(text)) {
            continue;
        }

        if (words.includes("font") && words.includes("size") && /^\d/.test(text)) {
            emit(`${prefix}${key}`, text, mode, "text");
        } else if ((words.includes("radius") || words.includes("radii")) && /^\d/.test(text)) {
            emit(`${prefix}${key}`, text, mode, "radius");
        } else if (
            (words.includes("shadow") || words.includes("elevation")) &&
            typeof value === "string" &&
            /\d/.test(value)
        ) {
            emit(`${prefix}${key}`, value, mode, "shadow");
        } else if (
            words.includes("font") &&
            words.includes("family") &&
            typeof value === "string"
        ) {
            emit(`${prefix}${key}`, value, mode, "font");
        } else if (/^(?:spacing|space)\w*/i.test(key) && /^\d/.test(text)) {
            emit(`${prefix}${key}`, text, mode, "space");
        }
    }
}
