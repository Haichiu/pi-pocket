export const CSS_BASE = `
:root {
    color-scheme: light;
    --dd-bg: #fafafc;
    --dd-panel: #ffffff;
    --dd-sunken: #f1f2f7;
    --dd-line: #e3e5ee;
    --dd-line-strong: #c9cddb;
    --dd-text: #14161f;
    --dd-muted: #566079;
    --dd-faint: #7a8299;
    --dd-ok: #17703f;
    --dd-ok-soft: #e4f4ea;
    --dd-bad: #b0233b;
    --dd-bad-soft: #fbe6ea;
    --dd-warn: #84560a;
    --dd-warn-soft: #faf0dc;
    --dd-accent: #3557a5;
    --dd-accent-ink: #ffffff;
    --dd-accent-soft: #e9eefb;
    --dd-radius: 12px;
    --dd-radius-sm: 8px;
    --dd-shadow: 0 1px 2px rgb(20 22 31 / 0.06), 0 8px 24px -12px rgb(20 22 31 / 0.18);
    --dd-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --dd-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --dd-side: 272px;
    --dd-top: 56px;
}

html[data-theme="dark"] {
    color-scheme: dark;
    --dd-bg: #0e0f15;
    --dd-panel: #161822;
    --dd-sunken: #11121a;
    --dd-line: #262938;
    --dd-line-strong: #3a3f55;
    --dd-text: #eceef7;
    --dd-muted: #a3abc4;
    --dd-faint: #7f87a1;
    --dd-ok: #7fd49e;
    --dd-ok-soft: #14291d;
    --dd-bad: #ff93a6;
    --dd-bad-soft: #3a161e;
    --dd-warn: #eab85a;
    --dd-warn-soft: #33270e;
    --dd-accent: #8fb0ff;
    --dd-accent-ink: #0e0f15;
    --dd-accent-soft: #1b2340;
    --dd-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 12px 30px -12px rgb(0 0 0 / 0.6);
}

* {
    box-sizing: border-box;
}

html {
    scroll-behavior: smooth;
    scroll-padding-top: calc(var(--dd-top) + 16px);
    -webkit-text-size-adjust: 100%;
}

body {
    margin: 0;
    background: var(--dd-bg);
    color: var(--dd-text);
    font: 15px/1.6 var(--dd-sans);
    -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4, p, ul, ol, dl, dd, figure, pre {
    margin: 0;
}

button {
    font: inherit;
    color: inherit;
    cursor: pointer;
}

code, pre, .mono {
    font-family: var(--dd-mono);
}

a {
    color: var(--dd-accent);
}

:focus-visible {
    outline: 2px solid var(--dd-accent);
    outline-offset: 2px;
    border-radius: 4px;
}

[hidden] {
    display: none !important;
}

.skip {
    position: absolute;
    left: 12px;
    top: -60px;
    z-index: 100;
    padding: 8px 12px;
    border-radius: var(--dd-radius-sm);
    background: var(--dd-accent);
    color: var(--dd-accent-ink);
    font-weight: 600;
    text-decoration: none;
}

.skip:focus {
    top: 8px;
}

/* ── Shell ─────────────────────────────────────────────── */

.topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--dd-top);
    padding: 0 16px;
    border-bottom: 1px solid var(--dd-line);
    background: color-mix(in srgb, var(--dd-bg) 86%, transparent);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
}

.brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    font-weight: 650;
    letter-spacing: -0.01em;
}

.brand-mark {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: linear-gradient(135deg, var(--dd-accent), color-mix(in srgb, var(--dd-accent) 40%, var(--dd-bg)));
}

.brand-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.brand-sub {
    color: var(--dd-faint);
    font-weight: 500;
}

.spacer {
    flex: 1;
}

.icon-btn {
    display: none;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    margin-left: -8px;
    border: 0;
    border-radius: var(--dd-radius-sm);
    background: transparent;
}

.icon-btn:hover {
    background: var(--dd-sunken);
}

.icon-btn svg {
    width: 20px;
    height: 20px;
}

.seg {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--dd-line);
    border-radius: 10px;
    background: var(--dd-sunken);
}

.seg button {
    min-height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--dd-muted);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
}

.seg button:hover {
    color: var(--dd-text);
}

.seg button[aria-pressed="true"] {
    background: var(--dd-panel);
    color: var(--dd-text);
    box-shadow: 0 0 0 1px var(--dd-line), 0 1px 2px rgb(0 0 0 / 0.08);
}

.layout {
    display: grid;
    grid-template-columns: var(--dd-side) minmax(0, 1fr);
    align-items: start;
}

.side {
    position: sticky;
    top: var(--dd-top);
    height: calc(100vh - var(--dd-top));
    height: calc(100dvh - var(--dd-top));
    overflow-y: auto;
    padding: 20px 14px 40px 16px;
    border-right: 1px solid var(--dd-line);
}

.search {
    position: relative;
    margin-bottom: 18px;
}

.search input {
    width: 100%;
    min-height: 40px;
    padding: 0 40px 0 36px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 10px;
    background: var(--dd-panel);
    color: var(--dd-text);
    font: inherit;
    font-size: 16px;
}

.search input::placeholder {
    color: var(--dd-faint);
}

.search svg {
    position: absolute;
    left: 11px;
    top: 12px;
    width: 16px;
    height: 16px;
    color: var(--dd-faint);
    pointer-events: none;
}

.search kbd {
    position: absolute;
    right: 9px;
    top: 9px;
    padding: 1px 7px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 5px;
    color: var(--dd-faint);
    font: 12px/18px var(--dd-mono);
    pointer-events: none;
}

.nav-group + .nav-group {
    margin-top: 18px;
}

.nav-title {
    margin: 0 10px 6px;
    color: var(--dd-faint);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.nav a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    border-radius: 8px;
    color: var(--dd-muted);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
}

.nav a:hover {
    background: var(--dd-sunken);
    color: var(--dd-text);
}

.nav a[aria-current="true"] {
    background: var(--dd-accent-soft);
    color: var(--dd-accent);
    font-weight: 650;
}

.nav .count {
    color: var(--dd-faint);
    font: 12px var(--dd-mono);
}

main {
    min-width: 0;
    padding: 0 clamp(16px, 4vw, 56px) 96px;
}

section.block {
    max-width: 1040px;
    padding-top: 56px;
}

section.block#overview {
    padding-top: 24px;
}

.eyebrow {
    margin-bottom: 8px;
    color: var(--dd-accent);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

h1 {
    font-size: clamp(34px, 5vw, 52px);
    font-weight: 750;
    line-height: 1.05;
    letter-spacing: -0.03em;
}

h2 {
    font-size: clamp(26px, 3.4vw, 34px);
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.02em;
}

h3 {
    margin-top: 40px;
    margin-bottom: 4px;
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.01em;
}

h4 {
    font-size: 15px;
    font-weight: 650;
}

.lead {
    max-width: 58ch;
    text-wrap: balance;
    margin-top: 14px;
    color: var(--dd-muted);
    font-size: 17px;
}

.intro {
    max-width: 66ch;
    margin-top: 10px;
    color: var(--dd-muted);
}

.counts {
    margin-top: 8px;
    color: var(--dd-faint);
    font: 600 12.5px var(--dd-mono);
    letter-spacing: 0.01em;
}

.sub {
    max-width: 66ch;
    margin-bottom: 14px;
    color: var(--dd-muted);
    font-size: 14px;
}

`;
