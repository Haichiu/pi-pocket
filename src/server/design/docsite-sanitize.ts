/**
 * The allowlist that the documentation page applies to a component's markup and CSS before it shows them (see
 * `docsite-components.ts`). The markup is project text. The page parses it in an inert document and then builds a new
 * tree from it: an element and an attribute that are not on a list below are not copied, so nothing that the lists do not
 * name can reach the page, and no new element or attribute of a browser (SMIL, `foreignObject`, `math`, …) is let in by
 * being missing from a denylist. The lists are data here and text in the page's script (`SANITIZER_JS`), and a test runs
 * probes through the real thing in Chromium.
 */

/** HTML elements that a specimen may use. Others are unwrapped (their children stay), or dropped whole (below). */
export const HTML_ELEMENTS =
    "a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup dd del details dfn div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark meter nav ol optgroup option output p pre progress q rp rt ruby s samp section select small span strong style sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr".split(
        " ",
    );

/** SVG elements: shapes, text, gradients, and the small set of filters. No animation, no `foreignObject`, no script, no image. */
export const SVG_ELEMENTS =
    "svg g path circle ellipse rect line polyline polygon text tspan defs lineargradient radialgradient stop clippath mask pattern symbol title desc use marker a style filter fegaussianblur feoffset fecolormatrix femerge femergenode feflood fecomposite feblend fedropshadow".split(
        " ",
    );

/** Elements that are dropped with everything inside them (an unlisted element is only unwrapped). */
export const DROPPED_ELEMENTS =
    "script iframe frame frameset object embed template noscript math foreignobject animate set animatetransform animatemotion mpath discard portal applet link meta base head".split(
        " ",
    );

/** Attributes of any element, besides `aria-*` and `data-*`. `style` is cleaned, and an address is checked, below. */
export const GLOBAL_ATTRIBUTES = "class id role title lang dir tabindex hidden style".split(" ");

/** Attributes of HTML elements. `href` (links) and `src` (images) are checked as addresses. */
export const HTML_ATTRIBUTES =
    "type value placeholder disabled checked selected readonly required for alt width height colspan rowspan min max step rows cols open label multiple maxlength size scope headers datetime name href src abbr cite span start reversed".split(
        " ",
    );

/** Attributes of SVG elements. None names an animation target or value (`attributeName`, `to`, `from`, `by`). */
export const SVG_ATTRIBUTES =
    "viewbox preserveaspectratio xmlns d fill fill-opacity fill-rule clip-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity stroke-miterlimit opacity transform cx cy r rx ry x y x1 y1 x2 y2 points width height offset stop-color stop-opacity gradientunits gradienttransform patternunits patterntransform clippathunits maskunits clip-path mask filter text-anchor dominant-baseline font-size font-family font-weight letter-spacing dx dy rotate textlength marker-start marker-mid marker-end markerwidth markerheight refx refy orient fx fy pathlength vector-effect shape-rendering color display visibility overflow in in2 result stddeviation mode type values flood-color flood-opacity href xlink:href".split(
        " ",
    );

/** Presentation attributes whose value may name another element of the picture, as `url(#id)` and nothing else. */
export const URL_ATTRIBUTES =
    "fill stroke clip-path mask filter marker-start marker-mid marker-end".split(" ");

/**
 * The script that cleans markup and CSS: `window.__dsClean(parsedDocument, targetElement)` copies what the lists allow;
 * `window.__dsCss(text)` removes `@import` and every `url()` but `#id` and a small image. ES5, run by the page.
 */
export const SANITIZER_JS = `
var HTML_NS = "http://www.w3.org/1999/xhtml";
var SVG_NS = "http://www.w3.org/2000/svg";
function setOf(list) { var set = {}; list.forEach(function (name) { set[name] = true; }); return set; }
var OK_HTML = setOf(${JSON.stringify(HTML_ELEMENTS)});
var OK_SVG = setOf(${JSON.stringify(SVG_ELEMENTS)});
var DROPPED = setOf(${JSON.stringify(DROPPED_ELEMENTS)});
var OK_GLOBAL = setOf(${JSON.stringify(GLOBAL_ATTRIBUTES)});
var OK_HTML_ATTR = setOf(${JSON.stringify(HTML_ATTRIBUTES)});
var OK_SVG_ATTR = setOf(${JSON.stringify(SVG_ATTRIBUTES)});
var URL_ATTR = setOf(${JSON.stringify(URL_ATTRIBUTES)});
var MAX_NODES = 4000;
var MAX_DEPTH = 40;

// CSS text: no @import, and a url() only to an element of the picture (#id) or to a small image in the text itself.
function cleanCss(text) {
    return String(text)
        .replace(/@import[^;]*;?/gi, "")
        .replace(/url\\(\\s*(["']?)(?!#|data:image\\/(png|gif|jpeg|webp)[;,])[^)]*\\)/gi, "none")
        .replace(/expression\\s*\\(|behavior\\s*:|-moz-binding/gi, "x");
}

// Whether an attribute (already on its element's list) may keep its value.
function okValue(name, value, tag) {
    var flat = value.replace(/[\\u0000-\\u0020\\u007f-\\u009f]+/g, "").toLowerCase();
    if (/(javascript|vbscript|livescript):|data:(text|application)|<\\s*script/.test(flat)) { return false; }
    if (name === "href" || name === "xlink:href") { return (tag === "a" || tag === "use") && /^#[\\w:.-]*$/.test(value.trim()); }
    if (name === "src") { return tag === "img" && /^data:image\\/(png|gif|jpeg|webp);base64,[a-z0-9+\\/=]*$/i.test(value.trim()); }
    if (URL_ATTR[name] && /url\\s*\\(/i.test(value)) { return /^\\s*url\\(\\s*#[\\w:.-]+\\s*\\)\\s*$/.test(value); }
    if (name === "values") { return tag === "fecolormatrix"; }
    return true;
}

function copyAttributes(from, to, svg, tag) {
    Array.prototype.slice.call(from.attributes).forEach(function (attribute) {
        var name = attribute.name.toLowerCase();
        var listed = OK_GLOBAL[name] || (svg ? OK_SVG_ATTR[name] : OK_HTML_ATTR[name]) || /^(aria|data)-[a-z0-9._-]+$/.test(name);
        if (!listed) { return; }
        var value = attribute.value;
        if (name === "style") { value = cleanCss(value); }
        else if (!okValue(name, value, tag)) { return; }
        try { to.setAttributeNS(attribute.namespaceURI, attribute.name, value); } catch (error) { /* a name that cannot be set is left out */ }
    });
}

function copyChildren(from, to, state, depth) {
    Array.prototype.slice.call(from.childNodes).forEach(function (child) {
        if (state.count > MAX_NODES || depth > MAX_DEPTH) { return; }
        if (child.nodeType === 3) { to.appendChild(document.createTextNode(child.data)); state.count++; return; }
        if (child.nodeType !== 1) { return; }
        var svg = child.namespaceURI === SVG_NS;
        if (!svg && child.namespaceURI !== HTML_NS) { return; }
        var tag = child.localName.toLowerCase();
        if (DROPPED[tag] || (!svg && tag === "title")) { return; }
        if (!(svg ? OK_SVG : OK_HTML)[tag]) { copyChildren(child, to, state, depth + 1); return; }
        var out = svg ? document.createElementNS(SVG_NS, child.localName) : document.createElement(tag);
        state.count++;
        copyAttributes(child, out, svg, tag);
        to.appendChild(out);
        if (tag === "style") { out.textContent = cleanCss(child.textContent); } else { copyChildren(child, out, state, depth + 1); }
    });
}

// Builds a new tree in \`to\` from a parsed document: the head's styles first, then the body.
function cleanInto(parsed, to) {
    var state = { count: 0 };
    copyChildren(parsed.head, to, state, 0);
    copyChildren(parsed.body, to, state, 0);
}
`;
