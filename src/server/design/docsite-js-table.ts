/** The page script's token table: a search of names and values, filters by type and tier, and rows drawn a screenful at a time on a phone. */
export const JS_TABLE = `    // The table of tokens. Its search, type filter, and tier filter hide rows; on a phone only the first rows are in the
    // page, and more come as the person scrolls (or taps), so that a long table costs a phone nothing until it is read.
    var tbody = $("#tokens tbody");
    var tableRows = tbody ? $$("tr", tbody) : [];
    // A row's type and tier are in its second cell; its CSS variable is its name with hyphens, unless the row says so.
    tableRows.forEach(function (row) {
        var spans = $$("span", row.cells[1]);
        row.__type = spans[0].textContent;
        row.__tier = spans[1].textContent;
        var first = row.cells[0];
        if ($$(".tk", first).length === 1) {
            var name = $(".tk", first).textContent;
            var chip = document.createElement("button");
            chip.className = "tk";
            chip.textContent = "--" + name.replace(/\\./g, "-");
            first.insertBefore(chip, $(".tk", first).parentNode.nextSibling);
        }
    });
    var pending = [];
    var moreRow = null;
    var moreObserver = null;
    var ROWS_AT_A_TIME = 60;
    function showMore() {
        var next = pending.splice(0, ROWS_AT_A_TIME);
        next.forEach(function (row) { tbody.insertBefore(row, moreRow); });
        if (pending.length === 0) {
            if (moreObserver) { moreObserver.disconnect(); }
            if (moreRow) { moreRow.remove(); moreRow = null; }
        } else {
            $("button", moreRow).textContent = "Show " + Math.min(ROWS_AT_A_TIME, pending.length) + " more of " + pending.length;
            if (moreObserver) { moreObserver.unobserve(moreRow); moreObserver.observe(moreRow); }
        }
    }
    function restoreRows() { while (pending.length > 0) { showMore(); } }
    if (tbody && tableRows.length > ROWS_AT_A_TIME + 20 && window.matchMedia && matchMedia("(max-width: 640px)").matches) {
        pending = tableRows.slice(ROWS_AT_A_TIME);
        pending.forEach(function (row) { row.remove(); });
        moreRow = document.createElement("tr");
        moreRow.className = "more";
        var moreCell = document.createElement("td");
        var moreButton = document.createElement("button");
        moreCell.colSpan = 9;
        moreButton.type = "button";
        moreButton.addEventListener("click", showMore);
        moreCell.appendChild(moreButton);
        moreRow.appendChild(moreCell);
        tbody.appendChild(moreRow);
        moreButton.textContent = "Show " + ROWS_AT_A_TIME + " more of " + pending.length;
        if ("IntersectionObserver" in window) {
            moreObserver = new IntersectionObserver(function (entries) { if (entries[0].isIntersecting) { showMore(); } }, { rootMargin: "400px" });
            moreObserver.observe(moreRow);
        }
    }
    var tableSearch = $("#tq");
    var tableType = $("#tt");
    var tableTier = $("#tr");
    var tableCount = $("#tc");
    function filterTable() {
        if (!tbody) { return; }
        var words = (tableSearch.value || "").trim().toLowerCase().split(/\\s+/).filter(Boolean);
        var type = tableType.value;
        var tier = tableTier.value;
        var shown = 0;
        var filtering = words.length > 0 || type !== "" || tier !== "";
        if (filtering) { restoreRows(); }
        tableRows.forEach(function (row) {
            var text = row.__q || (row.__q = row.textContent.toLowerCase());
            var hit = (!type || row.__type === type) && (!tier || row.__tier === tier) && words.every(function (word) { return text.indexOf(word) !== -1; });
            row.__l = !hit;
            row.hidden = !!row.__g || !hit;
            if (hit) { shown++; }
        });
        if (tableCount) { tableCount.textContent = filtering ? shown + " of " + tableRows.length : tableRows.length + " tokens"; }
    }
    if (tableSearch) { tableSearch.addEventListener("input", filterTable); }
    if (tableType) { tableType.addEventListener("change", filterTable); }
    if (tableTier) { tableTier.addEventListener("change", filterTable); }
    if (tableCount) { tableCount.textContent = tableRows.length + " tokens"; }

`;
