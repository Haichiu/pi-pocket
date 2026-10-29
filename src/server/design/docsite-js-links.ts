export const JS_LINKS = `    // Links to headings. A tap copies the address of the heading; the page follows it as any link.
    document.addEventListener("click", function (event) {
        var link = event.target && event.target.closest ? event.target.closest("a.anchor") : null;
        if (!link) { return; }
        var address = location.href.split("#")[0] + link.getAttribute("href");
        copyText(address).then(function (ok) { toast(ok ? "Copied the link" : "Could not copy the link"); });
    });
    // An address with a hash opens what it points at: every fold around the target, and a row or a section that the
    // filter or the phone's lazy rows had left out.
    function openHash() {
        var id = "";
        try { id = decodeURIComponent((location.hash || "").slice(1)); } catch (error) { id = ""; }
        var target = id ? document.getElementById(id) : null;
        if (!target) { return; }
        for (var node = target; node && node !== document.body; node = node.parentElement) {
            if (node.tagName === "DETAILS") { node.open = true; }
            if (node.hidden) { node.hidden = false; }
        }
        target.scrollIntoView();
    }
    window.addEventListener("hashchange", openHash);
    if (location.hash) { openHash(); }

`;
