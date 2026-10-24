// Links between linked sessions, above the transcript. Only the server's list for this person may name one. The
// sessions this one started fold under a heading, as this browser last chose.
import { useState } from "preact/hooks";
import { navigate, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** Links shown before the rest fold into "+N more": a coordinator's transcript stays near the top on a phone. */
const SHOWN = 3;
/** Whether the list is folded to its heading: this browser's choice, for every session, kept across reloads. */
const FOLDED_KEY = "pocket.linkedSessions.folded";

function readFolded() {
    try {
        return localStorage.getItem(FOLDED_KEY) === "1";
    } catch {
        return false;
    }
}

export function LinkedSessions() {
    const { conversationId, sessions, sessionsLoaded } = store.state;
    // Unfolded for one session: another one opens folded.
    const [openFor, setOpenFor] = useState(null);
    const open = openFor === conversationId;
    const [folded, setFolded] = useState(readFolded);

    const toggle = () => {
        setFolded(!folded);

        try {
            localStorage.setItem(FOLDED_KEY, folded ? "0" : "1");
        } catch {
            // Storage refused (a private window): it holds until the page reloads.
        }
    };

    if (!sessionsLoaded) {
        return null;
    }

    const current = sessions.find((session) => session.id === conversationId);
    const origin =
        current?.linkedFrom && sessions.find((session) => session.id === current.linkedFrom.id);
    const started = sessions.filter((session) => session.linkedFrom?.id === conversationId);

    if (!origin && !current?.linkedOrigin && !current?.linkedFrom && started.length === 0) {
        return null;
    }

    const link = (session, label) => html`<button
        class="breadcrumb"
        key=${session.id}
        onClick=${() => navigate(session.id)}
    >
        <${Icon} name="fork" size=${14} />
        <span>${label}: ${session.title ?? "New session"}</span>
    </button>`;
    const shown = open || started.length <= SHOWN ? started : started.slice(0, SHOWN);
    const count = started.length === 1 ? "1 linked session" : `${started.length} linked sessions`;

    return html`<nav class="linked-sessions" aria-label="Linked sessions">
        ${
            origin
                ? link(origin, "Started from")
                : (current?.linkedOrigin || current?.linkedFrom) &&
                  html`<p class="muted small">
                Started from another session
            </p>`
        }
        ${
            started.length > 0 &&
            html`<button
                class=${`breadcrumb linked-sessions-fold${folded ? "" : " open"}`}
                aria-expanded=${!folded}
                onClick=${toggle}
            >
                <span class="linked-sessions-chevron">
                    <${Icon} name="chevron" size=${14} />
                </span>
                <span>${count}</span>
            </button>`
        }
        ${!folded && shown.map((session) => link(session, "Linked session"))}
        ${
            !folded &&
            shown.length < started.length &&
            html`<button class="breadcrumb" onClick=${() => setOpenFor(conversationId)}>
                +${started.length - shown.length} more
            </button>`
        }
        ${
            !folded &&
            open &&
            started.length > SHOWN &&
            html`<button class="breadcrumb" onClick=${() => setOpenFor(null)}>Show fewer</button>`
        }
    </nav>`;
}
