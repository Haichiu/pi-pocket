/**
 * Tool search keeps tools that few conversations use out of every request until Pi asks for them. Each of them, with its
 * prompt section, costs tokens on every request of every conversation; here Pi gets one `tool_search` tool and a line
 * that names what it can load, and a search loads the matches for the next call. Loaded tools stay offered on that
 * branch. Turn this module off and every tool below is offered again, as before.
 *
 * Edit `DEFERRED` to choose which tools wait: what each is for, and the prompt section that goes with it, if one does.
 */
import {
    createToolSearchExtension,
    TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import {
    defineExtension,
    type PromptSection,
    section,
    type ToolRegistration,
    wrapSection,
    wrapTool,
} from "@earendil-works/pi-durable";

/** What loading a search matches at most, when the query is not the names of tools. */
const SEARCH_LIMIT = 2;

/** Tools that wait to be searched for: what each is for, and the key of the prompt section shown once it is loaded. */
const DEFERRED: Record<string, { use: string; section?: string }> = {
    browser: { use: "open and test web pages in a real browser", section: "browser" },
    background: {
        use: "run a dev server or other long command, instead of bash",
        section: "background_tasks",
    },
    schedule: { use: "send yourself a message later" },
    watch_pr: { use: "watch a pull request's checks" },
    design_preview: {
        use: "load it, then read its guide, before you make or change a design",
        section: "design_mode",
    },
    design_export: { use: "export a design" },
    design_system: { use: "read or write the project's design system" },
};

export default function createToolSearch() {
    const base = createToolSearchExtension();
    const search = base.tools![0]!;

    // A query that is only names of waiting tools loads exactly those: a BM25 search for "browser" also matches every
    // tool whose text mentions one, and each load is kept for the branch.
    const exact: ToolRegistration = {
        ...search,
        async execute(args: { query: string; limit?: number }, api, context) {
            const names = String(args.query)
                .split(/[\s,]+/)
                .filter(Boolean);
            const waiting = (await api.agent(context)).deferred.map((tool) => tool.name);

            if (names.length > 0 && names.every((name) => waiting.includes(name))) {
                return {
                    output: [
                        {
                            type: "text",
                            text: `Loaded ${names.join(", ")}. Use them from your next call.`,
                        },
                    ],
                    details: { loaded: names },
                    control: { addTools: names },
                };
            }

            return search.execute(
                { ...args, limit: args.limit ?? SEARCH_LIMIT } as never,
                api,
                context,
            );
        },
    } as ToolRegistration;

    return defineExtension({
        name: "pocket-tool-search",
        tools: [exact],
        sections: [
            section("deferred_tools", ({ agent }) =>
                agent.deferred.length === 0
                    ? undefined
                    : `Load a tool before you use it: ${TOOL_SEARCH_TOOL_NAME} with its name as the query. Waiting:\n${agent.deferred
                          .map(
                              (tool) =>
                                  `- ${tool.name}: ${DEFERRED[tool.name]?.use ?? tool.description.split(".")[0]}`,
                          )
                          .join("\n")}`,
            ),
        ],
        wraps: [
            ...Object.keys(DEFERRED).map((name) =>
                wrapTool({ name } as ToolRegistration, (tool) => ({ ...tool, deferred: true })),
            ),
            // A section waits with its tool: its text is of no use while the tool is not offered.
            ...Object.entries(DEFERRED).flatMap(([name, { section: key }]) =>
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
