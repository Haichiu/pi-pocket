// Your messages' browser module: a sheet that lists the people's messages in the session the tab shows, newest first, with
// a filter. A tap jumps to the message in the transcript, where tapping it again offers to edit it and send it again,
// which forks the session from there. It uses only `pocket`.
export const pocketApi = 1;

/** Lucide's list icon. */
const LIST_PATH = "M3 12h.01 M3 18h.01 M3 6h.01 M8 12h13 M8 18h13 M8 6h13";
/** Messages read at most: 10 pages of 200. Older ones are left out, and the sheet says so. */
const PAGE = 200;
const MAX_PAGES = 10;

/** "14:05" today, else "Oct 3, 14:05". */
function when(at) {
    if (at === null) {
        return "";
    }

    const date = new Date(at);
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    return date.toDateString() === new Date().toDateString()
        ? time
        : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;

    // An app older than 0.20.0 cannot read a session's messages.
    if (typeof pocket.messages !== "function" || typeof pocket.reveal !== "function") {
        return;
    }

    function OutlineSheet({ close }) {
        const [state, setState] = useState({ loading: true, messages: [], more: false });
        const [error, setError] = useState(null);
        const [filter, setFilter] = useState("");
        const field = useRef(null);
        const conversation = pocket.conversationId();

        useEffect(() => {
            const stop = new AbortController();

            (async () => {
                let before = null;
                let messages = [];
                let pages = 0;

                do {
                    const page = await pocket.messages({
                        before,
                        limit: PAGE,
                        signal: stop.signal,
                    });

                    // The tab moved to another session meanwhile: this list is not of it.
                    if (page.conversationId !== conversation) {
                        return;
                    }

                    messages = [...page.messages, ...messages];
                    before = page.before;
                    pages++;
                } while (before !== null && pages < MAX_PAGES);

                setState({ loading: false, messages, more: before !== null });
            })().catch((failure) => {
                if (!stop.signal.aborted) {
                    setError(failure.message);
                    setState((was) => ({ ...was, loading: false }));
                }
            });

            return () => stop.abort();
        }, [conversation]);

        // Ready to type with a keyboard; a phone's keyboard waits for a tap, so it does not cover the list.
        useEffect(() => {
            if (!matchMedia("(pointer: coarse)").matches) {
                field.current?.focus();
            }
        }, []);

        if (conversation === null) {
            return html`<p class="muted">Open a session to see its messages.</p>`;
        }

        const words = filter.trim().toLowerCase();
        const authors = new Set(state.messages.map((message) => message.by.id));
        const numbered = state.messages.map((message, index) => ({
            ...message,
            number: index + 1,
        }));
        const shown = numbered
            .filter((message) => words === "" || message.text.toLowerCase().includes(words))
            .reverse();

        const jump = async (message) => {
            close();

            if (!(await pocket.reveal(message.id))) {
                pocket.notify("warning", "That message is not in this session's transcript.");
            }
        };

        return html`<div class="outline-sheet">
            <input
                ref=${field}
                class="outline-filter"
                type="search"
                placeholder="Filter your messages"
                aria-label="Filter messages"
                value=${filter}
                onInput=${(event) => setFilter(event.currentTarget.value)}
            />
            <p class="muted small">
                Tap a message to jump to it. There, tap it to edit it and send it again: that forks
                the session from that point.
            </p>
            ${error && html`<div class="error-box">${error}</div>`}
            ${state.loading && html`<${pocket.Loader} label="Reading messages" />`}
            ${
                !state.loading &&
                shown.length === 0 &&
                !error &&
                html`<p class="muted">
                    ${state.messages.length === 0 ? "No messages yet." : "No message has those words."}
                </p>`
            }
            <ol class="outline-list">
                ${shown.map(
                    (message) =>
                        html`<li key=${message.id}>
                            <button class="outline-row" onClick=${() => jump(message)}>
                                <span class="outline-meta">
                                    ${`#${message.number}${authors.size > 1 && message.by.name ? ` · ${message.by.name}` : ""}${message.at === null ? "" : ` · ${when(message.at)}`}`}
                                </span>
                                <span class="outline-text">
                                    ${message.text.trim() === "" ? "(files only)" : message.text}
                                </span>
                            </button>
                        </li>`,
                )}
            </ol>
            ${
                state.more &&
                html`<p class="muted small">
                    Only the newest ${PAGE * MAX_PAGES} messages are listed.
                </p>`
            }
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "outline", title: "Your messages", component: OutlineSheet });
    pocket.menu({
        id: "outline",
        label: "Your messages",
        hint: "Jump to one, or find a place to fork",
        group: "session",
        sheet: "outline",
    });
    pocket.launcher({
        id: "outline",
        label: "Jump to one of your messages",
        detail: "A list of the people's messages in this session",
        iconPath: LIST_PATH,
        keywords: ["outline", "messages", "fork", "timeline", "prompts"],
        sheet: "outline",
    });
}
