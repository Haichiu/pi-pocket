import { NAMED_COLORS } from "./color.ts";

export interface Num {
    t: "num";
    n: number;
    unit: string;
}
interface Str {
    t: "str";
    s: string;
    quoted: boolean;
}
interface Col {
    t: "color";
    r: number;
    g: number;
    b: number;
    a: number;
}
interface Lst {
    t: "list";
    items: Value[];
    sep: "comma" | "space";
    bracket: boolean;
}
interface MapV {
    t: "map";
    entries: [Value, Value][];
}
export interface Bool {
    t: "bool";
    b: boolean;
}
interface Nul {
    t: "null";
}
export type Value = Num | Str | Col | Lst | MapV | Bool | Nul;

export const NULL: Nul = { t: "null" };
export const num = (n: number, unit = ""): Num => ({ t: "num", n, unit });
export const str = (s: string, quoted = false): Str => ({ t: "str", s, quoted });
export const bool = (b: boolean): Bool => ({ t: "bool", b });
export const list = (items: Value[], sep: "comma" | "space" = "comma", bracket = false): Lst => ({
    t: "list",
    items,
    sep,
    bracket,
});

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export const truthy = (value: Value) => !(value.t === "null" || (value.t === "bool" && !value.b));

export function colorFromText(text: string): Col | undefined {
    const hex = /^#([0-9a-f]{3,8})$/i.exec(text.trim());

    if (hex !== null && [3, 4, 6, 8].includes(hex[1]!.length)) {
        const digits = hex[1]!;
        const full =
            digits.length <= 4
                ? digits
                      .split("")
                      .map((digit) => digit + digit)
                      .join("")
                : digits;
        const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);

        return {
            t: "color",
            r: channel(0),
            g: channel(2),
            b: channel(4),
            a: full.length === 8 ? channel(6) / 255 : 1,
        };
    }

    const named = NAMED_COLORS.get(text.trim().toLowerCase());

    return named === undefined ? undefined : colorFromText(named);
}

function toHsl(color: Col): [number, number, number] {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;

    if (delta !== 0) {
        if (max === r) {
            hue = ((g - b) / delta) % 6;
        } else if (max === g) {
            hue = (b - r) / delta + 2;
        } else {
            hue = (r - g) / delta + 4;
        }

        hue *= 60;
    }

    const lightness = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

    return [(hue + 360) % 360, saturation * 100, lightness * 100];
}

function fromHsl(hue: number, saturation: number, lightness: number, alpha: number): Col {
    const h = (((hue % 360) + 360) % 360) / 360;
    const s = clamp(saturation, 0, 100) / 100;
    const l = clamp(lightness, 0, 100) / 100;
    const m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s;
    const m1 = l * 2 - m2;

    const channel = (offset: number) => {
        let at = offset;

        if (at < 0) {
            at += 1;
        }

        if (at > 1) {
            at -= 1;
        }

        const value =
            at * 6 < 1
                ? m1 + (m2 - m1) * at * 6
                : at * 2 < 1
                  ? m2
                  : at * 3 < 2
                    ? m1 + (m2 - m1) * (2 / 3 - at) * 6
                    : m1;

        return value * 255;
    };

    return {
        t: "color",
        r: channel(h + 1 / 3),
        g: channel(h),
        b: channel(h - 1 / 3),
        a: clamp(alpha, 0, 1),
    };
}

function mix(first: Col, second: Col, weight: number): Col {
    const w = weight / 100;
    const normal = w * 2 - 1;
    const alpha = first.a - second.a;
    const w1 = ((normal * alpha === -1 ? normal : (normal + alpha) / (1 + normal * alpha)) + 1) / 2;
    const w2 = 1 - w1;

    return {
        t: "color",
        r: first.r * w1 + second.r * w2,
        g: first.g * w1 + second.g * w2,
        b: first.b * w1 + second.b * w2,
        a: first.a * w + second.a * (1 - w),
    };
}

export function colorText(color: Col): string {
    const byte = (value: number) => clamp(Math.round(value), 0, 255);

    if (color.a >= 0.9995) {
        return `#${[color.r, color.g, color.b].map((value) => byte(value).toString(16).padStart(2, "0")).join("")}`;
    }

    return `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${Number(color.a.toFixed(3))})`;
}

const round = (value: number) => Number(value.toFixed(10));

export function text(value: Value): string {
    switch (value.t) {
        case "num":
            return `${round(value.n)}${value.unit}`;
        case "str":
            return value.quoted ? `"${value.s.replace(/"/g, '\\"')}"` : value.s;
        case "color":
            return colorText(value);
        case "bool":
            return value.b ? "true" : "false";
        case "null":
            return "";

        case "list": {
            const inner = value.items
                .filter((item) => item.t !== "null")
                .map((item) =>
                    item.t === "list" &&
                    item.items.length > 1 &&
                    !item.bracket &&
                    item.sep === "comma" &&
                    value.sep === "comma"
                        ? `(${text(item)})`
                        : text(item),
                )
                .join(value.sep === "comma" ? ", " : " ");

            return value.bracket ? `[${inner}]` : inner;
        }

        case "map":
            return `(${value.entries.map(([key, item]) => `${text(key)}: ${item.t === "list" && item.sep === "comma" && item.items.length > 1 ? `(${text(item)})` : text(item)}`).join(", ")})`;
    }
}

/** Text for a variable's value: an empty list or map is `()`. */
export const declText = (value: Value) =>
    (value.t === "list" && value.items.length === 0 && !value.bracket) ||
    (value.t === "map" && value.entries.length === 0)
        ? "()"
        : text(value);

/** A map key as a comparable string: `"a"` and `a` are the same key in Sass. */
export const keyOf = (value: Value): string =>
    value.t === "str"
        ? value.s
        : value.t === "num"
          ? `${round(value.n)}${value.unit}`
          : text(value);

export const equal = (a: Value, b: Value): boolean =>
    a.t === "num" && b.t === "num"
        ? Math.abs(a.n - b.n) < 1e-9 && (a.unit === b.unit || a.unit === "" || b.unit === "")
        : a.t === "str" && b.t === "str"
          ? a.s === b.s
          : a.t === "color" && b.t === "color"
            ? colorText(a) === colorText(b)
            : a.t === "null" && b.t === "null"
              ? true
              : a.t === "bool" && b.t === "bool"
                ? a.b === b.b
                : a.t === b.t && text(a) === text(b);

export function itemsOf(value: Value): Value[] {
    if (value.t === "list") {
        return value.items;
    }

    if (value.t === "map") {
        return value.entries.map(([key, item]) => list([key, item], "space"));
    }

    return value.t === "null" ? [] : [value];
}

type Args = { positional: Value[]; named: Map<string, Value> };

const asNum = (value: Value | undefined): Num | undefined =>
    value?.t === "num" ? value : undefined;

const asColor = (value: Value | undefined): Col | undefined => {
    if (value?.t === "color") {
        return value;
    }

    return value?.t === "str" && !value.quoted ? colorFromText(value.s) : undefined;
};

/** `$amount` as a percentage-points number: `20%` is 20, and a bare 0.2 is 0.2 (Sass wants a percent). */
const points = (value: Value | undefined) => (value?.t === "num" ? value.n : undefined);

const arg = (args: Args, at: number, name: string): Value | undefined =>
    args.named.get(name) ?? args.positional[at];

const ALIASES: Record<string, string> = {
    "color.adjust": "adjust-color",
    "color.scale": "scale-color",
    "color.change": "change-color",
    "color.mix": "mix",
    "color.red": "red",
    "color.green": "green",
    "color.blue": "blue",
    "color.hue": "hue",
    "color.saturation": "saturation",
    "color.lightness": "lightness",
    "color.alpha": "alpha",
    "color.opacity": "alpha",
    "color.complement": "complement",
    "color.grayscale": "grayscale",
    "color.invert": "invert",
    "color.ie-hex-str": "ie-hex-str",
    "math.div": "math-div",
    "math.round": "round",
    "math.floor": "floor",
    "math.ceil": "ceil",
    "math.abs": "abs",
    "math.min": "min",
    "math.max": "max",
    "math.percentage": "percentage",
    "math.pow": "pow",
    "math.sqrt": "sqrt",
    "math.clamp": "clamp",
    "map.get": "map-get",
    "map.merge": "map-merge",
    "map.keys": "map-keys",
    "map.values": "map-values",
    "map.has-key": "map-has-key",
    "map.remove": "map-remove",
    "map.set": "map-set",
    "list.nth": "nth",
    "list.length": "length",
    "list.append": "append",
    "list.join": "join",
    "list.index": "index",
    "list.set-nth": "set-nth",
    "string.unquote": "unquote",
    "string.quote": "quote",
    "string.to-lower-case": "to-lower-case",
    "string.to-upper-case": "to-upper-case",
    "string.length": "str-length",
    "string.slice": "str-slice",
    "string.index": "str-index",
    "string.insert": "str-insert",
    "meta.type-of": "type-of",
    "meta.inspect": "inspect",
    "fade-in": "opacify",
    "fade-out": "transparentize",
    alpha: "alpha",
    opacity: "alpha",
};

function recolor(
    kind: "adjust" | "scale" | "change",
    color: Col,
    named: Map<string, Value>,
): Col | undefined {
    const get = (name: string) => points(named.get(name));
    const hsl = ["hue", "saturation", "lightness"].some((name) => named.has(name));
    const rgb = ["red", "green", "blue"].some((name) => named.has(name));

    if (hsl && rgb) {
        return undefined;
    }

    const apply = (value: number, change: number | undefined, max: number, min = 0) => {
        if (change === undefined) {
            return value;
        }

        if (kind === "change") {
            return change;
        }

        if (kind === "adjust") {
            return value + change;
        }

        const p = clamp(change, -100, 100) / 100;

        return p > 0 ? value + (max - value) * p : value + (value - min) * p;
    };

    let out: Col;

    if (hsl) {
        const [h, s, l] = toHsl(color);
        const hue = kind === "scale" ? h : apply(h, get("hue"), 360);

        out = fromHsl(
            kind === "scale" ? h : hue,
            clamp(apply(s, get("saturation"), 100), 0, 100),
            clamp(apply(l, get("lightness"), 100), 0, 100),
            color.a,
        );
    } else {
        out = {
            t: "color",
            r: clamp(apply(color.r, get("red"), 255), 0, 255),
            g: clamp(apply(color.g, get("green"), 255), 0, 255),
            b: clamp(apply(color.b, get("blue"), 255), 0, 255),
            a: color.a,
        };
    }

    const alpha = get("alpha");

    if (alpha !== undefined) {
        out = { ...out, a: clamp(apply(out.a, alpha, 1), 0, 1) };
    }

    return out;
}

export const hasBuiltin = (name: string) => name in ALIASES;

export function builtinConstant(library: string, name: string): Value | undefined {
    const constants: Record<string, number> = {
        pi: Math.PI,
        e: Math.E,
        epsilon: 2 ** -10,
        "max-safe-integer": Number.MAX_SAFE_INTEGER,
        "min-safe-integer": Number.MIN_SAFE_INTEGER,
    };

    return library === "math" && constants[name.replace(/^\$/, "")] !== undefined
        ? num(constants[name.replace(/^\$/, "")]!, "")
        : undefined;
}

export function callBuiltin(rawName: string, args: Args): Value | undefined {
    const name = ALIASES[rawName] ?? rawName;
    const first = args.positional[0];
    const color = asColor(first);
    const percent = (value: Value | undefined) => points(value);

    switch (name) {
        case "mix": {
            const other = asColor(arg(args, 1, "color2"));
            const base = asColor(arg(args, 0, "color1"));
            const weight = arg(args, 2, "weight");

            return base === undefined || other === undefined
                ? undefined
                : mix(base, other, weight === undefined ? 50 : (percent(weight) ?? 50));
        }

        case "lighten":

        case "darken": {
            const amount = percent(arg(args, 1, "amount"));
            const base = asColor(arg(args, 0, "color"));

            if (base === undefined || amount === undefined) {
                return undefined;
            }

            const [h, s, l] = toHsl(base);

            return fromHsl(h, s, l + (name === "lighten" ? amount : -amount), base.a);
        }

        case "saturate":

        case "desaturate": {
            const amount = percent(arg(args, 1, "amount"));
            const base = asColor(arg(args, 0, "color"));

            if (base === undefined || amount === undefined) {
                return undefined;
            }

            const [h, s, l] = toHsl(base);

            return fromHsl(h, s + (name === "saturate" ? amount : -amount), l, base.a);
        }

        case "adjust-hue": {
            const amount = percent(arg(args, 1, "degrees"));
            const base = asColor(arg(args, 0, "color"));

            if (base === undefined || amount === undefined) {
                return undefined;
            }

            const [h, s, l] = toHsl(base);

            return fromHsl(h + amount, s, l, base.a);
        }

        case "complement": {
            const [h, s, l] = color === undefined ? [0, 0, 0] : toHsl(color);

            return color === undefined ? undefined : fromHsl(h + 180, s, l, color.a);
        }

        case "grayscale": {
            const [h, , l] = color === undefined ? [0, 0, 0] : toHsl(color);

            return color === undefined ? undefined : fromHsl(h, 0, l, color.a);
        }

        case "invert": {
            const weight = percent(arg(args, 1, "weight")) ?? 100;

            return color === undefined
                ? undefined
                : mix(
                      {
                          t: "color",
                          r: 255 - color.r,
                          g: 255 - color.g,
                          b: 255 - color.b,
                          a: color.a,
                      },
                      color,
                      weight,
                  );
        }

        case "opacify":

        case "transparentize": {
            const amount = points(arg(args, 1, "amount"));

            return color === undefined || amount === undefined
                ? undefined
                : { ...color, a: clamp(color.a + (name === "opacify" ? amount : -amount), 0, 1) };
        }

        case "rgba":

        case "rgb": {
            const [a, b, c, d] = args.positional;

            if (args.positional.length <= 2 && asColor(a) !== undefined) {
                const alpha = points(b ?? args.named.get("alpha")) ?? asColor(a)!.a;

                return { ...asColor(a)!, a: clamp(alpha, 0, 1) };
            }

            const channel = (value: Value | undefined) =>
                value?.t === "num"
                    ? value.unit === "%"
                        ? (value.n * 255) / 100
                        : value.n
                    : undefined;
            const [r, g, bl] = [channel(a), channel(b), channel(c)];

            return r === undefined || g === undefined || bl === undefined
                ? undefined
                : {
                      t: "color",
                      r: clamp(r, 0, 255),
                      g: clamp(g, 0, 255),
                      b: clamp(bl, 0, 255),
                      a: d?.t === "num" ? clamp(d.unit === "%" ? d.n / 100 : d.n, 0, 1) : 1,
                  };
        }

        case "hsl":

        case "hsla": {
            const [h, s, l, a] = args.positional;

            return h?.t === "num" && s?.t === "num" && l?.t === "num"
                ? fromHsl(h.n, s.n, l.n, a?.t === "num" ? (a.unit === "%" ? a.n / 100 : a.n) : 1)
                : undefined;
        }

        case "scale-color":
        case "adjust-color":

        case "change-color": {
            const base = asColor(arg(args, 0, "color"));

            return base === undefined
                ? undefined
                : recolor(
                      name === "scale-color"
                          ? "scale"
                          : name === "adjust-color"
                            ? "adjust"
                            : "change",
                      base,
                      args.named,
                  );
        }

        case "red":
        case "green":
        case "blue":
            return color === undefined
                ? undefined
                : num(Math.round(name === "red" ? color.r : name === "green" ? color.g : color.b));
        case "hue":
            return color === undefined ? undefined : num(round(toHsl(color)[0]), "deg");
        case "saturation":
            return color === undefined ? undefined : num(round(toHsl(color)[1]), "%");
        case "lightness":
            return color === undefined ? undefined : num(round(toHsl(color)[2]), "%");
        case "alpha":
            return color === undefined ? undefined : num(round(color.a));

        case "math-div": {
            const [a, b] = [asNum(args.positional[0]), asNum(args.positional[1])];

            return a === undefined || b === undefined || b.n === 0
                ? undefined
                : num(a.n / b.n, a.unit === b.unit ? "" : a.unit === "" ? b.unit : a.unit);
        }

        case "percentage":
            return asNum(first) === undefined ? undefined : num(asNum(first)!.n * 100, "%");
        case "round":
        case "floor":
        case "ceil":

        case "abs": {
            const n = asNum(first);

            return n === undefined
                ? undefined
                : num(
                      name === "round"
                          ? Math.round(n.n)
                          : name === "floor"
                            ? Math.floor(n.n)
                            : name === "ceil"
                              ? Math.ceil(n.n)
                              : Math.abs(n.n),
                      n.unit,
                  );
        }

        case "min":

        case "max": {
            const all = args.positional.map(asNum);

            return all.length === 0 || all.some((each) => each === undefined)
                ? undefined
                : (all as Num[]).reduce((best, each) =>
                      (name === "min" ? each.n < best.n : each.n > best.n) ? each : best,
                  );
        }

        case "pow":
            return asNum(args.positional[0]) !== undefined &&
                asNum(args.positional[1]) !== undefined
                ? num(
                      asNum(args.positional[0])!.n ** asNum(args.positional[1])!.n,
                      asNum(args.positional[0])!.unit,
                  )
                : undefined;
        case "sqrt":
            return asNum(first) === undefined
                ? undefined
                : num(Math.sqrt(asNum(first)!.n), asNum(first)!.unit);

        case "clamp": {
            const [a, b, c] = args.positional.map(asNum);

            return a === undefined || b === undefined || c === undefined
                ? undefined
                : num(clamp(b.n, a.n, c.n), b.unit || a.unit);
        }

        case "unquote":
            return first?.t === "str" ? str(first.s, false) : first;
        case "quote":
            return first === undefined ? undefined : str(text(first), true);
        case "to-lower-case":
            return first?.t === "str" ? str(first.s.toLowerCase(), first.quoted) : undefined;
        case "to-upper-case":
            return first?.t === "str" ? str(first.s.toUpperCase(), first.quoted) : undefined;
        case "str-length":
            return first?.t === "str" ? num(first.s.length) : undefined;

        case "str-slice": {
            const [a, b] = [asNum(args.positional[1]), asNum(args.positional[2])];

            if (first?.t !== "str" || a === undefined) {
                return undefined;
            }

            const from = a.n > 0 ? a.n - 1 : first.s.length + a.n;
            const to = b === undefined ? first.s.length : b.n > 0 ? b.n : first.s.length + b.n + 1;

            return str(first.s.slice(from, to), first.quoted);
        }

        case "str-index": {
            const second = args.positional[1];
            const at = first?.t === "str" && second?.t === "str" ? first.s.indexOf(second.s) : -1;

            return first?.t === "str" && second?.t === "str"
                ? at === -1
                    ? NULL
                    : num(at + 1)
                : undefined;
        }

        case "length":
            return first === undefined
                ? undefined
                : num(
                      first.t === "map"
                          ? first.entries.length
                          : itemsOf(first).length || (first.t === "null" ? 0 : 1),
                  );

        case "nth": {
            const index = asNum(args.positional[1]);

            if (first === undefined || index === undefined) {
                return undefined;
            }

            const items = itemsOf(first);

            return items[index.n > 0 ? index.n - 1 : items.length + index.n];
        }

        case "append": {
            const sep = first?.t === "list" ? first.sep : "space";
            const joiner = args.named.get("separator") ?? args.positional[2];

            return first === undefined || args.positional[1] === undefined
                ? undefined
                : list(
                      [...itemsOf(first), args.positional[1]],
                      joiner?.t === "str" && joiner.s === "comma"
                          ? "comma"
                          : joiner?.t === "str" && joiner.s === "space"
                            ? "space"
                            : sep,
                      first.t === "list" && first.bracket,
                  );
        }

        case "join": {
            const second = args.positional[1];

            return first === undefined || second === undefined
                ? undefined
                : list(
                      [...itemsOf(first), ...itemsOf(second)],
                      first.t === "list" ? first.sep : second.t === "list" ? second.sep : "space",
                  );
        }

        case "index": {
            const found =
                first === undefined || args.positional[1] === undefined
                    ? -1
                    : itemsOf(first).findIndex((item) => equal(item, args.positional[1]!));

            return first === undefined ? undefined : found === -1 ? NULL : num(found + 1);
        }

        case "map-get": {
            const key = args.positional[1];

            if (first?.t !== "map" && !(first?.t === "list" && first.items.length === 0)) {
                return first === undefined ? undefined : first.t === "null" ? NULL : undefined;
            }

            const entries = first.t === "map" ? first.entries : [];
            let found: Value | undefined =
                entries.find(([each]) => key !== undefined && keyOf(each) === keyOf(key))?.[1] ??
                NULL;

            for (const next of args.positional.slice(2)) {
                found =
                    found.t === "map"
                        ? (found.entries.find(([each]) => keyOf(each) === keyOf(next))?.[1] ?? NULL)
                        : NULL;
            }

            return found;
        }

        case "map-merge": {
            const second = args.positional[1];
            const a =
                first?.t === "map"
                    ? first.entries
                    : first?.t === "list" && first.items.length === 0
                      ? []
                      : undefined;
            const b =
                second?.t === "map"
                    ? second.entries
                    : second?.t === "list" && second.items.length === 0
                      ? []
                      : undefined;

            if (a === undefined || b === undefined) {
                return undefined;
            }

            const merged = [...a];

            for (const [key, value] of b) {
                const at = merged.findIndex(([each]) => keyOf(each) === keyOf(key));

                if (at === -1) {
                    merged.push([key, value]);
                } else {
                    merged[at] = [merged[at]![0], value];
                }
            }

            return { t: "map", entries: merged };
        }

        case "map-set": {
            const key = args.positional[1];
            const value = args.positional[2];

            return first?.t === "map" && key !== undefined && value !== undefined
                ? callBuiltin("map-merge", {
                      positional: [first, { t: "map", entries: [[key, value]] }],
                      named: new Map(),
                  })
                : undefined;
        }

        case "map-keys":
            return first?.t === "map" ? list(first.entries.map(([key]) => key)) : undefined;
        case "map-values":
            return first?.t === "map" ? list(first.entries.map(([, value]) => value)) : undefined;
        case "map-has-key":
            return first?.t === "map" && args.positional[1] !== undefined
                ? bool(first.entries.some(([key]) => keyOf(key) === keyOf(args.positional[1]!)))
                : undefined;
        case "map-remove":
            return first?.t === "map"
                ? {
                      t: "map",
                      entries: first.entries.filter(
                          ([key]) =>
                              !args.positional.slice(1).some((drop) => keyOf(drop) === keyOf(key)),
                      ),
                  }
                : undefined;

        case "type-of":
            return first === undefined
                ? undefined
                : str(
                      first.t === "num"
                          ? "number"
                          : first.t === "str"
                            ? "string"
                            : first.t === "bool"
                              ? "bool"
                              : first.t === "null"
                                ? "null"
                                : first.t,
                  );
        case "inspect":
            return first === undefined ? undefined : str(text(first));

        case "if": {
            const [condition, yes, no] = args.positional;

            return condition === undefined || yes === undefined || no === undefined
                ? undefined
                : truthy(condition)
                  ? yes
                  : no;
        }

        default:
            return undefined;
    }
}
