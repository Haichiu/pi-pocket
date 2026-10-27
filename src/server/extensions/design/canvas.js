// The canvas: a design's page in the artifact sandbox frame (the same frame and bridge as the artifact viewer), scaled to
// fit, with the page's side of Design mode (inspect, edit text, tweaks, pins, slides) spoken through the bridge.
import { useArtifactBridge } from "/artifact-bridge.js";
import { percent, scaleOf, stepZoom } from "./devices.js";
import { pinsOf } from "./comments.js";
import { addEdit } from "./edits.js";
import { forPage, normalizeKnobs, usable } from "./tweaks.js";

/** As the artifact viewer's frame (`web/sheets/viewers.js`): scripts and forms run; the app and its cookies are out of reach. */
export const SANDBOX =
    "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";
export const ALLOW = "fullscreen; clipboard-write; accelerometer; gyroscope";

export const frameUrl = (conversation, id, version) =>
    `/a/${conversation}/${encodeURIComponent(id)}/${version}`;

const num = (value) => typeof value === "number" && Number.isFinite(value);

export function createCanvas(env) {
    const { pocket, store, data, parts } = env;
    const { html, useEffect, useRef, useState } = pocket;
    const { Ico, useSize } = parts;

    /** A page at its own size, scaled by `scale`: the box takes the scaled room, the frame inside the full one. */
    function Stage({ size, scale, children, label }) {
        return html`<div
            class="dsn-stage"
            style=${`width:${Math.round(size.w * scale)}px;height:${Math.round(size.h * scale)}px`}
            title=${label}
        >
            <div
                class="dsn-stage-in"
                style=${`width:${size.w}px;height:${size.h}px;transform:scale(${scale})`}
            >
                ${children}
            </div>
        </div>`;
    }

    /** A frame that only shows (compare, thumbnails, the deck's present mode before it is wired): no bridge. */
    function Still({ src, title, interactive = true, lazy = false }) {
        return html`<iframe
            class="dsn-frame"
            src=${src}
            sandbox=${SANDBOX}
            allow=${ALLOW}
            title=${title}
            loading=${lazy ? "lazy" : "eager"}
            style=${interactive ? "" : "pointer-events:none"}
            tabindex=${interactive ? undefined : "-1"}
        ></iframe>`;
    }

    /** The zoom, the size, and the backdrop: a small bar over the canvas. */
    function ZoomBar({ s, size, scale }) {
        const dark = s.backdrop === "dark" || (s.backdrop === "auto" && env.darkTheme());

        return html`<div class="dsn-zoom" role="group" aria-label="Zoom">
            <button
                type="button"
                title="Zoom out"
                aria-label="Zoom out"
                onClick=${() => env.setZoom(stepZoom(scale, -1))}
            >
                <${Ico} name="minus" size=${14} />
            </button>
            <button
                type="button"
                class="dsn-zoom-value"
                title=${s.zoom === "fit" ? "Fits the room. Tap for 100%." : "Fit to the room"}
                onClick=${() => env.setZoom(s.zoom === "fit" ? 1 : "fit")}
            >
                ${s.zoom === "fit" ? "Fit " : ""}${percent(scale)}
            </button>
            <button
                type="button"
                title="Zoom in"
                aria-label="Zoom in"
                onClick=${() => env.setZoom(stepZoom(scale, 1))}
            >
                <${Ico} name="plus" size=${14} />
            </button>
            <span class="dsn-zoom-size mono">${size.w}×${size.h}</span>
            <button
                type="button"
                title=${dark ? "Light backdrop" : "Dark backdrop"}
                aria-label=${dark ? "Light backdrop" : "Dark backdrop"}
                onClick=${() => env.setBackdrop(dark ? "light" : "dark")}
            >
                <${Ico} name=${dark ? "sun" : "moon"} size=${14} />
            </button>
        </div>`;
    }

    /** The design's page, in the frame with the bridge, scaled to the room. */
    function CanvasView({ s, design, version, size, readOnly }) {
        const room = useRef(null);
        const frame = useRef(null);
        const roomSize = useSize(room);
        const [ready, setReady] = useState(0);
        const [loaded, setLoaded] = useState(false);
        const sent = useRef({ at: -1, values: {} });
        const scale = scaleOf(s.zoom, size, roomSize);
        const src = frameUrl(s.conversation, design.id, version);
        const key = `${src}#${s.reload}`;
        const notes = s.notes[design.id];
        const comments = notes?.comments ?? [];
        const pins = s.mode === "comment" || s.dock === "comments" ? pinsOf(comments, version) : [];
        const knobs = s.knobs;
        const values = s.tweaks[design.id] ?? {};

        // What the page says: the module's own handlers, current at every call (the bridge keeps the latest ones).
        const hear = useRef(null);

        hear.current = (message) => {
            if (!message || typeof message !== "object") {
                return;
            }

            const state = store.get();

            if (message.type === "pocket-picked" && state.mode === "comment" && !readOnly) {
                store.set({
                    draft: { artifact: design.id, version, target: message.target },
                    dock: "comments",
                });
            } else if (
                message.type === "pocket-text-edited" &&
                state.mode === "edit" &&
                !readOnly &&
                message.target &&
                typeof message.before === "string" &&
                typeof message.after === "string"
            ) {
                const at = `${design.id}@${version}`;

                store.set((now) => ({
                    edits: {
                        ...now.edits,
                        [at]: addEdit(now.edits[at] ?? [], {
                            target: message.target,
                            before: message.before,
                            after: message.after,
                        }),
                    },
                }));
            } else if (message.type === "pocket-tweaks") {
                store.set({ knobs: normalizeKnobs(message.knobs) });
            } else if (
                message.type === "pocket-deck" &&
                num(message.slides) &&
                message.slides > 0 &&
                num(message.current)
            ) {
                store.set({
                    deck: {
                        slides: Math.min(500, Math.round(message.slides)),
                        current: Math.max(0, Math.round(message.current)),
                    },
                });
            }
        };

        const bridge = useArtifactBridge(frame, {
            artifact: design.id,
            source: `the design “${design.title}”`,
            enabled: true,
            onMessage: (message) => hear.current(message),
            onReady: () => setReady((count) => count + 1),
        });
        const supported = typeof bridge?.send === "function";
        const send = (message) => (supported ? bridge.send(message) === true : false);

        // For other parts of the workspace (the slide strip, the dock): a way to talk to this frame.
        env.frame.current = {
            send,
            supported,
            goto: (slide) => send({ type: "pocket-goto", slide }),
        };

        useEffect(() => () => (env.frame.current = null), []);
        useEffect(() => void store.set({ bridge: supported }), [supported]);

        // A new page: what it said about itself is gone until it says it again.
        useEffect(() => {
            setLoaded(false);
            store.set({ knobs: [], deck: null });
        }, [key]);

        // The mode: the page's inspector for a comment, contenteditable text for an edit.
        useEffect(() => {
            send({ type: "pocket-inspect", on: s.mode === "comment" && !readOnly });
            send({ type: "pocket-edit-text", on: s.mode === "edit" && !readOnly });
        }, [ready, s.mode, readOnly]);

        // Numbered pins on the elements that have open comments on this version.
        const pinKey = pins.map((comment) => comment.id).join();

        useEffect(() => {
            send({ type: "pocket-highlight", targets: pins.map((comment) => comment.target) });
        }, [ready, pinKey]);

        // The saved tweaks, once the page has said what its knobs are and the server what was saved.
        useEffect(() => {
            if (knobs.length > 0 && notes?.loaded && s.tweaks[design.id] === undefined) {
                store.set((now) => ({
                    tweaks: { ...now.tweaks, [design.id]: usable(knobs, notes.tweaks) },
                }));
            }
        }, [knobs, notes?.loaded]);

        // Tweaks to the page: only what differs from what it was last told (a fresh page has been told nothing).
        useEffect(() => {
            if (sent.current.at !== ready) {
                sent.current = { at: ready, values: {} };
            }

            const out = {};
            const next = { ...sent.current.values };

            for (const knob of knobs) {
                const own = Object.hasOwn(values, knob.name);
                const want = own ? forPage(knob, values[knob.name]) : undefined;

                if (want !== sent.current.values[knob.name]) {
                    out[knob.name] = want === undefined ? forPage(knob, knob.value) : want;
                    next[knob.name] = want;
                }
            }

            if (Object.keys(out).length > 0 && send({ type: "pocket-tweak-set", values: out })) {
                sent.current.values = next;
            }
        }, [ready, knobs, values]);

        return html`<div
            class="dsn-canvas"
            ref=${room}
            data-backdrop=${s.backdrop}
            data-mode=${s.mode}
        >
            <div class="dsn-scroll" data-no-swipe>
                <${Stage} size=${size} scale=${scale} label=${design.title}>
                    <iframe
                        ref=${frame}
                        key=${key}
                        class=${`dsn-frame ${loaded ? "loaded" : ""}`}
                        src=${src}
                        sandbox=${SANDBOX}
                        allow=${ALLOW}
                        title=${design.title}
                        onLoad=${() => setLoaded(true)}
                    ></iframe>
                <//>
            </div>
            ${!loaded && html`<div class="dsn-loading"><${pocket.Spinner} label="Loading the design" /></div>`}
            ${
                s.mode === "comment" &&
                !s.draft &&
                html`<div class="dsn-hint">
                    ${
                        supported
                            ? "Tap an element to comment on it"
                            : "Pointing needs the frame's inspector"
                    }
                </div>`
            }
            ${
                s.mode === "edit" &&
                html`<div class="dsn-hint">
                    ${supported ? "Tap text to change it" : "Editing needs the frame's inspector"}
                </div>`
            }
            <${ZoomBar} s=${s} size=${size} scale=${scale} />
        </div>`;
    }

    return { Stage, Still, CanvasView, ZoomBar };
}
