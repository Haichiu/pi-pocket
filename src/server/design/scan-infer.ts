/**
 * The inference of the design system scan (stream T): turns the facts about a project into a DTCG draft. It keeps the
 * project's own variables (named by what they hold), decides the color roles, names a palette by hue and lightness, and
 * reads the type scale, the spacing scale, the radii, the shadows, and the motion from how the project uses them. The
 * draft is run through the tokens engine, and any token it rejects is dropped, so the result always loads.
 */
import { px } from "./scan-parse.ts";
import { contrastRatio, parseColor, toHex } from "./color.ts";
import {
    chooseRoles,
    type ColorEntry,
    distance,
    entryOf,
    merge as mergeFact,
    mergeColors,
    nearColors,
    paletteName,
    ROLE_PATHS,
    type RoleChoice,
    type RoleName,
} from "./scan-colors.ts";
import { type Category, type Facts } from "./scan-facts.ts";
import {
    Book,
    breakpointScale,
    detailScales,
    type Draft,
    fontScale,
    type Inferred,
    motionScale,
    radiusScale,
    shadowScale,
    sizeScale,
    spacingScale,
    topBy,
} from "./scan-scales.ts";
import { buildSystem } from "./tokens-model.ts";
import { kebab, type Obj, slug, vkey, w } from "./scan-util.ts";
import { type Variable } from "./scan-variables.ts";
import { assemble, dropTypes, hoistTypes, nameOf, nodeFor, pathOf, rewrite } from "./scan-tree.ts";
import {
    type Classified,
    pageIsDark,
    prepare,
    resolveDeferred,
    useDefaultColors,
    weighClassRules,
} from "./scan-prepare.ts";

export type { Draft, Inferred };

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
    if (facts.vars.some((fact) => fact.scope === "light") && pageIsDark(prep, facts)) {
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
    weighClassRules(facts);

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

    // A status color that the other mode names (`--success` set in the dark scope only) tells which color of this mode is the
    // status: the used color of its hue.
    const hints: Partial<Record<"danger" | "warning" | "success", number>> = {};

    if (prep.classified.some((entry) => entry.variable.dark !== undefined)) {
        const pairs = chooseRoles(darkColors, namedDark);

        for (const role of ["danger", "warning", "success"] as const) {
            const found = pairs[role];
            const color = found?.basis === "name" ? darkColors.get(found.hex) : undefined;

            if (color !== undefined) {
                hints[role] = color.h;
            }
        }
    }

    const lightRoles = chooseRoles(lightColors, namedLight, hints);

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

    // A class that has a color in each mode (`.text-gray-900` and `.dark .text-gray-900`) pairs the two: the dark color of
    // the role's class is the role's dark color.
    if (result.hasDark) {
        const kindOf: Partial<Record<RoleName, "bg" | "text" | "border">> = {
            background: "bg",
            surface: "bg",
            text: "text",
            muted: "text",
            border: "border",
            accent: "text",
        };

        for (const [role, choice] of Object.entries(lightRoles) as [RoleName, RoleChoice][]) {
            const kind = kindOf[role];
            const pair = [...facts.classRules.values()].find(
                (rule) =>
                    rule.kind === kind &&
                    rule.light !== undefined &&
                    rule.dark !== undefined &&
                    rule.light === choice.hex &&
                    rule.dark !== choice.hex,
            );

            if (pair !== undefined && darkRoles[role]?.basis !== "name") {
                darkRoles[role] = {
                    role,
                    hex: pair.dark!,
                    basis: "use",
                    source: "the same class in the dark mode",
                    score: choice.score,
                };
            }
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

        const fact = source?.variable.light;
        const at =
            light.basis === "name"
                ? fact === undefined
                    ? undefined
                    : `${fact.file}${fact.line === undefined ? "" : `:${fact.line}`}`
                : lightColors.get(light.hex)?.fact?.at;

        result.roles[role] = {
            token: path.join("."),
            value: light.hex,
            ...(dark !== undefined && dark.hex !== light.hex ? { dark: dark.hex } : {}),
            basis: light.basis,
            source: light.source,
            // A name that says the role is sure; the way a color is used is a guess, the less so the weaker the sign.
            confidence:
                light.basis === "name"
                    ? light.score >= 85
                        ? "high"
                        : "medium"
                    : light.score >= 40
                      ? "medium"
                      : "low",
            ...(at === undefined ? {} : { at }),
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
    const candidates = [...lightColors.values()].filter(
        (entry) =>
            !hexPath.has(entry.hex) &&
            !changing.has(entry.hex) &&
            entry.rgba.a > 0.05 &&
            entry.uses >= 1 &&
            known.every((other) => !nearColors(other, entry)),
    );
    // A color used twice or more is part of the design. One used once is a one-off (a gradient stop, a chart, a badge):
    // a small palette keeps it, a large one has no room for it.
    const repeated = candidates.filter((entry) => entry.uses >= 2);
    // A dark-first project's own colors are the dark mode's: its one-offs are not part of the palette of the other mode.
    const room =
        alt === "light" ? 0 : Math.max(0, 14 - hexPath.size - changing.size - repeated.length);
    const singles: ColorEntry[] = [];

    // A one-off that is a step from a color the design has (a hover shade of the brand) is that color, not a new one.
    for (const entry of candidates.filter((each) => each.uses < 2)) {
        if (
            singles.length < room &&
            [...known, ...repeated, ...singles].every((other) => distance(other, entry) > 0.025)
        ) {
            singles.push(entry);
        }
    }

    const extra = topBy([...repeated, ...singles], (entry) => entry.uses, 16);

    for (const entry of extra) {
        palette(entry.hex, asValue(entry.hex, lightColors));
    }

    // The rest of the project's own color variables, under their own names, as aliases of the palette.
    const roleNames = new Set([...roleVars].map(kebab));
    // A Sass variable that a custom property is set from (`--bg: #{$dark-bg}`) is that property: one token, not two.
    const sources = new Set(
        colorVars
            .flatMap((entry) =>
                (entry.variable.kind === "css" || entry.variable.kind === "theme"
                    ? [entry.via, entry.darkVia]
                    : []
                ).filter(
                    (through): through is Variable =>
                        through !== undefined &&
                        (through.kind === "scss" || through.kind === "less"),
                ),
            )
            .map((through) => vkey(through)),
    );
    const rest = classified.filter(
        (entry) =>
            entry.category === "color" &&
            !scaleVars.has(entry) &&
            !sources.has(vkey(entry.variable)) &&
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
        const darkHex = hexOf(entry.darkColor);

        // A dark-first project keeps the colors that change as they are in the default mode, as the roles are (the light
        // mode's file changes them), so its palette has no dark-only primitive.
        if (alt === "light" && target === undefined && darkHex !== undefined && darkHex !== hex) {
            changing.add(hex);
            book.add(path, { $value: asValue(hex, lightColors), $type: "color" });
        } else {
            const primitive = target ?? palette(hex, asValue(hex, lightColors));

            book.add(path, { $value: `{${primitive.join(".")}}`, $type: "color" });
        }

        lightHexOf.set(path.join("."), hex);
        aliasOf.set(vkey(entry.variable), path);

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

            // A second variable with no name of its own (`--gap` beside `$space`) keeps its own name.
            if (book.has(path)) {
                path = [path[0]!, slug(kebab(entry.variable.name))];
            }
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
