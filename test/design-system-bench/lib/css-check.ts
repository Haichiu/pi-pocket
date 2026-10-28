/**
 * The CSS check: load a compiled `tokens.css` in Chromium and, in every mode, read each custom property back through a
 * probe element. A variable is *defined* when it resolves with no `var()` left, *valid* when its type's CSS property
 * accepts it, and *correct* when the browser's value equals the bench's own reading of the DTCG files (colors, lengths,
 * font weights, durations, and shadows are compared; the rest are checked for validity only).
 */
import { colorOf, sameColor } from "./color.ts";
import { families, pixels, shadowLayers, type FlatSystem } from "./dtcg.ts";
import { BenchBrowser, serveFiles } from "./chromium.ts";
import { cssVar } from "./system.ts";

export interface CssCheck {
    /** The stylesheet had rules, and Chromium parsed it. */
    parsed: boolean;
    modes: string[];
    /** Variable and mode pairs that the bench expected. */
    expected: number;
    defined: number;
    valid: number;
    comparable: number;
    correct: number;
    /** The first problems, for the log. */
    problems: string[];
    /** Whether the stylesheet switches to the dark values by the media query when the system has a dark mode. */
    mediaDark: boolean | undefined;
}

/** The CSS property that takes a type's value, and how to read the browser's answer back. */
const PROBE: Record<string, string> = {
    color: "color",
    dimension: "margin-left",
    fontFamily: "font-family",
    fontWeight: "font-weight",
    duration: "transition-duration",
    cubicBezier: "transition-timing-function",
    number: "flex-grow",
    shadow: "box-shadow",
};

const SCRIPT = (tokens: { name: string; type: string }[]) => `(() => {
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:0;top:0;';
    document.body.append(probe);
    const properties = ${JSON.stringify(PROBE)};
    const out = {};
    for (const token of ${JSON.stringify(tokens)}) {
        const variable = '--' + token.name.replace(/\\./g, '-');
        const raw = getComputedStyle(root).getPropertyValue(variable).trim();
        const property = properties[token.type];
        const entry = { raw, defined: raw !== '' && !raw.includes('var('), valid: false, computed: '' };
        if (entry.defined && property) {
            entry.valid = CSS.supports(property, raw);
            probe.style.cssText = 'position:absolute;left:0;top:0;';
            probe.style.setProperty(property, 'var(' + variable + ')');
            entry.computed = getComputedStyle(probe).getPropertyValue(property);
        } else if (entry.defined) {
            entry.valid = true;
        }
        out[token.name] = entry;
    }
    probe.remove();
    return out;
})()`;

/** Compare the browser's computed value with the bench's reading of the same token. `undefined` when not compared. */
function agrees(type: string, computed: string, want: unknown): boolean | undefined {
    if (type === "color") {
        const [a, b] = [colorOf(computed), colorOf(want)];

        return a === undefined || b === undefined ? false : sameColor(a, b, 0.5, 0.02);
    }

    if (type === "dimension") {
        const [a, b] = [pixels(computed), pixels(want)];

        return a === undefined || b === undefined
            ? false
            : Math.abs(a - b) <= 0.01 || (b === 9999 && a > 1000);
    }

    if (type === "fontWeight") {
        return Number(computed) === Number(want);
    }

    if (type === "duration") {
        const seconds = /^(-?[\d.]+)(m?s)$/.exec(computed.trim());
        const wanted = /^(-?[\d.]+)(m?s)$/.exec(typeof want === "string" ? want.trim() : "");

        if (seconds === null || wanted === null) {
            return false;
        }

        const ms = (match: RegExpExecArray) => Number(match[1]) * (match[2] === "s" ? 1000 : 1);

        return Math.abs(ms(seconds) - ms(wanted)) < 0.5;
    }

    if (type === "fontFamily") {
        return families(computed)[0]?.toLowerCase() === families(want)[0]?.toLowerCase();
    }

    if (type === "shadow") {
        const [a, b] = [shadowLayers(computed), shadowLayers(want)];

        return (
            a.length === b.length &&
            a.length > 0 &&
            a.every(
                (layer, index) =>
                    Math.abs(layer.x - b[index]!.x) < 0.5 &&
                    Math.abs(layer.y - b[index]!.y) < 0.5 &&
                    Math.abs(layer.blur - b[index]!.blur) < 1 &&
                    sameColor(layer.color, b[index]!.color, 4, 0.04),
            )
        );
    }

    return undefined;
}

/**
 * Check a compiled stylesheet against the bench's reading of the same system. `flat.tokens` limits the check to the
 * types that have a plain CSS form.
 */
export async function checkCss(
    browser: BenchBrowser,
    css: string,
    flat: FlatSystem,
): Promise<CssCheck> {
    const tokens = flat.tokens.filter((token) => Object.hasOwn(PROBE, token.type));
    const served = await serveFiles(
        new Map([
            [
                "index.html",
                {
                    type: "text/html; charset=utf-8",
                    body: `<!doctype html><meta charset="utf-8"><style>${css.replace(/<\/style/gi, "<\\/style")}</style><body></body>`,
                },
            ],
        ]),
    );
    const page = await browser.page(served.url);
    const result: CssCheck = {
        parsed: false,
        modes: flat.modes.map((mode) => (mode === "default" ? "light" : mode)),
        expected: 0,
        defined: 0,
        valid: 0,
        comparable: 0,
        correct: 0,
        problems: [],
        mediaDark: undefined,
    };

    const note = (text: string) => {
        if (result.problems.length < 12) {
            result.problems.push(text);
        }
    };

    try {
        await page.open(served.url, { width: 800, height: 600 });
        result.parsed =
            (await page.evaluate<number>(
                `Array.from(document.styleSheets).reduce((sum, sheet) => sum + sheet.cssRules.length, 0)`,
            )) > 0;

        const read = async (mode: string, label: string) => {
            const answers = await page.evaluate<
                Record<string, { raw: string; defined: boolean; valid: boolean; computed: string }>
            >(SCRIPT(tokens));

            for (const token of tokens) {
                const answer = answers[token.name]!;

                result.expected++;

                if (!answer.defined) {
                    note(
                        `${label}: ${cssVar(token.name)} is ${answer.raw === "" ? "not defined" : `not resolved (${answer.raw.slice(0, 60)})`}`,
                    );

                    continue;
                }

                result.defined++;

                if (!answer.valid) {
                    note(
                        `${label}: ${cssVar(token.name)} is not a valid ${token.type}: ${answer.raw.slice(0, 60)}`,
                    );

                    continue;
                }

                result.valid++;
                const same = agrees(token.type, answer.computed, token.values[mode]);

                if (same !== undefined) {
                    result.comparable++;

                    if (same) {
                        result.correct++;
                    } else {
                        note(
                            `${label}: ${cssVar(token.name)} is ${answer.computed.slice(0, 60)}, expected ${JSON.stringify(token.values[mode]).slice(0, 60)}`,
                        );
                    }
                }
            }
        };

        await read("default", "light");

        for (const mode of flat.modes.slice(1)) {
            await page.evaluate(
                `document.documentElement.setAttribute('data-theme', ${JSON.stringify(mode)})`,
            );
            await read(mode, mode);
        }

        await page.evaluate(`document.documentElement.removeAttribute('data-theme')`);

        // The dark values must also apply by the media query alone, when the system has a dark mode.
        const dark = flat.modes.find((mode) => /dark/i.test(mode));

        if (dark !== undefined) {
            await page.send("Emulation.setEmulatedMedia", {
                features: [{ name: "prefers-color-scheme", value: "dark" }],
            });
            const before = result.correct;
            const comparable = result.comparable;

            await read(dark, "dark by media");
            const gained = result.correct - before;
            const asked = result.comparable - comparable;

            result.mediaDark = asked > 0 && gained === asked;
        }
    } finally {
        await page.close();
        await served.close();
    }

    return result;
}
