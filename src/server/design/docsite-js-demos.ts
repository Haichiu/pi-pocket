/** The page script's motion demos, code tabs, and its end. */
export const JS_DEMOS = `    // Motion demos.
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
