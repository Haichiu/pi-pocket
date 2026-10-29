export const JS_CORE = `
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

    // A token name (a "tk" chip) copies its own text; a button with data-copy copies that.
    document.addEventListener("click", function (event) {
        var target = event.target && event.target.closest ? event.target.closest("[data-copy], .tk") : null;
        if (!target) { return; }
        var text = target.hasAttribute("data-copy") ? target.getAttribute("data-copy") : target.textContent.trim();
        if (target.hasAttribute("data-copy-from")) {
            var source = document.getElementById(target.getAttribute("data-copy-from"));
            text = source ? source.textContent : "";
        }
        if (!text) { return; }
        copyText(text || "").then(function (ok) {
            toast(ok ? "Copied " + (text.length > 40 ? "to the clipboard" : text) : "Could not copy");
            target.classList.add("flash");
            setTimeout(function () { target.classList.remove("flash"); }, 900);
        });
    });

    // The copy buttons of a color card, made from the three values the card carries.
    $$(".copy-row").forEach(function (row) {
        [["CSS var", "var(" + row.getAttribute("data-var") + ")"], ["Tailwind", row.getAttribute("data-tw")], ["JSON", row.getAttribute("data-json")]].forEach(function (pair) {
            if (!pair[1]) { return; }
            var button = document.createElement("button");
            button.type = "button";
            button.className = "mini";
            button.textContent = pair[0];
            button.title = "Copy " + pair[1];
            button.setAttribute("data-copy", pair[1]);
            row.appendChild(button);
        });
    });

`;
