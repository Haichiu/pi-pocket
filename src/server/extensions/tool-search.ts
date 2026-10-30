/**
 * Tool search keeps tools that few conversations use out of every request until Pi asks for them. Each of them, with its
 * prompt section, costs tokens on every request of every conversation; here Pi gets one `tool_search` tool and a line
 * that names what it can load, and a search loads the matches for the next call. Loaded tools stay offered on that
 * branch. Turn this module off and every tool below is offered again, as before.
 *
 * Edit `DEFERRED` to choose which tools wait: the name of each, and the prompt section that goes with it, if one does.
 */
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
    defineExtension,
    type PromptSection,
    section,
    type ToolRegistration,
    wrapSection,
    wrapTool,
} from "@earendil-works/pi-durable";

/** Tools that wait to be searched for, each with the key of the prompt section that is shown only once it is loaded. */
const DEFERRED: Record<string, string | undefined> = {
    browser: "browser",
    background: "background_tasks",
    schedule: undefined,
    watch_pr: undefined,
    design_preview: "design_mode",
    design_export: undefined,
    design_system: undefined,
};

export default function createToolSearch() {
    const search = createToolSearchExtension();

    return defineExtension({
        name: "pocket-tool-search",
        tools: search.tools,
        sections: [
            // The names are all Pi needs to ask for one: a search matches them and the descriptions behind them.
            section("deferred_tools", ({ agent }) =>
                agent.deferred.length === 0
                    ? undefined
                    : `Load with tool_search before you use them: ${agent.deferred.map((tool) => tool.name).join(", ")}.`,
            ),
        ],
        wraps: [
            ...Object.keys(DEFERRED).map((name) =>
                wrapTool({ name } as ToolRegistration, (tool) => ({ ...tool, deferred: true })),
            ),
            // A section waits with its tool: its text is of no use while the tool is not offered.
            ...Object.entries(DEFERRED).flatMap(([name, key]) =>
                key === undefined
                    ? []
                    : [
                          wrapSection(key, (inner: PromptSection) => ({
                              ...inner,
                              render: (input, context) =>
                                  input.agent.tools.some((tool) => tool.name === name)
                                      ? inner.render(input, context)
                                      : undefined,
                          })),
                      ],
            ),
        ],
    });
}
