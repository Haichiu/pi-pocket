// The flagship design system (Pi Pocket's own, docs/examples/design-system/pocket): it loads, every reference and
// component token exists, it passes WCAG AA in every mode, and the bench's copy is the same.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contrastRatio, parseColor } from "../src/server/design/docsite-color.ts";
import type { DesignSystem, ResolvedToken } from "../src/server/design/system-types.ts";
import { loadSystem } from "./design-system-loader.ts";

const EXAMPLE = fileURLToPath(new URL("../docs/examples/design-system/pocket", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/design-system/flagship", import.meta.url));

const system = (): DesignSystem => {
    const loaded = loadSystem(EXAMPLE);

    assert.ok(loaded !== undefined, "the flagship loads");

    return loaded;
};

const byName = (tokens: ResolvedToken[]) => new Map(tokens.map((token) => [token.name, token]));

test("the flagship has what a complete system has: tiers, modes, scales, components, guidelines", () => {
    const loaded = system();

    assert.equal(loaded.name, "Pi Pocket");
    assert.deepEqual(loaded.modes, ["light", "dark", "high-contrast"]);
    assert.deepEqual(
        loaded.problems.filter((problem) => problem.level === "error"),
        [],
        "no validation error",
    );

    // Every kind of token the plan names.
    const types = new Set(loaded.tokens.map((token) => token.type));

    for (const type of [
        "color",
        "dimension",
        "fontFamily",
        "fontWeight",
        "duration",
        "cubicBezier",
        "number",
        "shadow",
        "typography",
        "transition",
    ]) {
        assert.ok(types.has(type as never), `has ${type} tokens`);
    }

    const tiers = new Set(loaded.tokens.map((token) => token.tier));

    assert.deepEqual([...tiers].sort(), ["component", "primitive", "semantic"]);

    // Every group of the plan: color, type, space, radius, shadow, motion, breakpoints, z-index.
    const roots = new Set(loaded.tokens.map((token) => token.path[0]));

    for (const group of [
        "color",
        "font",
        "type",
        "space",
        "radius",
        "shadow",
        "motion",
        "breakpoint",
        "z",
    ]) {
        assert.ok(roots.has(group), `has ${group}`);
    }

    assert.ok(loaded.components.length >= 8, `${loaded.components.length} components`);
    assert.ok(loaded.guidelines.length > 1000 && Buffer.byteLength(loaded.guidelines) <= 16_384);

    // Every mode's value of every token is a resolved value, and a mode changes at least the semantic colors.
    for (const token of loaded.tokens) {
        for (const mode of loaded.modes) {
            assert.ok(token.modes[mode] !== undefined, `${token.name} has a value in ${mode}`);
        }
    }

    const differing = loaded.tokens.filter(
        (token) => token.modes.dark!.css !== token.modes.light!.css,
    );

    assert.ok(differing.length >= 30, `${differing.length} tokens change in dark`);
    assert.ok(
        differing.every((token) => token.type === "color"),
        "only colors change by mode",
    );
});

test("every component has a template for each state, uses only tokens, and names the tokens it uses", () => {
    const loaded = system();
    const tokens = byName(loaded.tokens);
    const vars = new Map(loaded.tokens.map((token) => [token.cssVar, token]));

    for (const spec of loaded.components) {
        assert.ok(spec.states.length >= 2, `${spec.slug} has states`);
        assert.deepEqual(
            Object.keys(spec.markup),
            spec.states,
            `${spec.slug}: a template for each state`,
        );
        assert.ok(
            spec.description.length > 20 &&
                (spec.usage?.do.length ?? 0) > 0 &&
                (spec.usage?.dont.length ?? 0) > 0,
        );

        // The CSS reads tokens (or custom properties of its own) and holds no color or pixel size of its own.
        const own = new Set([...spec.css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
        const used = [...spec.css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!);

        for (const name of used) {
            assert.ok(own.has(name) || vars.has(name), `${spec.slug}: ${name} is a token`);
        }

        assert.doesNotMatch(
            spec.css,
            /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i,
            `${spec.slug}: no literal color`,
        );
        assert.doesNotMatch(
            spec.css,
            /font-size:\s*\d|border-radius:\s*\d|(padding|margin|gap):\s*\d+px/,
            `${spec.slug}: no literal size`,
        );

        // The `tokens` list is exactly the tokens its CSS reads.
        const expected = [...new Set(used.filter((name) => !own.has(name)))]
            .map((name) => vars.get(name)!.name)
            .sort();

        assert.deepEqual([...spec.tokens].sort(), expected, `${spec.slug}: tokens list`);

        for (const name of spec.tokens) {
            assert.ok(tokens.has(name), `${spec.slug}: ${name} exists`);
        }

        // Every state has markup to show.
        for (const state of spec.states) {
            assert.ok(spec.markup[state]!.trim().length > 10, `${spec.slug}/${state} has markup`);
        }
    }
});

test("every contrast pair passes in every mode, and text roles pass on every ground", () => {
    const loaded = system();
    const tokens = byName(loaded.tokens);
    const ratio = (fg: string, bg: string, mode: string) =>
        contrastRatio(
            parseColor(tokens.get(fg)!.modes[mode]!.value)!,
            parseColor(tokens.get(bg)!.modes[mode]!.value)!,
        );

    for (const token of loaded.tokens.filter((item) => item.contrast !== undefined)) {
        for (const mode of loaded.modes) {
            const on = token.contrast!.on.replace(/[{}]/g, "");

            assert.ok(
                ratio(token.name, on, mode) >= token.contrast!.min,
                `${token.name} on ${on} in ${mode}`,
            );
        }
    }

    const grounds = ["canvas", "base", "surface", "raised", "sunken"].map(
        (name) => `color.bg.${name}`,
    );
    const readers = [
        "color.text.primary",
        "color.text.secondary",
        "color.text.muted",
        ...["accent", "danger", "warning", "success", "info", "brand", "spark"].map(
            (name) => `color.${name}.default`,
        ),
    ];

    for (const mode of loaded.modes) {
        for (const fg of readers) {
            for (const bg of grounds) {
                const need = mode === "high-contrast" ? 7 : 4.5;

                assert.ok(
                    ratio(fg, bg, mode) >= need,
                    `${fg} on ${bg} in ${mode}: ${ratio(fg, bg, mode).toFixed(2)}`,
                );
            }
        }

        for (const status of ["accent", "danger", "warning", "success", "info"]) {
            assert.ok(
                ratio(`color.${status}.default`, `color.${status}.soft`, mode) >= 4.5,
                `${status} on its wash in ${mode}`,
            );
        }

        // Edges that a person must find, and the focus ring, reach 3:1 on the grounds.
        for (const bg of ["color.bg.base", "color.bg.surface", "color.bg.raised"]) {
            assert.ok(
                ratio("color.border.strong", bg, mode) >= 3,
                `border.strong on ${bg} in ${mode}`,
            );
            assert.ok(
                ratio("color.border.focus", bg, mode) >= 3,
                `border.focus on ${bg} in ${mode}`,
            );
        }
    }
});

/** Every file under a folder, relative, sorted. */
function files(root: string, at = root): string[] {
    return readdirSync(at, { withFileTypes: true })
        .flatMap((entry) =>
            entry.isDirectory()
                ? files(root, join(at, entry.name))
                : [relative(root, join(at, entry.name))],
        )
        .sort();
}

test("the bench's copy of the flagship is the same files as the example", () => {
    const names = files(EXAMPLE);

    assert.ok(names.length >= 14, names.join(", "));
    assert.deepEqual(files(FIXTURE), names);

    for (const name of names) {
        assert.equal(
            readFileSync(join(FIXTURE, name), "utf8"),
            readFileSync(join(EXAMPLE, name), "utf8"),
            name,
        );
    }
});
