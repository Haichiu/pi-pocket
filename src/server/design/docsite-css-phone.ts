/** The page's CSS for phones and small screens, for reduced motion, and for print. */
export const CSS_PHONE = `/* ── Phone and small screens ───────────────────────────── */

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
    .ref td.num {
        display: inline-block;
        margin: 4px 14px 0 0;
        font-size: 13px;
    }

    /* A mode's value says which mode it is, in line. */
    .ref td.num::before {
        display: inline;
        margin: 0 4px 0 0;
        content: attr(data-label) ":";
        color: var(--dd-faint);
        font: 600 11px var(--dd-sans);
        letter-spacing: 0;
        text-transform: none;
    }

    .toolbar input {
        flex-basis: 100%;
    }

    .rows-count {
        margin-left: 0;
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
