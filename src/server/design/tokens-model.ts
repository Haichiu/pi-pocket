/**
 * The token model of a design system (stream T): turns the parsed files of `.pi/design/` into a `DesignSystem`. It
 * reads W3C Design Tokens (DTCG) in both value forms, inherits types from groups, resolves references in every mode,
 * checks contrast pairs, parses the component specimens, and compiles `dist/`. No file access: `tokens-io.ts` reads
 * and writes, `tokens.ts` joins them.
 *
 * Every problem says where it is (file and token) and how to fix it. An error means the system cannot be used as it
 * is and stops a write; a warning does not.
 */
import { contrastRatio, parseColor, toHex } from "./color.ts";
import { parseComponent } from "./components.ts";
import type {
    DesignSystem,
    ModeValue,
    ResolvedToken,
    SystemProblem,
    TokenTier,
    TokenType,
} from "./system-types.ts";
import {
    LIMITS,
    MODE_NAME,
    NAME,
    RESERVED,
    TOKEN_TYPES,
    clip,
    extensionOf,
    isObject,
    plain,
    type Obj,
    type RawSystem,
} from "./tokens-base.ts";
import { compileDesignSystem } from "./tokens-compile.ts";
import {
    convert,
    inferType,
    refName,
    wholeRef,
    WHOLE_REF,
    type Ctx,
    type Out,
} from "./tokens-values.ts";

export { inferType };

// --- Problems -----------------------------------------------------------------------------------------------------

/** Collects problems without repeats and keeps at most `LIMITS.problems`. */
class Report {
    list: SystemProblem[] = [];
    private keys = new Set<string>();
    private dropped = 0;

    add(level: "error" | "warning", message: string, file?: string, token?: string): void {
        const key = `${level}|${file ?? ""}|${token ?? ""}|${message}`;

        if (this.keys.has(key)) {
            return;
        }

        this.keys.add(key);

        if (this.list.length >= LIMITS.problems) {
            this.dropped += 1;

            return;
        }

        const problem: SystemProblem = { level, message };

        if (file !== undefined) {
            problem.file = file;
        }

        if (token !== undefined) {
            problem.token = token;
        }

        this.list.push(problem);
    }

    error(message: string, file?: string, token?: string): undefined {
        this.add("error", message, file, token);
    }

    warn(message: string, file?: string, token?: string): void {
        this.add("warning", message, file, token);
    }

    /** The problems, errors first, with a note when some were left out. */
    done(): SystemProblem[] {
        const sorted = [
            ...this.list.filter((problem) => problem.level === "error"),
            ...this.list.filter((problem) => problem.level === "warning"),
        ];

        if (this.dropped > 0) {
            sorted.push({
                level: "warning",
                message: `${this.dropped} more problems are not shown.`,
            });
        }

        return sorted;
    }
}

/** The edit distance of two strings, for "did you mean". */
function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 4) {
        return 99;
    }

    let row = Array.from({ length: b.length + 1 }, (_, at) => at);

    for (let i = 1; i <= a.length; i++) {
        const next = [i];

        for (let j = 1; j <= b.length; j++) {
            next[j] = Math.min(
                row[j]! + 1,
                next[j - 1]! + 1,
                row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }

        row = next;
    }

    return row[b.length]!;
}

/** The token name closest to `name`, when one is close enough to be a typo. */
function nearest(name: string, names: Iterable<string>): string | undefined {
    let best: string | undefined;
    let bestDistance = Math.max(2, Math.floor(name.length / 4)) + 1;

    for (const candidate of names) {
        const gap = distance(name, candidate);

        if (gap < bestDistance) {
            best = candidate;
            bestDistance = gap;
        }
    }

    return best;
}

// --- Reading the DTCG tree ----------------------------------------------------------------------------------------

/** A token as written in a file. */
interface RawToken {
    name: string;
    path: string[];
    file: string;
    value: unknown;
    /** The `$type` of the token or of a group above it. */
    type?: string;
    description?: string;
    deprecated?: boolean | string;
    /** The `com.pi-pocket` extension, with `tier` inherited from the groups. */
    ext: Obj;
}

/** Walks a token file and lists its tokens. Problems of shape are reported here. */
function collect(root: unknown, file: string, report: Report): RawToken[] {
    const found: RawToken[] = [];

    if (!isObject(root)) {
        report.error(
            `The file must hold one JSON object (a DTCG token group), not ${Array.isArray(root) ? "an array" : typeof root}.`,
            file,
        );

        return found;
    }

    const token = (node: Obj, path: string[], inherited: { type?: string; tier?: string }) => {
        const name = path.join(".");

        for (const key of Object.keys(node)) {
            if (!key.startsWith("$")) {
                report.error(
                    `"${name}" has a $value, so it is a token and cannot hold "${clip(key, 30)}". Put tokens in a group, beside each other.`,
                    file,
                    name,
                );

                return;
            }
        }

        const own = node.$type;
        const ext = {
            ...(inherited.tier === undefined ? {} : { tier: inherited.tier }),
            ...extensionOf(node),
        };

        if (own !== undefined && typeof own !== "string") {
            report.error(`$type of "${name}" must be a string such as "color".`, file, name);

            return;
        }

        const raw: RawToken = {
            name,
            path,
            file,
            value: node.$value,
            ext,
        };
        const type = own ?? inherited.type;

        if (type !== undefined) {
            raw.type = type;
        }

        if (typeof node.$description === "string") {
            raw.description = plain(node.$description).slice(0, 300);
        }

        if (typeof node.$deprecated === "boolean" || typeof node.$deprecated === "string") {
            raw.deprecated =
                typeof node.$deprecated === "string"
                    ? plain(node.$deprecated).slice(0, 200)
                    : node.$deprecated;
        }

        found.push(raw);
    };

    const group = (node: Obj, path: string[], inherited: { type?: string; tier?: string }) => {
        if (path.length > LIMITS.depth) {
            report.error(
                `Groups nest more than ${LIMITS.depth} levels deep at "${path.join(".")}".`,
                file,
            );

            return;
        }

        const type = typeof node.$type === "string" ? node.$type : inherited.type;
        const tier = extensionOf(node).tier ?? inherited.tier;
        const next = {
            ...(type === undefined ? {} : { type }),
            ...(typeof tier === "string" ? { tier } : {}),
        };

        if (node.$extends !== undefined) {
            report.warn(
                `$extends on "${path.join(".") || "the root"}" is not supported; it is ignored. Copy the tokens instead.`,
                file,
            );
        }

        for (const key of Object.keys(node)) {
            const child = node[key];

            if (key === "$root") {
                if (isObject(child) && Object.hasOwn(child, "$value")) {
                    token(child, path, next);
                } else {
                    report.error('"$root" must be a token: { "$value": … }.', file, path.join("."));
                }

                continue;
            }

            if (key.startsWith("$")) {
                continue;
            }

            const here = [...path, key];
            const name = here.join(".");

            if (!NAME.test(key) || RESERVED.has(key)) {
                report.error(
                    `The name "${clip(key, 30)}" in "${path.join(".") || "the root"}" must use letters, digits, "-" or "_" (1 to 64 characters), not a dot, space, or symbol. Rename it, for example "${clip(key.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x", 30)}".`,
                    file,
                );

                continue;
            }

            if (!isObject(child)) {
                report.error(
                    `"${name}" is ${Array.isArray(child) ? "an array" : `a plain ${typeof child}`}. A token is an object: { "$value": ${typeof child === "string" ? JSON.stringify(clip(child, 20)) : "…"} }. A group holds tokens or groups.`,
                    file,
                    name,
                );
            } else if (Object.hasOwn(child, "$value")) {
                token(child, here, next);
            } else if (
                Object.hasOwn(child, "value") &&
                !Object.keys(child).some((each) => isObject(child[each]) && !each.startsWith("$"))
            ) {
                report.error(
                    `"${name}" uses "value"${Object.hasOwn(child, "type") ? ' and "type"' : ""}. DTCG writes "$value" and "$type" with a dollar sign.`,
                    file,
                    name,
                );
            } else {
                group(child, here, next);
            }
        }
    };

    group(root, [], {});

    return found;
}

// --- Tiers --------------------------------------------------------------------------------------------------------

const TIER_GROUPS: Record<string, TokenTier> = {
    primitive: "primitive",
    primitives: "primitive",
    core: "primitive",
    base: "primitive",
    global: "primitive",
    palette: "primitive",
    ref: "primitive",
    reference: "primitive",
    semantic: "semantic",
    sys: "semantic",
    system: "semantic",
    alias: "semantic",
    role: "semantic",
    roles: "semantic",
    theme: "semantic",
    component: "component",
    components: "component",
    comp: "component",
};

/** Path segments that name what a value is for, not which value it is. */
const ROLE_WORDS = new Set([
    "bg",
    "background",
    "surface",
    "text",
    "fg",
    "foreground",
    "border",
    "accent",
    "primary",
    "secondary",
    "danger",
    "success",
    "warning",
    "error",
    "info",
    "muted",
    "on",
    "focus",
    "ring",
    "overlay",
    "link",
    "brand",
    "body",
    "heading",
    "display",
    "default",
]);

// --- Building a system --------------------------------------------------------------------------------------------

interface Def {
    name: string;
    path: string[];
    cssVar: string;
    base: RawToken;
    over: Map<string, RawToken>;
    type?: TokenType;
}

/** Whether a mode is dark, by its declared scheme, its name, or (else) its page background. */
function schemeOf(mode: string, declared: unknown): "light" | "dark" | undefined {
    if (declared === "light" || declared === "dark") {
        return declared;
    }

    if (/(^|-)dark($|-)/.test(mode)) {
        return "dark";
    }

    return /(^|-)light($|-)/.test(mode) ? "light" : undefined;
}

/**
 * Builds the system: reads the token files, resolves every token in every mode, checks the contrast pairs and the
 * component specimens, and compiles `dist/`.
 */
export function buildSystem(raw: RawSystem): DesignSystem {
    const report = new Report();

    for (const problem of raw.problems) {
        report.add(problem.level, problem.message, problem.file, problem.token);
    }

    const root = isObject(raw.tokens) ? raw.tokens : undefined;
    const rootExt = root === undefined ? {} : extensionOf(root);
    const name =
        typeof rootExt.name === "string" && plain(rootExt.name) !== ""
            ? plain(rootExt.name).slice(0, 80)
            : raw.folder;
    const description =
        root !== undefined && typeof root.$description === "string"
            ? plain(root.$description).slice(0, 300)
            : undefined;
    let defaultMode = "light";

    if (typeof rootExt.mode === "string") {
        if (MODE_NAME.test(rootExt.mode)) {
            defaultMode = rootExt.mode;
        } else {
            report.error(
                `The default mode "${clip(rootExt.mode, 30)}" must be a lowercase name such as "light".`,
                "tokens.json",
            );
        }
    }

    // The defaults.
    const defs = new Map<string, Def>();
    const byVar = new Map<string, string>();

    if (raw.tokens === undefined) {
        report.warn(
            "There is no tokens.json yet. Add tokens with set, or write the whole file with init.",
            "tokens.json",
        );
    }

    for (const token of raw.tokens === undefined
        ? []
        : collect(raw.tokens, "tokens.json", report)) {
        if (defs.size >= LIMITS.tokens) {
            report.error(
                `tokens.json has more than ${LIMITS.tokens} tokens; the rest are ignored.`,
                "tokens.json",
            );

            break;
        }

        if (defs.has(token.name)) {
            report.error(
                `"${token.name}" is defined twice (as a token and as $root of a group).`,
                token.file,
                token.name,
            );

            continue;
        }

        const cssVar = `--${token.path.join("-")}`;
        const clash = byVar.get(cssVar);

        if (clash !== undefined) {
            report.error(
                `"${token.name}" and "${clash}" both become ${cssVar}. Rename one of them.`,
                token.file,
                token.name,
            );

            continue;
        }

        byVar.set(cssVar, token.name);
        defs.set(token.name, {
            name: token.name,
            path: token.path,
            cssVar,
            base: token,
            over: new Map(),
        });
    }

    // The modes.
    const modeNames: string[] = [];
    const modeMeta = new Map<string, unknown>();

    for (const [mode, file] of [...raw.modes].sort((a, b) => a[0].localeCompare(b[0]))) {
        const label = `tokens.${mode}.json`;

        if (!MODE_NAME.test(mode) || mode === defaultMode) {
            report.error(
                mode === defaultMode
                    ? `${label} has the name of the default mode ("${mode}"). Rename the file, or change the default mode in tokens.json.`
                    : `The mode name "${clip(mode, 30)}" must be lowercase letters, digits, and hyphens.`,
                label,
            );

            continue;
        }

        if (modeNames.length >= LIMITS.modes) {
            report.error(`There are more than ${LIMITS.modes} modes; ${label} is ignored.`, label);

            continue;
        }

        modeNames.push(mode);
        modeMeta.set(mode, isObject(file) ? extensionOf(file).colorScheme : undefined);

        for (const token of collect(file, label, report)) {
            const def = defs.get(token.name);

            if (def === undefined) {
                const close = nearest(token.name, defs.keys());

                report.error(
                    `"${token.name}" is not in tokens.json, so it has no default value.${close === undefined ? " Add it to tokens.json first." : ` Did you mean "${close}"?`}`,
                    label,
                    token.name,
                );
            } else {
                def.over.set(mode, token);
            }
        }
    }

    // Dark mode first, after the default; the rest in name order.
    modeNames.sort((a, b) => (a === "dark" ? -1 : b === "dark" ? 1 : a.localeCompare(b)));
    const modes = [defaultMode, ...modeNames];

    // Types: declared, taken from a reference, or read from the value.
    const types = new Map<string, TokenType | null>();

    const typeOf = (def: Def, visiting: string[] = []): TokenType | undefined => {
        if (types.has(def.name)) {
            return types.get(def.name) ?? undefined;
        }

        // A reference loop has no type to take; the loop is reported when the values are resolved.
        if (visiting.includes(def.name)) {
            return undefined;
        }

        const declared = def.base.type;
        const target = wholeRef(def.base.value);
        let type: TokenType | undefined;

        if (declared !== undefined) {
            if ((TOKEN_TYPES as readonly string[]).includes(declared)) {
                type = declared as TokenType;
            } else {
                report.error(
                    `Unknown $type "${clip(declared, 30)}". Use one of ${TOKEN_TYPES.join(", ")}.`,
                    def.base.file,
                    def.name,
                );
            }
        } else if (target !== undefined) {
            // A missing target is reported when the value is resolved.
            const other = defs.get(refName(target));

            type = other === undefined ? undefined : typeOf(other, [...visiting, def.name]);
        } else {
            type = inferType(def.base.value);

            if (type === undefined) {
                report.error(
                    `"${def.name}" has no $type and its value does not show one. Add "$type" to the token or its group: one of ${TOKEN_TYPES.join(", ")}.`,
                    def.base.file,
                    def.name,
                );
            } else {
                report.warn(
                    `"${def.name}" has no $type; it is read as ${type} from its value. Add "$type": "${type}".`,
                    def.base.file,
                    def.name,
                );
            }
        }

        // A type cut short by a loop is not final: leave it for the loop's first token to settle.
        if (type !== undefined || visiting.length === 0) {
            types.set(def.name, type ?? null);
        }

        return type;
    };

    for (const def of defs.values()) {
        def.type = typeOf(def);

        for (const [mode, over] of def.over) {
            if (over.type !== undefined && def.type !== undefined && over.type !== def.type) {
                report.error(
                    `"${def.name}" is ${def.type} in tokens.json but ${over.type} in tokens.${mode}.json. A mode changes values, not types.`,
                    over.file,
                    def.name,
                );
                def.over.delete(mode);
            }
        }
    }

    // Values, mode by mode.
    const results = new Map<string, Map<string, Out | null>>();

    for (const mode of modes) {
        const memo = new Map<string, Out | null>();
        const stack: string[] = [];

        results.set(mode, memo);

        const resolve = (key: string): Out | null => {
            const cached = memo.get(key);

            if (cached !== undefined) {
                return cached;
            }

            const def = defs.get(key)!;
            const source = def.over.get(mode) ?? def.base;

            stack.push(key);

            const ctx: Ctx = {
                error: (message) => report.error(message, source.file, def.name),
                warn: (message) => report.warn(message, source.file, def.name),
                ref(text, expect) {
                    const targetName = refName(text);
                    const target = defs.get(targetName);

                    if (target === undefined) {
                        const close = nearest(targetName, defs.keys());

                        return report.error(
                            `The reference {${clip(targetName)}} does not exist.${close === undefined ? "" : ` Did you mean {${close}}?`}`,
                            source.file,
                            def.name,
                        );
                    }

                    if (stack.includes(targetName)) {
                        const loop = stack.slice(stack.indexOf(targetName));
                        const at = loop.indexOf([...loop].sort()[0]!);
                        const turned = [...loop.slice(at), ...loop.slice(0, at)];

                        return report.error(
                            `Reference cycle: ${[...turned, turned[0]!].join(" → ")}. Make one of them a real value.`,
                            source.file,
                            turned[0],
                        );
                    }

                    const out = resolve(targetName);

                    if (out === null || target.type === undefined) {
                        // The cause is reported where it is.
                        return undefined;
                    }

                    if (expect !== undefined && !expect.includes(target.type)) {
                        return report.error(
                            `{${targetName}} is a ${target.type}, but a ${expect.join(" or ")} is needed here.`,
                            source.file,
                            def.name,
                        );
                    }

                    return { ...out, name: targetName, type: target.type, cssVar: target.cssVar };
                },
            };
            let out: Out | null = null;

            if (def.type !== undefined) {
                out = convert(def.type, source.value, ctx) ?? null;
            } else if (wholeRef(source.value) !== undefined) {
                // No type to take from the target: look at the reference, to report a missing target or a loop.
                ctx.ref(refName(wholeRef(source.value)!));
            }

            stack.pop();
            memo.set(key, out);

            return out;
        };

        for (const key of defs.keys()) {
            resolve(key);
        }
    }

    // The scheme of each mode.
    const schemes: Record<string, "light" | "dark"> = {};

    for (const mode of modes) {
        const declared = schemeOf(
            mode,
            mode === defaultMode ? rootExt.colorScheme : modeMeta.get(mode),
        );
        const page = [...defs.values()].find(
            (def) =>
                def.type === "color" &&
                /^(?:color\.)?(?:bg|background)(?:\.(?:page|default|base|canvas))?$/.test(def.name),
        );
        const hex = page === undefined ? undefined : results.get(mode)?.get(page.name)?.literal;
        const rgba = hex === undefined ? undefined : parseColor(hex);

        schemes[mode] =
            declared ??
            (rgba !== undefined &&
            rgba.a > 0 &&
            contrastRatio({ r: 1, g: 1, b: 1, a: 1 }, rgba) >
                contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, rgba)
                ? "dark"
                : "light");
    }

    // The components (parsed before the tiers, which use their names).
    const known = {
        byVar,
        names: new Set(defs.keys()),
    };
    const components = [];

    if (raw.components.size > LIMITS.components) {
        report.error(
            `There are more than ${LIMITS.components} components; the rest are ignored.`,
            "components",
        );
    }

    for (const [slug, html] of [...raw.components]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(0, LIMITS.components)) {
        const parsed = parseComponent(slug, html, known);

        for (const problem of parsed.problems) {
            report.add(problem.level, problem.message, problem.file, problem.token);
        }

        if (parsed.spec !== undefined) {
            components.push(parsed.spec);
        }
    }

    const componentSlugs = new Set(components.map((component) => component.slug));

    // The resolved tokens.
    const tokens: ResolvedToken[] = [];

    for (const def of defs.values()) {
        if (def.type === undefined) {
            continue;
        }

        const values: Record<string, ModeValue> = {};
        let complete = true;

        for (const mode of modes) {
            const out = results.get(mode)!.get(def.name);

            if (out === null || out === undefined) {
                complete = false;

                break;
            }

            const rgba = def.type === "color" ? parseColor(out.literal) : undefined;
            const entry: ModeValue = { value: out.value, css: out.css, literal: out.literal };

            if (rgba !== undefined) {
                entry.hex = toHex(rgba);
            }

            if (out.parts !== undefined) {
                entry.parts = out.parts;
            }

            if (out.alias !== undefined) {
                entry.alias = out.alias;
            }

            values[mode] = entry;
        }

        // A token that failed in a mode is left out; its problem is in the report.
        if (!complete) {
            continue;
        }

        const ext = def.base.ext;
        const first = def.path[0]!.toLowerCase();
        let tier: TokenTier;

        if (ext.tier === "primitive" || ext.tier === "semantic" || ext.tier === "component") {
            tier = ext.tier;
        } else if (TIER_GROUPS[first] !== undefined) {
            tier = TIER_GROUPS[first]!;
        } else if (componentSlugs.has(first)) {
            tier = "component";
        } else if (
            wholeRef(def.base.value) !== undefined ||
            def.path.some((each) => ROLE_WORDS.has(each.toLowerCase()))
        ) {
            tier = "semantic";
        } else {
            tier = "primitive";
        }

        const token: ResolvedToken = {
            path: def.path,
            name: def.name,
            cssVar: def.cssVar,
            type: def.type,
            tier,
            modes: values,
        };

        if (def.base.description !== undefined) {
            token.description = def.base.description;
        }

        if (def.base.deprecated !== undefined && def.base.deprecated !== false) {
            token.deprecated = def.base.deprecated;
        }

        if (typeof ext.tailwind === "string" && /^--[\w-]+$/.test(ext.tailwind)) {
            token.tailwind = ext.tailwind;
        }

        tokens.push(token);
    }

    // Semantic colors should name a primitive, so that a mode can change the palette in one place.
    if (tokens.some((token) => token.type === "color" && token.tier === "primitive")) {
        const raws = tokens.filter(
            (token) =>
                token.type === "color" &&
                token.tier === "semantic" &&
                wholeRef(defs.get(token.name)!.base.value) === undefined,
        );

        if (raws.length > 0) {
            report.warn(
                `${raws.length} semantic color${raws.length === 1 ? " holds a raw value" : "s hold raw values"} instead of references (${raws
                    .slice(0, 4)
                    .map((token) => token.name)
                    .join(
                        ", ",
                    )}${raws.length > 4 ? ", …" : ""}). Reference a primitive, such as {color.gray.900}, so that a mode changes the palette in one place.`,
                "tokens.json",
            );
        }
    }

    // Contrast pairs, in every mode.
    const byName = new Map(tokens.map((token) => [token.name, token]));

    for (const token of tokens) {
        const spec = defs.get(token.name)!.base.ext.contrast;
        const pairs = (Array.isArray(spec) ? spec : spec === undefined ? [] : [spec]).slice(0, 4);
        const failing: string[] = [];

        for (const [at, pair] of pairs.entries()) {
            const on =
                isObject(pair) && typeof pair.on === "string"
                    ? byName.get(refName(WHOLE_REF.exec(pair.on)?.[1] ?? pair.on))
                    : undefined;
            const min = isObject(pair) && typeof pair.min === "number" ? pair.min : 4.5;

            if (
                token.type !== "color" ||
                on === undefined ||
                on.type !== "color" ||
                !(min >= 1 && min <= 21)
            ) {
                report.error(
                    token.type !== "color"
                        ? `"${token.name}" declares a contrast pair, but it is a ${token.type}, not a color.`
                        : `The contrast pair of "${token.name}" must be { "on": "{color.bg.surface}", "min": 4.5 } with "on" an existing color token and "min" from 1 to 21.`,
                    "tokens.json",
                    token.name,
                );

                break;
            }

            if (at === 0) {
                token.contrast = { on: on.name, min };
            }

            for (const mode of modes) {
                const front = parseColor(token.modes[mode]!.literal ?? "");
                const back = parseColor(on.modes[mode]!.literal ?? "");

                if (front === undefined || back === undefined) {
                    continue;
                }

                const ratio = contrastRatio(
                    front,
                    back,
                    schemes[mode] === "dark"
                        ? { r: 0, g: 0, b: 0, a: 1 }
                        : { r: 1, g: 1, b: 1, a: 1 },
                );
                const pass = ratio >= min;

                if (at === 0) {
                    token.modes[mode]!.contrast = {
                        on: on.name,
                        ratio: Math.floor(ratio * 100) / 100,
                        min,
                        pass,
                    };
                }

                if (!pass) {
                    failing.push(
                        `${mode} ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 on ${on.name} (needs ${min})`,
                    );
                }
            }
        }

        if (failing.length > 0) {
            report.warn(
                `Contrast of "${token.name}" is too low: ${failing.join("; ")}. Make the two colors further apart in lightness.`,
                "tokens.json",
                token.name,
            );
        }
    }

    // A deprecated token that another token still points at.
    for (const token of tokens) {
        if (token.deprecated === undefined) {
            continue;
        }

        const users = tokens.filter(
            (other) =>
                other.name !== token.name &&
                Object.values(other.modes).some((value) => value.alias === token.name),
        );

        if (users.length > 0) {
            report.warn(
                `"${token.name}" is deprecated${typeof token.deprecated === "string" ? ` (${token.deprecated})` : ""} but ${users
                    .slice(0, 3)
                    .map((user) => user.name)
                    .join(
                        ", ",
                    )}${users.length > 3 ? ", …" : ""} still ${users.length === 1 ? "uses" : "use"} it.`,
                "tokens.json",
                token.name,
            );
        }
    }

    const guidelines = raw.guidelines;
    const system: Omit<DesignSystem, "compiled" | "problems"> = {
        name,
        modes,
        schemes,
        tokens,
        components,
        guidelines,
    };

    if (description !== undefined) {
        system.description = description;
    }

    const compiled = compileDesignSystem(system);

    return { ...system, problems: report.done(), compiled };
}
