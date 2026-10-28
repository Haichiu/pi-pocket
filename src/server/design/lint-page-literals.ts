/**
 * A part of the script that `lint.ts` runs inside a rendered design (see `lint-page.ts`): values that the page wrote as literals in its own CSS (with a system). The parts are one
 * function body, in this order: setup, values, literals, states, elements, checks, focus. Plain JavaScript in a string.
 */
export const PAGE_LITERALS = String.raw`// ---------------------------------------------------------------------------------------------------------------------
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
`;
