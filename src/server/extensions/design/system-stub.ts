/**
 * A small stand-in for the three engines that the System view calls (docs/design/design-system.md, "Contracts between the
 * streams"): T's `loadDesignSystem` and `writeDesignSystem`, V's `checkDesign`, and G's `renderSystemDoc`. It has their
 * signatures, and just enough behaviour to build the view and its routes against a real folder. `system-api.ts` is the
 * one place that imports it: when the real files land, that file re-exports them instead and this one goes.
 */
import { randomUUID } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DesignBundle } from "../../design/bundle.ts";
import type {
    CheckFinding,
    CheckReport,
    CompiledFiles,
    ComponentSpec,
    DesignSystem,
    ModeValue,
    ResolvedToken,
    SystemChange,
    SystemProblem,
    TokenTier,
    TokenType,
} from "../../design/system-types.ts";

const MAX_FILE = 1_000_000;
const MAX_TOKENS = 4000;
const MAX_MODES = 8;
const MAX_COMPONENTS = 100;
const MAX_GUIDELINES = 16_384;
const MODE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REFERENCE = /^\{([^{}]+)\}$/;
const NAMESPACE = "com.pi-pocket";

/** A file's text, or undefined when it is not a plain file: it follows no link and reads at most `max` bytes. */
function readText(path: string, max: number): string | undefined {
    let fd: number;

    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        return undefined;
    }

    try {
        const info = fstatSync(fd);

        if (!info.isFile() || info.size > max) {
            return undefined;
        }

        const bytes = Buffer.alloc(info.size);

        readSync(fd, bytes, 0, info.size, 0);

        return bytes.toString("utf8");
    } finally {
        closeSync(fd);
    }
}

/** A real directory (not a link), or false. */
function directory(path: string): boolean {
    try {
        const info = lstatSync(path);

        return info.isDirectory() && !info.isSymbolicLink();
    } catch {
        return false;
    }
}

type Raw = {
    path: string[];
    type: TokenType;
    value: unknown;
    description?: string;
    deprecated?: boolean | string;
    ext: Record<string, unknown>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** The tokens of a DTCG object, in file order. A group's `$type` is inherited. */
function flatten(node: unknown, path: string[], type: unknown, out: Raw[]): void {
    if (!isObject(node) || path.length > 12 || out.length > MAX_TOKENS) {
        return;
    }

    const own = typeof node.$type === "string" ? node.$type : type;

    if ("$value" in node) {
        const ext = isObject(node.$extensions) ? node.$extensions[NAMESPACE] : undefined;

        out.push({
            path,
            type: (typeof own === "string" ? own : "number") as TokenType,
            value: node.$value,
            ...(typeof node.$description === "string" ? { description: node.$description } : {}),
            ...(node.$deprecated !== undefined
                ? { deprecated: node.$deprecated as boolean | string }
                : {}),
            ext: isObject(ext) ? ext : {},
        });

        return;
    }

    for (const [key, child] of Object.entries(node)) {
        if (!key.startsWith("$")) {
            flatten(child, [...path, key], own, out);
        }
    }
}

const cssVar = (name: string) => `--${name.replace(/\./g, "-")}`;
const num = (value: unknown) => (typeof value === "number" ? String(value) : String(value ?? ""));

function colorCss(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (isObject(value)) {
        if (typeof value.hex === "string" && (value.alpha === undefined || value.alpha === 1)) {
            return value.hex;
        }

        const parts = Array.isArray(value.components) ? value.components.map(num) : [];
        const alpha = typeof value.alpha === "number" && value.alpha < 1 ? ` / ${value.alpha}` : "";

        return `color(${typeof value.colorSpace === "string" ? value.colorSpace : "srgb"} ${parts.join(" ")}${alpha})`;
    }

    return "";
}

const dimensionCss = (value: unknown) =>
    isObject(value) ? `${num(value.value)}${num(value.unit)}` : num(value);

function shadowCss(value: unknown): string {
    const layers = Array.isArray(value) ? value : [value];

    return layers
        .map((layer) =>
            isObject(layer)
                ? [
                      layer.inset === true ? "inset" : "",
                      dimensionCss(layer.offsetX ?? "0px"),
                      dimensionCss(layer.offsetY ?? "0px"),
                      dimensionCss(layer.blur ?? "0px"),
                      dimensionCss(layer.spread ?? "0px"),
                      colorCss(layer.color),
                  ]
                      .filter(Boolean)
                      .join(" ")
                : "",
        )
        .join(", ");
}

const familyCss = (value: unknown) =>
    (Array.isArray(value) ? value : [value])
        .map((name) => (/^[\w-]+$/.test(String(name)) ? String(name) : `"${String(name)}"`))
        .join(", ");

/** The CSS text of a resolved value. */
function cssOf(type: TokenType, value: unknown): string {
    switch (type) {
        case "color":
            return colorCss(value);
        case "dimension":
        case "duration":
            return dimensionCss(value);
        case "fontFamily":
            return familyCss(value);
        case "cubicBezier":
            return Array.isArray(value) ? `cubic-bezier(${value.join(", ")})` : num(value);
        case "shadow":
            return shadowCss(value);
        case "typography":
            return isObject(value)
                ? `${num(value.fontWeight ?? 400)} ${dimensionCss(value.fontSize)}/${num(value.lineHeight ?? 1.4)} ${familyCss(value.fontFamily)}`
                : "";
        default:
            return typeof value === "string" ? value : JSON.stringify(value);
    }
}

/** `{a.b}` inside a value, resolved against `lookup`; throws on a missing token or a loop. */
function deref(
    value: unknown,
    lookup: (name: string, seen: string[]) => unknown,
    seen: string[],
): unknown {
    if (typeof value === "string") {
        const match = REFERENCE.exec(value);

        return match ? lookup(match[1]!, seen) : value;
    }

    if (Array.isArray(value)) {
        return value.map((each) => deref(each, lookup, seen));
    }

    if (isObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, each]) => [key, deref(each, lookup, seen)]),
        );
    }

    return value;
}

function compile(
    modes: string[],
    tokens: ResolvedToken[],
    components: ComponentSpec[],
): CompiledFiles {
    const block = (selector: string, mode: string, only: boolean) => {
        const lines = tokens
            .filter((token) => !only || token.modes[mode]!.css !== token.modes[modes[0]!]!.css)
            .map((token) => `    ${token.cssVar}: ${token.modes[mode]!.css};`);

        return lines.length === 0 ? "" : `${selector} {\n${lines.join("\n")}\n}\n`;
    };

    const rest = modes.slice(1);
    const dark = rest.includes("dark")
        ? `@media (prefers-color-scheme: dark) {\n${block(":root:not([data-theme])", "dark", true).replace(/^/gm, "    ")}}\n`
        : "";

    return {
        css: [
            block(":root", modes[0]!, false),
            ...rest.map((mode) => block(`[data-theme="${mode}"]`, mode, true)),
            dark,
        ]
            .filter(Boolean)
            .join("\n"),
        tailwind: `@theme {\n${tokens.map((token) => `    ${token.cssVar}: var(${token.cssVar});`).join("\n")}\n}\n`,
        json: JSON.stringify(
            Object.fromEntries(
                tokens.map((token) => [
                    token.name,
                    Object.fromEntries(
                        Object.entries(token.modes).map(([mode, each]) => [mode, each.value]),
                    ),
                ]),
            ),
            null,
            2,
        ),
        components: components.map((each) => each.css).join("\n"),
    };
}

function component(slug: string, source: string): ComponentSpec | undefined {
    const meta = /<script[^>]*id=["']pocket-component["'][^>]*>([\s\S]*?)<\/script>/i.exec(source);
    let info: Record<string, unknown> = {};

    try {
        info = meta ? (JSON.parse(meta[1]!) as Record<string, unknown>) : {};
    } catch {
        return undefined;
    }

    const markup: Record<string, string> = {};

    for (const match of source.matchAll(
        /<template[^>]*data-state=["']([\w-]+)["'][^>]*>([\s\S]*?)<\/template>/gi,
    )) {
        markup[match[1]!] = match[2]!.trim();
    }

    const states = Object.keys(markup);
    const usage = isObject(info.usage) ? info.usage : undefined;
    const list = (value: unknown) =>
        Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];

    return {
        slug,
        name: typeof info.name === "string" ? info.name : slug,
        description: typeof info.description === "string" ? info.description : "",
        states,
        markup,
        css: [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
            .map((match) => match[1]!.trim())
            .join("\n"),
        ...(usage ? { usage: { do: list(usage.do), dont: list(usage.dont) } } : {}),
        tokens: list(info.tokens),
    };
}

/** The project's design system, or undefined when `.pi/design/` is not there. */
export function loadDesignSystem(cwd: string): DesignSystem | undefined {
    const root = join(cwd, ".pi", "design");

    if (!directory(join(cwd, ".pi")) || !directory(root)) {
        return undefined;
    }

    const problems: SystemProblem[] = [];

    const parse = (file: string): unknown => {
        const text = readText(join(root, file), MAX_FILE);

        if (text === undefined) {
            return undefined;
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            problems.push({
                level: "error",
                file,
                message: `Not valid JSON: ${(error as Error).message.slice(0, 120)}`,
            });

            return undefined;
        }
    };

    const base = parse("tokens.json");
    const names = readdirSync(root)
        .map((file) => /^tokens\.([a-z][a-z0-9-]{0,31})\.json$/.exec(file)?.[1])
        .filter((mode): mode is string => mode !== undefined)
        .sort()
        .slice(0, MAX_MODES - 1);
    const modes = ["light", ...names];
    const raws = new Map<string, Raw>();
    const list: Raw[] = [];

    flatten(base, [], undefined, list);

    for (const raw of list) {
        raws.set(raw.path.join("."), raw);
    }

    const overrides = new Map<string, Map<string, unknown>>();

    for (const mode of names) {
        const found: Raw[] = [];

        flatten(parse(`tokens.${mode}.json`), [], undefined, found);
        overrides.set(mode, new Map(found.map((raw) => [raw.path.join("."), raw.value])));
    }

    const extension =
        isObject(base) && isObject(base.$extensions) ? base.$extensions[NAMESPACE] : {};
    const info = isObject(extension) ? extension : {};

    const resolveIn = (mode: string, name: string, seen: string[]): unknown => {
        const raw = raws.get(name);

        if (raw === undefined) {
            throw new Error(`No token ${name}.`);
        }

        if (seen.includes(name)) {
            throw new Error(`Loop: ${[...seen, name].join(" → ")}.`);
        }

        const value = overrides.get(mode)?.has(name) ? overrides.get(mode)!.get(name) : raw.value;

        return deref(value, (target, trail) => resolveIn(mode, target, trail), [...seen, name]);
    };

    const tokens: ResolvedToken[] = list.map((raw) => {
        const name = raw.path.join(".");
        const tier: TokenTier =
            typeof raw.ext.tier === "string" &&
            ["primitive", "semantic", "component"].includes(raw.ext.tier)
                ? (raw.ext.tier as TokenTier)
                : typeof raw.value === "string" && REFERENCE.test(raw.value)
                  ? "semantic"
                  : "primitive";
        const values: Record<string, ModeValue> = {};

        for (const mode of modes) {
            const own = overrides.get(mode)?.has(name) ? overrides.get(mode)!.get(name) : raw.value;
            let value: unknown = null;

            try {
                value = resolveIn(mode, name, []);
            } catch (error) {
                problems.push({
                    level: "error",
                    token: name,
                    message: (error as Error).message,
                });
            }

            const alias = typeof own === "string" ? REFERENCE.exec(own)?.[1] : undefined;

            values[mode] = {
                value,
                css: alias ? `var(${cssVar(alias)})` : cssOf(raw.type, value),
                ...(alias ? { alias } : {}),
            };
        }

        const contrast = isObject(raw.ext.contrast) ? raw.ext.contrast : undefined;
        const on = typeof contrast?.on === "string" ? REFERENCE.exec(contrast.on)?.[1] : undefined;

        return {
            path: raw.path,
            name,
            cssVar: cssVar(name),
            type: raw.type,
            tier,
            ...(raw.description ? { description: raw.description } : {}),
            ...(raw.deprecated ? { deprecated: raw.deprecated } : {}),
            modes: values,
            ...(on && typeof contrast?.min === "number"
                ? { contrast: { on, min: contrast.min } }
                : {}),
        };
    });

    const components: ComponentSpec[] = [];
    const folder = join(root, "components");

    if (directory(folder)) {
        for (const file of readdirSync(folder).sort().slice(0, MAX_COMPONENTS)) {
            const slug = file.replace(/\.html$/, "");
            const source =
                file.endsWith(".html") && SLUG.test(slug)
                    ? readText(join(folder, file), MAX_FILE)
                    : undefined;
            const spec = source === undefined ? undefined : component(slug, source);

            if (spec) {
                components.push(spec);
            }
        }
    }

    return {
        name: typeof info.name === "string" ? info.name : "Design system",
        ...(typeof info.description === "string" ? { description: info.description } : {}),
        modes,
        tokens,
        components,
        guidelines: readText(join(root, "guidelines.md"), MAX_GUIDELINES) ?? "",
        problems,
        compiled: compile(modes, tokens, components),
    };
}

/** Write `value` to `path` (a dotted name) in a DTCG object, making the groups on the way. */
function put(tree: Record<string, unknown>, name: string, value: unknown): void {
    const parts = name.split(".");
    let at = tree;

    for (const part of parts.slice(0, -1)) {
        const next = at[part];

        if (!isObject(next)) {
            at[part] = {};
        }

        at = at[part] as Record<string, unknown>;
    }

    const last = parts.at(-1)!;
    const token = at[last];

    if (isObject(token) && "$value" in token) {
        token.$value = value;
    } else {
        at[last] = { $value: value };
    }
}

function writeAtomic(path: string, text: string): void {
    const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;

    writeFileSync(temporary, text, { mode: 0o644, flag: "wx" });
    renameSync(temporary, path);
}

/** Apply a change, write the files, and load the result. Throws with the reason when the change is not valid. */
export function writeDesignSystem(cwd: string, change: SystemChange): DesignSystem {
    const before = loadDesignSystem(cwd);
    const root = join(cwd, ".pi", "design");

    if (before === undefined && change.tokens === undefined) {
        throw new Error("There is no design system yet: write the tokens first.");
    }

    mkdirSync(join(root, "components"), { recursive: true });

    const read = (file: string): Record<string, unknown> => {
        const text = readText(join(root, file), MAX_FILE);

        return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
    };

    const files = new Map<string, Record<string, unknown>>();
    const fileOf = (mode: string) =>
        mode === (before?.modes[0] ?? "light") ? "tokens.json" : `tokens.${mode}.json`;

    if (change.tokens !== undefined) {
        if (!isObject(change.tokens)) {
            throw new Error("Tokens are a DTCG object.");
        }

        files.set("tokens.json", change.tokens);
    }

    for (const [mode, tree] of Object.entries(change.modes ?? {})) {
        if (!MODE_NAME.test(mode)) {
            throw new Error(
                `“${mode}” is not a mode name: use lowercase letters, digits, and hyphens.`,
            );
        }

        files.set(fileOf(mode), isObject(tree) ? tree : {});

        if (tree === null) {
            rmSync(join(root, fileOf(mode)), { force: true });
            files.delete(fileOf(mode));
        }
    }

    for (const edit of change.set ?? []) {
        const known = before?.tokens.find((token) => token.name === edit.token);

        if (known === undefined && edit.mode !== before?.modes[0]) {
            throw new Error(`No token ${edit.token}.`);
        }

        if (!before?.modes.includes(edit.mode) && !files.has(fileOf(edit.mode))) {
            throw new Error(`No mode ${edit.mode}.`);
        }

        const reference =
            typeof edit.value === "string" ? REFERENCE.exec(edit.value)?.[1] : undefined;

        if (reference && !before?.tokens.some((token) => token.name === reference)) {
            throw new Error(`${edit.token} refers to ${reference}, which is not a token.`);
        }

        const file = fileOf(edit.mode);

        if (!files.has(file)) {
            files.set(file, read(file));
        }

        put(files.get(file)!, edit.token, edit.value);
    }

    for (const [file, tree] of files) {
        writeAtomic(join(root, file), `${JSON.stringify(tree, null, 4)}\n`);
    }

    for (const [slug, source] of Object.entries(change.components ?? {})) {
        if (!SLUG.test(slug)) {
            throw new Error(`“${slug}” is not a component name.`);
        }

        if (source === null) {
            rmSync(join(root, "components", `${slug}.html`), { force: true });
        } else {
            writeAtomic(join(root, "components", `${slug}.html`), source);
        }
    }

    if (change.guidelines !== undefined) {
        writeAtomic(join(root, "guidelines.md"), change.guidelines.slice(0, MAX_GUIDELINES));
    }

    const after = loadDesignSystem(cwd)!;
    const errors = after.problems.filter((problem) => problem.level === "error");

    if (errors.length > 0) {
        throw new Error(errors.map((problem) => problem.message).join(" "));
    }

    mkdirSync(join(root, "dist"), { recursive: true });
    writeAtomic(join(root, "dist", "tokens.css"), after.compiled.css);
    writeAtomic(join(root, "dist", "tailwind.css"), after.compiled.tailwind);
    writeAtomic(join(root, "dist", "tokens.resolved.json"), after.compiled.json);
    writeAtomic(join(root, "dist", "components.css"), after.compiled.components);

    return after;
}

/** What `checkDesign` is asked for. */
export interface CheckOptions {
    colorScheme?: "light" | "dark";
    viewport?: { width: number; height: number };
}

const HEX = /#[0-9a-f]{3,8}\b/gi;

/**
 * A static scan of the page's source: colors that are no token, a missing viewport, images with no alt. The real check
 * renders the page and walks its elements; this one finds enough to show what the view does with a report.
 */
export async function checkDesign(
    bundle: DesignBundle,
    system: DesignSystem | undefined,
    options: CheckOptions,
    _host: unknown,
    _signal?: AbortSignal,
): Promise<CheckReport> {
    const findings: CheckFinding[] = [];
    const known = new Set(
        (system?.tokens ?? [])
            .filter((token) => token.type === "color")
            .flatMap((token) => Object.values(token.modes).map((mode) => mode.css.toLowerCase())),
    );
    const html = bundle.content;
    let elements = 0;

    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
        findings.push({
            rule: "missing-viewport",
            level: "error",
            selector: "",
            message: "The page has no viewport meta tag.",
            suggestion: '<meta name="viewport" content="width=device-width, initial-scale=1">',
        });
    }

    for (const tag of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
        elements += 1;

        const attributes = tag[2]!;
        const pid = /data-pid=["']([^"']+)["']/.exec(attributes)?.[1];

        if (tag[1]!.toLowerCase() === "img" && !/\balt=/.test(attributes)) {
            findings.push({
                rule: "image-alt",
                level: "error",
                selector: pid ? `[data-pid="${pid}"]` : "img",
                ...(pid ? { pid } : {}),
                message: "This image has no alt text.",
            });
        }

        const style = /\bstyle=["']([^"']*)["']/.exec(attributes)?.[1] ?? "";

        for (const color of style.match(HEX) ?? []) {
            if (system !== undefined && !known.has(color.toLowerCase())) {
                findings.push({
                    rule: "off-system-color",
                    level: "warning",
                    selector: pid ? `[data-pid="${pid}"]` : tag[1]!,
                    ...(pid ? { pid } : {}),
                    value: color,
                    message: `${color} is not a color of the system.`,
                });
            }
        }
    }

    return {
        viewport: options.viewport ?? { width: 390, height: 844 },
        colorScheme: options.colorScheme ?? "light",
        findings,
        summary: {
            errors: findings.filter((each) => each.level === "error").length,
            warnings: findings.filter((each) => each.level === "warning").length,
            elements,
            byRule: findings.reduce<Record<string, number>>((count, each) => {
                count[each.rule] = (count[each.rule] ?? 0) + 1;

                return count;
            }, {}),
        },
        withoutSystem: system === undefined,
    };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A bare documentation page: the token names with their values, per mode. */
export function renderSystemDoc(system: DesignSystem): {
    html: string;
    assets: { name: string; content: string }[];
} {
    const rows = system.tokens
        .map(
            (token) =>
                `<tr><td><code>${escapeHtml(token.cssVar)}</code></td>${system.modes
                    .map((mode) => `<td>${escapeHtml(token.modes[mode]?.css ?? "")}</td>`)
                    .join("")}</tr>`,
        )
        .join("\n");

    return {
        html: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(system.name)}</title><link rel="stylesheet" href="tokens.css"></head><body><h1>${escapeHtml(system.name)}</h1><table>${rows}</table></body></html>\n`,
        assets: [{ name: "tokens.css", content: system.compiled.css }],
    };
}
