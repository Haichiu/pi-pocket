import { colorOf, sameColor } from "./color.ts";
import { families, pixels, shadowLayers, type FlatSystem } from "./dtcg.ts";
import { BenchBrowser, serveFiles } from "./chromium.ts";
import { cssVar } from "./system.ts";

export interface CssCheck {
    parsed: boolean;
    modes: string[];
    expected: number;
    defined: number;
    valid: number;
    comparable: number;
    correct: number;
    problems: string[];
    mediaDark: boolean | undefined;
}

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
    const properties = ${JSON.stringify(PROBE)};
    const out = {};
    for (const token of ${JSON.stringify(tokens)}) {
        const variable = '--' + token.name.replace(/\\./g, '-');
        const raw = getComputedStyle(root).getPropertyValue(variable).trim();
        const property = properties[token.type];
        const entry = { raw, defined: raw !== '' && !raw.includes('var('), valid: false, computed: '' };
        if (entry.defined && property) {
            entry.valid = CSS.supports(property, raw);
            // A new element for every token: Chromium can hand back a stale value for an element whose inline style was
            // rewritten many times (--space-0 read as 0.4px, the value of a variable probed a few hundred tokens before).
            const probe = document.createElement('div');
            probe.style.cssText = 'position:absolute;left:0;top:0;';
            document.body.append(probe);
            probe.style.setProperty(property, 'var(' + variable + ')');
            entry.computed = getComputedStyle(probe).getPropertyValue(property);
            probe.remove();
        } else if (entry.defined) {
            entry.valid = true;
        }
        out[token.name] = entry;
    }
    return out;
})()`;

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
        const named: Record<string, number> = { normal: 400, bold: 700 };

        return (
            Number(computed) ===
            (typeof want === "string" && Object.hasOwn(named, want) ? named[want] : Number(want))
        );
    }

    if (type === "duration") {
        const seconds = /^(-?[\d.]+)(m?s)$/.exec(computed.trim());
        const text =
            typeof want === "object" && want !== null && "value" in want && "unit" in want
                ? `${(want as { value: unknown }).value}${(want as { unit: unknown }).unit}`
                : typeof want === "string"
                  ? want.trim()
                  : "";
        const wanted = /^(-?[\d.]+)(m?s)$/.exec(text);

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
