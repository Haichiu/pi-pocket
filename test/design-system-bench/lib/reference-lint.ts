/**
 * A reference linter. It is not the product: it is a plain, independent implementation of the rules that the lint
 * designs are seeded for, so the bench can show that its expected findings are right (a reasonable linter finds exactly
 * them) and that a perfect run scores 1.0. The bench test runs it on every design. Policy it implements, which the
 * README states as the bench's definition of each rule:
 *
 * - off-system-color / -size / -font: an authored value that is not a `var()`. A literal that equals a token's value is
 *   still a literal. `transparent`, `currentColor`, `inherit`, `0`, `auto`, `%` and keywords are not values.
 * - contrast: text color over the effective background, 4.5:1 (3:1 for large text). Disabled controls are exempt.
 * - tap-target: a control under 24 px is an error, under 44 px a warning.
 * - overflow, image-alt (no `alt` attribute), heading-order (a level skipped going down), missing-viewport,
 *   missing-pid (a control, heading, image or landmark without its own `data-pid`), font-fallback (the first declared
 *   family is not installed), focus-visible (a control with no outline or shadow when focused).
 */
import type {
    CheckFinding,
    CheckReport,
    DesignSystem,
} from "../../../src/server/design/system-types.ts";
import { BenchBrowser, serveFiles, typeOf, type FileEntry } from "./chromium.ts";
import { colorOf, contrastRatio, deltaE, toHex, type Rgba } from "./color.ts";
import { pixels } from "./dtcg.ts";

interface Facts {
    declarations: { pid: string; selector: string; prop: string; value: string }[];
    texts: {
        pid: string;
        selector: string;
        fg: number[];
        bg: number[];
        size: number;
        bold: boolean;
        disabled: boolean;
    }[];
    targets: { pid: string; selector: string; width: number; height: number }[];
    images: { pid: string; selector: string; alt: boolean }[];
    headings: { pid: string; selector: string; level: number }[];
    meta: { viewport: boolean; scrollWidth: number; innerWidth: number };
    unlabelled: { selector: string }[];
    focus: { pid: string; selector: string; indicator: boolean }[];
    families: { pid: string; selector: string; family: string; installed: boolean }[];
}

const SCRIPT = String.raw`(() => {
    const short = (el) => {
        const pid = el.closest('[data-pid]')?.getAttribute('data-pid');
        return el.hasAttribute('data-pid') ? el.tagName.toLowerCase() + '[data-pid="' + el.getAttribute('data-pid') + '"]'
            : pid ? el.tagName.toLowerCase() + ' in [data-pid="' + pid + '"]' : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    };
    const own = (el) => el.getAttribute('data-pid') ?? '';
    const facts = { declarations: [], texts: [], targets: [], images: [], headings: [], meta: {}, unlabelled: [], focus: [], families: [] };
    const wanted = /^(color|background(-color)?|border[a-z-]*|outline[a-z-]*|font-size|font-family|padding[a-z-]*|margin[a-z-]*|(row-|column-)?gap)$/;
    const declarations = (text) => {
        const out = []; let depth = 0, start = 0;
        for (let i = 0; i <= text.length; i++) {
            const c = text[i];
            if (c === '(') depth++; else if (c === ')') depth--;
            else if ((c === ';' && depth === 0) || i === text.length) {
                const part = text.slice(start, i), at = part.indexOf(':');
                if (at > 0) out.push([part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).replace(/!important/i, '').trim()]);
                start = i + 1;
            }
        }
        return out;
    };
    const take = (el, prop, value) => {
        if (!wanted.test(prop) || !value) return;
        facts.declarations.push({ pid: own(el) || el.closest('[data-pid]')?.getAttribute('data-pid') || '', selector: short(el), prop, value: value.trim() });
    };
    const walkRules = (rules) => {
        for (const rule of rules) {
            if (rule.cssRules && rule.media && !matchMedia(rule.media.mediaText).matches) continue;
            if (rule.cssRules && !rule.style) { walkRules(rule.cssRules); continue; }
            if (!rule.style || !rule.selectorText) continue;
            let matched = [];
            try { matched = Array.from(document.querySelectorAll(rule.selectorText)); } catch { continue; }
            // cssText, not the longhands: a shorthand that holds a var() reads back as empty longhands.
            for (const el of matched) for (const [prop, value] of declarations(rule.style.cssText)) take(el, prop, value);
        }
    };
    for (const sheet of Array.from(document.styleSheets)) {
        if (sheet.href && /ds\/tokens\.css/.test(sheet.href)) continue;
        try { walkRules(sheet.cssRules); } catch {}
    }
    for (const el of document.querySelectorAll('[style]')) for (const [prop, value] of declarations(el.getAttribute('style'))) take(el, prop, value);

    // Text and its effective background.
    const backdrop = (el) => {
        let layers = [];
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            const bg = getComputedStyle(node).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
            const a = bg.length > 3 ? bg[3] : 1;
            if (a > 0) { layers.push([bg[0], bg[1], bg[2], a]); if (a >= 1) break; }
        }
        let out = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255, 1];
        while (layers.length) { const top = layers.pop(); out = [0, 1, 2].map((i) => top[i] * top[3] + out[i] * (1 - top[3])).concat([1]); }
        return out;
    };
    for (const el of document.body.querySelectorAll('*')) {
        const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
        const style = getComputedStyle(el);
        if (!direct || style.display === 'none' || style.visibility === 'hidden') continue;
        const fg = style.color.match(/[\d.]+/g).map(Number);
        facts.texts.push({ pid: own(el), selector: short(el), fg: [fg[0], fg[1], fg[2], fg.length > 3 ? fg[3] : 1], bg: backdrop(el), size: parseFloat(style.fontSize), bold: Number(style.fontWeight) >= 700, disabled: !!el.closest('[disabled],[aria-disabled="true"]') });
    }

    // Controls: size, focus indicator.
    const controls = Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], summary'));
    for (const el of controls) {
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        facts.targets.push({ pid: own(el), selector: short(el), width: rect.width, height: rect.height });
        const before = getComputedStyle(el);
        const resting = [before.boxShadow, before.borderColor, before.backgroundColor, before.outlineStyle].join('|');
        el.focus({ focusVisible: true });
        const after = getComputedStyle(el);
        const outline = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0;
        const changed = after.boxShadow !== 'none' && after.boxShadow !== before.boxShadow ? true : [after.boxShadow, after.borderColor, after.backgroundColor, after.outlineStyle].join('|') !== resting;
        facts.focus.push({ pid: own(el), selector: short(el), indicator: document.activeElement === el ? outline || changed : true });
        el.blur();
    }

    for (const img of document.querySelectorAll('img')) facts.images.push({ pid: own(img), selector: short(img), alt: img.hasAttribute('alt') });
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) facts.headings.push({ pid: own(h), selector: short(h), level: Number(h.tagName[1]) });
    facts.meta = { viewport: !!document.querySelector('meta[name=viewport]'), scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
    for (const el of document.body.querySelectorAll('a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,img,section,main,header,footer,nav,article,form,table')) if (!el.hasAttribute('data-pid')) facts.unlabelled.push({ selector: short(el) });

    // Declared families that are not installed: the same text measures the same in the family and in the fallback.
    const canvas = document.createElement('canvas').getContext('2d');
    const width = (family, base) => { canvas.font = '40px ' + family + ', ' + base; return canvas.measureText('mmmmmmwwwiiiillll 0123456789').width; };
    for (const d of facts.declarations.filter((d) => d.prop === 'font-family' && !d.value.includes('var('))) {
        const first = d.value.split(',')[0].trim().replace(/^["']|["']$/g, '');
        if (/^(serif|sans-serif|monospace|system-ui|inherit|initial|ui-[a-z-]+)$/i.test(first)) continue;
        const quoted = '"' + first + '"';
        facts.families.push({ pid: d.pid, selector: d.selector, family: first, installed: width(quoted, 'monospace') !== width('monospace', 'monospace') || width(quoted, 'serif') !== width('serif', 'serif') });
    }
    return facts;
})()`;

/** Colors written in a value: hex, and the functional forms. */
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)/gi;
const LENGTH = /^-?\d*\.?\d+(px|rem|em)$/i;

/** The reference `checkDesign`. */
export async function referenceCheck(
    browser: BenchBrowser,
    bundle: { content: string; assets: { name: string; type: string; bytes: Buffer }[] },
    system: DesignSystem,
    options: { viewport: { width: number; height: number }; colorScheme: "light" | "dark" },
): Promise<CheckReport> {
    const files = new Map<string, FileEntry>([
        ["index.html", { type: typeOf("index.html"), body: bundle.content }],
    ]);

    for (const asset of bundle.assets) {
        files.set(asset.name, { type: asset.type || typeOf(asset.name), body: asset.bytes });
    }

    const served = await serveFiles(files);
    const page = await browser.page(served.url);
    let facts: Facts;

    try {
        await page.open(served.url, { ...options.viewport, colorScheme: options.colorScheme });
        facts = await page.evaluate<Facts>(SCRIPT);
    } finally {
        await page.close();
        await served.close();
    }

    const mode =
        options.colorScheme === "dark" && system.modes.includes("dark") ? "dark" : system.modes[0]!;
    const tokens = system.tokens.map((token) => ({ token, value: token.modes[mode]?.value }));
    const colors = tokens.flatMap(({ token, value }) => {
        const color = token.type === "color" ? colorOf(value) : undefined;

        return color === undefined
            ? []
            : [{ cssVar: token.cssVar, color, semantic: token.modes[mode]?.alias !== undefined }];
    });
    const sizes = (prefix: string) =>
        new Set(
            tokens
                .filter(({ token }) => token.name.startsWith(prefix))
                .map(({ value }) => pixels(value))
                .filter((value) => value !== undefined),
        );
    const fontSizes = sizes("font.size.");
    const spacing = new Set([0, ...sizes("space.")]);
    const radii = new Set([0, ...sizes("radius.")]);
    const fonts = new Set(
        tokens
            .filter(({ token }) => token.name.startsWith("font.family."))
            .map(({ value }) =>
                (Array.isArray(value) ? String(value[0]) : String(value).split(",")[0]!)
                    .replace(/["']/g, "")
                    .trim()
                    .toLowerCase(),
            ),
    );
    const findings: CheckFinding[] = [];
    const add = (finding: Omit<CheckFinding, "message"> & { message?: string }) =>
        findings.push({ message: finding.message ?? finding.rule, ...finding });

    const nearest = (color: Rgba) => {
        const ranked = colors
            .map((item) => ({ ...item, distance: deltaE(color, item.color) }))
            .sort((a, b) => a.distance - b.distance);
        const best = ranked[0];

        // Among equal values the role token (an alias) is the one to use, not the palette step behind it.
        return best === undefined
            ? undefined
            : (ranked.find((item) => item.semantic && item.distance - best.distance < 0.01) ??
                  best);
    };

    for (const declaration of facts.declarations) {
        const { prop, value, pid, selector } = declaration;

        if (/color|background|border|outline/.test(prop) && !/radius/.test(prop)) {
            for (const literal of value.match(COLOR_LITERAL) ?? []) {
                const color = colorOf(literal);
                const near = color === undefined ? undefined : nearest(color);

                if (color !== undefined && color.a > 0) {
                    add({
                        rule: "off-system-color",
                        level: "warning",
                        selector,
                        pid,
                        value: literal,
                        suggestion: near === undefined ? undefined : `var(${near.cssVar})`,
                    });
                }
            }
        } else if (prop === "font-size") {
            const size = pixels(value);

            if (LENGTH.test(value.trim()) && size !== undefined && !fontSizes.has(size)) {
                add({
                    rule: "off-system-size",
                    level: "warning",
                    selector,
                    pid,
                    value: value.trim(),
                });
            }
        } else if (/radius/.test(prop) || /^(padding|margin|gap|row-gap|column-gap)/.test(prop)) {
            const allowed = /radius/.test(prop) ? radii : spacing;

            for (const part of value.trim().split(/\s+/)) {
                const size = pixels(part);

                if (LENGTH.test(part) && size !== undefined && !allowed.has(Math.abs(size))) {
                    add({ rule: "off-system-size", level: "warning", selector, pid, value: part });
                }
            }
        } else if (prop === "font-family") {
            const first = value.split(",")[0]!.replace(/["']/g, "").trim();

            if (
                !value.includes("var(") &&
                !fonts.has(first.toLowerCase()) &&
                !/^(inherit|initial|unset)$/i.test(first)
            ) {
                add({
                    rule: "off-system-font",
                    level: "warning",
                    selector,
                    pid,
                    value: first,
                    suggestion: "var(--font-family-body)",
                });
            }
        }
    }

    for (const family of facts.families.filter((item) => !item.installed)) {
        add({
            rule: "font-fallback",
            level: "warning",
            selector: family.selector,
            pid: family.pid,
            value: family.family,
        });
    }

    for (const text of facts.texts) {
        const fg: Rgba = { r: text.fg[0]!, g: text.fg[1]!, b: text.fg[2]!, a: text.fg[3] ?? 1 };
        const bg: Rgba = { r: text.bg[0]!, g: text.bg[1]!, b: text.bg[2]!, a: text.bg[3] ?? 1 };
        const ratio = contrastRatio(fg, bg);
        const large = text.size >= 24 || (text.size >= 18.66 && text.bold);

        if (!text.disabled && ratio < (large ? 3 : 4.5)) {
            add({
                rule: "contrast",
                level: "error",
                selector: text.selector,
                pid: text.pid,
                value: `${ratio.toFixed(1)}:1`,
            });
        }
    }

    for (const target of facts.targets) {
        const smallest = Math.min(target.width, target.height);

        if (smallest < 44) {
            add({
                rule: "tap-target",
                level: smallest < 24 ? "error" : "warning",
                selector: target.selector,
                pid: target.pid,
                value: `${Math.round(smallest)}px`,
            });
        }
    }

    for (const image of facts.images.filter((item) => !item.alt)) {
        add({ rule: "image-alt", level: "error", selector: image.selector, pid: image.pid });
    }

    facts.headings.forEach((heading, index) => {
        const before = facts.headings[index - 1];

        if (before !== undefined && heading.level > before.level + 1) {
            add({
                rule: "heading-order",
                level: "warning",
                selector: heading.selector,
                pid: heading.pid,
                value: `h${heading.level} after h${before.level}`,
            });
        }
    });

    for (const control of facts.focus.filter((item) => !item.indicator)) {
        add({
            rule: "focus-visible",
            level: "warning",
            selector: control.selector,
            pid: control.pid,
        });
    }

    for (const item of facts.unlabelled) {
        add({ rule: "missing-pid", level: "warning", selector: item.selector });
    }

    if (!facts.meta.viewport) {
        add({ rule: "missing-viewport", level: "error", selector: "" });
    }

    // The page's width is the width that was asked for: a phone zooms out to fit wide content, so innerWidth grows with it.
    if (facts.meta.scrollWidth > options.viewport.width + 1) {
        add({
            rule: "overflow",
            level: "error",
            selector: "",
            value: `${facts.meta.scrollWidth}px`,
        });
    }

    const byRule: Record<string, number> = {};

    for (const finding of findings) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    }

    return {
        viewport: options.viewport,
        colorScheme: options.colorScheme,
        findings,
        summary: {
            errors: findings.filter((item) => item.level === "error").length,
            warnings: findings.filter((item) => item.level === "warning").length,
            elements: facts.texts.length + facts.targets.length,
            byRule,
        },
        withoutSystem: false,
    };
}

export { toHex };
