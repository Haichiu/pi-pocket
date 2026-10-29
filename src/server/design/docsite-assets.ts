// The chrome uses its own `--dd-*` properties so it never depends on the system it documents; the system's tokens are scoped to `body.ds`, where the specimens read them.

import { CSS_BASE } from "./docsite-css-base.ts";
import { CSS_CONTENT } from "./docsite-css-content.ts";
import { CSS_PHONE } from "./docsite-css-phone.ts";
import { CSS_REFERENCE } from "./docsite-css-reference.ts";
import { CSS_SPECIMENS } from "./docsite-css-specimens.ts";
import { JS_CODE } from "./docsite-js-code.ts";
import { JS_CORE } from "./docsite-js-core.ts";
import { JS_DEMOS } from "./docsite-js-demos.ts";
import { JS_LINKS } from "./docsite-js-links.ts";
import { JS_NAV } from "./docsite-js-nav.ts";
import { JS_STAGES } from "./docsite-js-stages.ts";
import { JS_TABLE } from "./docsite-js-table.ts";

export const DOC_CSS = CSS_BASE + CSS_CONTENT + CSS_SPECIMENS + CSS_REFERENCE + CSS_PHONE;

export const DOC_JS = JS_CORE + JS_STAGES + JS_TABLE + JS_NAV + JS_LINKS + JS_CODE + JS_DEMOS;

/** Runs first, in the head, so the page opens in the mode the visitor's color scheme asks for, with no flash. */
export const DOC_BOOT_JS = `(function(){try{var r=document.documentElement,m=r.getAttribute("data-dark-mode");if(m&&window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches){r.setAttribute("data-mode",m);r.setAttribute("data-theme","dark")}}catch(e){}})();`;
