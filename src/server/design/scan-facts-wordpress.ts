import { luminance, parseColor } from "./color.ts";
import { parseStyles, type Scope } from "./scan-parse.ts";
import { addVar, type Category, type Facts } from "./scan-facts.ts";
import { modeOf } from "./scan-facts-lists.ts";
import { ingestStyles } from "./scan-facts-use.ts";

export function wordpressNames(text: string): string {
    return text
        .replace(/--wp--preset--([\w-]+?)--([\w-]+)/g, "--$1-$2")
        .replace(
            /--wp--custom--([\w-]+)/g,
            (_, rest: string) => `--custom-${rest.replace(/--/g, "-")}`,
        )
        .replace(/var:preset\|([\w-]+)\|([\w-]+)/g, "var(--$1-$2)")
        .replace(
            /var:custom\|([\w|-]+)/g,
            (_, rest: string) => `var(--custom-${rest.replace(/\|/g, "-")})`,
        );
}

const WP_CSS: Record<string, string> = {
    background: "background-color",
    text: "color",
};

function wordpressCss(styles: unknown): string {
    const isObj = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
    const text = (value: unknown) =>
        typeof value === "string" || typeof value === "number"
            ? wordpressNames(String(value))
            : undefined;
    let rules = 0;

    const declarations = (node: Record<string, unknown>): string => {
        const out: string[] = [];

        const put = (property: string, value: unknown) => {
            const found = text(value);

            if (found !== undefined && found !== "") {
                out.push(`${property}: ${found};`);
            }
        };

        if (isObj(node.color)) {
            for (const [key, property] of Object.entries(WP_CSS)) {
                put(property, node.color[key]);
            }
        }

        if (isObj(node.typography)) {
            put("font-family", node.typography.fontFamily);
            put("font-size", node.typography.fontSize);
            put("line-height", node.typography.lineHeight);
            put("font-weight", node.typography.fontWeight);
        }

        if (isObj(node.border)) {
            put("border-color", node.border.color);
            put("border-radius", node.border.radius);
            put("border-width", node.border.width);
        }

        if (isObj(node.spacing)) {
            for (const key of ["padding", "margin"]) {
                const value = node.spacing[key];

                if (isObj(value)) {
                    for (const side of ["top", "right", "bottom", "left"]) {
                        put(`${key}-${side}`, value[side]);
                    }
                } else {
                    put(key, value);
                }
            }

            put("gap", node.spacing.blockGap);
        }

        put("box-shadow", node.shadow);

        return out.join(" ");
    };

    const rule = (selector: string, node: unknown): string => {
        if (!isObj(node) || ++rules > 120) {
            return "";
        }

        const own = declarations(node);
        const nested: string[] = [];

        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith(":")) {
                nested.push(rule(`${selector}${key}`, child));
            }
        }

        return `${own === "" ? "" : `${selector} { ${own} }`} ${nested.join(" ")}`;
    };

    if (!isObj(styles)) {
        return "";
    }

    const out = [rule("body", styles)];
    const elements: Record<string, string> = {
        link: "a",
        button: ".wp-element-button, .wp-block-button__link",
        heading: "h1, h2, h3, h4, h5, h6",
        caption: "figcaption",
        cite: "cite",
    };

    if (isObj(styles.elements)) {
        for (const [key, node] of Object.entries(styles.elements)) {
            out.push(
                rule(
                    elements[key] ??
                        (/^h[1-6]$/.test(key) ? key : `.wp-element-${key.replace(/[^\w-]/g, "")}`),
                    node,
                ),
            );
        }
    }

    if (isObj(styles.blocks)) {
        for (const [key, node] of Object.entries(styles.blocks)) {
            out.push(rule(`.wp-block-${key.replace(/^core\//, "").replace(/[^\w-]/g, "-")}`, node));
        }
    }

    return out.join("\n");
}

const CUSTOM_HINTS: Record<string, Category> = {
    color: "color",
    colors: "color",
    radius: "radius",
    radii: "radius",
    "border-radius": "radius",
    spacing: "space",
    space: "space",
    shadow: "shadow",
    shadows: "shadow",
    elevation: "shadow",
    gradient: "gradient",
    gradients: "gradient",
    "font-size": "text",
    "font-sizes": "text",
    "font-family": "font",
    "font-families": "font",
    "font-weight": "weight",
    "line-height": "leading",
    "letter-spacing": "tracking",
    duration: "duration",
    easing: "ease",
};

// The middle step is slug 50 and the others are 10 apart: seven steps have the slugs 20 to 80.
function spacingScale(scale: unknown): { slug: string; size: string }[] {
    if (typeof scale !== "object" || scale === null) {
        return [];
    }

    const { operator, increment, steps, mediumStep, unit } = scale as Record<string, unknown>;
    const step = Number(steps);
    const medium = Number(mediumStep);
    const by = Number(increment);

    if (
        !(step >= 1 && step <= 20) ||
        !(medium > 0) ||
        !(by > 0) ||
        !["rem", "em", "px", "%", "vw"].includes(String(unit ?? "rem"))
    ) {
        return [];
    }

    const times = operator !== "+";
    const middle = Math.round(step / 2 + 1e-9);
    const sizes: { slug: string; size: string }[] = [];
    const size = (value: number) => `${Number(value.toFixed(2))}${String(unit ?? "rem")}`;
    let current = medium;

    for (let below = 1; below < middle; below++) {
        current = times ? (by > 1 ? current / by : current * by) : current - by;

        if (current <= 0) {
            break;
        }

        sizes.unshift({ slug: String(50 - 10 * below), size: size(current) });
    }

    sizes.push({ slug: "50", size: size(medium) });
    current = medium;

    for (let above = 1; above <= step - middle; above++) {
        current = times ? current * by : current + by;
        sizes.push({ slug: String(50 + 10 * above), size: size(current) });
    }

    return sizes.filter((each) => /^\d+$/.test(each.slug) && Number(each.slug) > 0);
}

function paletteIsDark(palette: Record<string, unknown>[]): boolean {
    const base = palette.find((item) =>
        /^(?:base|background|bg|canvas|page|body|white|surface)$/i.test(String(item.slug ?? "")),
    );
    const color = typeof base?.color === "string" ? parseColor(base.color) : undefined;

    return color !== undefined && luminance(color) < 0.18;
}

export function wordpressTheme(facts: Facts, file: string, source: string): boolean {
    if (
        !/\bsettings\b/.test(source) ||
        !/\b(?:palette|fontSizes|spacingSizes|spacingScale|presets|fontFamilies|gradients|radiusSizes|custom)\b/.test(
            source,
        )
    ) {
        return false;
    }

    let root: unknown;

    try {
        root = JSON.parse(source);
    } catch {
        return false;
    }

    const isObj = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value);
    const settings = isObj(root) ? root.settings : undefined;

    if (
        !isObj(root) ||
        !isObj(settings) ||
        (!/wp\.org|theme\.json/i.test(`${root.$schema ?? ""} ${file}`) && !isObj(settings.color))
    ) {
        return false;
    }

    facts.wordpress = true;

    const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? value.filter(isObj).slice(0, 80) : [];
    const key = (value: unknown) => String(value ?? "").replace(/[^\w-]/g, "-");
    const palette = isObj(settings.color) ? list(settings.color.palette) : [];

    // A theme's own `theme.json` is the default. A style variation (`styles/*.json`, a file with a `title`) is another
    // look of it: a dark one is the dark mode, and any other is not this theme's default, so it is left out.
    const variation =
        /(?:^|\/)styles\//.test(file) ||
        (typeof root.title === "string" && !/(?:^|\/)theme\.json$/.test(file));
    const title = typeof root.title === "string" ? modeOf(root.title) : undefined;
    let scope: Scope =
        facts.fileMode ?? (title === "dark" || title === "light" ? title : "default");

    if (variation && scope === "default") {
        if (!paletteIsDark(palette)) {
            return true;
        }

        scope = "dark";
    }

    const add = (name: string, value: unknown, hint?: Category) => {
        if (typeof value === "string" || typeof value === "number") {
            addVar(facts, {
                name,
                value: wordpressNames(String(value)).slice(0, 400),
                scope,
                kind: "css",
                file,
                ...(hint === undefined ? {} : { hint }),
            });
        }
    };

    for (const item of palette) {
        add(`color-${key(item.slug)}`, item.color, "color");
    }

    if (isObj(settings.color)) {
        for (const item of list(settings.color.gradients)) {
            add(`gradient-${key(item.slug)}`, item.gradient, "gradient");
        }
    }

    if (isObj(settings.typography)) {
        for (const item of list(settings.typography.fontSizes)) {
            // `size` is the size at the widest screen; a fluid size that has only `fluid.max` says it there.
            const fluid = isObj(item.fluid) ? item.fluid : undefined;

            add(`font-size-${key(item.slug)}`, item.size ?? fluid?.max, "text");
        }

        for (const item of list(settings.typography.fontFamilies)) {
            // A family with only `fontFace` has its name there.
            const face = list(item.fontFace)[0];

            add(
                `font-family-${key(item.slug ?? item.name)}`,
                item.fontFamily ?? face?.fontFamily,
                "font",
            );
        }
    }

    if (isObj(settings.spacing)) {
        for (const item of list(settings.spacing.spacingSizes)) {
            add(`spacing-${key(item.slug)}`, item.size, "space");
        }

        for (const item of spacingScale(settings.spacing.spacingScale)) {
            add(`spacing-${item.slug}`, item.size, "space");
        }
    }

    if (isObj(settings.border)) {
        for (const item of list(settings.border.radiusSizes)) {
            add(`radius-${key(item.slug)}`, item.size, "radius");
        }
    }

    if (isObj(settings.shadow)) {
        for (const item of list(settings.shadow.presets)) {
            add(`shadow-${key(item.slug)}`, item.shadow, "shadow");
        }
    }

    const custom = (node: unknown, path: string[]) => {
        if (path.length > 4) {
            return;
        }

        if (isObj(node)) {
            for (const [name, child] of Object.entries(node).slice(0, 60)) {
                custom(child, [...path, name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()]);
            }
        } else if (typeof node === "string" || typeof node === "number") {
            add(`custom-${path.join("-")}`, node, CUSTOM_HINTS[path[0] ?? ""]);
        }
    };

    custom(settings.custom, []);

    const css = wordpressCss(root.styles);

    if (css !== "") {
        ingestStyles(facts, file, parseStyles(css));
    }

    return true;
}
