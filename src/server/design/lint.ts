// Precision matters more than recall: a finding is reported only when the page's own values prove it.
// The page is untrusted: everything that comes back from it is shape-checked and bounded before it is used.
import { createHash } from "node:crypto";
import type { PocketHost } from "../host.ts";
import type { DesignBundle } from "./bundle.ts";
import { contrastFindings } from "./lint-analyze-contrast.ts";
import { colorFindings, fontFindings, sizeFindings } from "./lint-analyze-system.ts";
import { tokenSet, type TokenSet } from "./lint-color.ts";
import { colorRoleOf } from "./lint-suggest.ts";
import { PAGE_SCRIPT, type PageInput, type RawPage } from "./lint-page.ts";
import {
    clip,
    elementOf,
    lengthsOf,
    more,
    num,
    plural,
    rgbaOf,
    tokenRef,
    weighted,
    type WeightedFinding,
} from "./lint-analyze-util.ts";
import {
    type DesignAction,
    type DesignPage,
    type DesignViewport,
    type TweakValues,
    type ViewportName,
    viewportOf,
    withRender,
} from "./render.ts";
import type { CheckFinding, CheckReport, CheckRule, DesignSystem } from "./system-types.ts";

export interface CheckOptions {
    viewport?: ViewportName | DesignViewport;
    colorScheme?: "light" | "dark";
    // A mode of the system: the page gets `data-theme="<mode>"` on its root, is drawn in the mode's color scheme (`colorScheme` is the fallback), and is compared with that mode's tokens.
    // Left out: `dark` when the system has that mode and the scheme is dark (the root gets `data-theme` only if the page sets none), else the system's default mode.
    mode?: string;
    tweaks?: TweakValues;
    page?: string;
    accepted?: string[];
    actions?: DesignAction[];
    /** For a deck: the slide to check (from 1, default 1), or `all` (up to 40 slides). */
    slide?: number | "all";
}

const RULE_ORDER: CheckRule[] = [
    "contrast",
    "overflow",
    "off-system-color",
    "off-system-font",
    "off-system-size",
    "tap-target",
    "font-fallback",
    "image-alt",
    "missing-viewport",
    "focus-visible",
    "reduced-motion",
    "form-label",
    "accessible-name",
    "missing-lang",
    "input-zoom",
    "missing-main",
    "heading-order",
    "missing-pid",
];

export const MOTION_MS = 500;

export { colorRoleOf };

interface ModeView {
    mode: string;
    scheme: "light" | "dark";
    theme?: string;
    /** True when the mode was asked for by name: the attribute then replaces the page's own. */
    named: boolean;
}

export function modeFor(
    system: DesignSystem,
    colorScheme: "light" | "dark",
    mode?: string,
): ModeView {
    if (mode !== undefined) {
        if (!system.modes.includes(mode)) {
            throw new Error(
                `The design system has no mode "${mode}". Modes: ${system.modes.join(", ")}.`,
            );
        }

        return { mode, scheme: system.schemes?.[mode] ?? colorScheme, theme: mode, named: true };
    }

    // The mode that `tokens.css` shows at this scheme without a data-theme: the default mode in its own scheme, else the
    // mode of its media query (named for the scheme, else the first of that scheme), as `preferred` in tokens-compile.ts.
    const base = system.modes[0] ?? "light";
    const other =
        (system.schemes?.[base] ?? "light") === colorScheme
            ? undefined
            : (system.modes.find((each) => each !== base && each === colorScheme) ??
              system.modes.find(
                  (each) => each !== base && (system.schemes?.[each] ?? "light") === colorScheme,
              ));

    if (other !== undefined) {
        return { mode: other, scheme: colorScheme, theme: other, named: false };
    }

    return { mode: base, scheme: colorScheme, named: false };
}

function resolveTokens(set: TokenSet, raw: RawPage): void {
    set.colors.forEach((token, index) => {
        token.rgba = rgbaOf(raw.resolvedColors?.[index]);
    });
    set.lengths.forEach((token, index) => {
        const value = raw.resolvedLengths?.[index];

        token.px = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    });
}

export function analyze(
    raw: RawPage,
    tokens: TokenSet | undefined,
    context: { deck?: boolean; phone?: boolean } = {},
): CheckFinding[] {
    const out: WeightedFinding[] = [];
    const add = (finding: CheckFinding, weight = 1) => out.push(weighted(finding, weight));

    if (tokens !== undefined) {
        resolveTokens(tokens, raw);
    }

    out.push(
        ...colorFindings(raw, tokens),
        ...fontFindings(raw, tokens),
        ...sizeFindings(raw, tokens),
        ...contrastFindings(raw, tokens),
    );

    for (const group of raw.targets ?? []) {
        const width = num(group.width);
        const height = num(group.height);
        const level = group.level === "error" ? "error" : "warning";

        add(
            {
                rule: "tap-target",
                level,
                ...elementOf(group.el),
                value: `${width}×${height}px`,
                message:
                    level === "error"
                        ? `A <${clip(group.tag, 20)}> target is ${width}×${height} px, under the 24×24 px minimum of WCAG 2.2${more(num(group.count))}. Set \`min-width: 44px; min-height: 44px\` (or padding) on it.`
                        : `A <${clip(group.tag, 20)}> target is ${width}×${height} px; 44×44 px is easier to hit on a phone${more(num(group.count))}. Set \`min-width: 44px; min-height: 44px\` (or padding) on it.`,
            },
            num(group.count),
        );
    }

    if (raw.overflow !== undefined && context.deck !== true) {
        const { scrollWidth, clientWidth, clipped, offenders } = raw.overflow;

        add({
            rule: "overflow",
            level: clipped ? "warning" : "error",
            ...elementOf(raw.overflow.el),
            value: `${num(scrollWidth)}px in ${num(clientWidth)}px`,
            message: clipped
                ? `Content reaches ${num(scrollWidth)} px in a ${num(clientWidth)} px viewport and is cut off (${plural(num(offenders), "element")} end past the edge).`
                : `The page scrolls sideways: ${num(scrollWidth)} px wide in a ${num(clientWidth)} px viewport${raw.overflow.el === undefined ? "" : `, with the widest element ending past the edge (${plural(num(offenders), "element")} do)`}. Let it wrap, shrink, or scroll inside its own box.`,
        });
    }

    for (const group of raw.images ?? []) {
        add(
            {
                rule: "image-alt",
                level: "error",
                ...elementOf(group.el),
                message: `An image has ${clip(group.why, 60)}${more(num(group.count))}. Add \`alt="what it shows"\`, or \`alt=""\` if it is decoration.`,
            },
            num(group.count),
        );
    }

    for (const group of raw.headings ?? []) {
        add({
            rule: "heading-order",
            level: "warning",
            ...elementOf(group.el),
            value: `h${num(group.level)} after h${num(group.previous)}`,
            message: `A heading jumps from level ${num(group.previous)} to ${num(group.level)}. Change the tag to <h${num(group.previous) + 1}> and keep its look with CSS.`,
        });
    }

    for (const group of raw.fontFaces ?? []) {
        const family = clip(group.family, 120);

        add(
            {
                rule: "font-fallback",
                level: group.failed ? "error" : "warning",
                ...elementOf(group.el),
                value: family,
                message: `Font "${family}" is used but ${clip(group.why, 100)}, so the text falls back to another font${more(num(group.count))}. Load the font (an @font-face file in the bundle, or a public HTTPS stylesheet).`,
            },
            num(group.count),
        );
    }

    if (raw.hasViewportMeta === false && context.deck !== true) {
        add({
            rule: "missing-viewport",
            level: "error",
            selector: "",
            message:
                'The page has no viewport meta tag, so a phone shows it zoomed out. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        });
    }

    for (const group of raw.focus ?? []) {
        const tag = clip(group.tag, 20);

        add(
            {
                rule: "focus-visible",
                level: "warning",
                ...elementOf(group.el),
                message: `A <${tag}> shows no focus style: ${group.outlineNone ? "its outline is removed and nothing else changes" : "nothing changes"} when a keyboard focuses it${more(num(group.count))}. Add a :focus-visible rule, such as outline: 2px solid ${tokens?.colors.find((token) => /focus|ring/i.test(token.name)) === undefined ? "an accent color" : tokenRef(tokens.colors.find((token) => /focus|ring/i.test(token.name))!)}.`,
            },
            num(group.count),
        );
    }

    const semantics = raw.semantics;

    if (semantics !== undefined && semantics.lang === false) {
        add({
            rule: "missing-lang",
            level: "error",
            ...elementOf(semantics.html),
            message:
                'The page has no lang attribute on <html>, so a screen reader has to guess its language (WCAG 3.1.1). Set `<html lang="en">`, with the page\'s own language.',
        });
    }

    if (semantics !== undefined && semantics.main === false && context.deck !== true) {
        add({
            rule: "missing-main",
            level: "warning",
            ...elementOf(semantics.body),
            message:
                "The page has no main landmark, so a screen reader cannot jump to its content. Wrap the page's content in `<main>`.",
        });
    }

    for (const group of raw.labels ?? []) {
        add(
            {
                rule: "form-label",
                level: "error",
                ...elementOf(group.el),
                value: clip(group.kind, 40),
                message: `A <${clip(group.kind, 40)}> has no label (no label, aria-label, aria-labelledby, or title; a placeholder is not a label: it goes away when a person types, and not every screen reader reads it)${more(num(group.count))}. Add a \`<label for="id">\` (or wrap the field in a \`<label>\`), or add \`aria-label="what it is"\`.`,
            },
            num(group.count),
        );
    }

    for (const group of raw.names ?? []) {
        add(
            {
                rule: "accessible-name",
                level: "error",
                ...elementOf(group.el),
                value: clip(group.kind, 40),
                message: `A <${clip(group.kind, 40)}> has no accessible name (no text, aria-label, aria-labelledby, title, image alt, or SVG title)${more(num(group.count))}. Add \`aria-label="what it does"\`.`,
            },
            num(group.count),
        );
    }

    if (context.phone === true) {
        const sizes =
            tokens === undefined
                ? []
                : lengthsOf(tokens, "font-size").filter((token) => token.px >= 16);
        const step = sizes.sort((a, b) => a.px - b.px)[0];

        for (const group of raw.zoom ?? []) {
            add(
                {
                    rule: "input-zoom",
                    level: "warning",
                    ...elementOf(group.el),
                    value: `${num(group.px)}px`,
                    ...(step === undefined ? {} : { suggestion: tokenRef(step) }),
                    message: `A <${clip(group.kind, 40)}> has font-size ${num(group.px)}px: iOS Safari zooms the page in when a field under 16px gets the focus${more(num(group.count))}. ${
                        step === undefined
                            ? "Set `font-size: 16px`."
                            : `Set \`font-size: ${tokenRef(step)}\` (${step.px}px).`
                    }`,
                },
                num(group.count),
            );
        }
    }

    const motion = raw.motion;

    if (
        motion !== undefined &&
        num(motion.count) > 0 &&
        motion.override !== true &&
        motion.unreadable !== true
    ) {
        add({
            rule: "reduced-motion",
            level: "warning",
            ...elementOf(motion.el),
            value: `${num(motion.longest)}ms`,
            message:
                `${plural(num(motion.count), "element")} use a transition or an animation longer than ${MOTION_MS} ms, or one that repeats forever (the longest is ${num(motion.longest)} ms), and the page has no \`@media (prefers-reduced-motion: reduce)\` rule. ` +
                "Add \`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }\`.",
        });
    }

    const pids = (raw.pids ?? []).filter((group) => num(group.count) > 0);

    if (pids.length > 0) {
        const total = pids.reduce((sum, group) => sum + num(group.count), 0);
        const listed = pids
            .slice(0, 5)
            .map((group) => `${num(group.count)} <${clip(group.tag, 20)}>`);
        const tags = pids.length > 5 ? `${listed.join(", ")}, …` : listed.join(", ");

        add({
            rule: "missing-pid",
            level: "warning",
            ...elementOf(pids[0]!.el),
            message: `${plural(total, "element")} with no data-pid on it or a parent (${tags}). Add data-pid to the sections and controls people may comment on.`,
        });
    }

    const seen = new Map<string, number>();

    return out
        .sort(
            (a, b) =>
                (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1) ||
                RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
                b.weight - a.weight,
        )
        .map(({ weight: _weight, ...finding }) => finding)
        .reduce(groupFindings, [] as CheckFinding[])
        .map((finding) => {
            const id = findingId(finding);
            const again = (seen.get(id) ?? 0) + 1;

            seen.set(id, again);

            return { id: again === 1 ? id : `${id}-${again}`, ...finding };
        });
}

/** A message without its counts, so that two findings of one defect on different elements compare equal. */
const plain = (message: string) =>
    message.replace(/\d+ (more )?(elements?|uses?)/g, "N").replace(/ ?\(and N\)/g, "");

const groupKeys = new WeakMap<CheckFinding, string>();

// Findings of one rule with the same value, suggestion, and message (apart from counts) become one finding that lists its elements. A page-level finding is left alone.
export function groupFindings(list: CheckFinding[], next: CheckFinding): CheckFinding[] {
    const element = (finding: CheckFinding) => ({
        selector: finding.selector,
        ...(finding.pid === undefined ? {} : { pid: finding.pid }),
        ...(finding.rect === undefined ? {} : { rect: finding.rect }),
    });

    const key = (finding: CheckFinding) => {
        if (!groupKeys.has(finding)) {
            groupKeys.set(
                finding,
                [
                    finding.rule,
                    finding.level,
                    finding.value ?? "",
                    finding.suggestion ?? "",
                    plain(finding.message),
                ].join("\0"),
            );
        }

        return groupKeys.get(finding)!;
    };

    const same =
        next.selector === ""
            ? undefined
            : list.find((each) => each.selector !== "" && key(each) === key(next));

    if (same === undefined) {
        return [...list, next];
    }

    const elements = same.elements ?? [element(same)];

    if (elements.length < 12) {
        elements.push(element(next));
    }

    same.elements = elements;
    same.message = same.message.replace(/ The same in \d+ more places?: .*$/, "");
    same.message += ` The same in ${plural(elements.length - 1, "more place")}: ${elements
        .slice(1, 4)
        .map((each) => each.pid ?? each.selector)
        .join(", ")}${elements.length > 4 ? ", …" : ""}.`;

    return list;
}

// The same problem on the same element has the same id in every run, so a pin can follow it; fixing the value ends it. The color scheme, the viewport, and the wording do not change it.
export function findingId(
    finding: Pick<CheckFinding, "rule" | "pid" | "selector" | "value" | "elements">,
): string {
    const one = (item: { pid?: string; selector: string }) =>
        item.pid !== undefined && item.pid !== "" ? `pid:${item.pid}` : `sel:${item.selector}`;
    // One defect on several elements: the scope is all of them (sorted), so that its id does not depend on their order.
    const scope =
        finding.elements === undefined ? one(finding) : finding.elements.map(one).sort().join("+");
    const hash = createHash("sha256")
        .update(`${finding.rule}\0${scope}\0${finding.value ?? ""}`)
        .digest("hex")
        .slice(0, 10);

    return `${finding.rule}-${hash}`;
}

export function reportOf(
    findings: CheckFinding[],
    view: { viewport: DesignViewport; colorScheme: "light" | "dark"; mode?: string },
    elements: number,
    withoutSystem: boolean,
    notJudged?: { count: number; elements: string[] },
): CheckReport {
    const byRule: CheckReport["summary"]["byRule"] = {};

    for (const finding of findings) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    }

    return {
        viewport: view.viewport,
        colorScheme: view.colorScheme,
        ...(view.mode === undefined ? {} : { mode: view.mode }),
        findings,
        summary: {
            errors: findings.filter((finding) => finding.level === "error").length,
            warnings: findings.filter((finding) => finding.level === "warning").length,
            elements,
            byRule,
            ...(notJudged === undefined || notJudged.count <= 0
                ? {}
                : {
                      notJudged: {
                          contrast: { count: notJudged.count, elements: notJudged.elements },
                      },
                  }),
        },
        withoutSystem,
    };
}

export function acceptFindings(
    report: CheckReport,
    ids: readonly string[] | undefined,
): CheckReport {
    const wanted = new Set(ids ?? []);
    const accepted = report.findings.filter(
        (finding) => finding.id !== undefined && wanted.has(finding.id),
    );

    if (accepted.length === 0) {
        return report;
    }

    const rest = report.findings.filter((finding) => !accepted.includes(finding));
    const byRule: CheckReport["summary"]["byRule"] = {};

    for (const finding of rest) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    }

    return {
        ...report,
        findings: rest,
        accepted,
        summary: {
            ...report.summary,
            errors: rest.filter((finding) => finding.level === "error").length,
            warnings: rest.filter((finding) => finding.level === "warning").length,
            byRule,
            accepted: accepted.length,
        },
    };
}

export function notJudgedText(report: CheckReport): string | undefined {
    const left = report.summary.notJudged?.contrast;

    return left === undefined || left.count <= 0
        ? undefined
        : `Contrast not judged on ${plural(left.count, "element")} (what is behind the text is not certain: a gradient, an image, an overlay, a filter, or a faded parent)${left.elements.length > 0 ? `: ${left.elements.join(", ")}${left.count > left.elements.length ? ", …" : ""}` : ""}.`;
}

export function mergeNotJudged(
    reports: CheckReport[],
): { count: number; elements: string[] } | undefined {
    const all = reports
        .map((report) => report.summary.notJudged?.contrast)
        .filter((each) => each !== undefined);

    return all.length === 0
        ? undefined
        : {
              count: Math.max(...all.map((each) => each.count)),
              elements: [...new Set(all.flatMap((each) => each.elements))].slice(0, 8),
          };
}

export async function renderedMode(
    page: DesignPage,
    system: DesignSystem | undefined,
    asked: string | undefined,
    picked: string | undefined,
): Promise<string | undefined> {
    if (asked !== undefined) {
        return picked;
    }

    const theme = await page.evaluateIsolated(
        "document.documentElement.getAttribute('data-theme')",
    );

    return typeof theme === "string" && system?.modes.includes(theme) ? theme : picked;
}

export async function checkPage(
    page: DesignPage,
    system: DesignSystem | undefined,
    view: { viewport: DesignViewport; colorScheme?: "light" | "dark"; mode?: string },
): Promise<CheckReport> {
    const picked =
        system === undefined ? undefined : modeFor(system, view.colorScheme ?? "light", view.mode);
    const colorScheme = picked?.scheme ?? view.colorScheme ?? "light";
    const tokens =
        system === undefined || picked === undefined ? undefined : tokenSet(system, picked.mode);
    const deck = await page.isDeck();
    const input: PageInput = {
        tokenColors: tokens?.colors.map((token) => token.css) ?? [],
        tokenLengths: tokens?.lengths.map((token) => ({ css: token.css, kind: token.kind })) ?? [],
        deck,
        literals: tokens !== undefined,
    };
    const raw = (await page.evaluateIsolated(`(${PAGE_SCRIPT})(${JSON.stringify(input)})`)) as
        RawPage | undefined;

    if (raw === undefined || raw === null || typeof raw !== "object") {
        throw new Error("The page check returned nothing.");
    }

    return reportOf(
        analyze(raw, tokens, { deck, phone: view.viewport.width < 600 }),
        { viewport: view.viewport, colorScheme, mode: picked?.mode },
        num(raw.elements),
        system === undefined,
        raw.notJudged === undefined
            ? undefined
            : {
                  count: num(raw.notJudged.count),
                  elements: (Array.isArray(raw.notJudged.elements) ? raw.notJudged.elements : [])
                      .slice(0, 8)
                      .map((each) => clip(each, 500)),
              },
    );
}

export function mergeFindings(reports: CheckReport[]): CheckFinding[] {
    const seen = new Set<string>();
    const merged: CheckFinding[] = [];

    for (const report of reports) {
        for (const finding of report.findings) {
            const key = [finding.rule, finding.level, finding.selector, finding.value ?? ""].join(
                "|",
            );

            if (!seen.has(key)) {
                seen.add(key);
                merged.push(finding);
            }
        }
    }

    return merged;
}

export async function checkDesign(
    bundle: DesignBundle,
    system: DesignSystem | undefined,
    options: CheckOptions,
    host: PocketHost,
    signal?: AbortSignal,
): Promise<CheckReport> {
    const viewport = viewportOf(options.viewport ?? "desktop");

    if (options.mode !== undefined && system === undefined) {
        throw new Error("A mode needs a design system: this project has none.");
    }

    const picked =
        system === undefined
            ? undefined
            : modeFor(system, options.colorScheme ?? "light", options.mode);
    const colorScheme = picked?.scheme ?? options.colorScheme ?? "light";

    return withRender(bundle, host, signal, async (page) => {
        await page.load(viewport, { page: options.page });
        await page.applyView({
            colorScheme,
            theme: picked?.theme,
            forceTheme: picked?.named,
            tweaks: options.tweaks,
        });
        await page.act(options.actions ?? []);
        const mode = await renderedMode(page, system, options.mode, picked?.mode);
        const view = { viewport, colorScheme, mode };

        if (!(await page.isDeck())) {
            return acceptFindings(await checkPage(page, system, view), options.accepted);
        }

        const count = (await page.slides()).length;
        const slides =
            options.slide === "all"
                ? Array.from({ length: Math.min(count, 40) }, (_, index) => index + 1)
                : [options.slide ?? 1];
        const reports: CheckReport[] = [];

        for (const slide of slides) {
            await page.showSlide(slide, viewport);
            reports.push(await checkPage(page, system, view));
        }

        const findings = mergeFindings(reports);

        return acceptFindings(
            reportOf(
                findings,
                { viewport, colorScheme, mode },
                reports.reduce((total, report) => total + report.summary.elements, 0),
                system === undefined,
                mergeNotJudged(reports),
            ),
            options.accepted,
        );
    });
}
