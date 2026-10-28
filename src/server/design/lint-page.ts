/**
 * The script that `lint.ts` runs inside a rendered design: it walks the DOM once and returns what the page uses
 * (colors, fonts, sizes, text and background pairs) and the page-level problems (targets, overflow, images, headings,
 * focus), as groups of equal values. The comparison with a design system happens on the server (`lint.ts`).
 *
 * It is plain JavaScript in a string, run with `Runtime.evaluate` as `(<script>)(input)`. Its output is untrusted data
 * (the page can lie), so `lint.ts` checks the shape and bounds every string before it uses it.
 */

/** What the script gets. */
export interface PageInput {
    /** CSS text of the system's colors and lengths, for the browser to resolve (the same way it resolves the page's). */
    tokenColors: string[];
    tokenLengths: { css: string; kind: string }[];
    /** Whether to treat the page as a deck: no overflow or tap checks. */
    deck: boolean;
    /** Whether to find values written as literals in the page's own CSS (with a system). */
    literals: boolean;
}

export interface RawElement {
    selector: string;
    pid: string;
    rect: { x: number; y: number; width: number; height: number };
}

export interface RawGroup {
    count: number;
    el: RawElement;
}

export interface RawPage {
    elements: number;
    viewport: { width: number; height: number };
    hasViewportMeta: boolean;
    resolvedColors: (number[] | null)[];
    resolvedLengths: (number | null)[];
    colors: (RawGroup & { rgba: number[]; roles: Record<string, number>; literal?: boolean })[];
    fonts: (RawGroup & { family: string; list: string; literal?: boolean })[];
    sizes: (RawGroup & { kind: string; px: number; props: string[]; literal?: boolean })[];
    contrast: (RawGroup & {
        fg: number[];
        bg: number[];
        size: number;
        large: boolean;
        ui: boolean;
        ratio?: number;
        /** The colors that make a form field's edge: its fill and borders, as authored. */
        edges?: number[][];
    })[];
    targets: (RawGroup & { level: string; width: number; height: number; tag: string })[];
    overflow?: {
        scrollWidth: number;
        clientWidth: number;
        clipped: boolean;
        offenders: number;
        el?: RawElement;
    };
    images: (RawGroup & { tag: string; why: string })[];
    headings: (RawGroup & { level: number; previous: number })[];
    fontFaces: (RawGroup & { family: string; why: string; failed: boolean })[];
    focus: (RawGroup & { tag: string; outlineNone: boolean })[];
    pids: (RawGroup & { tag: string })[];
}

export const PAGE_SCRIPT = String.raw`(async (input) => {
const doc = document;
const win = window;
const root = doc.documentElement;
const body = doc.body;
const XHTML = 'http://www.w3.org/1999/xhtml';
const MAX_ELEMENTS = 4000;
const MAX_GROUPS = 300;
const round = (n) => Math.round(n * 100) / 100;

// A style that stops transitions and animations, so every computed value is the resting one.
const calm = doc.createElement('style');
calm.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
doc.head.append(calm);

// ---------------------------------------------------------------------------------------------------------------------
// Colors: any CSS color the browser knows, as red, green, blue, and alpha.

const canvas = doc.createElement('canvas');
canvas.width = canvas.height = 1;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const colors = new Map();
const RGB = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.]+%?))?\s*\)$/;

const paint = (css, back) => {
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);

    return ctx.getImageData(0, 0, 1, 1).data;
};

const viaCanvas = (css) => {
    ctx.fillStyle = '#010203';
    ctx.fillStyle = css;

    if (ctx.fillStyle === '#010203' && !/^#010203$/i.test(css)) {
        return null;
    }

    const onWhite = paint(css, '#ffffff');
    const onBlack = paint(css, '#000000');
    let alpha = 0;

    for (let channel = 0; channel < 3; channel++) {
        alpha += 1 - (onWhite[channel] - onBlack[channel]) / 255;
    }

    alpha = Math.min(1, Math.max(0, alpha / 3));

    if (alpha < 0.004) {
        return [0, 0, 0, 0];
    }

    return [0, 1, 2].map((channel) => Math.min(255, onBlack[channel] / alpha)).concat([alpha]);
};

const toRgba = (css) => {
    css = String(css);

    if (colors.has(css)) {
        return colors.get(css);
    }

    const match = RGB.exec(css);
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(css);
    const slash = /^(.*?)\s*\/\s*([\d.]+%?)\s*\)$/.exec(css);
    let out = null;

    if (hex) {
        // A hex color is exact; the canvas would round a faint one.
        let digits = hex[1];

        if (digits.length <= 4) digits = digits.replace(/./g, (c) => c + c);

        out = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)).concat([digits.length === 8 ? Math.round((parseInt(digits.slice(6, 8), 16) / 255) * 100) / 100 : 1]);
    } else if (slash && !match) {
        // oklch(... / 0.07): the color from the canvas without its alpha (a faint one would lose digits), then the alpha.
        const base = viaCanvas(slash[1] + ')');
        const alpha = slash[2].endsWith('%') ? parseFloat(slash[2]) / 100 : parseFloat(slash[2]);

        out = base ? [base[0], base[1], base[2], alpha] : null;
    } else if (match) {
        const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);

        out = [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
    } else {
        out = viaCanvas(css);
    }

    colors.set(css, out);

    return out;
};

const mix = (back, front, alpha) => [
    front[0] * alpha + back[0] * (1 - alpha),
    front[1] * alpha + back[1] * (1 - alpha),
    front[2] * alpha + back[2] * (1 - alpha),
];

const rootStyle = getComputedStyle(root);
const darkCanvas = /dark/.test(rootStyle.colorScheme) && win.matchMedia('(prefers-color-scheme: dark)').matches;
const canvasRgb = darkCanvas ? [18, 18, 18] : [255, 255, 255];

// ---------------------------------------------------------------------------------------------------------------------
// The system's values, as the browser resolves them.

const probe = doc.createElement('div');
probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;height:0;border:0;padding:0';
body.append(probe);
const resolvedColors = input.tokenColors.map((css) => toRgba(css));
const resolvedLengths = input.tokenLengths.map((token) => {
    probe.style.fontSize = '';
    probe.style.width = '';

    if (token.kind === 'font-size') {
        probe.style.fontSize = token.css;

        return probe.style.fontSize === '' ? null : parseFloat(getComputedStyle(probe).fontSize);
    }

    probe.style.width = token.css;

    return probe.style.width === '' ? null : probe.getBoundingClientRect().width;
});
probe.remove();

// ---------------------------------------------------------------------------------------------------------------------
// What an element is: a short selector (as the inspector names it), its pid, and where it sits.

const unique = (selector) => {
    try {
        return doc.querySelectorAll(selector).length === 1;
    } catch {
        return false;
    }
};
const idSelector = (el) => (el.id ? '#' + CSS.escape(el.id) : '');
const pidSelector = (value) => '[data-pid=' + JSON.stringify(value) + ']';
const step = (el) => {
    const classes = [...el.classList].filter((name) => name.length <= 30 && !/\d{3,}/.test(name)).slice(0, 2);
    let selector = el.localName + classes.map((name) => '.' + CSS.escape(name)).join('');
    const parent = el.parentElement;

    if (parent) {
        const same = [...parent.children].filter((child) => child.matches(selector));

        if (same.length > 1) {
            const ofType = [...parent.children].filter((child) => child.localName === el.localName);

            selector += ':nth-of-type(' + (ofType.indexOf(el) + 1) + ')';
        }
    }

    return selector;
};
const selectorOf = (el) => {
    if (el === root) return 'html';
    if (el === body) return 'body';
    if (el.id && unique(idSelector(el))) return idSelector(el);

    const pid = el.getAttribute('data-pid');

    if (pid && unique(pidSelector(pid))) return pidSelector(pid);

    const parts = [];

    for (let node = el; node && node.nodeType === 1 && node !== root; node = node.parentElement) {
        if (node !== el && node.id && unique(idSelector(node))) {
            parts.unshift(idSelector(node));
            break;
        }

        parts.unshift(step(node));

        if (unique(parts.join(' > '))) break;
    }

    return parts.join(' > ').slice(0, 500);
};
const infoOf = (el) => {
    const rect = el.getBoundingClientRect();
    const owner = el.closest('[data-pid]');

    return {
        selector: selectorOf(el),
        pid: owner ? owner.getAttribute('data-pid').slice(0, 200) : '',
        rect: { x: Math.round(rect.left + win.scrollX), y: Math.round(rect.top + win.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
};

// Groups of equal values: the first element and a count; the selector is worked out once, at the end.
// Equal values are one group for each data-pid scope: a finding can then name the element a person comments on.
const owners = new Map();
const ownerId = (el) => {
    const owner = el.closest('[data-pid]');

    if (!owner) return 0;

    if (!owners.has(owner)) owners.set(owner, owners.size + 1);

    return owners.get(owner);
};
const group = (map, key, make, el) => {
    if (map !== groups.pids) key += '@' + ownerId(el);

    let found = map.get(key);

    if (!found) {
        if (map.size >= MAX_GROUPS) return null;

        found = Object.assign({ count: 0, el }, make());
        map.set(key, found);
    }

    found.count++;

    return found;
};
const finish = (map) => [...map.values()].map((item) => Object.assign({}, item, { el: infoOf(item.el) }));

const groups = { colors: new Map(), fonts: new Map(), sizes: new Map(), contrast: new Map(), targets: new Map(), images: new Map(), pids: new Map() };
const headings = [];


// ---------------------------------------------------------------------------------------------------------------------
// Authored literals. With a system, a color, length, or font written as a literal in the page's own CSS is hard-coded
// even when its value equals a token: it does not follow the token. The page's rules say which values were authored (a
// computed value cannot): the colors, lengths, and font families that they set without var().

const literalRules = [];
const KEEP_WORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto', 'canvas', 'canvastext', 'buttonface', 'buttontext', 'buttonborder', 'field', 'fieldtext', 'highlight', 'highlighttext', 'linktext', 'visitedtext', 'activetext', 'graytext', 'mark', 'marktext', 'accentcolor', 'accentcolortext', 'selecteditem', 'selecteditemtext']);
const stripVars = (text) => {
    let out = '';

    for (let i = 0; i < text.length; ) {
        if (text.startsWith('var(', i)) {
            let depth = 0;
            let j = i + 3;

            for (; j < text.length; j++) {
                if (text[j] === '(') depth++;
                else if (text[j] === ')' && --depth === 0) break;
            }

            out += ' ';
            i = j + 1;
        } else {
            out += text[i++];
        }
    }

    return out;
};
const colorWords = (text) => {
    const found = [];
    const pattern = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-z][a-z-]*/gi;

    for (const match of stripVars(text).matchAll(pattern)) {
        const word = match[0];

        if (/^[a-z]/i.test(word) && !word.includes('(') && (KEEP_WORDS.has(word.toLowerCase()) || !CSS.supports('color', word))) continue;

        found.push(word);
    }

    return found;
};
const lengthWords = (text) => [...stripVars(text).matchAll(/(-?\d*\.?\d+)(px|rem|em|pt)\b/gi)].map((m) => ({ value: Number(m[1]), unit: m[2].toLowerCase() }));
const splitDecls = (cssText) => {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;

    for (let i = 0; i <= cssText.length; i++) {
        const ch = cssText[i];

        if (quote) {
            if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if ((ch === ';' && depth === 0) || i === cssText.length) {
            const text = cssText.slice(start, i);
            const colon = text.indexOf(':');

            if (colon > 0) out.push([text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).replace(/!important\s*$/i, '').trim()]);

            start = i + 1;
        }
    }

    return out;
};
const partsOf = (cssText) => {
    const parts = { text: [], background: [], border: [], outline: [], 'font-size': [], space: [], radius: [], family: [] };
    let any = false;
    const put = (kind, list) => {
        if (list.length > 0) {
            parts[kind].push(...list);
            any = true;
        }
    };

    for (const [prop, value] of splitDecls(cssText)) {
        if (prop.startsWith('--')) continue;

        if (prop === 'color' || prop === '-webkit-text-fill-color') put('text', colorWords(value));
        else if (prop === 'background' || prop === 'background-color') put('background', colorWords(value));
        else if (/^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/.test(prop)) put('border', colorWords(value));
        else if (prop === 'outline' || prop === 'outline-color') put('outline', colorWords(value));
        else if (prop === 'font-size') put('font-size', lengthWords(value));
        else if (prop === 'font') put('font-size', lengthWords(value).slice(0, 1));
        else if (/^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.test(prop) || /^(grid-)?(row-|column-)?gap$/.test(prop)) put('space', lengthWords(value));
        else if (/^border(-(top|bottom)-(left|right))?-radius$/.test(prop)) put('radius', lengthWords(value));
        else if (prop === 'font-family' && !value.includes('var(')) put('family', [value]);
    }

    return any ? parts : null;
};

if (input.literals === true) {
    const walk = (rules) => {
        for (const rule of rules) {
            if (literalRules.length >= 800) return;

            if (rule.type === 1) {
                const parts = partsOf(rule.style.cssText);

                if (parts) literalRules.push({ selector: rule.selectorText, parts });
            } else if (rule.cssRules && (rule.type === 4 ? win.matchMedia(rule.conditionText || rule.media.mediaText).matches : rule.type === 12 ? CSS.supports(rule.conditionText) : true)) {
                walk(rule.cssRules);
            }
        }
    };

    for (const sheet of doc.styleSheets) {
        try {
            if (!sheet.disabled) walk(sheet.cssRules);
        } catch {
            // A style sheet from another origin cannot be read.
        }
    }
}

const literalCache = new Map();
const literalsOf = (el) => {
    if (literalCache.has(el)) return literalCache.get(el);

    const merged = { text: [], background: [], border: [], outline: [], 'font-size': [], space: [], radius: [], family: [] };

    if (literalRules.length > 0 || el.hasAttribute('style')) {
        const lists = literalRules.filter((rule) => {
            try {
                return el.matches(rule.selector);
            } catch {
                return false;
            }
        }).map((rule) => rule.parts);
        const inline = el.hasAttribute('style') && input.literals === true ? partsOf(el.getAttribute('style')) : null;

        for (const parts of inline ? [...lists, inline] : lists) {
            for (const kind of Object.keys(merged)) merged[kind].push(...parts[kind]);
        }
    }

    literalCache.set(el, merged);

    return merged;
};
const sameColor = (a, b) => Math.abs(a[0] - b[0]) <= 1.5 && Math.abs(a[1] - b[1]) <= 1.5 && Math.abs(a[2] - b[2]) <= 1.5 && Math.abs(a[3] - b[3]) <= 0.02;
const authoredColor = (el, role, rgba) => literalsOf(el)[role].some((css) => {
    const other = toRgba(css);

    return other && sameColor(other, rgba);
});
const rootPx = parseFloat(rootStyle.fontSize) || 16;
const authoredLength = (el, kind, px, style) => literalsOf(el)[kind].some((item) => {
    const base = item.unit === 'px' ? 1 : item.unit === 'pt' ? 4 / 3 : item.unit === 'rem' ? rootPx : kind === 'font-size' ? parseFloat(getComputedStyle(el.parentElement || el).fontSize) || rootPx : parseFloat(style.fontSize) || rootPx;

    return Math.abs(Math.abs(item.value) * base - px) <= 0.5;
});
const authoredFamily = (el, family) => literalsOf(el).family.some((list) => familyOf(list) === family);

// ---------------------------------------------------------------------------------------------------------------------
// The walk.

const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'OPTION', 'OPTGROUP']);
const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
const nodes = body ? [root, body, ...body.querySelectorAll('*')].slice(0, MAX_ELEMENTS + 2) : [root];
const states = new Map();
const painters = [];
const boxes = new Map();
const rects = new Map();
let elements = 0;
const rectOf = (el) => {
    let rect = rects.get(el);

    if (!rect) {
        rect = el.getBoundingClientRect();
        rects.set(el, rect);
    }

    return rect;
};
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// First pass: the resolved background behind each element (every ancestor's color, with opacity), whether it can be
// known at all, and the elements that paint over others (media, images, positioned fills).
for (const el of nodes) {
    if (SKIP.has(el.tagName.toUpperCase()) || el.namespaceURI !== XHTML) {
        if (el.localName === 'svg' && el.namespaceURI !== XHTML) {
            const style = getComputedStyle(el);

            if (style.display !== 'none' && painters.length < 300) {
                const rect = rectOf(el);

                if (rect.width > 0 && rect.height > 0) painters.push({ el, rect });
            }
        }

        continue;
    }

    const style = getComputedStyle(el);

    if (style.display === 'none') continue;

    const parent = el.parentElement;
    const before = parent ? states.get(parent) : undefined;
    let back = before ? before.back : canvasRgb;
    let cum = before ? before.cum : 1;
    let uncertain = before ? before.uncertain : false;
    let clip = before ? before.clip : false;
    let fixed = before ? before.fixed : false;
    const opacity = parseFloat(style.opacity);

    cum *= Number.isNaN(opacity) ? 1 : opacity;
    const bg = toRgba(style.backgroundColor) || [0, 0, 0, 0];

    if (bg[3] > 0) back = mix(back, bg, bg[3] * cum);

    const image = style.backgroundImage !== 'none';

    if (image || style.filter !== 'none' || (style.backdropFilter || 'none') !== 'none' || style.mixBlendMode !== 'normal') uncertain = true;

    // Partial opacity (a faded state, a transition caught half way) and an overlay drawn by ::before or ::after make
    // what is behind the text uncertain; so does a clip or a mask.
    if (cum < 0.99 || (style.clipPath !== 'none' && style.clipPath !== undefined) || (style.maskImage || style.webkitMaskImage || 'none') !== 'none') uncertain = true;

    for (const pseudo of ['::before', '::after']) {
        const made = getComputedStyle(el, pseudo);

        if (made.content !== 'none' && made.content !== 'normal' && made.display !== 'none' && (made.position === 'absolute' || made.position === 'fixed') && (made.backgroundImage !== 'none' || (toRgba(made.backgroundColor) || [0, 0, 0, 0])[3] > 0)) uncertain = true;
    }

    if (el !== root && el !== body && style.overflowX !== 'visible') clip = true;

    if (style.position === 'fixed') fixed = true;

    states.set(el, { back, cum, uncertain, clip, fixed, before: before ? before.back : canvasRgb });

    if (painters.length < 300 && el !== root && el !== body) {
        const rect = rectOf(el);

        if (rect.width > 0 && rect.height > 0) {
            const positioned = style.position === 'absolute' || style.position === 'fixed' || style.zIndex !== 'auto' || style.transform !== 'none';

            if (MEDIA.has(el.tagName) || image || (positioned && bg[3] > 0)) painters.push({ el, rect });
        }
    }
}

const overlapped = (el, rect) => painters.some((item) => item.el !== el && !item.el.contains(el) && !el.contains(item.el) && intersects(rect, item.rect));
const hasText = (el) => {
    for (const child of el.childNodes) {
        if (child.nodeType === 3 && child.nodeValue.trim() !== '') return true;
    }

    return el.localName === 'input' && /^(button|submit|reset)$/.test(el.type) && el.value !== '';
};
const familyOf = (list) => {
    const first = list.split(',')[0].trim().replace(/^["']|["']$/g, '');

    return first.toLowerCase();
};
const pxOf = (value) => parseFloat(value);
// What a pointer or finger can hit; the keyboard also reaches anything with a tabindex.
const pointed = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch]';
const interactive = pointed + ',[tabindex]:not([tabindex="-1"])';
const OS_BLACK = 'rgba(0, 0, 0, 1)';
const targets = [];
const textFamilies = new Map();
const focusCandidates = new Map();
const viewWidth = root.clientWidth || win.innerWidth;
const offenders = [];
const fontInfo = new Map();
const spaceSeen = new Map();
const radiusSeen = new Map();
const scaleSides = [['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']];

for (const el of nodes) {
    const state = states.get(el);

    if (!state) continue;

    const style = getComputedStyle(el);
    const rect = rectOf(el);
    const box = rect.width > 0 && rect.height > 0 && style.display !== 'contents';

    if (!box && el !== root && el !== body) continue;
    if (style.visibility !== 'visible' || state.cum < 0.01) continue;
    if (rect.right + win.scrollX < 0 || rect.bottom + win.scrollY < 0) continue;

    elements++;
    const tag = el.localName;
    const text = hasText(el);
    const disabled = el.matches(':disabled');
    const parentStyle = el.parentElement ? getComputedStyle(el.parentElement) : null;

    // Colors in use: where each is used (text, background, border, outline).
    const used = new Set();
    const useColor = (css, role) => {
        const rgba = toRgba(css);

        if (!rgba || rgba[3] <= 0) return;

        const key = rgba.map((n) => round(n)).join(',');
        const hard = input.literals === true && authoredColor(el, role, rgba);

        if (used.has(role + key)) return;

        used.add(role + key);
        const found = group(groups.colors, key + '|' + role + (hard ? '|L' : ''), () => ({ rgba, roles: {}, literal: hard }), el);

        if (found) found.roles[role] = (found.roles[role] || 0) + 1;
    };

    const fill = toRgba(style.webkitTextFillColor || style.color);
    const gradientText = style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text' || (fill && fill[3] === 0);

    if (text && !gradientText && !(style.color === 'rgb(0, 0, 0)' && rootStyle.color === 'rgb(0, 0, 0)' && parentStyle && parentStyle.color === style.color)) {
        useColor(style.webkitTextFillColor || style.color, 'text');
    }

    useColor(style.backgroundColor, 'background');

    for (const [side, name] of scaleSides) {
        if (pxOf(style['border' + name + 'Width']) > 0 && !/^(none|hidden)$/.test(style['border' + name + 'Style'])) {
            useColor(style['border' + name + 'Color'], 'border');
        }
    }

    if (pxOf(style.outlineWidth) > 0 && !/^(none|hidden)$/.test(style.outlineStyle)) useColor(style.outlineColor, 'outline');

    // Fonts and font sizes, and the text's contrast with what is behind it.
    // Text made invisible on purpose (a screen-reader-only label) is not judged.
    const hiddenText = /^rect\(0(px)?,? ?0(px)?,? ?0(px)?,? ?0(px)?\)$/.test(style.clip) || /^inset\((50|100)%/.test(style.clipPath) || pxOf(style.textIndent) <= -500 || (/^(hidden|clip)$/.test(style.overflowX) && rect.height <= 1);

    if (text && !gradientText && !hiddenText && fill && rect.width > 1 && rect.height > 1 && pxOf(style.fontSize) >= 1) {
        const fontSize = pxOf(style.fontSize);
        const family = familyOf(style.fontFamily);

        const hardFamily = input.literals === true && authoredFamily(el, family);

        group(groups.fonts, family + (hardFamily ? '|L' : ''), () => ({ family, list: style.fontFamily.slice(0, 300), literal: hardFamily }), el);

        const info = fontInfo.get(family) || { list: style.fontFamily.slice(0, 300), count: 0 };

        info.count++;
        fontInfo.set(family, info);

        if (!textFamilies.has(family)) textFamilies.set(family, el);

        const hardSize = input.literals === true && authoredLength(el, 'font-size', fontSize, style);

        group(groups.sizes, 'font-size|' + round(fontSize) + (hardSize ? '|L' : ''), () => ({ kind: 'font-size', px: round(fontSize), props: ['font-size'], literal: hardSize }), el);

        const near = overlapped(el, rect);

        if (!state.uncertain && !near && !disabled) {
            const alpha = fill[3] * state.cum;
            const fg = mix(state.back, fill, alpha).map(Math.round);
            const bgc = state.back.map(Math.round);
            const weight = parseInt(style.fontWeight, 10) || 400;
            const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);

            group(groups.contrast, 'text|' + fg + '|' + bgc + '|' + large, () => ({ fg, bg: bgc, size: round(fontSize), large, ui: false }), el);
        }
    }

    // A form control's edge against what it sits on (WCAG 1.4.11).
    if (!disabled && (tag === 'select' || tag === 'textarea' || (tag === 'input' && !/^(hidden|checkbox|radio|range|color|file|button|submit|reset|image)$/.test(el.type))) && !state.uncertain) {
        const around = state.before;
        const own = state.back;
        let best = 0;
        const ratioOf = (a, b) => {
            const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            const [la, lb] = [lum(a), lum(b)].map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);

            return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };
        let edge = false;
        const edges = [];
        const fillRaw = toRgba(style.backgroundColor);

        best = ratioOf(own, around);

        if (best > 1.02) {
            edge = true;

            if (fillRaw && fillRaw[3] > 0) edges.push(fillRaw);
        }

        for (const [side, name] of scaleSides) {
            const color = toRgba(style['border' + name + 'Color']);

            if (pxOf(style['border' + name + 'Width']) > 0 && !/^(none|hidden)$/.test(style['border' + name + 'Style']) && color && color[3] > 0) {
                edge = true;
                edges.push(color);
                best = Math.max(best, ratioOf(mix(own, color, color[3] * state.cum), around));
            }
        }

        if (edge && best < 3) {
            group(groups.contrast, 'ui|' + own.map(Math.round) + '|' + around.map(Math.round) + '|' + best.toFixed(1), () => ({ fg: own.map(Math.round), bg: around.map(Math.round), size: 0, large: false, ui: true, ratio: best, edges: edges.slice(0, 5) }), el);
        }
    }

    // Spacing and radii.
    if (box) {
        const space = (value, prop, auto) => {
            const px = Math.abs(pxOf(value));

            if (auto || !(px > 0.5) || Number.isNaN(px)) return;

            const hard = input.literals === true && authoredLength(el, 'space', px, style);
            const key = 'space|' + round(px) + (hard ? '|L' : '');

            let seen = spaceSeen.get(key);

            if (!seen || seen.el !== el) {
                seen = { el, found: group(groups.sizes, key, () => ({ kind: 'space', px: round(px), props: [], literal: hard }), el) };
                spaceSeen.set(key, seen);
            }

            const found = seen.found;

            if (found && found.props.length < 3 && !found.props.includes(prop)) found.props.push(prop);
        };
        let map = null;

        try {
            map = el.computedStyleMap();
        } catch {
            map = null;
        }

        const typed = (prop) => {
            const value = map ? map.get(prop) : null;

            if (!value) return false;

            return value.toString() === 'auto' || (value.unit === 'percent');
        };

        // A native checkbox or radio keeps the browser's margin unless the page changes it.
        const native = tag === 'input' && /^(checkbox|radio)$/.test(el.type);

        for (const [side, name] of scaleSides) {
            space(style['padding' + name], 'padding', typed('padding-' + side));
            space(style['margin' + name], 'margin', native || typed('margin-' + side));
        }

        space(style.rowGap === 'normal' ? '0px' : style.rowGap, 'gap', false);
        space(style.columnGap === 'normal' ? '0px' : style.columnGap, 'gap', false);

        for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
            const value = style['border' + corner + 'Radius'];

            if (value.includes('%')) continue;

            const px = pxOf(value);

            if (!(px > 0.5) || px >= Math.min(rect.width, rect.height) / 2) continue;

            const hard = input.literals === true && authoredLength(el, 'radius', px, style);
            const key = 'radius|' + round(px) + (hard ? '|L' : '');

            if (radiusSeen.get(key) === el) continue;

            radiusSeen.set(key, el);
            group(groups.sizes, key, () => ({ kind: 'radius', px: round(px), props: ['border-radius'], literal: hard }), el);
        }
    }

    // Targets that a finger or a pointer must hit.
    if (!input.deck && el.matches(pointed) && !disabled && el.getAttribute('aria-hidden') !== 'true' && !el.parentElement.closest(pointed)) {
        let width = rect.width;
        let height = rect.height;
        let left = rect.left;
        let top = rect.top;
        const labels = el.labels ? [...el.labels] : [];
        const isCheck = tag === 'input' && /^(checkbox|radio)$/.test(el.type);

        for (const label of labels) {
            const lr = label.getBoundingClientRect();

            if (lr.width * lr.height > width * height) {
                width = lr.width;
                height = lr.height;
                left = lr.left;
                top = lr.top;
            }
        }

        const inline = style.display === 'inline' && tag !== 'input' && tag !== 'button' && tag !== 'select' && tag !== 'textarea' && el.parentElement && [...el.parentElement.childNodes].some((n) => n !== el && n.nodeType === 3 && n.nodeValue.trim() !== '');
        const bare = (isCheck || (tag === 'input' && el.type === 'range')) && style.appearance !== 'none' && labels.length === 0;

        if (!inline && !bare && width > 0 && height > 0) targets.push({ el, left, top, width, height, tag });
    }

    // Overflow: elements that end past the viewport and are not clipped or fixed.
    if (!input.deck && el !== root && el !== body && !state.clip && !state.fixed && rect.right > viewWidth + 1) offenders.push({ el, right: rect.right, content: (el.textContent || '').trim() !== '' || el.matches(pointed + ',img,video,canvas,svg') });

    // Headings in order.
    const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : el.getAttribute('role') === 'heading' ? Number(el.getAttribute('aria-level')) : 0;

    if (level >= 1 && level <= 6 && (el.textContent || '').trim() !== '') headings.push({ el, level });

    // Elements that comments and pins need a data-pid on.
    if (/^(header|nav|main|footer|section|article|aside|form|h[1-6]|button|img|a|input|select|textarea)$/.test(tag) && !el.hasAttribute('data-pid') && !(tag === 'a' && !el.hasAttribute('href'))) {
        group(groups.pids, tag, () => ({ tag }), el);
    }
}

// Images without a text alternative (an SVG with role=img counts too).
for (const el of [...doc.querySelectorAll('img,input[type=image],[role=img]')].slice(0, 500)) {
    const tag = el.localName;
    const role = el.getAttribute('role');
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const hidden = el.getAttribute('aria-hidden') === 'true' || role === 'presentation' || role === 'none' || style.display === 'none' || style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0;

    if (hidden) continue;

    const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || (tag !== 'img' && tag !== 'input' && (el.hasAttribute('title') || el.querySelector('title')));
    let why = '';

    if ((tag === 'img' || tag === 'input') && !el.hasAttribute('alt') && !named) why = 'no alt attribute';
    else if (tag !== 'img' && tag !== 'input' && !named) why = 'role=img with no accessible name';

    if (why) group(groups.images, tag + '|' + (el.getAttribute('src') || '').slice(0, 120) + '|' + why, () => ({ tag, why }), el);
}

// Elements that can take the focus, one for each kind. A control that is see-through (a custom checkbox) still counts.
for (const el of [...doc.querySelectorAll(interactive)].slice(0, 1000)) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    if (style.display === 'none' || style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0 || el.matches(':disabled') || el.getAttribute('aria-hidden') === 'true') continue;

    if (el.parentElement && el.parentElement.closest(interactive)) continue;

    if (el.closest('[inert]') || (input.deck && !el.closest('section.slide'))) continue;

    // A specimen of the focus state (class is-focus, a static ring) is not the real thing: it has the ring at rest.
    if ([...el.classList].some((name) => /(^|[-_])(focus|focused|focus-visible)($|[-_])/i.test(name)) || el.hasAttribute('data-focus')) continue;

    const key = el.localName + '.' + [...el.classList].slice(0, 3).join('.');

    if (!focusCandidates.has(key)) focusCandidates.set(key, { el, count: 0 });

    focusCandidates.get(key).count++;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tap targets: under 24 px is an error, under 44 px a warning (WCAG 2.2 sets 24 px; 44 px is the common touch advice).

for (const target of targets) {
    // Whole pixels: a 43.99 px box from fractional text widths is 44.
    const least = Math.round(Math.min(target.width, target.height));
    const level = least < 24 ? 'error' : least < 44 ? 'warning' : '';

    if (level) {
        const width = Math.round(target.width);
        const height = Math.round(target.height);

        group(groups.targets, level + '|' + width + 'x' + height + '|' + target.tag, () => ({ level, width, height, tag: target.tag }), target.el);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Page-level checks.

let overflow;

if (!input.deck) {
    const scrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    const viewportX = rootStyle.overflowX === 'visible' && body ? getComputedStyle(body).overflowX : rootStyle.overflowX;
    const clipped = /^(hidden|clip)$/.test(viewportX);

    // Hidden overflow of decoration (a glow, a blob) is on purpose; hidden text, controls, and images are not.
    const cut = offenders.filter((item) => item.content);

    // Page scrolls: every offender. Page clips: only those with something to read or touch.
    const shown = clipped ? cut : offenders;

    if ((scrollWidth > viewWidth + 1 && !clipped) || (clipped && cut.length > 0)) {
        shown.sort((a, b) => b.right - a.right);
        overflow = { scrollWidth: Math.round(scrollWidth), clientWidth: Math.round(viewWidth), clipped, offenders: shown.length, el: shown[0] ? infoOf(shown[0].el) : undefined };
    }
}

const headingResults = [];
let previousLevel = 0;

for (const { el, level } of headings) {
    if (previousLevel > 0 && level > previousLevel + 1 && headingResults.length < 10) {
        headingResults.push({ count: 1, level, previous: previousLevel, el: infoOf(el) });
    }

    previousLevel = level;
}

// Fonts: a face that failed to load, or a family that nothing here provides.
const faces = [];

if (doc.fonts && doc.fonts.forEach) {
    doc.fonts.forEach((face) => faces.push({ family: String(face.family).replace(/^["']|["']$/g, '').toLowerCase(), status: face.status }));
}

const KEYWORD = /^(-apple-system|blinkmacsystemfont|system-ui|ui-[a-z-]+|serif|sans-serif|monospace|cursive|fantasy|emoji|math|fangsong|inherit|initial|unset)$/;
const OS_FONTS = new Set(['arial', 'helvetica', 'helvetica neue', 'times new roman', 'times', 'courier new', 'courier', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'segoe ui', 'menlo', 'monaco', 'consolas', 'sf pro', 'sf pro text', 'sf pro display', 'sf mono', 'san francisco', 'lucida grande', 'impact', 'palatino', 'garamond', 'comic sans ms', 'apple color emoji', 'segoe ui emoji', 'noto color emoji', 'roboto', 'ubuntu', 'cantarell', 'noto sans', 'liberation sans', 'dejavu sans']);
const meter = doc.createElement('span');
meter.textContent = 'mmmmmmmmmmlliWW@@';
meter.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:nowrap;font-size:72px;font-style:normal;font-weight:400;letter-spacing:0';
body.append(meter);
const widthOf = (family) => {
    meter.style.fontFamily = family;

    return meter.getBoundingClientRect().width;
};
const bases = ['monospace', 'serif', 'sans-serif'].map((name) => [name, widthOf(name)]);
const installed = (family) => bases.some(([name, width]) => widthOf('"' + family.replace(/"/g, '') + '",' + name) !== width);
const fontFaces = [];
const shownName = (list) => list.split(',')[0].trim().replace(/^["']|["']$/g, '');

for (const [family, el] of textFamilies) {
    if (KEYWORD.test(family) || fontFaces.length >= 12) continue;

    const own = faces.filter((face) => face.family === family);
    const count = fontInfo.get(family).count;

    if (own.length > 0 && !own.some((face) => face.status === 'loaded')) {
        fontFaces.push({ count, family: shownName(fontInfo.get(family).list), why: 'the @font-face did not load (' + own[0].status + ')', failed: true, el: infoOf(el) });
    } else if (own.length === 0 && !OS_FONTS.has(family) && !installed(family)) {
        fontFaces.push({ count, family: shownName(fontInfo.get(family).list), why: 'there is no @font-face for it and it is not installed', failed: false, el: infoOf(el) });
    }
}

meter.remove();

// Focus: put the focus on one element of each kind and see whether anything about it, or around it, changes.
const focusProps = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'backgroundColor', 'color', 'textDecorationLine', 'textDecorationColor', 'filter', 'opacity', 'transform', 'backgroundImage'];
const snapshot = (list) => list.map((node) => { const s = getComputedStyle(node); return focusProps.map((p) => s[p]).join('|'); }).join('||');
const focusResults = [];
const startActive = doc.activeElement;

for (const { el, count } of [...focusCandidates.values()].slice(0, 40)) {
    if (focusResults.length >= 20) break;

    const scope = new Set([el, ...[...el.querySelectorAll('*')].slice(0, 12), ...(el.labels ? [...el.labels] : [])]);
    let ancestor = el.parentElement;

    for (let depth = 0; ancestor && depth < 3; depth++) {
        scope.add(ancestor);
        [...ancestor.children].slice(0, 12).forEach((child) => scope.add(child));
        ancestor = ancestor.parentElement;
    }

    const list = [...scope];
    const before = snapshot(list);

    try {
        el.focus({ preventScroll: true, focusVisible: true });
    } catch {
        continue;
    }

    if (doc.activeElement !== el) continue;

    const after = snapshot(list);
    const style = getComputedStyle(el);
    const ring = !/^(none|hidden)$/.test(style.outlineStyle) && pxOf(style.outlineWidth) !== 0 && (toRgba(style.outlineColor) || [0, 0, 0, 0])[3] > 0;

    el.blur();

    if (!ring && before === after) {
        focusResults.push({ count, tag: el.localName, outlineNone: style.outlineStyle === 'none' || pxOf(style.outlineWidth) === 0, el: infoOf(el) });
    }
}

if (startActive && startActive !== doc.body) startActive.focus({ preventScroll: true });

calm.remove();

return {
    elements,
    viewport: { width: win.innerWidth, height: win.innerHeight },
    hasViewportMeta: doc.querySelector('meta[name=viewport]') !== null,
    resolvedColors,
    resolvedLengths,
    colors: finish(groups.colors),
    fonts: finish(groups.fonts),
    sizes: finish(groups.sizes),
    contrast: finish(groups.contrast),
    targets: finish(groups.targets),
    overflow,
    images: finish(groups.images),
    headings: headingResults,
    fontFaces,
    focus: focusResults,
    pids: finish(groups.pids),
};
})`;
