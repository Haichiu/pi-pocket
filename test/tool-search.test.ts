// Tool search: tools that few conversations use (and their prompt sections) wait until Pi searches for them.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

let app: App;
/** The sections of the newest request, by name: every system message adds the ones that changed since the last. */
let sections: Record<string, string> = {};

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    sections = Object.assign(
        {},
        ...(request.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    ) as Record<string, string>;

    if (role !== "toolResult" && text.includes("need the browser")) {
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "browser" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    cleanUp();
});

async function agent(id: ConversationId) {
    const each = await (await app.conversation(id)).agent(context);

    return {
        offered: each.tools.map((tool) => tool.name),
        waiting: each.deferred.map((tool) => tool.name),
    };
}

test("a new conversation is offered tool_search, not the tools that wait, and their sections stay out", async () => {
    const id = await newSession(app);
    const { offered, waiting } = await agent(id);

    assert.ok(offered.includes("tool_search"));
    assert.ok(offered.includes("artifact"), "tools in common use are offered");

    for (const name of ["browser", "background", "schedule", "design_preview", "design_system"]) {
        assert.ok(!offered.includes(name), `${name} waits`);
        assert.ok(waiting.includes(name), `${name} can be loaded`);
    }

    await say(app, id, "hello");

    assert.match(sections.deferred_tools ?? "", /browser.*design_preview/);

    for (const key of ["browser", "background_tasks", "design_mode"]) {
        assert.equal(sections[key], undefined, `${key} is not shown while its tool waits`);
    }
});

test("a search loads the matches, with their section, for the rest of the conversation", async () => {
    const id = await newSession(app);

    await say(app, id, "need the browser");
    await say(app, id, "and now?");

    const { offered, waiting } = await agent(id);

    assert.ok(offered.includes("browser"), "browser is offered after the search");
    assert.ok(!waiting.includes("browser"));
    assert.ok(!offered.includes("schedule"), "a tool the search did not match still waits");
    assert.match(sections.browser ?? "", /Chromium/);
    assert.doesNotMatch(sections.deferred_tools ?? "", /browser/);
});
