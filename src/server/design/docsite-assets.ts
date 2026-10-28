/**
 * The look and the behavior of the design-system documentation page (docsite.ts), as two text constants. The page is a
 * self-contained artifact that runs in the sandbox, so both are inline: no font, image, or script is fetched. The chrome
 * (navigation, cards, tables) uses its own `--dd-*` properties, so it never depends on the system it documents; the
 * system's tokens are scoped to `body.ds`, where the specimens read them.
 */

/** The CSS of the page. `--dd-accent` and the accent ink are set per theme by docsite.ts. */
export const DOC_CSS = `
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

.sub {
    max-width: 66ch;
    margin-bottom: 14px;
    color: var(--dd-muted);
    font-size: 14px;
}

/* ── Overview ──────────────────────────────────────────── */

.hero {
    position: relative;
    padding: clamp(24px, 4vw, 48px);
    overflow: hidden;
    border: 1px solid var(--dd-line);
    border-radius: 20px;
    background:
        radial-gradient(900px 300px at 100% 0%, color-mix(in srgb, var(--dd-accent) 16%, transparent), transparent 70%),
        var(--dd-panel);
}

.strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 28px;
}

.sw {
    display: grid;
    gap: 5px;
    justify-items: center;
    width: 64px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--dd-muted);
}

.sw i {
    width: 100%;
    height: 34px;
    border-radius: 9px;
    box-shadow: inset 0 0 0 1px rgb(128 128 128 / 0.28);
    transition: transform 120ms;
}

.sw:hover i,
.sw:focus-visible i {
    transform: translateY(-2px);
}

.sw span {
    max-width: 100%;
    font: 10.5px/1.2 var(--dd-mono);
    overflow-wrap: anywhere;
    text-align: center;
}

.copy-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 4px;
}

.mini {
    min-height: 26px;
    padding: 0 9px;
    border: 1px solid var(--dd-line);
    border-radius: 6px;
    background: var(--dd-sunken);
    color: var(--dd-muted);
    font: 600 11.5px var(--dd-sans);
}

.mini:hover {
    border-color: var(--dd-accent);
    color: var(--dd-accent);
}

.mini.flash {
    border-color: var(--dd-ok);
    background: var(--dd-ok-soft);
    color: var(--dd-ok);
}

.modesel {
    display: none;
    min-height: 36px;
    padding: 0 10px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 10px;
    background: var(--dd-panel);
    color: var(--dd-text);
    font: inherit;
    font-size: 16px;
}

.stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
    margin-top: 28px;
}

.stat {
    padding: 14px 16px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: color-mix(in srgb, var(--dd-panel) 70%, transparent);
}

.stat b {
    display: block;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.1;
}

.stat span {
    color: var(--dd-muted);
    font-size: 13px;
}

.tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
    gap: 12px;
    margin-top: 24px;
}

.tile {
    display: grid;
    gap: 4px;
    padding: 16px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
    color: inherit;
    text-decoration: none;
    transition: border-color 140ms, transform 140ms;
}

.tile:hover {
    border-color: var(--dd-accent);
    transform: translateY(-1px);
}

.tile b {
    font-size: 15px;
}

.tile span {
    color: var(--dd-muted);
    font-size: 13px;
}

details.notes {
    margin-top: 18px;
    padding: 12px 16px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

details.notes summary {
    cursor: pointer;
    font-weight: 600;
}

details.notes ul {
    margin-top: 10px;
    padding-left: 20px;
    color: var(--dd-muted);
    font-size: 14px;
}

/* ── Cards and swatches ────────────────────────────────── */

.cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr));
    gap: 14px;
    margin-top: 16px;
}

.card {
    overflow: hidden;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.sw-chip {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    width: 100%;
    min-height: 92px;
    padding: 10px 12px;
    border: 0;
    border-bottom: 1px solid var(--dd-line);
    border-radius: 0;
    background-color: transparent;
    background-image:
        linear-gradient(45deg, rgb(128 128 128 / 0.16) 25%, transparent 25%, transparent 75%, rgb(128 128 128 / 0.16) 75%),
        linear-gradient(45deg, rgb(128 128 128 / 0.16) 25%, transparent 25%, transparent 75%, rgb(128 128 128 / 0.16) 75%);
    background-position: 0 0, 6px 6px;
    background-size: 12px 12px;
    text-align: left;
}

.sw-fill {
    position: absolute;
    inset: 0;
}

.sw-chip > span:not(.sw-fill) {
    position: relative;
}

.aa {
    font-size: 26px;
    font-weight: 650;
    line-height: 1;
}

.aa-sm {
    font-size: 12px;
    font-weight: 600;
}

.card-body {
    display: grid;
    gap: 8px;
    padding: 12px 14px 14px;
}

.tk {
    display: inline-flex;
    max-width: 100%;
    padding: 3px 8px;
    border: 1px solid var(--dd-line);
    border-radius: 6px;
    background: var(--dd-sunken);
    color: var(--dd-text);
    font: 12.5px/1.4 var(--dd-mono);
    text-align: left;
    overflow-wrap: anywhere;
    transition: border-color 120ms, background 120ms;
}

.tk:hover {
    border-color: var(--dd-accent);
    background: var(--dd-accent-soft);
}

.tk.flash {
    border-color: var(--dd-ok);
    background: var(--dd-ok-soft);
}

.desc {
    color: var(--dd-muted);
    font-size: 13px;
    line-height: 1.5;
}

.vals {
    display: grid;
    gap: 3px;
    font-size: 12.5px;
}

.vals div {
    display: flex;
    gap: 10px;
}

.vals dt {
    flex: none;
    width: 46px;
    color: var(--dd-faint);
}

.vals dd {
    min-width: 0;
    overflow-wrap: anywhere;
    font-family: var(--dd-mono);
}

.chain {
    color: var(--dd-muted);
}

.pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--dd-sunken);
    color: var(--dd-muted);
    font: 600 11.5px/18px var(--dd-sans);
    white-space: nowrap;
}

.pill.ok {
    background: var(--dd-ok-soft);
    color: var(--dd-ok);
}

.pill.bad {
    background: var(--dd-bad-soft);
    color: var(--dd-bad);
}

.pill.warn {
    background: var(--dd-warn-soft);
    color: var(--dd-warn);
}

.pill.accent {
    background: var(--dd-accent-soft);
    color: var(--dd-accent);
}

.cr {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
}

.cr .ratio {
    font: 600 13px var(--dd-mono);
}

.ramp {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(76px, 1fr));
    gap: 0;
    margin-top: 12px;
    overflow: hidden;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
}

.step {
    position: relative;
    display: grid;
    align-content: space-between;
    min-height: 84px;
    padding: 8px 9px;
    border: 0;
    border-radius: 0;
    text-align: left;
}

.step b {
    display: block;
    font: 700 13px/1.2 var(--dd-mono);
}

.step small {
    display: block;
    margin-top: 2px;
    font: 11px/1.2 var(--dd-mono);
    opacity: 0.85;
}

.step > span {
    position: relative;
    display: block;
}

/* ── Tables ────────────────────────────────────────────── */

.table-wrap {
    margin-top: 14px;
    overflow-x: auto;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
}

th, td {
    padding: 9px 14px;
    border-bottom: 1px solid var(--dd-line);
    text-align: left;
    vertical-align: middle;
}

th {
    background: var(--dd-sunken);
    color: var(--dd-muted);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.02em;
    white-space: nowrap;
}

tbody tr:last-child td {
    border-bottom: 0;
}

td.num {
    font-family: var(--dd-mono);
    white-space: nowrap;
}

.matrix td {
    padding: 6px;
    text-align: center;
}

.matrix th:first-child,
.matrix td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--dd-panel);
    text-align: left;
}

.matrix th:first-child {
    background: var(--dd-sunken);
}

.table-wrap:not(.ref) .tk,
.matrix .tk {
    white-space: nowrap;
}

.cell {
    display: grid;
    gap: 2px;
    min-width: 88px;
    padding: 8px 6px;
    border-radius: 8px;
    box-shadow: inset 0 0 0 1px rgb(128 128 128 / 0.3);
    font-size: 12px;
}

.cell b {
    font-size: 18px;
    line-height: 1.1;
}

.cell em {
    font: normal 600 11px var(--dd-mono);
}

.mini-sw {
    display: inline-block;
    flex: none;
    width: 18px;
    height: 18px;
    margin-right: 8px;
    border-radius: 5px;
    vertical-align: -4px;
    box-shadow: inset 0 0 0 1px rgb(128 128 128 / 0.35);
}

.dep {
    text-decoration: line-through;
    opacity: 0.7;
}

/* ── Specimens ─────────────────────────────────────────── */

.spec {
    display: grid;
    gap: 14px;
    margin-top: 14px;
}

.spec-row {
    display: grid;
    grid-template-columns: minmax(120px, 190px) minmax(0, 1fr);
    gap: 8px 20px;
    align-items: center;
    padding: 12px 16px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.spec-row.c {
    grid-template-columns: minmax(150px, 230px) 72px minmax(0, 1fr);
    padding: 9px 16px;
}

.spec-row.c .val {
    color: var(--dd-muted);
    font: 12.5px var(--dd-mono);
}

.spec-meta {
    display: grid;
    gap: 4px;
    justify-items: start;
}

.spec-meta .val {
    color: var(--dd-muted);
    font: 12.5px var(--dd-mono);
}

.sample {
    min-width: 0;
    overflow: hidden;
    color: var(--dd-text);
    text-overflow: ellipsis;
}

.sample.wrap {
    overflow: visible;
}

.family {
    padding: 22px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.family .big {
    font-size: 64px;
    line-height: 1;
    letter-spacing: -0.02em;
}

.family .abc {
    margin-top: 10px;
    color: var(--dd-muted);
    font-size: 15px;
    overflow-wrap: anywhere;
}

.family .stack {
    margin-top: 12px;
    color: var(--dd-faint);
    font: 12px/1.5 var(--dd-mono);
    overflow-wrap: anywhere;
}

.bar {
    height: 22px;
    max-width: 100%;
    min-width: 2px;
    border-radius: 5px;
    background: linear-gradient(90deg, var(--dd-accent), color-mix(in srgb, var(--dd-accent) 55%, var(--dd-panel)));
}

.box {
    max-width: 100%;
    max-height: 96px;
    border-radius: 6px;
    background: var(--dd-accent-soft);
    box-shadow: inset 0 0 0 1px var(--dd-accent);
}

.radii {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
    gap: 14px;
    margin-top: 14px;
}

.radius {
    display: grid;
    align-content: start;
    gap: 10px;
    justify-items: start;
    padding: 14px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.radius .shape {
    width: 100%;
    max-width: 120px;
    height: 72px;
    border: 2px solid var(--dd-accent);
    background: var(--dd-accent-soft);
}

.shadows {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
    gap: 28px 20px;
    margin-top: 14px;
    padding: 28px 20px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-sunken);
}

.shadow-tile {
    display: grid;
    justify-items: start;
    align-content: end;
    gap: 6px;
    min-height: 110px;
    padding: 14px;
    border-radius: 12px;
    background: var(--dd-panel);
}

.demo {
    --dur: 400ms;
    --ease: ease;
    display: grid;
    gap: 10px;
    padding: 14px 16px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.demo-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
}

.track {
    position: relative;
    height: 26px;
    border-radius: 999px;
    background: var(--dd-sunken);
}

.dot {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: var(--dd-accent);
    transition: left var(--dur) var(--ease);
}

.demo.on .dot {
    left: calc(100% - 23px);
}

.reduce .dot {
    transition: none;
}

.play {
    min-height: 32px;
    padding: 0 14px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 8px;
    background: var(--dd-panel);
    font-size: 13px;
    font-weight: 600;
}

.play:hover {
    border-color: var(--dd-accent);
    color: var(--dd-accent);
}

.curve {
    flex: none;
    width: 56px;
    height: 56px;
    border: 1px solid var(--dd-line);
    border-radius: 8px;
    background: var(--dd-sunken);
}

.curve path {
    fill: none;
    stroke: var(--dd-accent);
    stroke-width: 2.5;
    stroke-linecap: round;
}

.curve line {
    stroke: var(--dd-line-strong);
    stroke-dasharray: 3 3;
}

.motion-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
    gap: 12px;
    margin-top: 14px;
}

.hover-demo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 18px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 10px;
    background: var(--dd-sunken);
    transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}

.hover-demo:hover,
.hover-demo:focus-visible {
    border-color: var(--dd-accent);
    background: var(--dd-accent-soft);
    transform: translateY(-2px);
}

.reduce .hover-demo {
    transition: none;
}

.layers {
    display: grid;
    gap: 6px;
    margin-top: 14px;
}

.layer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 14px;
    border: 1px solid var(--dd-line);
    border-radius: 10px;
    background: var(--dd-panel);
}

/* ── Components ────────────────────────────────────────── */

.comp {
    margin-top: 32px;
    padding-top: 8px;
}

.comp-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 12px;
}

.comp-head h3 {
    margin: 0;
}

.comp-frame {
    display: block;
    width: 100%;
    margin-top: 14px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.dos {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
    gap: 12px;
    margin-top: 14px;
}

.do, .dont {
    padding: 14px 16px;
    border: 1px solid var(--dd-line);
    border-top: 3px solid var(--dd-ok);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

.dont {
    border-top-color: var(--dd-bad);
}

.do h4 {
    color: var(--dd-ok);
}

.dont h4 {
    color: var(--dd-bad);
}

.do ul, .dont ul {
    display: grid;
    gap: 6px;
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--dd-muted);
    font-size: 14px;
}

.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
}

details.code {
    margin-top: 12px;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--dd-panel);
}

details.code > summary {
    display: flex;
    align-items: center;
    min-height: 44px;
    padding: 0 16px;
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
}

.code-body {
    padding: 0 16px 16px;
}

.tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
}

.tabs button {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--dd-line);
    border-radius: 8px;
    background: var(--dd-sunken);
    color: var(--dd-muted);
    font: 600 12.5px var(--dd-mono);
}

.tabs button[aria-pressed="true"] {
    border-color: var(--dd-accent);
    background: var(--dd-accent-soft);
    color: var(--dd-accent);
}

pre.snip {
    position: relative;
    max-height: 420px;
    overflow: auto;
    padding: 40px 16px 14px;
    font-variant-ligatures: none;
    border: 1px solid var(--dd-line);
    border-radius: 10px;
    background: var(--dd-sunken);
    color: var(--dd-text);
    font-size: 12.5px;
    line-height: 1.6;
    tab-size: 4;
}

.nojs .tabs {
    display: none;
}

.uses {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: 16px;
    margin-top: 16px;
}

.use {
    min-width: 0;
}

.use .snip-wrap {
    margin-top: 0;
}

.snip-wrap {
    position: relative;
    margin-top: 10px;
}

.snip-wrap .copy {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--dd-line-strong);
    border-radius: 7px;
    background: var(--dd-panel);
    font-size: 12px;
    font-weight: 600;
}

.snip-wrap .copy:hover {
    border-color: var(--dd-accent);
    color: var(--dd-accent);
}

/* ── Guidelines (rendered Markdown) ────────────────────── */

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

/* ── Phone and small screens ───────────────────────────── */

@media (max-width: 959px) {
    .layout {
        display: block;
    }

    .icon-btn {
        display: grid;
    }

    .side {
        position: fixed;
        top: var(--dd-top);
        left: 0;
        bottom: 0;
        z-index: 35;
        width: min(320px, 86vw);
        height: auto;
        border-right: 1px solid var(--dd-line);
        background: var(--dd-bg);
        box-shadow: var(--dd-shadow);
        transform: translateX(-102%);
        transition: transform 180ms ease;
        visibility: hidden;
    }

    .nav-open .side {
        transform: none;
        visibility: visible;
    }

    .nav-open::after {
        content: "";
        position: fixed;
        inset: var(--dd-top) 0 0 0;
        z-index: 34;
        background: rgb(0 0 0 / 0.4);
    }

    .nojs .side {
        position: static;
        width: auto;
        transform: none;
        visibility: visible;
        box-shadow: none;
    }

    .nav a {
        min-height: 44px;
    }

    .brand-sub {
        display: none;
    }
}

@media (max-width: 640px) {
    :root {
        --dd-top: 52px;
    }

    .topbar {
        padding: 0 10px;
    }

    .seg {
        display: none;
    }

    .modesel {
        display: block;
    }

    .brand-name {
        max-width: 38vw;
    }

    /* Rows that fill: three to a row where they fit, and the last row's cards grow to the width. */
    .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    .stat {
        flex: 1 1 88px;
        padding: 12px;
    }

    .stat b {
        font-size: 22px;
    }

    .stat span {
        font-size: 12px;
        line-height: 1.3;
    }

    .tiles {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
    }

    .tile {
        padding: 12px;
    }

    /* An odd last card takes the whole row, so none stands alone at half width. */
    .tile:last-child:nth-child(odd) {
        grid-column: 1 / -1;
    }

    .tile span {
        font-size: 12px;
        line-height: 1.35;
    }

    .seg button {
        min-height: 36px;
        padding: 0 10px;
    }

    section.block {
        padding-top: 40px;
    }

    .hero {
        border-radius: 16px;
    }

    .spec-row,
    .spec-row.c {
        grid-template-columns: minmax(0, 1fr);
    }

    .spec-row.c {
        grid-template-columns: minmax(0, 1fr) auto;
    }

    .spec-row.c .sample {
        grid-column: 1 / -1;
    }

    .family .big {
        font-size: 48px;
    }

    /* Color cards become rows on a phone: the chip on the left, the facts on the right. */
    .cards {
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
    }

    .cards > .card {
        display: grid;
        grid-template-columns: 92px minmax(0, 1fr);
    }

    .cards > .card .sw-chip {
        flex-direction: column;
        align-items: flex-start;
        justify-content: space-between;
        min-height: 100%;
        border-right: 1px solid var(--dd-line);
        border-bottom: 0;
    }

    .cards > .card .aa-sm,
    .cards > .card .vals div:nth-child(2) {
        display: none;
    }

    .ref thead {
        display: none;
    }

    .ref table, .ref tbody, .ref tr, .ref td {
        display: block;
    }

    .ref tr {
        padding: 10px 14px;
        border-bottom: 1px solid var(--dd-line);
    }

    .ref tr:last-child {
        border-bottom: 0;
    }

    .ref td {
        padding: 2px 0;
        border: 0;
    }

    .ref td[data-label]::before {
        display: none;
    }

    .ref td[data-label="Type"],
    .ref td[data-label="Value"] {
        display: inline-block;
        margin: 4px 14px 0 0;
        font-size: 13px;
    }
}

@media (prefers-reduced-motion: reduce) {
    html {
        scroll-behavior: auto;
    }

    .tile, .toast, .side {
        transition: none;
    }
}

@media print {
    .topbar, .side, .toast {
        display: none;
    }

    .layout {
        display: block;
    }

    section.block {
        break-inside: avoid-page;
    }
}
`;

/** The script of the page: the mode switch, copy, search, navigation, demos, and the height of the component frames. */
export const DOC_JS = `
(function () {
    "use strict";
    var root = document.documentElement;
    root.classList.remove("nojs");
    root.classList.add("js");
    var $ = function (selector, scope) { return (scope || document).querySelector(selector); };
    var $$ = function (selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); };
    var toastEl = $(".toast");
    var toastTimer = 0;

    function toast(text) {
        if (!toastEl) { return; }
        toastEl.textContent = text;
        toastEl.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1400);
    }

    function copyText(text) {
        function fallback() {
            var area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            var done = false;
            try { done = document.execCommand("copy"); } catch (error) { done = false; }
            document.body.removeChild(area);
            return done;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
        }
        return Promise.resolve(fallback());
    }

    document.addEventListener("click", function (event) {
        var target = event.target && event.target.closest ? event.target.closest("[data-copy]") : null;
        if (!target) { return; }
        var text = target.getAttribute("data-copy");
        if (target.hasAttribute("data-copy-from")) {
            var source = document.getElementById(target.getAttribute("data-copy-from"));
            text = source ? source.textContent : "";
        }
        copyText(text || "").then(function (ok) {
            toast(ok ? "Copied " + (text.length > 40 ? "to the clipboard" : text) : "Could not copy");
            target.classList.add("flash");
            setTimeout(function () { target.classList.remove("flash"); }, 900);
        });
    });

    // Mode: the system's own modes. The theme (light or dark) of the page follows the mode.
    var frames = $$("iframe.comp-frame");
    function setMode(mode, theme) {
        root.setAttribute("data-mode", mode);
        root.setAttribute("data-theme", theme);
        $$(".seg button").forEach(function (button) {
            button.setAttribute("aria-pressed", String(button.getAttribute("data-mode") === mode));
        });
        var picker = $(".modesel");
        if (picker) { picker.value = mode; }
        frames.forEach(function (frame) { syncFrame(frame); });
    }
    $$(".seg button").forEach(function (button) {
        button.addEventListener("click", function () {
            setMode(button.getAttribute("data-mode"), button.getAttribute("data-theme"));
        });
    });
    var select = $(".modesel");
    if (select) {
        select.addEventListener("change", function () {
            var option = select.options[select.selectedIndex];
            setMode(option.value, option.getAttribute("data-theme"));
        });
    }
    var startMode = root.getAttribute("data-mode");

    // A component frame is sandboxed: it has no access to this page, and this page none to it. Each side talks by
    // message. The frame reports its height; this page tells it the mode. Messages are data: check them first.
    function syncFrame(frame) {
        if (!frame.contentWindow) { return; }
        frame.contentWindow.postMessage({ type: "ds-mode", mode: root.getAttribute("data-mode"), theme: root.getAttribute("data-theme") }, "*");
    }
    window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.type !== "ds-frame" || typeof data.height !== "number" || !isFinite(data.height)) { return; }
        frames.forEach(function (frame) {
            if (frame.contentWindow === event.source) {
                frame.style.height = Math.min(4000, Math.max(40, Math.ceil(data.height) + 2)) + "px";
            }
        });
    });
    frames.forEach(function (frame) {
        frame.addEventListener("load", function () { syncFrame(frame); });
    });
    setMode(startMode, root.getAttribute("data-theme"));
    var resizeTimer = 0;
    window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { frames.forEach(syncFrame); }, 120);
    });

    // Navigation on a phone.
    var menuButton = $(".icon-btn");
    function navOpen(open) {
        root.classList.toggle("nav-open", open);
        if (menuButton) { menuButton.setAttribute("aria-expanded", String(open)); }
    }
    if (menuButton) {
        menuButton.addEventListener("click", function () { navOpen(!root.classList.contains("nav-open")); });
    }
    $$(".nav a").forEach(function (link) {
        link.addEventListener("click", function () { navOpen(false); });
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { navOpen(false); }
        var field = $("#q");
        if (event.key === "/" && field && document.activeElement !== field && !/input|textarea/i.test((document.activeElement || {}).tagName || "")) {
            event.preventDefault();
            navOpen(true);
            field.focus();
        }
    });

    // Search: hide the cards, rows, and sections that do not match.
    var field = $("#q");
    var emptyEl = $("#nomatch");
    function search() {
        var query = (field.value || "").trim().toLowerCase();
        var words = query.split(/\\s+/).filter(Boolean);
        var shown = 0;
        $$("[data-q]").forEach(function (item) {
            var text = item.getAttribute("data-q");
            var hit = words.every(function (word) { return text.indexOf(word) !== -1; });
            item.hidden = !hit;
            if (hit) { shown++; }
        });
        $$("[data-group]").forEach(function (group) {
            group.hidden = words.length > 0 && !$("[data-q]:not([hidden])", group);
        });
        $$("section.block[data-searchable]").forEach(function (section) {
            section.hidden = words.length > 0 && !$("[data-q]:not([hidden])", section);
        });
        if (emptyEl) { emptyEl.hidden = !(words.length > 0 && shown === 0); }
    }
    if (field) { field.addEventListener("input", search); }

    // Scroll spy.
    var links = {};
    $$(".nav a[href^='#']").forEach(function (link) { links[link.getAttribute("href").slice(1)] = link; });
    if ("IntersectionObserver" in window) {
        var current = "";
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                var id = entry.target.id;
                if (!links[id] || id === current) { return; }
                if (links[current]) { links[current].removeAttribute("aria-current"); }
                links[id].setAttribute("aria-current", "true");
                current = id;
            });
        }, { rootMargin: "-20% 0px -70% 0px" });
        $$("main section[id], main article.comp[id]").forEach(function (section) { observer.observe(section); });
    }

    // Motion demos.
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { root.classList.add("reduce"); $$("[data-reduce-note]").forEach(function (note) { note.hidden = false; }); }
    $$(".demo .play").forEach(function (button) {
        button.addEventListener("click", function () {
            var demo = button.closest(".demo");
            demo.classList.toggle("on");
        });
    });

    // Code tabs: one panel at a time, when script runs.
    $$("[data-tabs]").forEach(function (group) {
        var buttons = $$("button", group);
        var panels = $$("[data-panel]", group.parentNode);
        function pick(name) {
            buttons.forEach(function (button) { button.setAttribute("aria-pressed", String(button.getAttribute("data-tab") === name)); });
            panels.forEach(function (panel) { panel.hidden = panel.getAttribute("data-panel") !== name; });
        }
        buttons.forEach(function (button) { button.addEventListener("click", function () { pick(button.getAttribute("data-tab")); }); });
        if (buttons[0]) { pick(buttons[0].getAttribute("data-tab")); }
    });
})();
`;

/** Runs first, in the head: the page opens in the mode that the visitor's color scheme asks for, with no flash. */
export const DOC_BOOT_JS = `(function(){try{var r=document.documentElement,m=r.getAttribute("data-dark-mode");if(m&&window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches){r.setAttribute("data-mode",m);r.setAttribute("data-theme","dark")}}catch(e){}})();`;

/** The script inside each component frame (it runs only with the page's nonce): it sizes the frame and follows the mode. */
export const FRAME_JS = `(function(){
var id=document.documentElement.getAttribute("data-frame");
function size(){var g=document.querySelector(".__g");if(!g){return}parent.postMessage({type:"ds-frame",id:id,height:Math.ceil(g.getBoundingClientRect().height)},"*")}
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="ds-mode"){return}
if(typeof d.mode==="string"&&/^[a-z0-9-]+$/.test(d.mode)){document.documentElement.setAttribute("data-mode",d.mode)}
if(d.theme==="light"||d.theme==="dark"){document.documentElement.setAttribute("data-theme",d.theme)}
size()});
addEventListener("load",size);
if(window.ResizeObserver){new ResizeObserver(size).observe(document.body)}
size()})();`;
