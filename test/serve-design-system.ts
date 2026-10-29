// node test/serve-design-system.ts [port] [host] [--no-system | --flagship]

// helpers.ts first: it points Pi's folder at a temporary one before anything from src/ loads.
import { cleanUp, newSession, openApp, root, say, scriptedModel, work } from "./helpers.ts";
import { cpSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { APP_ROOT } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { watchTree } from "../src/server/reload.ts";
import { publishAll, publishDesign } from "./design-fixtures.ts";
import { ferryPage, writeSystemFixture } from "./design-system-fixtures.ts";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";

const args = process.argv.slice(2).filter((each) => !each.startsWith("--"));
const port = Number(args[0] ?? 8913);
const host = args[1] ?? "127.0.0.13";
const app = await openApp(scriptedModel());
const server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));
const stopWatching = watchTree(join(APP_ROOT, "web"), (file) => app.reloadClients(file));

app.loader.watch();
app.themes.watch();

await new Promise<void>((resolve) => server.listen(port, host, resolve));

const session = await newSession(app);

if (process.argv.includes("--flagship")) {
    cpSync(
        new URL("../docs/examples/design-system/pocket/.pi", import.meta.url),
        join(work, ".pi"),
        {
            recursive: true,
        },
    );
} else if (!process.argv.includes("--no-system")) {
    writeSystemFixture(work);
}

await publishAll(app, session);

const system = process.argv.includes("--no-system") ? undefined : loadDesignSystem(work);

await publishDesign(app, session, {
    id: "ferry",
    title: "Ferry booking",
    content: ferryPage(system?.compiled.css ?? ""),
});
await say(app, session, "Hello from the copy");

const guest = app.config.addUser("Guest", "guest");
const viewer = app.config.addUser("Viewer", "viewer");
const base = `http://${host}:${port}`;

console.log(`A copy of Pi Pocket with a design system, data in ${root}`);
console.log(`  session: ${base}/s/${session}`);
console.log(`  owner:  ${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
console.log(`  guest:  ${base}/login?token=${encodeURIComponent(guest.token)}`);
console.log(`  viewer: ${base}/login?token=${encodeURIComponent(viewer.token)}`);
console.log(`Ctrl+C, or kill ${process.pid}, stops it and deletes its data.`);

const stop = async () => {
    stopWatching();
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
