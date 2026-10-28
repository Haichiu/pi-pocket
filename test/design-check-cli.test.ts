// The CI entry point `src/server/design/check-cli.ts`: arguments, exit codes, the bundle next to the page, and a system.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { runCheck } from "../src/server/design/check-cli.ts";
import { writeSystemFixture } from "./design-system-fixtures.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };
const folder = mkdtempSync(join(tmpdir(), "pocket-check-cli-"));
const cli = join(import.meta.dirname, "..", "src", "server", "design", "check-cli.ts");
const run = promisify(execFile);

after(() => rmSync(folder, { recursive: true, force: true }));

const head =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="ds/tokens.css">';
const good = `${head}<style>body{margin:0;background:var(--color-bg-canvas);color:var(--color-text-primary)}</style></head><body data-pid="b"><main data-pid="m"><h1 data-pid="t" style="margin:0;padding:var(--space-4)">Fine</h1></main></body></html>`;
const bad = `${head}</head><body><h1 style="color:#7ba3f8">Off</h1><img src="x.gif"></body></html>`;

async function exec(args: string[]) {
    try {
        const { stdout, stderr } = await run("node", [cli, ...args], { timeout: 100_000 });

        return { code: 0, stdout, stderr };
    } catch (error) {
        const failed = error as { code: number; stdout: string; stderr: string };

        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
}

test("the arguments are checked: exit 2 and a usage line", async () => {
    for (const args of [
        [],
        ["a.html", "b.html"],
        ["a.html", "--nope"],
        ["a.html", "--mode"],
        ["a.html", "--scheme", "sepia"],
    ]) {
        const result = await exec(args);

        assert.equal(result.code, 2, args.join(" "));
        assert.match(
            result.stderr,
            /Usage: node src\/server\/design\/check-cli\.ts|--scheme is light or dark/,
        );
    }

    const missing = await exec([join(folder, "missing.html")]);

    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /ENOENT|no such file/);
});

test(
    "a page with an error exits 1 and lists what is wrong; one without exits 0",
    browser,
    async () => {
        writeFileSync(join(folder, "bad.html"), bad);
        writeFileSync(join(folder, "good.html"), good.replace("ds/tokens.css", "none.css"));
        const failed = await exec([join(folder, "bad.html")]);

        assert.equal(failed.code, 1);
        assert.match(failed.stdout, /error\s+image-alt\s+img\n\s+An image has no alt attribute\./);
        assert.match(
            failed.stdout,
            /bad\.html: \d+ errors?, \d+ warnings? in \d+ elements \(1280×800, light, no design system\)\./,
        );
        const passed = await exec([join(folder, "good.html")]);

        assert.equal(passed.code, 0, passed.stdout);
        assert.match(passed.stdout, /good\.html: 0 errors, 0 warnings/);
    },
);

test(
    "with a system: the page's bundle, the system's tokens, a mode, a viewport, and JSON",
    browser,
    async () => {
        const project = join(folder, "project");
        const pages = join(project, "pages");

        mkdirSync(pages, { recursive: true });
        writeSystemFixture(project);
        writeFileSync(join(pages, "page.html"), bad);
        writeFileSync(join(pages, "x.gif"), Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
        // A link, a dot folder, and `node_modules` are not part of the bundle.
        symlinkSync("/etc/hostname", join(pages, "link.txt"));
        mkdirSync(join(pages, ".git"), { recursive: true });
        writeFileSync(join(pages, ".git", "x.txt"), "x");
        const page = join(pages, "page.html");
        const result = await exec([
            page,
            "--system",
            project,
            "--mode",
            "dark",
            "--viewport",
            "390x844",
            "--json",
        ]);

        assert.equal(result.code, 1);
        const report = JSON.parse(result.stdout) as {
            viewport: { width: number };
            colorScheme: string;
            mode: string;
            withoutSystem: boolean;
            findings: { rule: string; value?: string; suggestion?: string }[];
        };

        assert.equal(report.viewport.width, 390);
        assert.equal(report.mode, "dark");
        assert.equal(report.colorScheme, "dark");
        assert.equal(report.withoutSystem, false);
        assert.ok(
            report.findings.some(
                (item) => item.rule === "off-system-color" && item.value === "#7ba3f8",
            ),
        );
        // The `.pi/design` folder itself is accepted, and a mode that the system lacks is an error of the arguments.
        const same = await exec([page, "--system", join(project, ".pi", "design")]);

        assert.equal(same.code, 1);
        assert.match(same.stdout, /off-system-color/);
        assert.match(same.stdout, /light, mode light\)/);
        const wrong = await exec([page, "--system", project, "--mode", "sepia"]);

        assert.equal(wrong.code, 2);
        assert.match(wrong.stderr, /no mode "sepia"/);
        const none = await exec([page, "--system", join(folder, "nothing")]);

        assert.equal(none.code, 2);
        assert.match(none.stderr, /There is no design system/);
    },
);

test("runCheck can be called with its own output", browser, async () => {
    const lines: string[] = [];
    const code = await runCheck([join(folder, "good.html"), "--viewport", "mobile"], {
        log: (text) => lines.push(text),
        error: (text) => lines.push(text),
    });

    assert.equal(code, 0);
    assert.match(lines.at(-1)!, /\(390×844, light, no design system\)/);
});
