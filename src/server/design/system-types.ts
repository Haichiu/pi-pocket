/**
 * The shared shapes of a design system (docs/design/design-system.md): what the tokens engine (`tokens.ts`) loads and
 * writes, what the checks (`lint.ts`) report, what the docs page (`docsite.ts`) renders, and what the Design workspace
 * shows. Owned by stream T; the other streams import it and do not change it without a note.
 */

/** The DTCG token types that the engine understands. */
export type TokenType =
    | "color"
    | "dimension"
    | "fontFamily"
    | "fontWeight"
    | "duration"
    | "cubicBezier"
    | "number"
    | "shadow"
    | "typography"
    | "border"
    | "transition"
    | "gradient"
    | "strokeStyle";

/** Where a token sits: a raw value, a role that names what a value is for, or a part of one component. */
export type TokenTier = "primitive" | "semantic" | "component";

/** A token's value in one mode, resolved (no reference left), with its CSS text. */
export interface ModeValue {
    /** The resolved DTCG value (a string, a number, or a DTCG object such as a color or a shadow). */
    value: unknown;
    /** The CSS for the value: `#7aa2f7`, `16px`, `0 1px 2px rgb(0 0 0 / 0.2)`, `var(--color-blue-500)` for a reference. */
    css: string;
    /** The referenced token's name when the raw value in this mode is a reference (`color.blue.500`). */
    alias?: string;
}

/** One token, resolved. */
export interface ResolvedToken {
    /** The path of group names and the token's name: `["color", "bg", "surface"]`. */
    path: string[];
    /** The path joined by dots: `color.bg.surface`. */
    name: string;
    /** The CSS custom property: `--color-bg-surface`. */
    cssVar: string;
    type: TokenType;
    tier: TokenTier;
    description?: string;
    /** True, or a note on what to use instead. */
    deprecated?: boolean | string;
    /** The value in each mode, by mode name. Every mode of the system is present. */
    modes: Record<string, ModeValue>;
    /** The contrast this text color must reach against another token, in every mode. */
    contrast?: { on: string; min: number };
}

/** One component specimen (`.pi/design/components/<slug>.html`). */
export interface ComponentSpec {
    /** The file's name without `.html`: lowercase letters, digits, and hyphens. */
    slug: string;
    name: string;
    description: string;
    /** The states the file has a template for, in its order. The first is the default. */
    states: string[];
    /** The markup of each state, by state name. Untrusted: shown only in a sandboxed frame. */
    markup: Record<string, string>;
    /** The component's CSS. Untrusted: shown only in a sandboxed frame. */
    css: string;
    usage?: { do: string[]; dont: string[] };
    /** The token names that the component uses. */
    tokens: string[];
}

/** A problem that the validator found. An error stops a write; a warning does not. */
export interface SystemProblem {
    level: "error" | "warning";
    /** The file it is in, relative to `.pi/design/` (`tokens.dark.json`, `components/button.html`). */
    file?: string;
    /** The token it is about. */
    token?: string;
    message: string;
}

/** The generated files in `.pi/design/dist/`. */
export interface CompiledFiles {
    /** `tokens.css`: `:root` for the default mode, `[data-theme="<mode>"]` for each other, and a dark media query. */
    css: string;
    /** `tailwind.css`: a Tailwind v4 `@theme` block that maps to the same variables. */
    tailwind: string;
    /** `tokens.resolved.json`: every token, every mode, resolved. */
    json: string;
    /** `components.css`: the CSS of every component. */
    components: string;
}

/** A project's design system, loaded and checked. */
export interface DesignSystem {
    /** From `$extensions["com.pi-pocket"].name` in `tokens.json`, else the folder's name. */
    name: string;
    description?: string;
    /** Mode names; the first is the default (the one in `tokens.json`). */
    modes: string[];
    tokens: ResolvedToken[];
    components: ComponentSpec[];
    /** `guidelines.md`, bounded. Untrusted project text. */
    guidelines: string;
    problems: SystemProblem[];
    compiled: CompiledFiles;
}

/**
 * A change to write. Each field is optional; what is left out stays. `tokens` and `modes` replace whole files;
 * `set` changes single tokens in place (the Design workspace's editor uses it).
 */
export interface SystemChange {
    /** The whole `tokens.json` (a DTCG object). */
    tokens?: unknown;
    /** Whole mode files, by mode name; `null` removes a mode. */
    modes?: Record<string, unknown | null>;
    /** Single token values, by mode (the default mode's name for `tokens.json`) and token name. */
    set?: { mode: string; token: string; value: unknown }[];
    /** Component files, by slug; `null` removes one. */
    components?: Record<string, string | null>;
    guidelines?: string;
}

/** The rules that `checkDesign` applies. */
export type CheckRule =
    | "off-system-color"
    | "off-system-font"
    | "off-system-size"
    | "contrast"
    | "tap-target"
    | "overflow"
    | "image-alt"
    | "heading-order"
    | "font-fallback"
    | "missing-viewport"
    | "missing-pid"
    | "focus-visible";

/** One finding of `checkDesign`. */
export interface CheckFinding {
    rule: CheckRule;
    level: "error" | "warning";
    /** The element, as the inspector names it. Empty for a page-level finding. */
    selector: string;
    pid?: string;
    /** The value that breaks the rule: `#7ba3f8`, `15px`, `3.1:1`. */
    value?: string;
    /** What to use instead, when there is one: `var(--color-accent-default)`. */
    suggestion?: string;
    message: string;
    rect?: { x: number; y: number; width: number; height: number };
}

/** What `checkDesign` returns. */
export interface CheckReport {
    /** The viewport the page was checked at. */
    viewport: { width: number; height: number };
    colorScheme: "light" | "dark";
    findings: CheckFinding[];
    /** Counts by rule and level, and how many elements were checked. */
    summary: {
        errors: number;
        warnings: number;
        elements: number;
        byRule: Partial<Record<CheckRule, number>>;
    };
    /** True when the system was absent, so no off-system rule ran. */
    withoutSystem: boolean;
}
