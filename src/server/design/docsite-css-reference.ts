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

`;
