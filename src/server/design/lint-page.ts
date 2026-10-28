/**
 * The script that `lint.ts` runs inside a rendered design: it walks the DOM once and returns what the page uses
 * (colors, fonts, sizes, text and background pairs) and the page-level problems (targets, overflow, images, headings,
 * focus), as groups of equal values. The comparison with a design system happens on the server (`lint.ts`).
 *
 * It is plain JavaScript in a string, run with `Runtime.evaluate` as `(<script>)(input)`. Its output is untrusted data
 * (the page can lie), so `lint.ts` checks the shape and bounds every string before it uses it.
 */
import { PAGE_SETUP } from "./lint-page-setup.ts";
import { PAGE_VALUES } from "./lint-page-values.ts";
import { PAGE_LITERALS } from "./lint-page-literals.ts";
import { PAGE_STATES } from "./lint-page-states.ts";
import { PAGE_ELEMENTS } from "./lint-page-elements.ts";
import { PAGE_CHECKS } from "./lint-page-checks.ts";
import { PAGE_FOCUS } from "./lint-page-focus.ts";

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
        /** What the pair is: a form field's edge (default), a focus ring, or an icon. */
        what?: string;
        tag?: string;
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
    motion?: {
        count: number;
        longest: number;
        /** The page's CSS has a prefers-reduced-motion rule. */
        override: boolean;
        /** A style sheet could not be read (another origin), so its rules are unknown. */
        unreadable: boolean;
        el?: RawElement;
    };
}
/**
 * The script: one async function `(async (input) => { … })`, from its parts in order (the first opens it, the last
 * closes it). Run as `(<script>)(input)`; the answer is a `RawPage`.
 */
export const PAGE_SCRIPT = [
    PAGE_SETUP,
    PAGE_VALUES,
    PAGE_LITERALS,
    PAGE_STATES,
    PAGE_ELEMENTS,
    PAGE_CHECKS,
    PAGE_FOCUS,
].join("\n");
