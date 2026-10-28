/**
 * The color roles of the scan (stream T): the colors that the project's variables hold and the literal colors it uses,
 * merged for each mode, and the role (page, surface, text, muted, border, accent, and the statuses) that each mode picks.
 */
import {
    chooseRoles,
    type ColorEntry,
    entryOf,
    merge as mergeFact,
    mergeColors,
    type RoleChoice,
    type RoleName,
} from "./scan-colors.ts";
import { type Facts } from "./scan-facts.ts";
import {
    type Classified,
    type Prepared,
    useDefaultColors,
    weighClassRules,
} from "./scan-prepare.ts";
import { type Book, type Inferred } from "./scan-scales.ts";
import { hexOf } from "./scan-util.ts";
import { type Variable } from "./scan-variables.ts";

/** What the phases of the inference share: the facts, the classified variables, the draft that grows, and the result. */
export interface InferContext {
    facts: Facts;
    prep: Prepared;
    classified: Classified[];
    alt: "dark" | "light";
    result: Inferred;
    book: Book;
    aliasOf: Map<string, string[]>;
    uses: (variable: Variable) => number;
}

/** The colors and roles of each mode, for the palette. */
export interface ColorRoles {
    lightColors: Map<string, ColorEntry>;
    darkColors: Map<string, ColorEntry>;
    lightRoles: Partial<Record<RoleName, RoleChoice>>;
    darkRoles: Partial<Record<RoleName, RoleChoice>>;
}

export function chooseColorRoles(context: InferContext): ColorRoles {
    const { facts, prep, classified, alt, result, uses } = context;
    const colorVars = classified.filter((entry) => entry.category === "color");

    // 2. Colors: the variables' values and the literal uses, merged; then the roles.
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

    return { lightColors, darkColors, lightRoles, darkRoles };
}
