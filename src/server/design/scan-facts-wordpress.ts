/** WordPress `theme.json` (stream T): the palette, the font sizes, the spacing, and the styles of a block theme. */
import { parseStyles, type Scope } from "./scan-parse.ts";
import { addVar, type Category, type Facts } from "./scan-facts.ts";
import { modeOf } from "./scan-facts-lists.ts";
import { ingestStyles } from "./scan-facts-use.ts";

/** `--wp--preset--color--primary` is `--color-primary`; `--wp--custom--radius--pill` is `--custom-radius-pill`; `var:preset|color|primary` too. */
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

/** A WordPress `styles` object as CSS rules, so that the scan reads how the theme uses its presets. */
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

/**
 * A WordPress block theme's `theme.json` (and its style variations in `styles/`): the palette, font sizes, font
 * families, spacing sizes, shadows, and `settings.custom` become variables; `styles` becomes the rules that use them.
 * A variation named for dark (`styles/dark.json`) holds the dark values. Returns whether the file was one.
 */
export function wordpressTheme(facts: Facts, file: string, source: string): boolean {
    if (
        !/\bsettings\b/.test(source) ||
        !/\b(?:palette|fontSizes|spacingSizes|presets|fontFamilies|custom)\b/.test(source)
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

    const title = typeof root.title === "string" ? modeOf(root.title) : undefined;
    const scope: Scope =
        facts.fileMode ?? (title === "dark" || title === "light" ? title : "default");

    const add = (name: string, value: unknown, hint: Category) => {
        if (typeof value === "string" || typeof value === "number") {
            addVar(facts, {
                name,
                value: String(value).slice(0, 400),
                scope,
                kind: "css",
                file,
                hint,
            });
        }
    };

    const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? value.filter(isObj).slice(0, 80) : [];
    const key = (value: unknown) => String(value ?? "").replace(/[^\w-]/g, "-");

    if (isObj(settings.color)) {
        for (const item of list(settings.color.palette)) {
            add(`color-${key(item.slug)}`, item.color, "color");
        }
    }

    if (isObj(settings.typography)) {
        for (const item of list(settings.typography.fontSizes)) {
            add(`font-size-${key(item.slug)}`, item.size, "text");
        }

        for (const item of list(settings.typography.fontFamilies)) {
            add(`font-family-${key(item.slug)}`, item.fontFamily, "font");
        }
    }

    if (isObj(settings.spacing)) {
        for (const item of list(settings.spacing.spacingSizes)) {
            add(`spacing-${key(item.slug)}`, item.size, "space");
        }
    }

    if (isObj(settings.shadow)) {
        for (const item of list(settings.shadow.presets)) {
            add(`shadow-${key(item.slug)}`, item.shadow, "shadow");
        }
    }

    // `settings.custom`: nested groups, named by their path (`--custom-radius-pill`).
    const custom = (node: unknown, path: string[]) => {
        if (path.length > 4) {
            return;
        }

        if (isObj(node)) {
            for (const [name, child] of Object.entries(node).slice(0, 60)) {
                custom(child, [...path, name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()]);
            }
        } else if (typeof node === "string" || typeof node === "number") {
            const name = path.join("-");
            const hint: Category | undefined =
                path[0] === "color"
                    ? "color"
                    : path[0] === "radius"
                      ? "radius"
                      : path[0] === "spacing"
                        ? "space"
                        : path[0] === "shadow"
                          ? "shadow"
                          : undefined;

            if (hint !== undefined) {
                add(`custom-${name}`, node, hint);
            }
        }
    };

    custom(settings.custom, []);

    const css = wordpressCss(root.styles);

    if (css !== "") {
        ingestStyles(facts, file, parseStyles(css));
    }

    return true;
}
