// The names in tailwind.css: every variable that starts with a namespace of Tailwind v4's theme is of that namespace's kind,
// and the utilities that Tailwind makes from the flagship are the ones in the fixture (made with a real Tailwind 4.3 compile).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadDesignSystem, tailwindNames } from "../src/server/design/tokens.ts";

const FLAGSHIP = join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket");
const system = loadDesignSystem(FLAGSHIP)!;

/** Which token types a namespace may hold: Tailwind reads any variable that starts with it as that kind of value. */
const KINDS: [string, string[]][] = [
    ["font-weight", ["fontWeight"]],
    ["inset-shadow", ["shadow"]],
    ["drop-shadow", ["shadow"]],
    ["color", ["color"]],
    ["font", ["fontFamily"]],
    ["text", ["dimension", "typography"]],
    ["tracking", ["dimension"]],
    ["leading", ["number", "dimension"]],
    ["breakpoint", ["dimension"]],
    ["container", ["dimension"]],
    ["spacing", ["dimension"]],
    ["radius", ["dimension"]],
    ["shadow", ["shadow"]],
    ["blur", ["dimension"]],
    ["perspective", ["dimension"]],
    ["aspect", ["number"]],
    ["ease", ["cubicBezier"]],
    ["animate", ["transition"]],
];

test("a token is in a namespace of Tailwind's theme only when it is of that kind: no --font-leading-tight", () => {
    const names = tailwindNames(system);

    assert.equal(names.size, system.tokens.length);

    for (const token of system.tokens) {
        const variable = names.get(token.name)!;
        const namespace = KINDS.find(([each]) => variable.startsWith(`--${each}-`));

        if (namespace !== undefined) {
            assert.ok(
                namespace[1].includes(token.type),
                `${token.name} (${token.type}) is ${variable}, in the namespace of ${namespace[0]}`,
            );
        }
    }

    const css = system.compiled.tailwind.slice(system.compiled.tailwind.indexOf("@theme"));

    assert.doesNotMatch(css, /--font-leading|--font-tracking/);
    assert.match(css, /--leading-tight: /);
    assert.match(css, /--tracking-wide: /);
    assert.equal(new Set(names.values()).size, names.size, "one variable for each token");
});

test("a name that Tailwind would read wrongly is kept out of its namespaces: --ds- in front", () => {
    const made = loadDesignSystem(FLAGSHIP)!;
    const other = {
        ...made,
        tokens: [
            {
                ...made.tokens[0]!,
                name: "font.foo",
                path: ["font", "foo"],
                cssVar: "--font-foo",
                type: "number" as const,
            },
            {
                ...made.tokens[0]!,
                name: "z.modal",
                path: ["z", "modal"],
                cssVar: "--z-modal",
                type: "number" as const,
            },
        ],
    };
    const names = tailwindNames(other);

    assert.equal(
        names.get("font.foo"),
        "--ds-font-foo",
        "a number in --font-* would make font-foo",
    );
    assert.equal(names.get("z.modal"), "--z-modal", "no namespace, no change");
});

test("color roles drop the word that the utility repeats: bg-surface, text-primary, border-default; tokens.css keeps its names", () => {
    const names = tailwindNames(system);

    assert.equal(names.get("color.bg.surface"), "--color-surface");
    assert.equal(names.get("color.text.primary"), "--color-primary");
    assert.equal(names.get("color.border.default"), "--color-default");
    assert.equal(names.get("color.accent.default"), "--color-accent", "a trailing default goes");
    assert.equal(
        names.get("color.accent.fill"),
        "--color-accent-fill",
        "a role group's own name stays",
    );
    assert.equal(
        names.get("color.neutral.500"),
        "--color-neutral-500",
        "a palette step is as it is",
    );
    assert.match(
        system.compiled.css,
        /--color-bg-surface: /,
        "the variable of tokens.css is unchanged",
    );
    assert.match(system.compiled.css, /--color-text-primary: /);
    assert.match(
        system.compiled.css,
        /--font-leading-tight: /,
        "and so is the tokens.css name of a leading",
    );
});

/** The utilities that Tailwind v4 makes for each variable of the theme (what its namespaces mean). */
function utilities(css: string): string[] {
    const theme = css.slice(
        css.indexOf("@theme static {"),
        css.indexOf("\n}\n", css.indexOf("@theme static {")),
    );
    const variables = [...theme.matchAll(/^ {4}(--[\w-]+):/gm)]
        .map((match) => match[1]!)
        .filter((name) => !name.includes("--", 2));
    const made = new Set<string>();
    const table: [string, string[]][] = [
        ["color", ["bg", "text", "border"]],
        ["font-weight", ["font"]],
        ["font", ["font"]],
        ["text", ["text"]],
        ["tracking", ["tracking"]],
        ["leading", ["leading"]],
        ["spacing", ["p"]],
        ["radius", ["rounded"]],
        ["shadow", ["shadow"]],
        ["ease", ["ease"]],
        ["blur", ["blur"]],
        ["container", ["max-w"]],
    ];

    for (const name of variables) {
        const namespace = [
            "font-weight",
            "inset-shadow",
            "drop-shadow",
            ...table.map(([each]) => each),
        ].find((each) => name.startsWith(`--${each}-`));

        if (namespace === undefined) {
            continue;
        }

        const rest = name.slice(namespace.length + 3);

        for (const [each, prefixes] of table) {
            if (each === namespace) {
                prefixes.forEach((prefix) => made.add(`${prefix}-${rest}`));
            }
        }

        if (namespace === "breakpoint") {
            made.add(`${rest}:flex`);
        }
    }

    return [...made].sort();
}

test("the utilities of the flagship are the ones that a real Tailwind compile made (the fixture)", () => {
    const fixture = readFileSync(
        join(import.meta.dirname, "fixtures", "design-system", "pocket-tailwind-utilities.txt"),
        "utf8",
    )
        .split("\n")
        .filter(Boolean);
    const now = utilities(system.compiled.tailwind);

    assert.deepEqual(
        now,
        fixture,
        "the names in tailwind.css changed. If that is meant, compile it with Tailwind 4 (see docs/design/ds-notes-t.md, round 4), and write the utilities to the fixture",
    );
    assert.ok(
        now.includes("bg-surface") &&
            now.includes("text-primary") &&
            now.includes("border-default"),
    );
    assert.ok(
        !now.some((name) =>
            /font-leading|font-tracking|bg-bg-|text-text-|border-border-/.test(name),
        ),
    );
});
