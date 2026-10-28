// The System view's model, as pure functions (no DOM, so a test can run them): which section a token belongs to, how the
// tokens group, the value a token has once the person's unsaved edits are laid over the saved ones (aliases followed), the
// contrast of a text color, the history of edits (undo and redo), and the change a save sends. The system is data from the
// project's files: every value read here is checked before it is used.
import { contrast, grade, parseColor, swatchCss, toHex, writeColor } from "./color.js";

/** The sections of the view, in order. `Other` shows only when something is in it. */
export const SECTIONS = [
    { id: "colors", label: "Colors" },
    { id: "type", label: "Type" },
    { id: "spacing", label: "Spacing" },
    { id: "radii", label: "Radii" },
    { id: "shadows", label: "Shadows" },
    { id: "motion", label: "Motion" },
    { id: "other", label: "Other" },
    { id: "components", label: "Components" },
    { id: "guidelines", label: "Guidelines" },
];

const HINTS = [
    ["type", /^(font|type|text|typography|line|leading|letter|tracking)$/],
    ["spacing", /^(space|spacing|gap|size|sizes|padding|margin|inset|stack|layout)$/],
    ["radii", /^(radius|radii|round|rounded|corner|corners)$/],
    ["motion", /^(motion|duration|delay|ease|easing|transition|timing)$/],
];

/** The section of a token: by its type, and for plain numbers and sizes by the words of its name. */
export function sectionOf(token) {
    switch (token.type) {
        case "color":
        case "gradient":
            return "colors";
        case "fontFamily":
        case "fontWeight":
        case "typography":
            return "type";
        case "shadow":
            return "shadows";
        case "duration":
        case "cubicBezier":
        case "transition":
            return "motion";
        case "dimension":

        case "number": {
            for (const part of token.path) {
                const hint = HINTS.find(([, pattern]) => pattern.test(part.toLowerCase()));

                if (hint) {
                    return hint[0];
                }
            }

            return "other";
        }

        default:
            return "other";
    }
}

const title = (text) =>
    text === "" ? "" : text[0].toUpperCase() + text.slice(1).replace(/[-_]+/g, " ");

/** The tokens of a section, in groups the view shows one after another. A color group is `roles` or a `palette`. */
export function groupsOf(tokens, section, defaultMode) {
    const mine = tokens.filter((token) => sectionOf(token) === section);
    const groups = new Map();

    const add = (id, name, kind, token) => {
        if (!groups.has(id)) {
            groups.set(id, { id, title: name, kind, tokens: [] });
        }

        groups.get(id).tokens.push(token);
    };

    for (const token of mine) {
        if (section === "colors") {
            const own = token.path.length >= 3 ? token.path[1] : token.path[0];
            const aliased = token.modes[defaultMode]?.alias !== undefined;

            add(
                `color:${own}`,
                title(token.path.length >= 3 ? token.path[1] : "Base"),
                aliased ? "roles" : "palette",
                token,
            );

            // A group with any reference in it is made of roles; one with only raw values is a palette.
            if (aliased) {
                groups.get(`color:${own}`).kind = "roles";
            }
        } else if (section === "type") {
            const by = {
                typography: ["styles", "Styles"],
                fontFamily: ["families", "Families"],
                fontWeight: ["weights", "Weights"],
            }[token.type];
            const sub =
                by ?? (token.type === "number" ? ["leading", "Line height"] : ["sizes", "Sizes"]);

            add(`type:${sub[0]}`, sub[1], "type", token);
        } else if (section === "motion") {
            const by =
                token.type === "duration"
                    ? ["durations", "Durations"]
                    : token.type === "cubicBezier"
                      ? ["easing", "Easing"]
                      : ["transitions", "Transitions"];

            add(`motion:${by[0]}`, by[1], "motion", token);
        } else if (section === "other") {
            add(`other:${token.path[0]}`, title(token.path[0]), "other", token);
        } else {
            add(`${section}:all`, "", section, token);
        }
    }

    const list = [...groups.values()];

    // What people edit (roles) first, the raw palette after it.
    return section === "colors"
        ? [
              ...list.filter((each) => each.kind === "roles"),
              ...list.filter((each) => each.kind !== "roles"),
          ]
        : list;
}

/** Whether a token matches what was typed in the search: its name, description, or any value. */
export function matches(token, query) {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return true;
    }

    const text = [
        token.name,
        token.description ?? "",
        ...Object.values(token.modes).flatMap((mode) => [
            mode.css,
            mode.alias ?? "",
            showValue(token, mode),
        ]),
    ]
        .join(" ")
        .toLowerCase();

    return words.every((word) => text.includes(word));
}

// ─── Values ──────────────────────────────────────────────────────────────

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** `{ n, unit }` from a dimension or a duration in either dialect (`{ value, unit }` or `"16px"`), or null. */
export function amountOf(value) {
    if (isObject(value)) {
        return number(value.value) !== undefined && typeof value.unit === "string"
            ? { n: value.value, unit: value.unit }
            : null;
    }

    const match =
        typeof value === "string"
            ? /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i.exec(value)
            : null;

    return match ? { n: Number(match[1]), unit: match[2] } : null;
}

/** An amount written in the dialect of `like` (the object form when `like` is one, else text). */
export function writeAmount(amount, like) {
    const n = Math.round(amount.n * 10000) / 10000;

    return isObject(like) ? { value: n, unit: amount.unit } : `${n}${amount.unit}`;
}

/** Pixels in an amount, for drawing a bar or a corner (rem and em at 16); null when it has no size. */
export function pixelsOf(value) {
    const amount = amountOf(value);

    if (amount === null) {
        return null;
    }

    return amount.unit === "px" || amount.unit === ""
        ? amount.n
        : amount.unit === "rem" || amount.unit === "em"
          ? amount.n * 16
          : null;
}

/** Milliseconds in a duration; null when it has none. */
export function millisecondsOf(value) {
    const amount = amountOf(value);

    return amount === null
        ? null
        : amount.unit === "s"
          ? amount.n * 1000
          : amount.unit === "ms" || amount.unit === ""
            ? amount.n
            : null;
}

const family = (name) => (/^[\w-]+$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`);

/** The CSS of a value of a simple type, as the engine writes it. A type with no simple form gives `undefined`. */
export function cssOf(type, value) {
    switch (type) {
        case "color": {
            if (typeof value === "string") {
                return value;
            }

            const color = parseColor(value);

            return color === null ? undefined : toHex(color);
        }

        case "dimension":

        case "duration": {
            const amount = amountOf(value);

            return amount === null ? undefined : `${amount.n}${amount.unit}`;
        }

        case "number":
        case "fontWeight":
            return typeof value === "number" || typeof value === "string"
                ? String(value)
                : undefined;
        case "fontFamily":
            return Array.isArray(value)
                ? value.map((each) => family(String(each))).join(", ")
                : typeof value === "string"
                  ? family(value)
                  : undefined;
        case "cubicBezier":
            return Array.isArray(value) &&
                value.length === 4 &&
                value.every((each) => number(each) !== undefined)
                ? `cubic-bezier(${value.join(", ")})`
                : undefined;
        default:
            return undefined;
    }
}

/** The types that an editor can write whole: the others (a shadow, a typography style) are edited with Pi. */
export const EDITABLE = new Set([
    "color",
    "dimension",
    "duration",
    "number",
    "fontWeight",
    "fontFamily",
    "cubicBezier",
]);

/**
 * What a person typed for a token of `type`, as a value to write. `like` is the value it replaces: the new one keeps its
 * dialect (an object or text). Returns `{ value }`, or `{ error }` with words for the field.
 */
export function readInput(type, text, like) {
    const input = String(text ?? "").trim();

    if (input === "") {
        return { error: "Enter a value." };
    }

    switch (type) {
        case "color": {
            const color = parseColor(input);

            return color === null
                ? { error: "Not a color. Try #3b6cf6, rgb(59 108 246), or oklch(0.6 0.2 260)." }
                : { value: writeColor(color, like) };
        }

        case "dimension":

        case "duration": {
            const units = type === "dimension" ? ["px", "rem", "em", "%", "vw", "vh"] : ["ms", "s"];
            const amount = amountOf(input);
            const unit =
                amount?.unit === "" || amount === null
                    ? (amountOf(like)?.unit ?? units[0])
                    : amount.unit;

            if (amount === null) {
                return {
                    error:
                        type === "dimension"
                            ? "Enter a size, like 16 or 1.5rem."
                            : "Enter a time, like 200ms or 0.4s.",
                };
            }

            if (!units.includes(unit)) {
                return { error: `Use ${units.slice(0, 4).join(", ")}.` };
            }

            return { value: writeAmount({ n: amount.n, unit }, like) };
        }

        case "number": {
            const value = Number(input);

            return Number.isFinite(value) ? { value } : { error: "Enter a number." };
        }

        case "fontWeight": {
            const value = Number(input);

            return Number.isFinite(value) && value >= 1 && value <= 1000
                ? { value: Math.round(value) }
                : { error: "Use a weight from 1 to 1000, like 400." };
        }

        case "fontFamily": {
            const names = input
                .split(",")
                .map((each) => each.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean);

            if (
                names.length === 0 ||
                names.length > 12 ||
                names.some((each) => each.length > 80 || /[<>{};\\]/.test(each))
            ) {
                return { error: "List up to 12 font names, separated by commas." };
            }

            return { value: Array.isArray(like) || names.length > 1 ? names : names[0] };
        }

        case "cubicBezier": {
            const values = input
                .replace(/^cubic-bezier\(|\)$/g, "")
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number);

            return values.length === 4 &&
                values.every(Number.isFinite) &&
                values[0] >= 0 &&
                values[0] <= 1 &&
                values[2] >= 0 &&
                values[2] <= 1
                ? { value: values }
                : { error: "Four numbers. The first and third go from 0 to 1." };
        }

        default:
            return { error: "This kind of value is edited with Pi." };
    }
}

/** A value for people to read: `#3b6cf6`, `16px`, `120ms`, `600`, `Geist`, `0.2, 0, 0, 1`. */
export function showValue(token, mode) {
    const { value, css } = mode;

    switch (token.type) {
        case "color": {
            const color = parseColor(value);

            return color === null ? String(css ?? "") : toHex(color);
        }

        case "dimension":
        case "duration":
            return cssOf(token.type, value) ?? css ?? "";
        case "fontFamily":
            return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
        case "cubicBezier":
            return Array.isArray(value) ? value.join(", ") : "";
        case "typography":
        case "shadow":
        case "gradient":
        case "border":
        case "transition":
        case "strokeStyle":
            return String(css ?? "");
        default:
            return value === null || value === undefined ? "" : String(value);
    }
}

// ─── The model: saved values with the person's edits over them ───────────────

const keyOf = (mode, token) => `${mode}\u0000${token}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The raw value of a token in a mode, as it is saved: a reference or the value. */
const rawOf = (value) =>
    value.alias === undefined ? { value: value.value } : { alias: value.alias };

/**
 * The tokens of `system` with the edits of `edits` (a Map from an edit's key to `{ alias }` or `{ value }`) laid over them.
 * `value(name, mode)` is what a token has in a mode now: its value (aliases followed), its CSS, and whether it was edited.
 */
export function createModel(system, edits = new Map()) {
    const tokens = new Map(system.tokens.map((token) => [token.name, token]));
    const defaultMode = system.modes[0];
    const cache = new Map();

    /** The raw value a mode takes in the file: its own, or the default's when it has none of its own. */
    const savedRaw = (name, mode) => {
        const token = tokens.get(name);

        return token?.modes[mode] ? rawOf(token.modes[mode]) : undefined;
    };

    /** Whether a mode takes the default's value for a token, as far as the saved values can tell. */
    const inherits = (name, mode) =>
        mode !== defaultMode && same(savedRaw(name, mode), savedRaw(name, defaultMode));

    function resolve(name, mode, trail) {
        const token = tokens.get(name);
        const saved = token?.modes[mode];

        if (token === undefined || saved === undefined) {
            return { value: null, css: "", error: `No token ${name}.` };
        }

        if (trail.includes(name)) {
            return { value: null, css: "", error: `A loop: ${[...trail, name].join(" → ")}.` };
        }

        const own = edits.get(keyOf(mode, name));
        // A mode that takes the default's value follows an edit of the default.
        const edit =
            own ?? (inherits(name, mode) ? edits.get(keyOf(defaultMode, name)) : undefined);

        if (edit?.alias !== undefined) {
            const target = resolve(edit.alias, mode, [...trail, name]);

            return {
                value: target.value,
                css: `var(${tokens.get(edit.alias)?.cssVar ?? "--unknown"})`,
                alias: edit.alias,
                edited: true,
                ...(target.error ? { error: target.error } : {}),
            };
        }

        if (edit !== undefined) {
            return {
                value: edit.value,
                css: cssOf(token.type, edit.value) ?? saved.css,
                edited: true,
            };
        }

        if (saved.alias !== undefined) {
            const target = resolve(saved.alias, mode, [...trail, name]);

            return target.edited || target.error || target.derived
                ? {
                      ...saved,
                      value: target.value,
                      derived: true,
                      ...(target.error ? { error: target.error } : {}),
                  }
                : saved;
        }

        return saved;
    }

    let named;
    let byVar;

    const model = {
        /** The token that has the custom property `--name`. */
        byVar: (name) =>
            (byVar ??= new Map(system.tokens.map((token) => [token.cssVar, token]))).get(name),
        /** The color tokens that play each role (`roles`), found once for this model. */
        roles: () => (named ??= roles(model)),
        system,
        defaultMode,
        modes: system.modes,
        tokens: system.tokens,
        token: (name) => tokens.get(name),
        has: (name) => tokens.has(name),
        raw: savedRaw,
        /** What a token has in a mode now. */
        value(name, mode) {
            const key = keyOf(mode, name);

            if (!cache.has(key)) {
                cache.set(key, resolve(name, mode, []));
            }

            return cache.get(key);
        },
        /** Whether the person edited the token in this mode, or in the default mode that this one follows. */
        edited: (name, mode) => model.value(name, mode).edited === true,
        /** The tokens that refer to `name` (in any mode), by name. */
        dependents(name) {
            return system.tokens
                .filter((token) => Object.values(token.modes).some((each) => each.alias === name))
                .map((token) => token.name);
        },
        /** The names an alias chain goes through from `name` to a value: `[name, next, …]`. */
        chain(name, mode) {
            const out = [name];

            for (
                let step = model.value(name, mode);
                step.alias !== undefined && out.length < 12 && !out.includes(step.alias);
                step = model.value(step.alias, mode)
            ) {
                out.push(step.alias);
            }

            return out;
        },
        /** The tokens an alias for `name` may point to: the same type, and none that lead back to `name`. */
        targets(name) {
            const token = tokens.get(name);

            return system.tokens.filter(
                (each) =>
                    each.name !== name &&
                    each.type === token?.type &&
                    !model.reaches(each.name, name),
            );
        },
        /** Whether following aliases from `from` (in any mode) arrives at `to`. */
        reaches(from, to, seen = new Set()) {
            if (from === to) {
                return true;
            }

            if (seen.has(from)) {
                return false;
            }

            seen.add(from);

            const token = tokens.get(from);

            return Object.values(token?.modes ?? {}).some(
                (each) => each.alias !== undefined && model.reaches(each.alias, to, seen),
            );
        },
        /** The contrast of a text color on its pair, in a mode: declared by the token, or worked out for text roles. */
        contrastOf(name, mode) {
            const token = tokens.get(name);

            if (token?.type !== "color") {
                return null;
            }

            // The pair names its ground as a token's name, or as a reference to it (`{color.bg.surface}`).
            let pair =
                token.contrast === undefined
                    ? undefined
                    : { ...token.contrast, on: String(token.contrast.on).replace(/^\{|\}$/g, "") };
            let auto = false;

            if (pair === undefined) {
                const ground = isText(token) ? model.roles().canvas : undefined;

                if (ground === undefined || ground === name) {
                    return null;
                }

                pair = { on: ground, min: 4.5 };
                auto = true;
            }

            const ink = parseColor(model.value(name, mode).value);
            const ground = tokens.has(pair.on)
                ? parseColor(model.value(pair.on, mode).value)
                : null;

            return ink && ground
                ? { ...grade(contrast(ink, ground), pair.min), on: pair.on, auto }
                : null;
        },
    };

    return model;
}

/**
 * Whether a color token is body text that sits on the page: its group says text, and its own name says the plain kinds
 * (`primary`, `muted`, `link`). One that is `inverse`, `faint`, `disabled`, or `on-accent` sits on another ground, which only
 * its declared pair can say: nothing is worked out for it.
 */
const isText = (token) =>
    token.path
        .slice(0, -1)
        .some((part) => /^(text|fg|foreground|content|ink|label)$/i.test(part)) &&
    /^(primary|secondary|tertiary|muted|default|body|strong|link)$/i.test(token.path.at(-1) ?? "");

/** The words that name each role: the group a token is in (`text`), and its own name (`primary`), best first. */
const ROLES = {
    canvas: {
        group: ["bg", "background", "surface", "canvas", "color"],
        name: ["canvas", "page", "app", "background", "base", "body", "default"],
    },
    surface: {
        group: ["bg", "background", "surface", "color"],
        name: ["surface", "card", "panel", "container", "raised", "elevated"],
    },
    text: {
        group: ["text", "fg", "foreground", "content", "ink"],
        name: ["primary", "default", "base", "body", "strong", "main"],
    },
    muted: {
        group: ["text", "fg", "foreground", "content", "ink"],
        name: ["muted", "secondary", "subtle", "tertiary", "weak", "dim", "faint"],
    },
    accent: {
        group: ["accent", "primary", "brand", "action"],
        name: ["default", "base", "main", "500", "600"],
    },
    onAccent: {
        group: ["text", "fg", "foreground", "on", "content"],
        name: ["inverse", "on-accent", "onaccent"],
    },
    border: {
        group: ["border", "line", "outline", "divider", "stroke"],
        name: ["default", "base", "subtle", "muted"],
    },
    danger: {
        group: [
            "status",
            "state",
            "feedback",
            "semantic",
            "danger",
            "error",
            "negative",
            "destructive",
        ],
        name: ["danger", "error", "negative", "destructive", "critical", "default"],
    },
    success: {
        group: ["status", "state", "feedback", "semantic", "success", "positive", "ok"],
        name: ["success", "positive", "ok", "default"],
    },
    warning: {
        group: ["status", "state", "feedback", "semantic", "warning", "caution"],
        name: ["warning", "caution", "default"],
    },
};

/**
 * The color tokens that play each role (a page, a card, text, an accent, a border, the statuses), found by the last two
 * words of their names: `{ canvas: "color.bg.canvas", … }`. A role with no match is left out. The same names in every mode.
 */
export function roles(model) {
    const found = {};
    const colors = model.tokens.filter((token) => token.type === "color");

    for (const [role, words] of Object.entries(ROLES)) {
        let best;
        let top = 0;

        for (const token of colors) {
            const parts = token.path.map((part) => part.toLowerCase());
            const name = parts.at(-1) ?? "";
            const group = parts.length > 1 ? parts.at(-2) : "";
            const named = words.name.indexOf(name);
            const grouped = words.group.indexOf(group);

            // Both words must fit, and a hover or a disabled state is never the role.
            if (
                named === -1 ||
                grouped === -1 ||
                /(hover|active|pressed|disabled)/.test(token.name)
            ) {
                continue;
            }

            const score = 100 - named * 4 - grouped + (token.tier === "semantic" ? 2 : 0);

            if (score > top) {
                best = token.name;
                top = score;
            }
        }

        if (best !== undefined) {
            found[role] = best;
        }
    }

    return found;
}

// ─── Edits, undo, and redo ───────────────────────────────────────────────

/** An empty history: the edits made (`past`, oldest first) and the ones undone (`future`, the next redo last). */
export const emptyHistory = () => ({ past: [], future: [] });

const GUIDELINES = "guidelines";
/** Edits to one thing in a row, closer than this, make one step of undo (a color picker drag). */
const COALESCE_MS = 1200;

/** The key of an edit: a token in a mode, or the guidelines. */
export const editKey = (op) => (op.kind === "guidelines" ? GUIDELINES : keyOf(op.mode, op.token));

/** A token edit: `raw` is `{ alias }` or `{ value }`. */
export const tokenEdit = (mode, token, raw) => ({ kind: "token", mode, token, raw });

export const guidelinesEdit = (text) => ({ kind: "guidelines", text });

/** The steps of undo that are kept: past it, a step that a later one makes no difference to goes first. */
const MAX_STEPS = 500;

/**
 * The history after `op`: a step of its own, or (with `coalesce`) the same step again when it edits the thing the last one
 * did, a moment later.
 */
export function push(history, op, now = Date.now(), coalesce = true) {
    const last = history.past.at(-1);
    const again =
        coalesce &&
        last !== undefined &&
        editKey(last) === editKey(op) &&
        now - (last.at ?? 0) < COALESCE_MS;
    let past = [...(again ? history.past.slice(0, -1) : history.past), { ...op, at: now }];

    // A long session of edits keeps its newest steps: the first step whose thing a later one sets again is the one to go.
    if (past.length > MAX_STEPS) {
        const keys = past.map(editKey);
        const shadowed = keys.findIndex((key, at) => keys.indexOf(key, at + 1) !== -1);

        past = past.filter((_, at) => at !== (shadowed === -1 ? 0 : shadowed));
    }

    return { past, future: [] };
}

export function undo(history) {
    const last = history.past.at(-1);

    return last === undefined
        ? history
        : { past: history.past.slice(0, -1), future: [...history.future, last] };
}

export function redo(history) {
    const next = history.future.at(-1);

    return next === undefined
        ? history
        : { past: [...history.past, { ...next, at: 0 }], future: history.future.slice(0, -1) };
}

/** The edits now in force: the last one for each thing, as a Map from its key (a token's edits first, in order). */
export function editsOf(history) {
    const edits = new Map();

    for (const op of history.past) {
        edits.set(editKey(op), op);
    }

    return edits;
}

/** The map `createModel` takes: token edits only, by key. */
export function tokenEdits(history) {
    return new Map(
        [...editsOf(history)]
            .filter(([, op]) => op.kind === "token")
            .map(([key, op]) => [key, op.raw]),
    );
}

/**
 * The change to save, and how many things it changes. An edit that puts back what is saved changes nothing, and is left out.
 * `set` is in the order the edits were made.
 */
export function changeOf(system, history) {
    const model = createModel(system);
    const set = [];
    let guidelines;

    for (const [, op] of editsOf(history)) {
        if (op.kind === "guidelines") {
            if (op.text !== system.guidelines) {
                guidelines = op.text;
            }

            continue;
        }

        const saved = model.raw(op.token, op.mode);

        if (saved !== undefined && same(saved, op.raw)) {
            continue;
        }

        set.push({
            mode: op.mode,
            token: op.token,
            value: op.raw.alias === undefined ? op.raw.value : `{${op.raw.alias}}`,
        });
    }

    return {
        set,
        ...(guidelines === undefined ? {} : { guidelines }),
        count: set.length + (guidelines === undefined ? 0 : 1),
    };
}

// ─── The CSS for the page and the specimens ──────────────────────────────────

/** A CSS value that is safe to write inside a `<style>`: no markup, no block, no escape, no import or url. */
export function safeCss(value) {
    const text = String(value ?? "");

    return text.length <= 400 && !/[<>{};\\]|\/\*|url\(|@|expression\(|[\u0000-\u001f]/i.test(text)
        ? text
        : "";
}

/** A custom property that the artifact bridge takes: `--` and up to 78 letters, digits, `_`, `-`. */
export const bridgeName = (cssVar) => /^--[A-Za-z0-9_-]{1,78}$/.test(cssVar);

/** The custom properties of a mode as `[name, css]`, from what the tokens have now. */
export function varsOf(model, mode) {
    const out = [];

    for (const token of model.tokens) {
        const css = safeCss(model.value(token.name, mode).css);

        if (css !== "" && /^--[A-Za-z0-9_-]+$/.test(token.cssVar)) {
            out.push([token.cssVar, css]);
        }
    }

    return out;
}

/**
 * What the open design is told, to show `mode` with the edits, as `{ name: css }`: the custom properties that this mode
 * has other than the saved default's, and those that any mode sets other than the default, set to this mode's value (a
 * page that follows the system's dark setting by itself shows `mode` all the same). The bridge refuses a value past 200
 * characters, and a refused batch changes nothing, so a long one is left out.
 */
export function previewVars(model, mode) {
    const base = model.defaultMode;
    const out = {};

    for (const token of model.tokens) {
        const css = safeCss(model.value(token.name, mode).css);
        const varies = model.modes.some(
            (other) => token.modes[other]?.css !== token.modes[base]?.css,
        );

        if (
            css !== "" &&
            css.length <= 200 &&
            bridgeName(token.cssVar) &&
            (varies || css !== token.modes[base]?.css)
        ) {
            out[token.cssVar] = css;
        }
    }

    return out;
}

/** The `:root` block of a mode, for a specimen's page. */
export function themeCss(model, mode) {
    return `:root{${varsOf(model, mode)
        .map(([name, css]) => `${name}:${css}`)
        .join(";")}}`;
}

// ─── Specimens drawn from a resolved value ───────────────────────────────

/** The names of the app's own fonts, for the system's: a specimen in Geist shows in the font the app has. */
const FONTS = {
    geist: '"Pocket Sans", Geist',
    "jetbrains mono": '"Pocket Mono", "JetBrains Mono"',
};

/** A font stack with each family of the app's own put first of its pair: `Geist, serif` → `"Pocket Sans", Geist, serif`. */
export const fontStack = (css) =>
    css
        .split(",")
        .map((part) => {
            const name = part.trim().replace(/^["']|["']$/g, "");

            return FONTS[name.toLowerCase()] ?? part.trim();
        })
        .join(", ");

/** The style text of a resolved typography value (family, size, weight, line height, letter spacing), or "". */
export function typographyStyle(value) {
    if (!isObject(value)) {
        return "";
    }

    const parts = [];

    const add = (name, css) => {
        const safe = css === undefined ? "" : safeCss(css);

        if (safe !== "") {
            parts.push(`${name}:${safe}`);
        }
    };

    const family = cssOf("fontFamily", value.fontFamily);

    add("font-family", family === undefined ? undefined : fontStack(family));
    add("font-size", cssOf("dimension", value.fontSize));
    add(
        "font-weight",
        typeof value.fontWeight === "number" || typeof value.fontWeight === "string"
            ? String(value.fontWeight)
            : undefined,
    );
    add(
        "line-height",
        typeof value.lineHeight === "number"
            ? String(value.lineHeight)
            : cssOf("dimension", value.lineHeight),
    );
    add("letter-spacing", cssOf("dimension", value.letterSpacing));

    return parts.join(";");
}

/** The `box-shadow` of a resolved shadow value (one layer or a list), or "" when it has none that can be drawn. */
export function shadowOf(value) {
    const layers = Array.isArray(value) ? value : [value];
    const css = layers
        .map((layer) => {
            if (!isObject(layer)) {
                return "";
            }

            const color = swatchCss(layer.color);
            const sizes = ["offsetX", "offsetY", "blur", "spread"].map((key) =>
                cssOf("dimension", layer[key] ?? "0px"),
            );

            return color === "" || sizes.includes(undefined)
                ? ""
                : `${layer.inset === true ? "inset " : ""}${sizes.join(" ")} ${color}`;
        })
        .filter(Boolean)
        .join(", ");

    return safeCss(css);
}

/** How many things the unsaved edits change in `system` (a step that puts a value back changes nothing). */
export const unsavedCount = (system, history) => (system ? changeOf(system, history).count : 0);

// ─── A style made of parts that link to other tokens ──────────────────────────

const VAR = /var\((--[A-Za-z0-9_-]{1,78})\)/g;

/** `text` (CSS) with each `var(--name)` of a token put as what the token is now in `mode`, and so on in turn. */
export function literalOf(model, mode, text, depth = 0) {
    return depth > 6
        ? text
        : text.replace(VAR, (whole, name) => {
              const token = model.byVar(name);
              const css = token ? safeCss(model.value(token.name, mode).css) : "";

              return css === "" ? whole : literalOf(model, mode, css, depth + 1);
          });
}

/** The custom properties that `text` uses, set to what they are now in `mode` (a style text), and those they use in turn. */
export function scopeStyle(model, mode, text, limit = 40) {
    const declared = new Map();
    const queue = [text];

    while (queue.length > 0 && declared.size < limit) {
        for (const [, name] of queue.pop().matchAll(VAR)) {
            const token = declared.has(name) ? undefined : model.byVar(name);
            let css = token ? safeCss(model.value(token.name, mode).css) : "";

            if (css !== "") {
                css = token.type === "fontFamily" ? fontStack(css) : css;
                declared.set(name, css);
                queue.push(css);
            }
        }
    }

    return [...declared].map(([name, css]) => `${name}:${css}`).join(";");
}

const TYPE_PARTS = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing"];

/**
 * The style of a typography token in `mode`. The engine gives its members as CSS that links to the tokens they come from
 * (`font-size: var(--font-size-base)`): the style sets those properties to what they are now, so an edit to the size
 * token moves the specimen. Without them, the style is drawn from the resolved value.
 */
export function typographyStyleOf(model, mode, now) {
    const parts = isObject(now.parts) ? now.parts : undefined;

    if (parts === undefined) {
        return typographyStyle(now.value);
    }

    const text = TYPE_PARTS.map((name) => parts[name]).filter((part) => typeof part === "string");
    const rules = TYPE_PARTS.flatMap((name) => {
        const css = typeof parts[name] === "string" ? safeCss(parts[name]) : "";

        return css === "" ? [] : [`${name}:${name === "font-family" ? fontStack(css) : css}`];
    });

    return [scopeStyle(model, mode, text.join(" ")), ...rules].filter(Boolean).join(";");
}

/** The line under a typography token's name, from what its parts are now: `20px / 1.15 · 600 · Geist`. */
export function typographyMeta(model, mode, now) {
    const parts = isObject(now.parts) ? now.parts : undefined;
    const part = (name) =>
        typeof parts?.[name] === "string" ? literalOf(model, mode, parts[name]) : undefined;

    if (parts === undefined) {
        return undefined;
    }

    const size = part("font-size");
    const height = part("line-height");
    const family = part("font-family")
        ?.split(",")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "");

    return [
        [size, height === undefined ? "" : `/ ${height}`].filter(Boolean).join(" "),
        part("font-weight"),
        family,
    ]
        .filter((each) => each !== undefined && each !== "")
        .join(" · ");
}
