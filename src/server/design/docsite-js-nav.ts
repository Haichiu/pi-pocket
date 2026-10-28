/** The page script's phone navigation, filter, and scroll spy. */
export const JS_NAV = `    // Navigation on a phone.
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
        $$("[data-s]").forEach(function (item) {
            var text = item.__q || (item.__q = item.textContent.toLowerCase());
            var hit = words.every(function (word) { return text.indexOf(word) !== -1; });
            item.hidden = !hit;
            if (hit) { shown++; }
        });
        $$("[data-group]").forEach(function (group) {
            group.hidden = words.length > 0 && !$("[data-s]:not([hidden])", group);
        });
        $$("section.block[data-searchable]").forEach(function (section) {
            section.hidden = words.length > 0 && !$("[data-s]:not([hidden])", section);
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

`;
