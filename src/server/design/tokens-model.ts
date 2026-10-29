import { contrastRatio, parseColor, toHex } from "./color.ts";
import { parseComponent } from "./components.ts";
import type {
    ContrastExemption,
    DesignSystem,
    ModeValue,
    ResolvedToken,
    TokenTier,
} from "./system-types.ts";
import {
    LIMITS,
    MODE_NAME,
    clip,
    extensionOf,
    isObject,
    plain,
    type RawSystem,
} from "./tokens-base.ts";
import { compileDesignSystem } from "./tokens-compile.ts";
import { collectDefinitions, collectModes } from "./tokens-model-defs.ts";
import { Report } from "./tokens-model-report.ts";
import { assignTypes, resolveModes } from "./tokens-model-resolve.ts";
import { rampProblems } from "./tokens-ramps.ts";
import { inferType, refName, wholeRef, WHOLE_REF } from "./tokens-values.ts";

export { inferType };

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

function schemeOf(mode: string, declared: unknown): "light" | "dark" | undefined {
    if (declared === "light" || declared === "dark") {
        return declared;
    }

    if (/(^|-)dark($|-)/.test(mode)) {
        return "dark";
    }

    return /(^|-)light($|-)/.test(mode) ? "light" : undefined;
}

export function buildSystem(raw: RawSystem): DesignSystem {
    const report = new Report();
    // Typo suggestions are optional: the edit-distance work of one load is bounded (a few tenths of a second at most).
    const suggestionBudget = { remaining: 20_000_000 };

    for (const problem of raw.problems) {
        report.add(problem.level, problem.message, problem.file, problem.token, problem.fix);
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

    const { defs, byVar } = collectDefinitions(raw, report);
    const { modes, modeMeta } = collectModes(raw, defaultMode, defs, report, suggestionBudget);

    assignTypes(defs, report);

    const results = resolveModes(modes, defs, report, suggestionBudget);
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
        } else if (wholeRef(def.base.value) !== undefined) {
            tier = "semantic";
        } else if (/^\d+$/.test(def.path.at(-1)!)) {
            tier = "primitive";
        } else if (def.path.some((each) => ROLE_WORDS.has(each.toLowerCase()))) {
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

    // A token named for its own value (`space.16` = 16px, `duration.140` = 140ms) is renamed whenever the value changes.
    const named = new Map<string, string[]>();

    for (const token of tokens) {
        const step = /^\d+(?:\.\d+)?$/.exec(token.path.at(-1)!);
        const literal = token.modes[modes[0]!]?.literal ?? "";
        const amount = (type: string) =>
            type === "dimension"
                ? /^(\d*\.?\d+)(px|rem)?$/.exec(literal)
                : /^(\d*\.?\d+)(ms|s)$/.exec(literal);
        const found =
            step === null || (token.type !== "dimension" && token.type !== "duration")
                ? null
                : amount(token.type);

        if (found !== null && step !== null && found[1] !== "0") {
            const number = Number(found[1]);
            const value =
                token.type === "dimension"
                    ? found[2] === "rem"
                        ? number * 16
                        : found[2] === "px"
                          ? number
                          : undefined
                    : found[2] === "s"
                      ? number * 1000
                      : number;

            if (value !== undefined && value === Number(step[0])) {
                const group = token.path.slice(0, -1).join(".");

                named.set(group, [...(named.get(group) ?? []), token.name]);
            }
        }
    }

    for (const [group, names] of named) {
        const first = names[0]!;

        report.warn(
            `${names.length === 1 ? `"${first}" is` : `${names.length} tokens in "${group}" are`} named for ${names.length === 1 ? "its" : "their"} own value (${names
                .slice(0, 4)
                .map((each) => each.split(".").at(-1))
                .join(
                    ", ",
                )}${names.length > 4 ? ", …" : ""}): the name has to change when the value does.`,
            "tokens.json",
            first,
            `Rename ${names.length === 1 ? `"${first}"` : "each"} to a role (for example "${group}.card"), or to a step of a scale ("${group}.4", "${group}.5"), and point the tokens that use ${names.length === 1 ? "it" : "them"} at the new name.`,
        );
    }

    for (const problem of rampProblems(tokens, modes)) {
        report.warn(problem.message, "tokens.json", problem.second, problem.fix);
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

    const byName = new Map(tokens.map((token) => [token.name, token]));

    for (const token of tokens) {
        const spec = defs.get(token.name)!.base.ext.contrast;
        const pairs = (Array.isArray(spec) ? spec : spec === undefined ? [] : [spec]).slice(0, 4);
        const failing: string[] = [];
        const exempted: string[] = [];
        let exemptWord = "";

        for (const [at, pair] of pairs.entries()) {
            const target =
                isObject(pair) && typeof pair.on === "string"
                    ? refName(WHOLE_REF.exec(pair.on)?.[1] ?? pair.on)
                    : undefined;
            const on = target === undefined ? undefined : byName.get(target);
            const min = isObject(pair) && typeof pair.min === "number" ? pair.min : 4.5;
            const exempt: ContrastExemption | undefined =
                isObject(pair) && (pair.exempt === "disabled" || pair.exempt === "decorative")
                    ? pair.exempt
                    : undefined;

            if (isObject(pair) && pair.exempt !== undefined && exempt === undefined) {
                report.error(
                    `The contrast pair of "${token.name}" has exempt ${JSON.stringify(pair.exempt)}; it must be "disabled" or "decorative".`,
                    "tokens.json",
                    token.name,
                );

                break;
            }

            // The color it sits on failed: that error says why, and this one would only repeat it.
            if (on === undefined && target !== undefined && defs.has(target)) {
                break;
            }

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

            const entry = { on: on.name, min, ...(exempt === undefined ? {} : { exempt }) };

            if (at === 0) {
                token.contrast = entry;
            }

            (token.contrasts ??= []).push(entry);

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
                        ...(exempt === undefined ? {} : { exempt }),
                    };
                }

                if (!pass) {
                    (exempt === undefined ? failing : exempted).push(
                        `${mode} ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 on ${on.name} (needs ${min})`,
                    );
                    exemptWord = exempt ?? exemptWord;
                }
            }
        }

        if (failing.length > 0) {
            report.warn(
                `Contrast of "${token.name}" is too low: ${failing.join("; ")}. Make the two colors further apart in lightness.`,
                "tokens.json",
                token.name,
                `Raise the contrast, or declare the pair exempt if it is a disabled or decorative color: "contrast": { "on": …, "min": …, "exempt": "disabled" }.`,
            );
        }

        if (exempted.length > 0) {
            report.info(
                `Contrast of "${token.name}" is below its minimum (${exempted.join("; ")}), and the pair is exempt (${exemptWord}).`,
                "tokens.json",
                token.name,
            );
        }
    }

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
    const overrides: Record<string, string[]> = {};

    for (const mode of modes.slice(1)) {
        overrides[mode] = tokens
            .filter((token) => defs.get(token.name)?.over.has(mode) === true)
            .map((token) => token.name);
    }

    // `"tailwindReset": ["color"]` (or `true`, which is color) clears Tailwind's defaults of those namespaces.
    const resetOf = rootExt.tailwindReset;
    const tailwindReset = [
        ...new Set(
            (resetOf === true
                ? ["color"]
                : Array.isArray(resetOf)
                  ? resetOf
                  : typeof resetOf === "string"
                    ? [resetOf]
                    : []
            ).filter(
                (each): each is string =>
                    typeof each === "string" &&
                    [
                        "color",
                        "font",
                        "text",
                        "font-weight",
                        "spacing",
                        "radius",
                        "shadow",
                        "ease",
                        "breakpoint",
                        "all",
                    ].includes(each),
            ),
        ),
    ];
    // `"format": "2025.10"` writes the object forms of the DTCG 2025.10 draft in the per-mode files.
    const formatOf = rootExt.format;
    let dtcgFormat: "2021" | "2025.10" | undefined;

    if (formatOf !== undefined) {
        const text = String(formatOf).trim();

        if (/^2025(?:[.-]10)?$/.test(text)) {
            dtcgFormat = "2025.10";
        } else if (/^2021(?:[.-]\d+)?$/.test(text)) {
            dtcgFormat = "2021";
        } else {
            report.warn(
                `The format "${clip(text, 30)}" in tokens.json is not "2021" or "2025.10"; the default, "2021", is used.`,
                "tokens.json",
            );
        }
    }

    const system: Omit<DesignSystem, "compiled" | "problems"> = {
        name,
        modes,
        schemes,
        tokens,
        overrides,
        ...(tailwindReset.length === 0 ? {} : { tailwindReset }),
        ...(dtcgFormat === undefined ? {} : { dtcgFormat }),
        components,
        guidelines,
    };

    if (description !== undefined) {
        system.description = description;
    }

    const compiled = compileDesignSystem(system);

    return {
        ...system,
        problems: report.done(),
        ...(report.notes.length === 0 ? {} : { notes: report.notes }),
        compiled,
    };
}
