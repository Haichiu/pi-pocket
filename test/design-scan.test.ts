// The design_system scan: drafts tokens from style files, stays inside the folder, and the write check for the tokens block.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    LIMITS,
    checkTokensBlock,
    draftDesignSystem,
    scanRoot,
    scanTokens,
} from "../src/server/design/scan.ts";
import { designSystemTool } from "../src/server/design/system.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-scan-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

test("scan counts colors, fonts, radii and reads CSS variables", () => {
    const dir = project({
        "src/app.css": `:root{--brand:#FF5500;--gap: 8px}
a{color:#ff5500;background:#FFF;border-radius:8px;font-family:Inter, sans-serif}
b{color:#f50;border-radius:8px;font-family:Inter,  sans-serif}`,
        "node_modules/x/skip.css": "a{color:#123456}",
    });
    const scan = scanTokens(dir);

    assert.deepEqual(scan.files, ["src/app.css"]);
    assert.deepEqual(scan.variables, { "--brand": "#FF5500", "--gap": "8px" });
    // #FF5500 and #ff5500 differ only in case, so they merge to a count of 2.
    assert.deepEqual(scan.colors[0], { value: "#ff5500", count: 2 });
    assert.ok(!scan.colors.some((c) => c.value === "#123456"));
    assert.deepEqual(scan.fonts, [{ value: "Inter, sans-serif", count: 2 }]);
    assert.deepEqual(scan.radii, [{ value: "8px", count: 2 }]);
});

test("a 5-digit hex is not a color", () => {
    const dir = project({ "a.css": "a{color:#12345;x:#abcd}" });

    assert.deepEqual(
        scanTokens(dir).colors.map((c) => c.value),
        ["#abcd"],
    );
});

test("scan never follows a symlink out of the folder", () => {
    const outside = project({ "secret.css": "a{color:#abcdef}" });
    const dir = project({ "ok.css": "a{color:#111}" });

    symlinkSync(outside, join(dir, "link"));
    symlinkSync(join(outside, "secret.css"), join(dir, "file.css"));

    assert.deepEqual(scanTokens(dir).files, ["ok.css"]);
    assert.throws(() => scanRoot(dir, "link"), /folder|inside/);
    assert.throws(() => scanRoot(dir, "../x"), /inside/);
    assert.throws(() => scanRoot(dir, "/etc"), /relative/);
});

test("the file limit ends the walk and says so", () => {
    const files: Record<string, string> = {};

    for (let i = 0; i < LIMITS.files + 5; i++) {
        files[`f${i}.css`] = "a{color:#111}";
    }

    const scan = scanTokens(project(files));

    assert.equal(scan.files.length, LIMITS.files);
    assert.equal(scan.partial, true);
});

test("the draft's tokens block parses and passes the write check", () => {
    const draft = draftDesignSystem(scanTokens(project({ "a.css": ":root{--c:#123}" })));

    assert.equal(checkTokensBlock(draft), true);
});

test("checkTokensBlock: none is false, broken or non-object throws", () => {
    assert.equal(checkTokensBlock("# just words"), false);
    assert.throws(() => checkTokensBlock("```json\n{oops}\n```"), /not valid JSON/);
    assert.throws(() => checkTokensBlock("```json\n[1]\n```"), /JSON object/);
});

test("the tool: scan returns a draft and writes nothing; write refuses broken tokens", async () => {
    const dir = project({ "a.css": "a{color:#abc}" });
    const tool = designSystemTool();
    const run = (args: object) =>
        tool.execute(
            args as never,
            { agent: async () => ({ cwd: dir }) } as never,
            undefined as never,
        );
    const text = async (call: ReturnType<typeof run>) =>
        ((await call).output as { text: string }[])[0]!.text;

    assert.match(await text(run({ action: "scan" })), /#abc/);
    assert.match(await text(run({ action: "read" })), /no .*design-system\.md/);
    await assert.rejects(run({ action: "write", content: "```json\n{bad\n```" }), /not valid JSON/);
    assert.match(await text(run({ action: "write", content: "# plain" })), /no fenced JSON/);
});
