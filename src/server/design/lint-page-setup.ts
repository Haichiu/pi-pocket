/**
 * A part of the script that `lint.ts` runs inside a rendered design (see `lint-page.ts`): the first lines of the page script: the input, a few helpers, the motion scan (before the calm style hides it), and the calm style. The parts are one
 * function body, in this order: setup, values, literals, states, elements, checks, focus. Plain JavaScript in a string.
 */
export const PAGE_SETUP = String.raw`(async (input) => {
const doc = document;
const win = window;
const root = doc.documentElement;
const body = doc.body;
const XHTML = 'http://www.w3.org/1999/xhtml';
const MAX_ELEMENTS = 4000;
const MAX_GROUPS = 300;
const round = (n) => Math.round(n * 100) / 100;

// Motion first: the calm style below would hide it. A transition or animation that runs longer than 500 ms, or an
// animation that repeats forever, is motion that a person who asks for less (prefers-reduced-motion) should not get,
// unless the page's CSS has a prefers-reduced-motion rule.
const MOTION_MS = 500;
const motion = { count: 0, longest: 0, first: null, override: false, unreadable: false };
const toMs = (text) => text.split(',').map((part) => { const t = part.trim(); return t.endsWith('ms') ? parseFloat(t) : t.endsWith('s') ? parseFloat(t) * 1000 : 0; });

for (const el of [...(body ? body.querySelectorAll('*') : [])].slice(0, 3000)) {
    const style = getComputedStyle(el);

    if (style.display === 'none') continue;

    const props = style.transitionProperty.split(',').map((part) => part.trim());
    const transition = Math.max(0, ...toMs(style.transitionDuration).filter((ms, at) => props[at % props.length] !== 'none'));
    const names = style.animationName.split(',').map((part) => part.trim());
    const durations = toMs(style.animationDuration);
    const repeats = style.animationIterationCount.split(',').map((part) => part.trim());
    let animation = 0;

    names.forEach((name, at) => {
        const ms = durations[at % durations.length];

        if (name === 'none' || !(ms > 0)) return;

        animation = Math.max(animation, repeats[at % repeats.length] === 'infinite' ? Math.max(ms, MOTION_MS + 1) : ms);
    });

    const longest = Math.max(transition, animation);

    if (longest > MOTION_MS) {
        motion.count++;
        motion.longest = Math.max(motion.longest, Math.round(longest));
        if (!motion.first) motion.first = el;
    }
}

const reducedRule = (rules) => {
    for (const rule of rules) {
        if (rule.media && /prefers-reduced-motion/.test(rule.media.mediaText || '')) return true;
        if (rule.conditionText && /prefers-reduced-motion/.test(rule.conditionText)) return true;
        if (rule.cssRules && reducedRule(rule.cssRules)) return true;
    }

    return false;
};

for (const sheet of doc.styleSheets) {
    try {
        if (reducedRule(sheet.cssRules)) motion.override = true;
    } catch {
        motion.unreadable = true;
    }
}

// A style that stops transitions and animations, so every computed value is the resting one.
const calm = doc.createElement('style');
calm.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
doc.head.append(calm);
`;
