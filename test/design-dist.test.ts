// The flagship's dist/ is committed, and it is what the compiler makes now. A change to the compiler changes these
// files, so it shows up as a diff in review. To accept a change on purpose: `PI_UPDATE_DIST=1 node --test test/design-dist.test.ts`.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDesignSystem } from "../src/server/design/tokens.ts";

const FLAGSHIP = fileURLToPath(new URL("../docs/examples/design-system/pocket", import.meta.url));
const DIST = join(FLAGSHIP, ".pi", "design", "dist");

function compiled(): Map<string, string> {
    const system = loadDesignSystem(FLAGSHIP)!;
    const files = new Map<string, string>([
        ["tokens.css", system.compiled.css],
        ["tailwind.css", system.compiled.tailwind],
        ["tokens.resolved.json", system.compiled.json],
        ["components.css", system.compiled.components],
        ["tokens.studio.json", system.compiled.studio!],
        ["names.md", system.compiled.names!],
    ]);

    for (const [mode, text] of Object.entries(system.compiled.modes!)) {
        files.set(`tokens.${mode}.resolved.json`, text);
    }

    return files;
}

test("the flagship's dist/ is committed, and equal to what the compiler makes from its sources", () => {
    const made = compiled();

    if (process.env.PI_UPDATE_DIST === "1") {
        rmSync(DIST, { recursive: true, force: true });
        mkdirSync(DIST, { recursive: true });
        made.forEach((text, name) => writeFileSync(join(DIST, name), text));
    }

    const hint =
        "The compiler or the flagship's tokens changed, and dist/ did not. If that is meant, run PI_UPDATE_DIST=1 node --test test/design-dist.test.ts and commit dist/.";

    assert.deepEqual(
        readdirSync(DIST).sort(),
        [...made.keys()].sort(),
        `the files in dist/. ${hint}`,
    );

    for (const [name, text] of made) {
        assert.equal(
            readFileSync(join(DIST, name), "utf8") === text,
            true,
            `dist/${name} differs. ${hint}`,
        );
    }
});

test("the committed dist/ is what a person gets: tokens.css has the modes, tailwind.css the namespaces, the JSON parses", () => {
    const read = (name: string) => readFileSync(join(DIST, name), "utf8");

    assert.match(read("tokens.css"), /:root,\n\[data-theme="light"\] \{/);
    assert.match(read("tokens.css"), /\[data-theme="dark"\] \{/);
    assert.match(read("tailwind.css"), /--leading-tight:/);
    assert.doesNotMatch(
        read("tailwind.css").slice(read("tailwind.css").indexOf("@theme")),
        /--font-leading/,
    );

    for (const name of readdirSync(DIST).filter((file) => file.endsWith(".json"))) {
        assert.doesNotThrow(() => JSON.parse(read(name)), name);
    }

    const studio = JSON.parse(read("tokens.studio.json"));

    assert.deepEqual(studio.$metadata.tokenSetOrder, ["light", "dark", "high-contrast"]);
});
