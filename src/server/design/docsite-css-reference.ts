/** The page's CSS for the guidelines (rendered Markdown), the token table, and the footer. */
export const CSS_REFERENCE = `/* ── Guidelines (rendered Markdown) ────────────────────── */

.prose {
    max-width: 72ch;
    margin-top: 16px;
}

.prose > * + * {
    margin-top: 12px;
}

.prose h3, .prose h4, .prose h5, .prose h6 {
    margin-top: 32px;
}

.prose h3 {
    font-size: 22px;
}

.prose h4 {
    font-size: 17px;
}

.prose h5 {
    font-size: 15px;
}

.prose ul, .prose ol {
    display: grid;
    gap: 6px;
    padding-left: 22px;
}

.prose code, .desc code, .sub code {
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--dd-sunken);
    font-size: 0.9em;
}

.prose pre {
    padding: 14px 16px;
    overflow-x: auto;
    border-radius: 10px;
    background: var(--dd-sunken);
    font-size: 13px;
}

.prose pre code {
    padding: 0;
    background: none;
}

.prose blockquote {
    padding: 4px 16px;
    border-left: 3px solid var(--dd-accent);
    color: var(--dd-muted);
}

.prose hr {
    border: 0;
    border-top: 1px solid var(--dd-line);
}

.prose .table-wrap {
    max-width: none;
}

/* ── Reference table ───────────────────────────────────── */

.ref td {
    vertical-align: top;
}

.ref .tk {
    margin: 0 6px 4px 0;
}

.empty {
    margin-top: 32px;
    padding: 28px;
    border: 1px dashed var(--dd-line-strong);
    border-radius: var(--dd-radius);
    color: var(--dd-muted);
    text-align: center;
}

.foot {
    max-width: 1040px;
    margin-top: 72px;
    padding-top: 20px;
    border-top: 1px solid var(--dd-line);
    color: var(--dd-faint);
    font-size: 13px;
}

.toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    z-index: 90;
    padding: 9px 16px;
    border-radius: 999px;
    background: var(--dd-text);
    color: var(--dd-bg);
    font-size: 13px;
    font-weight: 600;
    opacity: 0;
    transform: translate(-50%, 12px);
    transition: opacity 160ms, transform 160ms;
    pointer-events: none;
}

.toast.show {
    opacity: 1;
    transform: translate(-50%, 0);
}


/* ── Links to headings, the token table's toolbar, and code blocks ─────── */

.anchor {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: 6px;
    border-radius: 6px;
    color: var(--dd-faint);
    opacity: 0;
    text-decoration: none;
    vertical-align: middle;
    transition: opacity 120ms;
}

.anchor::before {
    width: 16px;
    height: 16px;
    background: currentcolor;
    content: "";
    -webkit-mask: url("data:image/svg+xml,%3Csvg viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8'/%3E%3Cpath d='M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l.8-.8'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8'/%3E%3Cpath d='M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l.8-.8'/%3E%3C/svg%3E") center / contain no-repeat;
}

h2:hover .anchor,
h3:hover .anchor,
.anchor:focus-visible {
    opacity: 1;
}

.anchor:hover {
    background: var(--dd-accent-soft);
    color: var(--dd-accent);
}

@media (hover: none) {
    .anchor {
        opacity: 0.5;
    }
}

:target > h2,
:target > .comp-head h3 {
    scroll-margin-top: calc(var(--dd-top) + 16px);
}

.toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
}

.toolbar input,
.toolbar select {
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 10px;
    background: var(--dd-panel);
    color: var(--dd-text);
    font: inherit;
    font-size: 16px;
}

.toolbar input {
    flex: 1 1 240px;
}

.rows-count {
    margin-left: auto;
    color: var(--dd-faint);
    font: 12.5px var(--dd-mono);
}

tr.more td {
    padding: 14px;
    text-align: center;
}

tr.more button {
    min-height: 40px;
    padding: 0 18px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 10px;
    background: var(--dd-panel);
    font-weight: 600;
}

/* The "use it" cards in a row are as tall as the tallest; their code scrolls, with the scroll bar in view. */
.uses {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr));
    align-items: stretch;
}

.use {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.use .snip-wrap {
    display: flex;
    flex: 1;
}

.use pre.snip {
    flex: 1;
    max-height: none;
    min-width: 0;
    overflow: auto;
    white-space: pre;
}

/* A block that scrolls shows its scroll bar, in every browser: the default ones hide until touched. */
pre.snip {
    scrollbar-color: var(--dd-line-strong) var(--dd-sunken);
    scrollbar-width: thin;
}

pre.snip::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

pre.snip::-webkit-scrollbar-track {
    border-radius: 6px;
    background: var(--dd-sunken);
}

pre.snip::-webkit-scrollbar-thumb {
    border: 2px solid var(--dd-sunken);
    border-radius: 6px;
    background: var(--dd-line-strong);
}

`;
