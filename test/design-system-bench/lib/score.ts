import { colorOf, sameColor, type Rgba } from "./color.ts";
import {
    families,
    flatten,
    pixels,
    shadowLayers,
    type FlatSystem,
    type FlatToken,
    type ShadowLayer,
} from "./dtcg.ts";

export const COLOR_TOLERANCE = 2;
export const ALPHA_TOLERANCE = 0.02;
/** Two pixel sizes are the same when they differ by at most this (type sizes may be 0.5 px apart in `rem` rounding). */
export const SIZE_TOLERANCE = 0.26;

export const ROLES = [
    "bg",
    "surface",
    "text",
    "muted",
    "border",
    "accent",
    "danger",
    "warning",
    "success",
] as const;
export type Role = (typeof ROLES)[number];

export interface Expected {
    name: string;
    description?: string;
    colors: (string | { value: string; near?: string[] })[];
    darkColors?: (string | { value: string; near?: string[] })[];
    roles: Partial<Record<Role, { light: string | string[]; dark?: string | string[] }>>;
    typeScale: (number | { value: number; near?: number[] })[];
    spacing: (number | { value: number; near?: number[] })[];
    spacingBase?: number;
    radii: (number | { value: number; near?: number[] })[];
    shadows: string[];
    fonts: string[];
    dark: { present: boolean };
}

export interface Extracted {
    colors: Rgba[];
    darkColors: Rgba[];
    roles: Partial<
        Record<Role, { token: string; light?: Rgba; dark?: Rgba; darkChanged: boolean }>
    >;
    typeScale: number[];
    spacing: number[];
    spacingBase?: number;
    radii: number[];
    shadows: ShadowLayer[][];
    fonts: string[];
    darkPresent: boolean;
}

export interface PRF {
    expected: number;
    actual: number;
    matched: number;
    precision: number;
    recall: number;
    f1: number;
    /** False when both sides are empty: nothing was asked and nothing was claimed. */
    applicable: boolean;
}

export function prf(expected: number, actual: number, matched: number, credit = 0): PRF {
    if (expected === 0 && actual === 0) {
        return { expected, actual, matched, precision: 1, recall: 1, f1: 1, applicable: false };
    }

    // Claiming nothing is never wrong, so precision is 1; recall then says what was missed. `credit` adds to recall only.
    const precision = actual === 0 ? 1 : matched / actual;
    const recall = expected === 0 ? 1 : (matched + credit) / expected;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    return { expected, actual, matched, precision, recall, f1, applicable: true };
}

export function maxMatching<E, A>(
    expected: E[],
    actual: A[],
    fits: (entry: E, item: A) => boolean,
): number {
    const owner: number[] = Array.from({ length: actual.length }, () => -1);

    const augment = (entry: number, seen: boolean[]): boolean => {
        for (let item = 0; item < actual.length; item++) {
            if (seen[item] || !fits(expected[entry]!, actual[item]!)) {
                continue;
            }

            seen[item] = true;

            if (owner[item] === -1 || augment(owner[item]!, seen)) {
                owner[item] = entry;

                return true;
            }
        }

        return false;
    };

    let matched = 0;

    for (let entry = 0; entry < expected.length; entry++) {
        if (
            augment(
                entry,
                Array.from({ length: actual.length }, () => false),
            )
        ) {
            matched++;
        }
    }

    return matched;
}

function fitsColor(accept: string[], color: Rgba): boolean {
    return accept.some((text) => {
        const wanted = colorOf(text);

        return wanted !== undefined && sameColor(wanted, color, COLOR_TOLERANCE, ALPHA_TOLERANCE);
    });
}

export function scoreColors(expected: Expected["colors"], actual: Rgba[]): PRF {
    const entries = expected.map((entry) =>
        typeof entry === "string" ? [entry] : [entry.value, ...(entry.near ?? [])],
    );

    return prf(
        entries.length,
        actual.length,
        maxMatching(entries, actual, (accept, color) => fitsColor(accept, color)),
    );
}

export function scoreSizes(
    expected: (number | { value: number; near?: number[] })[],
    actual: number[],
    extra: number[] = [],
): PRF {
    const entries = expected.map((entry) =>
        typeof entry === "number" ? [entry] : [entry.value, ...(entry.near ?? [])],
    );
    const fits = (accept: number[], size: number) =>
        accept.some((value) => Math.abs(value - size) <= SIZE_TOLERANCE);
    const real = maxMatching(entries, actual, fits);
    // A base unit's implied steps can fill an expected size that the scan did not list, but are never counted against it.
    const claimed = entries.filter((accept) => !actual.some((size) => fits(accept, size)));
    const implied = claimed.filter((accept) => extra.some((size) => fits(accept, size))).length;

    return prf(entries.length, actual.length, real, implied);
}

const sameLayer = (first: ShadowLayer, second: ShadowLayer) =>
    first.inset === second.inset &&
    Math.abs(first.x - second.x) <= 0.5 &&
    Math.abs(first.y - second.y) <= 0.5 &&
    Math.abs(first.blur - second.blur) <= 1 &&
    Math.abs(first.spread - second.spread) <= 0.5 &&
    sameColor(first.color, second.color, 4, 0.04);

export function scoreShadows(expected: string[], actual: ShadowLayer[][]): PRF {
    const wanted = expected.map((text) => shadowLayers(text));

    return prf(
        wanted.length,
        actual.length,
        maxMatching(
            wanted,
            actual,
            (layers, found) =>
                layers.length === found.length &&
                layers.every((layer, index) => sameLayer(layer, found[index]!)),
        ),
    );
}

export function scoreFonts(expected: string[], actual: string[]): PRF {
    const lower = (list: string[]) => list.map((name) => name.toLowerCase());

    return prf(
        expected.length,
        actual.length,
        maxMatching(lower(expected), lower(actual), (a, b) => a === b),
    );
}

const ROLE_WORDS: Record<Role, string[]> = {
    bg: ["bg", "background", "canvas", "page", "app"],
    surface: ["surface", "card", "panel", "elevated", "raised", "popover", "layer"],
    text: ["text", "fg", "foreground", "ink", "content", "copy"],
    muted: ["muted", "subtle", "secondary", "dim", "faint", "quiet", "tertiary", "subdued"],
    border: ["border", "divider", "outline", "stroke", "line", "separator", "hairline"],
    accent: ["accent", "brand"],
    danger: ["danger", "error", "destructive", "critical", "negative"],
    warning: ["warning", "warn", "caution"],
    success: ["success", "positive", "valid", "confirm"],
};
const WEAK_ACCENT = ["primary", "link", "action", "interactive", "highlight"];
const IGNORED = new Set([
    "color",
    "colors",
    "colour",
    "clr",
    "semantic",
    "sys",
    "ref",
    "theme",
    "default",
    "base",
    "main",
    "root",
    "light",
    "dark",
    "alias",
]);
const PRIORITY: Role[] = [
    "danger",
    "warning",
    "success",
    "border",
    "muted",
    "accent",
    "surface",
    "text",
    "bg",
];
const KNOWN = new Set([...Object.values(ROLE_WORDS).flat(), ...WEAK_ACCENT, ...IGNORED]);

export function words(path: string[]): string[] {
    return path
        .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s\-_]+/))
        .map((word) => word.toLowerCase())
        .filter((word) => word !== "");
}

export function roleOf(path: string[]): Role | undefined {
    const all = words(path);
    const found = new Set<Role>();

    for (const role of ROLES) {
        if (ROLE_WORDS[role].some((word) => all.includes(word))) {
            found.add(role);
        }
    }

    if (found.size === 0 && WEAK_ACCENT.some((word) => all.includes(word))) {
        found.add("accent");
    }

    if (found.size === 0) {
        return undefined;
    }

    // "Text on a color" (`primary-foreground`, `danger.text`, `on-accent`, `text.inverse`) is a pair token, not a role:
    // a word that names a colored thing, followed later by a text word.
    const textAt = all.flatMap((word, index) => (ROLE_WORDS.text.includes(word) ? [index] : []));
    const carrierWords = [
        ...ROLE_WORDS.accent,
        ...WEAK_ACCENT,
        ...ROLE_WORDS.danger,
        ...ROLE_WORDS.warning,
        ...ROLE_WORDS.success,
        ...ROLE_WORDS.surface,
    ];
    const carrierAt = all.flatMap((word, index) => (carrierWords.includes(word) ? [index] : []));

    if (
        all.some((word) => ["on", "inverse"].includes(word)) ||
        carrierAt.some((at) => textAt.some((text) => text > at))
    ) {
        return undefined;
    }

    // "Muted" next to a fill word names a fill (`bg.subtle`), not muted text.
    if (
        found.has("muted") &&
        !found.has("text") &&
        (found.has("bg") || found.has("surface") || found.has("border"))
    ) {
        found.delete("muted");
    }

    return PRIORITY.find((role) => found.has(role));
}

const CANON: Record<Role, string[]> = {
    bg: ["bg", "background"],
    surface: ["surface"],
    text: ["text", "foreground"],
    muted: ["muted"],
    border: ["border"],
    accent: ["accent", "primary", "brand"],
    danger: ["danger", "error"],
    warning: ["warning"],
    success: ["success"],
};

// [not the role's own word, words that are no role word, path length]: the nearest name is the role's token.
function distance(path: string[], role: Role): [number, number, number] {
    const all = words(path);

    return [
        CANON[role].some((word) => all.includes(word)) ? 0 : 1,
        all.filter((word) => !KNOWN.has(word)).length,
        path.length,
    ];
}

// A dark-first project may keep its dark values in `tokens.json`: the mode names say which is which.
export function themeModes(system: FlatSystem): { light: string; dark: string | undefined } {
    const others = system.modes.slice(1);
    const dark = others.find((mode) => /dark|night/i.test(mode));

    if (dark !== undefined) {
        return { light: "default", dark };
    }

    const light = others.find((mode) => /^(light|day)$/i.test(mode));

    if (light !== undefined) {
        return { light, dark: "default" };
    }

    return { light: "default", dark: others.length === 1 ? others[0] : undefined };
}

const colorEquals = (first: unknown, second: unknown) => {
    const [a, b] = [colorOf(first), colorOf(second)];

    return a !== undefined && b !== undefined && sameColor(a, b, 0.5, ALPHA_TOLERANCE);
};

function dimensions(system: FlatSystem, include: string[], exclude: string[]): FlatToken[] {
    return system.tokens.filter((token) => {
        if (token.type !== "dimension" && token.type !== "number") {
            return false;
        }

        const all = words(token.path);

        return (
            include.some((word) => all.includes(word)) &&
            !exclude.some((word) => all.includes(word))
        );
    });
}

const LEADING = ["line", "leading", "tracking", "letter", "weight", "height", "width", "lh"];
const NOT_TYPE = [
    "space",
    "spacing",
    "gap",
    "radius",
    "radii",
    "rounded",
    "corner",
    "shadow",
    "border",
    "breakpoint",
    "screen",
    "z",
    "index",
    ...LEADING,
];

export function extract(system: FlatSystem): Extracted {
    const { light: lightKey, dark } = themeModes(system);
    const colorTokens = system.tokens.filter((token) => token.type === "color");
    const colors: Rgba[] = [];
    const darkColors: Rgba[] = [];

    const addUnique = (list: Rgba[], color: Rgba | undefined) => {
        if (color !== undefined && !list.some((item) => sameColor(item, color, 0.5, 0.01))) {
            list.push(color);
        }
    };

    for (const token of colorTokens) {
        const light = colorOf(token.values[lightKey]);

        addUnique(colors, light);

        if (
            dark !== undefined &&
            token.values[dark] !== undefined &&
            !colorEquals(token.values[lightKey], token.values[dark])
        ) {
            addUnique(darkColors, colorOf(token.values[dark]));
        }
    }

    const roles: Extracted["roles"] = {};

    for (const role of ROLES) {
        const candidates = colorTokens
            .map((token, order) => ({ token, order, role: roleOf(token.path) }))
            .filter(
                (item) => item.role === role && colorOf(item.token.values[lightKey]) !== undefined,
            );

        candidates.sort((a, b) => {
            const [da, db] = [distance(a.token.path, role), distance(b.token.path, role)];

            return da[0] - db[0] || da[1] - db[1] || da[2] - db[2] || a.order - b.order;
        });

        const pick = candidates[0]?.token;

        if (pick !== undefined) {
            roles[role] = {
                token: pick.name,
                light: colorOf(pick.values[lightKey]),
                dark: dark === undefined ? undefined : colorOf(pick.values[dark]),
                darkChanged:
                    dark !== undefined &&
                    pick.values[dark] !== undefined &&
                    !colorEquals(pick.values[lightKey], pick.values[dark]),
            };
        }
    }

    const typeSizes: number[] = [];

    for (const token of dimensions(
        system,
        ["font", "text", "type", "typography", "fs", "fontsize", "size"],
        NOT_TYPE,
    )) {
        const all = words(token.path);

        // A bare `size` group is for icons and boxes: it needs a type word beside it.
        if (
            all.includes("size") &&
            !all.some((word) => ["font", "text", "type", "typography", "fs"].includes(word))
        ) {
            continue;
        }

        const size = pixels(token.values[lightKey]);

        if (size !== undefined) {
            typeSizes.push(size);
        }
    }

    for (const token of system.tokens.filter((item) => item.type === "typography")) {
        const size = pixels(
            (token.values[lightKey] as { fontSize?: unknown } | undefined)?.fontSize,
        );

        if (size !== undefined) {
            typeSizes.push(size);
        }
    }

    // Zero is "none", not a step of a scale.
    const uniqueSizes = (list: number[]) =>
        [...new Set(list.map((value) => Math.round(value * 100) / 100))].filter(
            (value) => value > 0,
        );
    const spacingTokens = dimensions(
        system,
        ["space", "spacing", "spacer", "gap", "inset", "pad", "padding", "margin", "unit"],
        ["font", "text", "radius", "radii", "shadow", "breakpoint", "screen", "line", "leading"],
    );
    const spacing: number[] = [];
    let spacingBase: number | undefined;

    for (const token of spacingTokens) {
        const size = pixels(token.values[lightKey]);

        if (size === undefined) {
            continue;
        }

        const all = words(token.path);
        const last = all.at(-1);

        if (token.path.length === 1 || last === "base" || last === "unit") {
            spacingBase ??= size;
        }

        spacing.push(size);
    }

    const radii = dimensions(system, ["radius", "radii", "rounded", "corner"], []).flatMap(
        (token) => pixels(token.values[lightKey]) ?? [],
    );
    const shadows = system.tokens
        .filter(
            (token) =>
                token.type === "shadow" ||
                (words(token.path).some((word) => ["shadow", "elevation"].includes(word)) &&
                    token.type !== "color"),
        )
        .map((token) => shadowLayers(token.values[lightKey]))
        .filter((layers) => layers.length > 0);
    const fonts = [
        ...new Set(
            system.tokens
                .filter(
                    (token) =>
                        token.type === "fontFamily" ||
                        (token.type === "string" && words(token.path).includes("family")),
                )
                .flatMap((token) => families(token.values[lightKey]).slice(0, 1))
                .concat(
                    system.tokens
                        .filter((token) => token.type === "typography")
                        .flatMap((token) =>
                            families(
                                (token.values[lightKey] as { fontFamily?: unknown } | undefined)
                                    ?.fontFamily,
                            ).slice(0, 1),
                        ),
                )
                .map((name) => name.toLowerCase()),
        ),
    ];

    return {
        colors,
        darkColors,
        roles,
        typeScale: uniqueSizes(typeSizes),
        spacing: uniqueSizes(spacing),
        spacingBase,
        radii: uniqueSizes(radii),
        shadows: dedupeShadows(shadows),
        fonts,
        darkPresent:
            dark !== undefined &&
            darkColors.length + Object.values(roles).filter((role) => role.darkChanged).length > 0,
    };
}

function dedupeShadows(list: ShadowLayer[][]): ShadowLayer[][] {
    const unique: ShadowLayer[][] = [];

    for (const layers of list) {
        if (
            !unique.some(
                (item) =>
                    item.length === layers.length &&
                    item.every((layer, index) => sameLayer(layer, layers[index]!)),
            )
        ) {
            unique.push(layers);
        }
    }

    return unique;
}

export const IMPLIED_STEPS = [
    0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
];

export interface ScanScore {
    colors: PRF;
    darkColors: PRF;
    roles: PRF;
    darkRoles: PRF;
    typeScale: PRF;
    spacing: PRF;
    radii: PRF;
    shadows: PRF;
    fonts: PRF;
    roleDetail: { right: Role[]; wrong: Role[]; missed: Role[] };
    darkDetected: boolean;
    darkExpected: boolean;
}

export function scoreScan(expected: Expected, found: Extracted): ScanScore {
    const right: Role[] = [];
    const wrong: Role[] = [];
    const missed: Role[] = [];
    let darkExpected = 0;
    let darkClaimed = 0;
    let darkRight = 0;

    for (const role of ROLES) {
        const want = expected.roles[role];
        const have = found.roles[role];
        const accept = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

        if (have?.darkChanged === true) {
            darkClaimed++;
        }

        if (want?.dark !== undefined) {
            darkExpected++;

            // A dark value counts only when the scan says the dark theme differs: precision is right over claimed.
            if (
                have?.darkChanged === true &&
                have.dark !== undefined &&
                fitsColor(accept(want.dark), have.dark)
            ) {
                darkRight++;
            }
        }

        if (want === undefined) {
            if (have !== undefined) {
                wrong.push(role);
            }

            continue;
        }

        if (have?.light === undefined) {
            missed.push(role);
        } else if (fitsColor(accept(want.light), have.light)) {
            right.push(role);
        } else {
            wrong.push(role);
        }
    }

    const expectedRoles = Object.keys(expected.roles).length;
    const claimed = Object.keys(found.roles).length;
    const sizes =
        found.spacingBase === undefined
            ? []
            : IMPLIED_STEPS.map((step) => step * found.spacingBase!);

    return {
        colors: scoreColors(expected.colors, found.colors),
        darkColors: scoreColors(expected.darkColors ?? [], found.darkColors),
        roles: prf(expectedRoles, claimed, right.length),
        darkRoles: prf(darkExpected, darkClaimed, darkRight),
        typeScale: scoreSizes(expected.typeScale, found.typeScale),
        spacing: scoreSizes(expected.spacing, found.spacing, sizes),
        radii: scoreSizes(expected.radii, found.radii),
        shadows: scoreShadows(expected.shadows, found.shadows),
        fonts: scoreFonts(expected.fonts, found.fonts),
        roleDetail: { right, wrong, missed },
        darkDetected: found.darkPresent,
        darkExpected: expected.dark.present,
    };
}

export function scoreDraft(
    expected: Expected,
    draft: { tokens: unknown; modes?: Record<string, unknown> },
): ScanScore & { problems: string[] } {
    const system = flatten(draft.tokens, draft.modes ?? {});

    return { ...scoreScan(expected, extract(system)), problems: system.problems };
}

export const SCAN_CATEGORIES = {
    colors: 0.9,
    roles: 0.9,
    typeScale: 0.85,
    spacing: 0.85,
    radii: 0.85,
    darkColors: 0.85,
    darkRoles: 0.85,
    shadows: 0.85,
    fonts: 0.85,
} as const;

export type ScanCategory = keyof typeof SCAN_CATEGORIES;

export function aggregateScans(
    scores: ScanScore[],
): Record<ScanCategory, PRF & { fixtures: number }> {
    const out = {} as Record<ScanCategory, PRF & { fixtures: number }>;

    for (const category of Object.keys(SCAN_CATEGORIES) as ScanCategory[]) {
        const applicable = scores.map((score) => score[category]).filter((item) => item.applicable);
        const mean = (pick: (item: PRF) => number) =>
            applicable.length === 0
                ? 0
                : applicable.reduce((sum, item) => sum + pick(item), 0) / applicable.length;

        out[category] = {
            expected: applicable.reduce((sum, item) => sum + item.expected, 0),
            actual: applicable.reduce((sum, item) => sum + item.actual, 0),
            matched: applicable.reduce((sum, item) => sum + item.matched, 0),
            precision: mean((item) => item.precision),
            recall: mean((item) => item.recall),
            f1: mean((item) => item.f1),
            applicable: applicable.length > 0,
            fixtures: applicable.length,
        };
    }

    return out;
}
