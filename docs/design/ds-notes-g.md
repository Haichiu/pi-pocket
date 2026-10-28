# Stream G notes: the guide, the docs page, and the flagship

Branch `ds/guide`. Stream G owns `guide.ts`, `docsite.ts`, `docs/examples/design-system/`, and `test/fixtures/design-system/flagship/`.

## What was built

### The flagship (`docs/examples/design-system/pocket/.pi/design/`)

Pi Pocket's own system, derived from `web/style.css`, `web/themes/pocket/theme.css`, and `web/theme-surface.js`. A copy is in `test/fixtures/design-system/flagship/` (a test checks that the two are the same files).

- `tokens.json` (the light mode, 380 tokens in all, DTCG with string forms), `tokens.dark.json` (Tokyo Night, the app's own palette), `tokens.high-contrast.json` (text at 7:1).
- **Primitives**: `color.neutral` (17 steps), seven hue ramps (`blue red yellow orange green cyan magenta`, 10 steps each: 300 is the app's own Tokyo Night value, 700 reads on light grounds and under white text), `color.alpha.*` overlays, a pixel ramp `dim.*`, `font.*` (family, weight, size, leading, tracking), `duration.*`, `easing.*`, `z.*`.
- **Semantic roles**: `color.bg|text|border|accent|danger|warning|success|info|brand|spark|code|shadow.*`, `space`, `radius` (the app's `--r-*`), `size`, `breakpoint`, `border.width`, `shadow.*` (the app's `--shadow`, `--pop`, the focus ring), `type.*` (11 text styles), `motion.duration|ease|transition.*`.
- **Component tokens**: `button input switch segmented badge card notice menu step code-block`.
- **Contrast**: 20 declared pairs, 60 checks across the three modes, all pass. `test/design-flagship.test.ts` also checks every text role on every ground (4.5:1; 7:1 in high contrast), the status colors on their washes, and the field border and focus ring at 3:1.
- **Components** (10, with 2 to 5 states each): button, input, switch, segmented control, badge, card, notice, menu row, tool step, code block. Each CSS reads only `var(--token)` (no literal color or size), and its `tokens` list is exactly the tokens it reads (a test checks both).
- `guidelines.md` (6.4 KB): principles, color, type, space, elevation, motion, accessibility, voice, do and don't.

### The docs page (`src/server/design/docsite.ts` and three helpers)

`renderSystemDoc(system): { html, assets }` returns one self-contained page (about 730 KB for the flagship; `assets` is empty). Helpers I added, all mine: `docsite-assets.ts` (the CSS and the scripts as text), `docsite-color.ts` (color parsing, WCAG contrast, OKLCH text), `docsite-markdown.ts` (a safe Markdown renderer for `guidelines.md`).

- Sections: overview (stats, a swatch strip, validation notes), Color (roles as cards with hex, OKLCH, alias chain, and contrast badges; the palette as ramps; a text-on-ground matrix; the table of declared pairs), Typography (typefaces, weights, text styles, size scale), Space and layout (spacing, sizes, breakpoints, radius, borders, layers), Shadows, Motion (durations and easings with Play buttons and curves, transitions with a hover demo), Components (each as a state grid, do and don't, tokens used, and tabs of the escaped markup and CSS with Copy), Guidelines, All tokens (a filterable table), and Use in code (the compiled CSS files).
- A switch for each of the system's modes. The page follows the mode: light or dark chrome, by the luminance of the system's ground color. A value that differs by mode is written once for each mode and shown by the mode in force, in CSS alone, so no work is done in script and the switch is instant. The accent of the chrome is the system's own accent when it reads at 4.5:1 on the page.
- Copy any token name, CSS variable, or CSS code with a tap. A filter box (and `/`) hides what does not match. Scroll spy on the navigation. Phone: a drawer for the navigation, color cards as rows, tables as cards, 44 px targets.
- **Safety.** No network: a page policy (`default-src 'none'`, no fonts, images, or scripts from outside), no `<link>`, no `@import`. All text is escaped. A token value that could end a declaration or a block (`{ } ; < > \`, `url(`, `@import`, comments) never reaches a style; a custom property name that is not plain is replaced. Component markup and CSS run only in an `iframe` with `sandbox="allow-scripts"` (never `allow-same-origin`), a policy of its own with a random nonce that only the frame's own script has, and `default-src 'none'`: scripts, event handlers, and requests in a component do nothing. The frame and the page talk by `postMessage` (the page checks `event.source` and the shape); no message can make a frame taller than 4,000 px. Markdown links keep only `https:` and `#` addresses.
- **Bounds.** 3,000 tokens, 60 components, 16 states of one; lists of 120 specimens, 240 color cards, and 480 palette steps; a page over 1.8 MB (an artifact holds 2 MB) shrinks the token table until it fits.

### The guide (`src/server/design/guide.ts`)

Rewritten as the plan says. The first part (about 4.8 KB) is the same for every session, so the provider's prompt cache holds it: the canvas, the page skeleton, `data-pid`, the tweaks manifest, decks, variations, the craft rules (phone first, type scale, 4 px grid, contrast, states, real copy, motion, alt text), the check before replying (`design_preview` at two sizes, fix every error, the preview's limits), and feedback and handoff. After it comes one of: how to use the system plus the system's summary (about 8 KB at most), the 0.26 file as before, a notice that `.pi/design/` is unreadable, or the offer to scan. A test checks that the opening is the same in every case.

### Tests

`test/design-docsite.test.ts` (10 tests: every section and link, modes, no external request, hostile text in every place, empty and huge systems, color math, Markdown, and a Chromium run that loads the page, sizes the frames, switches the mode, filters, and shows that a component's script does not run), `test/design-flagship.test.ts` (4), and 5 new tests in `test/design-guide.test.ts`. `npm run check`, `npm run lint`, and the whole `npm test` (938 tests) pass.

## Stubs used (delete when stream T lands)

- `src/server/design/tokens-stub.ts`: `loadDesignSystem(cwd)` and `systemSummary(system, maxBytes)` with the signatures of the contract. Bounded, symlink-safe reads; resolves references per mode; `problems` is empty and `compiled` is a rough copy. **Integration:** when `tokens.ts` lands, change the one import in `guide.ts` (`import { loadDesignSystem, systemSummary } from "./tokens.ts"`), delete the stub, and `test/design-system-loader.ts` already prefers the real loader when the file exists (it falls back only on "file not found").
- Guide expectations of T's `systemSummary`: names by role with the default mode's values, the modes, the components with their states, and the guidelines (cut first), at most `SUMMARY_BYTES` (8,000); the guide wraps it in `<project_design_system>` and says it is untrusted. If the real summary is longer, the guide cuts nothing: T's function must keep to `maxBytes`.

## What differs from the plan, and why

- **The default mode is named `light`.** T names the default mode; the flagship says so with `$extensions["com.pi-pocket"].mode: "light"` in `tokens.json` (the stub reads it). Without it a loader would call the mode `default`; the docs page copes with either. T: please read that key, or choose the name by another rule and tell me.
- **Reference-only tokens carry an explicit `$type`.** DTCG lets a token that is only a reference omit it, but a loader may not infer it; the flagship's 83 component tokens state it, so the file is valid for a strict reader.
- **Tier is set on groups** (`$extensions["com.pi-pocket"].tier` on a group, inherited). Every semantic token is a reference and every primitive a raw value, so a loader that infers the tier gets the same result.
- **The docs page does not use `compiled.css`.** It builds its own scoped variables from `ResolvedToken.modes[*].css` (so that one page can show every mode at once, and component frames get only the variables they need). It uses `compiled.css`, `tailwind`, and `components` only as text in the "Use in code" section. `assets` is empty: the page needs no file beside it.
- **Component frames use `allow-scripts` with a nonce**, not `allow-same-origin` with no script as first built: the artifact viewer serves the page with a sandbox policy, and a nested frame cannot get back the origin that its parent lacks, so the page could not measure the frame. Checked in the real viewer route, in the private renderer (`design_preview`), and in `file://`.
- **No `dist/` in the flagship folder.** It is generated by T's compile; bench: the fixture loads and compiles in memory.
- **Guide mentions V's new `design_preview` options** (`colorScheme`, asking for a hover, a focus, a tweak value, or a second page "in the call") and `ds/tokens.css` and `ds/components.css` in the bundle (T's `ds/` auto-attach) without their exact argument names. If V names them otherwise, the sentences in `GUIDE` and `USE` need the names; the tests check the sentences' parts.

## Needs from other streams

- **T**: read `$extensions["com.pi-pocket"].mode` for the default mode's name (or tell me the rule); inherit `$type` and the tier from groups; infer a missing `$type` from the referenced token; `$value` of a composite (typography, shadow, transition) comes back with every reference resolved, as the stub does; `ModeValue.css` of a reference is `var(--…)`. The docs page reads `value` for colors and dimensions and `css` for the variables. The flagship should load with no error and, ideally, no warning from T's validator: please send me what it says.
- **V**: the docs page is a good fixture for `checkDesign` (it has a lot of off-system chrome on purpose: the page chrome is not on the system it documents). It must not be checked against the flagship.
- **U**: "Publish docs" calls `renderSystemDoc(system)` and publishes `html` as an artifact (2 MB limit: the function keeps to 1.8 MB). The page's section ids are `overview color typography layout shadows motion components guidelines tokens code`, and each component is `comp-<slug>`, in case U wants to link to one.

## What I checked

- `npm run check`, `npm run lint`, and `npm test` (938 pass).
- By hand on a throwaway copy (`node test/serve.ts`-style, port 8914): the page as an artifact at `/a/<session>/<id>/<version>` in the shared Chromium, at 390×844 and 1440×900, in light, dark, and high contrast; the mode switch (also in the frames), the drawer, the filter, copy, the Play buttons, and the frame sizes. Also `design_preview` on the published page at mobile and desktop (no console error, no failed request).
- The flagship's 60 contrast checks in the tests and the matrix in the page.

## What is still weak

- No syntax color in the code blocks of the docs page (plain monospace).
- The page is large (730 KB for 380 tokens, mostly the token table and the escaped component code); a system of a few thousand tokens loses table rows (it says so).
- The tweaks manifest and `pocket-tweak-set` are not used by the docs page: it has no knobs.
- The stand-in `systemSummary` cuts the guidelines at a quarter of the budget, in the middle of a sentence; T's version should cut at a line.
- Not checked on a real iPhone; the drawer and the frames were checked in an emulated phone only.
- The components were checked by eye in three modes at desktop width; the hover and focus states are drawn by classes (`.is-hover`, `.is-focus`) and also work as real `:hover` and `:focus-visible`, but a coarse pointer was not tested.
- The shared Chromium showed `scroll-behavior: smooth` mid-scroll in screenshots; the page keeps it (it turns off under reduced motion).

## Round 2 (after merging `feat/design-system`)

Four tests failed with the real engine. Causes and fixes:

1. **docsite "asks for nothing"** (test expected the stub's behavior). The real `compiled.tailwind` has a comment that says `@import "tailwindcss"`; the page prints it as escaped text in a code listing. The code is right. The test now looks for `@import` only inside `<style>` elements of the page and of the frames. Not a weaker check: a style with `@import` still fails.
2. **guide "holds its summary"** (test expected the stub's summary text). The real summary has other words, and `defang` turns the `<link …>` tag in it into `‹link`, which would mislead Pi. **Code fix:** `USE` now states the `<link rel="stylesheet" href="ds/tokens.css">` tag itself, outside the fence. The test now checks the engine's phrases.
3. **guide "hostile system"** (test expected guidelines in the summary; the real summary does not include them, Pi reads them with `design_system read file "guidelines.md"`). The test now puts the hostile text in a token note, which the summary does carry. Same checks: one closing tag, text kept inside the fence.
4. **guide "broken .pi/design"** (the stub threw; the real loader returns a system with `problems`). A broken system is now an `N errors` line in the summary, and the guide tells Pi to run `design_system validate` and say so. `.pi/design/` wins over the old file even when broken. The symlink check stays: nothing from the link's target reaches the prompt.

Other changes:

- `guide.ts` names the real arguments: `design_preview` (`colorScheme`, `tweaks`, `actions`, `page`, `slide`, `fullPage`; `checks` is on by default), `design_export` (`tweaks`, `viewport`, `slide` as a number or `"all"`), and `design_system` (`scan`, `init` with `fromScan`, `changes`, `replace`, `modes`; `set`, `component`, `guidelines`, `validate`, `read` with `file`). A test checks that each argument the guide names is in the schema in `index.ts`. `ds/tokens.css`, `ds/tailwind.css`, and `ds/components.css` are named as the files the app attaches.
- `SUMMARY_BYTES` is 12,000 (was 8,000): at 8,000 the real summary showed only colors, then cut. T's summary lists primitives (`dim`, `font`, `easing`, `z`) before roles (`space`, `radius`, `type`) and the component list after the component tokens; **T: list roles and components first.** The guide then needs no larger budget.
- **Flagship:** the engine gave 2 warnings (`--notice-*` and `--step-ink`, custom properties local to a component). I rewrote `notice.html` and `tool-step.html` to use tokens only, regenerated their `tokens` lists, and copied the files to `test/fixtures/design-system/flagship/`. `loadDesignSystem` now returns **0 problems** (0 errors, 0 warnings), and `design-flagship.test.ts` asserts `problems` is empty.
- `npm run format`, `npm run check`, and `npm run lint` pass. The full `npm test` had 1,105 of 1,106 passing; the one failure (`design-bridge-ui`: a deck shows one slide at a time) timed out under load and passes alone (18 of 18).

## Round 3

- **Token names.** Durations are roles now: `duration.stagger 24`, `fast 150`, `base 175`, `slow 420`, `slower 540`, `spring 560` (the app's 140 and 410 are rounded to 150 and 420, so that hover and exit share one token and enter and glide share one). `motion.duration.*` and the transitions point at them. The pixel ramp `dim.*` (named by value) is gone: `space`, `radius`, `size`, `breakpoint`, and `border.width` hold their pixel values as primitive scales (steps and roles, not values), and the two odd sizes components needed are `space.hair` and `size.dot`. The alpha overlays are `color.alpha.light|dark.faint|soft|medium` (were 7, 10, 17). `radius.sheet` and `radius.float` stay: both are 12 px today; `float` says in its description that it is a role of its own. 348 tokens now.
- **Disabled text.** `color.text.faint` is `color.text.disabled`, described as disabled controls only. A placeholder uses `color.text.muted` (a placeholder is not exempt). The engine has no exemption flag yet, so the token declares no contrast pair. **When T adds one, the flagship change is:** add `"$extensions": { "com.pi-pocket": { "contrastExempt": "disabled" } }` (T's key name) to `color.text.disabled` in `tokens.json`, and the same fixture copy.
- **Docs page, phone.** The header keeps the system name; the three-way switch is a menu (`select`) on a phone. The overview cards are two columns. Hero swatches are labelled chips (the short name under each, the full name in a tooltip, a tap copies it).
- **Role cards.** Groups of one or two cards share one grid ("Brand · Spark · Shadow").
- **Copy.** Each color card has `CSS var`, `Tailwind` (`bg-`, `text-`, or `border-` plus the name after `--color-`, which the compiled `@theme` makes a utility), and `JSON` (`color.bg.surface.$value`) buttons.
- **Footer and ratios.** The footer has the name, the token count, the modes, the components, and the date. A ratio has one decimal, cut and not rounded (4.48 shows as 4.4, never 4.5), everywhere.
- **Counting rule (agreed with U; U's `sectionOf` in `extensions/design/system.js` is the source, and `sectionOf` in `docsite.ts` is the same rule).** Each token is in exactly one section, chosen by its type (and for dimensions and numbers by the words of its path), whatever its tier: a component's tokens count too. The token sections are Color, Typography, Spacing, Radii, Shadows, Motion, and Other; their counts add up to the system's token count (a test checks it). A token with no specimen of its own is listed in a "More tokens" table at the end of its section, so every counted token is on the page. **Components** counts components (not tokens), **Guidelines** has no count, and **All tokens** counts all tokens. The docs page now has the same seven token sections as the view (it had "Space and layout" and "Other tokens").
- **Guide.** The no-system text says to make a system in three calls: `scan`, `init` with `fromScan` and `changes` for every role the scan guessed or marks uncertain, then `validate`. (The scan's output already says to save with `init fromScan`; the guide adds the correction and the check.)
- **Still weak.** The page is 840 KB (component colors and the "More tokens" tables). The durations section shows both the primitive and the semantic durations, which repeat. No syntax color in code listings.

### Round 3, second judge's items

- **Grammar.** `plural(n, noun)` and `article(word)` (in `docsite-markdown.ts`) make every counted phrase ("1 mode", "2 modes", "All 20 contrast checks meet their minimum", "The contrast check meets its minimum"), and a test reads every generated sentence of the flagship and of a one-of-each system for "a" before a vowel, "an" before a consonant, a plural noun after 1, and a singular after another number. The flagship's "The border of a info message" is "an info message" now.
- **Hero.** The flagship's description is one sentence (the sources are in the README), the lead text balances its lines, and on a phone the stat cards are a wrapping row that fills (3 and 2) and an odd last overview card takes the whole row.
- **Guide.** The system tail ends with `SYSTEM_EXAMPLE`: a short card design with the `ds/` links, roles through `var(--…)`, a component's markup and classes, `data-pid`s, a tap-size line, and a tweaks manifest bound to tokens. A test renders it with the flagship in Chromium (light and dark) through `checkDesign`: no error, no tap-target or off-system finding (a `font-fallback` warning stays, because the flagship's Geist is not in the bundle). The stable part still comes first.
