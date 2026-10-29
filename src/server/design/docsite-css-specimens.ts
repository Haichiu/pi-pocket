export const CSS_SPECIMENS = `

.spec {
    display: grid;
    gap: 14px;
    margin-top: 14px;
}

.spec.cols {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr));
    gap: 10px;
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
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 176px), 1fr));
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
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
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
    align-content: start;
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

.comp-stage {
    display: block;
    min-height: 120px;
    margin-top: 14px;
    overflow: hidden;
    border: 1px solid var(--dd-line);
    border-radius: var(--dd-radius);
    background: var(--g, var(--dd-panel));
    color: var(--t, var(--dd-text));
    font: 14px/1.5 var(--f, system-ui, sans-serif);
    position: relative;
    isolation: isolate;
    contain: layout paint;
}

.comp-host {
    display: block;
}

.stage-note {
    margin: 0;
    padding: 16px;
    color: var(--dd-muted);
    font-size: 13px;
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

`;
