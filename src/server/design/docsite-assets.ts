/**
 * The look and the behavior of the design-system documentation page (docsite.ts), as two text constants. The page is a
 * self-contained artifact that runs in the sandbox, so both are inline: no font, image, or script is fetched. The chrome
 * (navigation, cards, tables) uses its own `--dd-*` properties, so it never depends on the system it documents; the
 * system's tokens are scoped to `body.ds`, where the specimens read them.
 */

/** The CSS of the page. `--dd-accent` and the accent ink are set per theme by docsite.ts. */
import { CSS_BASE } from "./docsite-css-base.ts";
import { CSS_CONTENT } from "./docsite-css-content.ts";
import { CSS_PHONE } from "./docsite-css-phone.ts";
import { CSS_REFERENCE } from "./docsite-css-reference.ts";
import { CSS_SPECIMENS } from "./docsite-css-specimens.ts";
import { JS_CORE } from "./docsite-js-core.ts";
import { JS_DEMOS } from "./docsite-js-demos.ts";
import { JS_NAV } from "./docsite-js-nav.ts";
import { JS_STAGES } from "./docsite-js-stages.ts";

/** The CSS of the page, in the order of the cascade. `--dd-accent` and the accent ink are set per theme by docsite.ts. */
export const DOC_CSS = CSS_BASE + CSS_CONTENT + CSS_SPECIMENS + CSS_REFERENCE + CSS_PHONE;

/** The script of the page. It is one function, so its parts share its helpers. */
export const DOC_JS = JS_CORE + JS_STAGES + JS_NAV + JS_DEMOS;

/** Runs first, in the head: the page opens in the mode that the visitor's color scheme asks for, with no flash. */
export const DOC_BOOT_JS = `(function(){try{var r=document.documentElement,m=r.getAttribute("data-dark-mode");if(m&&window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches){r.setAttribute("data-mode",m);r.setAttribute("data-theme","dark")}}catch(e){}})();`;
