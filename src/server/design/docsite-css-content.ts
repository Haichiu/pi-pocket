/** The page's CSS for the overview, the color cards and swatches, and the tables. */
export const CSS_CONTENT = `/* ── Overview ──────────────────────────────────────────── */

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
    width: 72px;
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
    text-align: center;
    white-space: nowrap;
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

td.num.wrap {
    white-space: normal;
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

`;
