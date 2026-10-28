// The whole path of a design system, as an agent walks it: scan a project, init from the scan, validate, publish a design
// that links ds/tokens.css, and check the page. The guide promises three design_system calls; this counts them.
import { cleanUp, context, newSession, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ConversationId } from "@earendil-works/pi-durable";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { readBundle } from "../src/server/design/bundle.ts";
import { checkDesign } from "../src/server/design/lint.ts";
import { designSystemTool } from "../src/server/design/system.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let conversation: ConversationId;
const host = { fetchPublic: createPublicFetch() } as PocketHost;
const [artifact] = createArtifacts(host).tools!;
const system = designSystemTool();
/** Every tool call of the transcript, in order: the tool's name and the action. */
const transcript: string[] = [];

before(async () => {
    app = await openApp(scriptedModel());
    conversation = await newSession(app);
});

after(async () => {
    await app.close();
    cleanUp();
});

/** A call of the design_system tool, as the agent loop makes it: the arguments are checked against the tool's schema first. */
async function call(args: Record<string, unknown>): Promise<string> {
    transcript.push(`design_system ${String(args.action)}`);

    const checked = validateToolArguments(
        system as never,
        {
            type: "toolCall",
            id: `call-${transcript.length}`,
            name: "design_system",
            arguments: args,
        } as never,
    ) as Record<string, unknown>;
    const result = await system.execute(
        checked as never,
        { agent: async () => ({ cwd: work }) } as never,
        context,
    );

    return (result.output as { text: string }[])[0]!.text;
}

async function publish(args: object): Promise<string> {
    transcript.push("artifact publish");

    const api = {
        conversationId: conversation,
        taskId: 7200,
        callId: `transcript-${transcript.length}`,
        agent: async () => ({ cwd: work }),
        snapshot: app.harness.snapshot.bind(app.harness),
        commit: app.harness.commit.bind(app.harness),
    };
    const result = await artifact!.execute(args as never, api as never, context);

    return (result.output![0] as { text: string }).text;
}

const PROJECT_CSS = `:root {
  --bg: #fbfaf7; --surface: #f0ece3; --text: #1c1b19; --text-muted: #6e685d; --border: #ddd5c6; --accent: #b5451b; --danger: #a8201a;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;
  --radius-sm: 4px; --radius-md: 8px; --font-sans: "Public Sans", system-ui, sans-serif;
  --font-size-sm: 13px; --font-size-md: 16px; --font-size-xl: 28px;
  --shadow-md: 0 4px 12px rgba(28, 27, 25, 0.18);
}
@media (prefers-color-scheme: dark) { :root { --bg: #14130f; --surface: #201e19; --text: #ece8df; --text-muted: #a8a193; --border: #3a372f; --accent: #e8825a; --danger: #f08a82 } }
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: var(--font-size-md) }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); box-shadow: var(--shadow-md) }
a { color: var(--accent) } .err { color: var(--danger) }`;

test("the guide promises a system in three design_system calls", () => {
    const text = readFileSync(
        fileURLToPath(new URL("../src/server/design/guide.ts", import.meta.url)),
        "utf8",
    );

    assert.match(
        text,
        /make one in three calls: design_system action "scan"[\s\S]*then action "init" with fromScan true[\s\S]*then action "validate"/,
    );
});

test(
    "scan, init from the scan, validate, publish a page that links ds/tokens.css, check it: no off-system finding, and the calls the guide promises",
    { skip: findBrowser() === undefined ? "No Chromium on this machine." : false },
    async () => {
        mkdirSync(join(work, "src"), { recursive: true });
        writeFileSync(join(work, "src", "styles.css"), PROJECT_CSS);

        // 1. scan: a report with a draft; nothing is saved.
        const report = await call({ action: "scan" });

        assert.match(report, /Color roles \(\d of 9 found\)/);
        assert.match(report, /design_system init fromScan: true|init fromScan/);
        assert.equal(loadDesignSystem(work), undefined, "a scan saves nothing");

        // 2. init from the scan, correcting a role in the same call (the value is typed: a string).
        const made = await call({
            action: "init",
            name: "Harbor",
            fromScan: true,
            changes: [{ token: "color.accent.default", value: "#b5451b" }],
        });

        assert.match(made, /Design system "Harbor"/);

        // 3. validate: no error.
        const checked = await call({ action: "validate" });

        assert.doesNotMatch(checked, /\b[1-9]\d* error/);

        const loaded = loadDesignSystem(work)!;

        assert.equal(loaded.problems.filter((problem) => problem.level === "error").length, 0);

        // 4. publish: the page links ds/tokens.css and uses only the variables of the summary.
        const byName = (name: string) => loaded.tokens.find((token) => token.name === name)?.cssVar;
        const first = (group: string, type: string) =>
            loaded.tokens.find(
                (token) =>
                    token.path[0] === group && token.type === type && token.tier !== "component",
            )?.cssVar;
        const page = [
            byName("color.bg.page"),
            byName("color.text.primary"),
            first("space", "dimension"),
            first("text", "dimension"),
            first("radius", "dimension"),
            first("font", "fontFamily"),
        ];

        assert.ok(
            page.every((each) => each !== undefined),
            page.join(", "),
        );

        const [bg, text, space, size, radius, family] = page as string[];
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbor</title><link rel="stylesheet" href="ds/tokens.css"><style>body{margin:0;background:var(${bg});color:var(${text});font-family:var(${family});font-size:var(${size})}main{padding:var(${space});border-radius:var(${radius})}h1{margin:0 0 var(${space});font-size:var(${size})}p{margin:0}</style></head><body data-pid="page"><main data-pid="main"><h1 data-pid="title">Harbor</h1><p data-pid="copy">One page on the system.</p></main></body></html>`;
        const reply = await publish({ id: "harbor", title: "Harbor", content: html });

        assert.match(reply, /Attached ds\/tokens\.css from the design system "Harbor"/);

        // 5. check the stored page against the system.
        const bundle = await readBundle(
            host,
            app.harness.snapshot.bind(app.harness),
            conversation,
            "harbor",
            undefined,
            context,
        );

        assert.deepEqual(
            bundle.assets.map((asset) => asset.name),
            ["ds/tokens.css"],
        );

        for (const colorScheme of ["light", "dark"] as const) {
            const found = await checkDesign(
                bundle,
                loaded,
                { colorScheme, viewport: "mobile" },
                host,
            );
            const off = found.findings.filter((finding) => finding.rule.startsWith("off-system"));

            assert.deepEqual(off, [], `${colorScheme}: ${JSON.stringify(off)}`);
            assert.equal(
                found.findings.filter((finding) => finding.level === "error").length,
                0,
                JSON.stringify(found.findings),
            );
        }

        // The calls: three design_system calls made the system, then one publish; the check is not a tool call of the agent's own.
        assert.deepEqual(transcript, [
            "design_system scan",
            "design_system init",
            "design_system validate",
            "artifact publish",
        ]);
    },
);

test("the tool refuses a value that is not a token value, with the schema's words, before the engine sees it", () => {
    const refuse = (value: unknown) =>
        validateToolArguments(
            system as never,
            {
                type: "toolCall",
                id: "x",
                name: "design_system",
                arguments: { action: "set", changes: [{ token: "color.a", value }] },
            } as never,
        );

    // The forms that a DTCG token takes pass: text, a number, a list, a color object, a quantity, a shadow, a whole token.
    for (const value of [
        "#7aa2f7",
        400,
        ["Inter", "sans-serif"],
        [0.2, 0, 0, 1],
        { colorSpace: "srgb", components: [0.1, 0.2, 0.3], alpha: 1 },
        { value: 16, unit: "px" },
        { color: "#000", offsetX: "0px", offsetY: "1px", blur: "2px", inset: true },
        [{ color: "#0004", offsetX: "0", offsetY: "4px", blur: "8px" }],
        { $value: "#fff", $type: "color", $description: "White" },
    ]) {
        assert.doesNotThrow(() => refuse(value), JSON.stringify(value));
    }

    // A nested object where a member should be text or a number, and a function-like value, do not.
    assert.throws(() => refuse({ color: { nested: { deeper: [{}] } } }));
});
