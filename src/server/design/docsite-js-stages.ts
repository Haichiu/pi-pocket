import { SANITIZER_JS } from "./docsite-sanitize.ts";

export const JS_STAGES = `    // Mode: the system's own modes. The theme (light or dark) of the page follows the mode. Every token variable
    // is set on the body for each mode, so nothing else needs to change: component states inherit them.
    function setMode(mode, theme) {
        root.setAttribute("data-mode", mode);
        root.setAttribute("data-theme", theme);
        $$(".seg button").forEach(function (button) {
            button.setAttribute("aria-pressed", String(button.getAttribute("data-mode") === mode));
        });
        var picker = $(".modesel");
        if (picker) { picker.value = mode; }
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
    setMode(root.getAttribute("data-mode"), root.getAttribute("data-theme"));

    // Component states. The markup and CSS are project text. Each state is parsed in an inert document (nothing in it
    // runs or loads), and a new tree is built from what an allowlist names (docsite-sanitize.ts): no script, no handler,
    // no animation, no address but "#id", no frame or form. It goes in a shadow root inside a box that clips it and holds
    // any fixed position: the component's CSS stays in, the page's stays out, the page's custom properties come in.
    ${SANITIZER_JS}
    var STAGE_CSS = "*{box-sizing:border-box}.__w{overflow:hidden}.__g{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));margin:0 -1px -1px 0}.__c{min-width:0;padding:16px 18px 20px;box-shadow:inset -1px -1px 0 rgb(128 128 128/.28)}.__l{margin:0 0 14px;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.62}";
    $$(".comp-stage").forEach(function (stage) {
        if (!document.body.attachShadow) { return; }
        var article = stage.closest("article");
        var panels = $$(".snip-wrap[data-kind]", article);
        var css = "";
        var wrap = document.createElement("div");
        var grid = document.createElement("div");
        wrap.className = "__w";
        grid.className = "__g";
        panels.forEach(function (panel) {
            var code = $("pre", panel).textContent;
            if (panel.getAttribute("data-kind") === "css") { css = code; return; }
            var cell = document.createElement("div");
            var label = document.createElement("p");
            var parsed = new DOMParser().parseFromString(code, "text/html");
            cell.className = "__c";
            label.className = "__l";
            label.textContent = panel.getAttribute("data-panel");
            cell.appendChild(label);
            cleanInto(parsed, cell);
            grid.appendChild(cell);
        });
        // The shadow root is on a box inside the stage: the stage clips and contains what the component's CSS does to its
        // own host (a fixed position, a huge z-index), so that it cannot cover the page.
        var host = document.createElement("div");
        host.className = "comp-host";
        stage.appendChild(host);
        var shadow = host.attachShadow({ mode: "open" });
        var style = document.createElement("style");
        style.textContent = STAGE_CSS + cleanCss(css);
        wrap.appendChild(grid);
        shadow.appendChild(style);
        shadow.appendChild(wrap);
        // A specimen is a picture of a state: its links and forms go nowhere.
        shadow.addEventListener("click", function (event) {
            var path = event.composedPath();
            for (var i = 0; i < path.length; i++) { if (path[i].localName && path[i].localName.toLowerCase() === "a") { event.preventDefault(); return; } }
        });
        shadow.addEventListener("submit", function (event) { event.preventDefault(); });
        var note = $(".stage-note", stage);
        if (note) { note.remove(); }
        stage.setAttribute("data-ready", "");
    });
    // A capture (the bench, design_preview, a PDF) can wait for this: every state is drawn in the page itself.
    root.setAttribute("data-docs-ready", "");

`;
