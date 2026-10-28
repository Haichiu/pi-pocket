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
