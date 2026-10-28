# Stream V notes: verification and export (`ds/verify`)

## What was built

### `src/server/design/lint.ts` (checks), with `lint-page.ts` and `lint-color.ts`

- **`checkDesign(bundle, system | undefined, options, host, signal): Promise<CheckReport>`**, the contract. It renders in the private Chromium (`withRender`), loads the page, applies the view, runs the steps, and checks. It works with only a `DesignSystem` object (no file reads).
- **`CheckOptions`** (new, in `lint.ts`; `system-types.ts` is untouched): `viewport` (a preset or `{ width, height }`, default desktop), `colorScheme` (`light` | `dark`), `mode` (a system mode; default `dark` for a dark scheme when the system has that mode, else its default mode; a non-default mode also sets `data-theme` on the root when the page sets none), `tweaks`, `page` (another HTML page of the bundle), `actions` (`hover | click | focus` + selector, run first), `slide` (a deck: a slide from 1, or `"all"` up to 40).
- **`checkPage(page, system, view)`**: the same checks on a page already loaded in a `DesignPage`. `design_preview` uses it, so the checks cost no extra render. Also exported: `analyze(raw, tokens)` (pure: no browser), `modeFor`, `reportOf`, `mergeFindings`.
- **`lint-page.ts`** is the script that runs in the page: one walk of the DOM (capped at 4,000 elements and 300 groups for each kind), which returns groups of equal values with a count and the first element. It runs in an **isolated world** (`Page.createIsolatedWorld`), so a page cannot change `getComputedStyle`, `Array.from`, and so on. Its answer is untrusted: `analyze` checks shapes and cuts strings.
- **`lint-color.ts`**: OKLab distance, WCAG contrast, and `tokenSet(system, mode)`: the system's colors, font families, and font-size, spacing, and radius lengths in one mode. Token colors and lengths are resolved **by the browser** (the same canvas path that resolves the page's colors), so every CSS color syntax and `rem`/`clamp()` work, and a token compares with the page like with like.
- Rules (levels): `off-system-color` (error), `off-system-font` (error), `off-system-size` (warning; font size, spacing, radius, each on its own scale), `contrast` (error for text: 4.5, 3 for large text; warning for a form field's edge: 3), `tap-target` (error under 24 px, warning under 44 px; see round 2), `overflow` (error when the page scrolls sideways, warning when `overflow-x: hidden` hides content), `image-alt` (error), `heading-order` (warning), `font-fallback` (error when a declared `@font-face` did not load, warning when a family has no face and is not installed), `missing-viewport` (error; not for decks), `missing-pid` (warning; one finding for the whole page that names the tags; an element needs its own `data-pid`), `focus-visible` (warning).
- Precision choices: the background is the real one (every ancestor's color, opacity, alpha composited over the canvas). Contrast is **not judged** when it cannot be known: a gradient, image, filter, blend mode, or `backdrop-filter` in the chain, text over media or a positioned fill, `background-clip: text`, disabled controls, hidden or 1 px text. Auto and percent margins and padding, pill and circle radii, native checkbox margins, text-link tap targets inside a sentence, a native checkbox without a label, and `0` are not findings. The default black text is not an off-system color. Transitions and animations are switched off while checking, so computed values are resting values. Focus is tested on one element of each kind by really focusing it, and the snapshot covers the element, its descendants, its labels, and siblings and parents three levels up, so a `:focus-visible + .box` pattern counts.
- Equal values in one `data-pid` scope are one finding (round 2): its message ends with `(and N more elements)` (or says `N elements`), and the selector, `pid`, and `rect` are the first element's.
- Suggestions: `off-system-color` names the nearest token (a role beats a palette value when two are as near; a token named for another role is not offered: a border is not a background; none when nothing is within 20); `contrast` names the system color nearest to the text color that passes on that background; `off-system-size` names the nearest step (the smaller one on a tie); `off-system-font` names the font token with the same generic fallback.

### `design_preview`

New arguments: `checks` (default true), `tweaks`, `colorScheme`, `page`, `actions` (up to 10; hover, click, focus; a step that cannot run is a `Note:` and is skipped). The output is the screenshots, then one text: `Checks (mobile, desktop; light; system "Name", mode light): 3 errors, 5 warnings.`, up to 30 findings (errors first, then by rule), `… and N more`, notes, then the console errors and failed requests (the old JSON text is gone; `details.errors` and `details.failedRequests` stay, and `details.checks` holds up to 200 findings for each view). A finding that is in only some of the viewports names them. With actions, the checks run before and after the steps and merge. A system that cannot be read is a note, and the screenshots still come.

### Export fixes

- Deck PNG: `slide` (number from 1) in the tool and the route; `"all"` writes a zip of `slide-N.png` (default path `exports/<id>-v<n>-slides.zip`). `slide` with a non-deck or another format is an error.
- `tweaks` in the tool and the route are applied before the export (CSS custom properties with the knob's unit, plus a `pocket:tweak` event, as the canvas does). The route takes `viewport` as a preset, `WxH`, or `{ width, height }`.
- A page's PDF is as wide as the viewport (paper width and height from the viewport, no margins; an `@page` rule still wins, and decks keep their slide size).
- PPTX: notes leave out `style`, `script`, `template`, `noscript`, and `title` text (`slides()` reads text nodes, not `textContent`); slide images are taken at 2× (3840×2160 for the default slide; no side over 4096 pixels, so very large slides are scaled less).
- Renders hide scrollbars (`Emulation.setScrollbarsHidden`): a tall page's PNG was 15 px narrower than its viewport.

### `render.ts`

- `Slots` (limit, queue, wait): renders **queue** first in, first out instead of failing the third. 2 at once, up to 16 waiting, up to 5 minutes of waiting; a wait ends on abort. The 90 s limit starts when a render starts.
- `DesignPage`: `load(viewport, { scale, page })`, `setScale`, `settle`, `applyView({ colorScheme, theme, tweaks })`, `act(actions)`, `evaluateIsolated`, `pdf(viewport)`. `tweakValues` and `designActions` validate tool and route input.

## What differs from the plan

- `color.ts` was renamed `lint-color.ts` so that it does not clash with stream T's `color.ts` (commit 5440256 on `ds/tokens`).
- New files besides `lint.ts`: `lint-page.ts` (the page script), `lint-color.ts` (math and token sets), `tokens-stub.ts` (below). All are in `src/server/design/` and are new, so nothing conflicts.
- `checkDesign` takes `CheckOptions` as its `options` (the plan left its shape open). `checkPage` is the extra seam so the preview does not render twice.
- `design_preview`'s `slide` stays a single number; `"all"` is only for `design_export`.
- Level choices the plan did not fix: off-system colors and fonts are **errors** (the system is the point), sizes are warnings.
- `focus-visible` and the form-field edge are warnings (best effort).

## Stubs

- `src/server/design/tokens-stub.ts`: `loadDesignSystem(cwd)` with the plan's signature, returning `undefined`. `index.ts` imports it. When T lands, the integrator changes that one import to `./tokens.ts` and deletes the stub. `designTools(host, { loadSystem })` takes the loader as an optional second argument, which the tests use, so U's `designTools(host)` call needs no change.

## For U (the System view)

- `checkDesign(await readBundle(...), loadDesignSystem(cwd), { viewport, colorScheme, tweaks, slide }, host, signal)` gives `CheckReport`. Each finding has `selector`, `pid`, and `rect` (page coordinates) for pins, `suggestion` (`var(--…)`), and a message that can go to Pi as is. Counts of equal values are in the message.
- A check takes about 0.5 s on a small page and about 1.5 s with 4,000 elements.

## Text for `docs/features.md` (the integrator merges it)

In the Design bullet, replace the `design_preview` and `design_export` sentences: `design_preview` renders a version in a private headless Chromium at mobile and desktop sizes (or the sizes asked for) and returns screenshots, then a short report: values that are not design-system tokens (with the nearest token), contrast (WCAG 2.2 AA), tap targets, sideways overflow, image alt text, heading order, fonts that did not load, a missing viewport tag, missing `data-pid`s, and elements with no visible focus style; at most 30 findings, errors first. Options: `checks` (on by default), `tweaks`, `colorScheme`, `page`, and `actions` (hover, click, or focus before the screenshot). `design_export` also takes `tweaks`, a custom `viewport`, and (for a deck's PNG) `slide`, or `"all"` for a zip of every slide. A page's PDF is as wide as the viewport, and PPTX slide images have twice the pixels. Renders queue (2 at once) instead of failing.

## What I checked

- `npm run format`, `npm run check`, `npm run lint`, and the full `npm test` (961 tests) pass.
- New tests: `test/design-lint.test.ts` (24 tests: color math, token sets, every rule with a positive and a negative page, dark mode, tweaks, another page, actions, decks, a clean page with zero findings, a hostile page), `test/design-verify.test.ts` (18 tests: the queue, input validation, the report text, every new preview argument, deck slide PNG and zip, tweaks, custom size, PDF width, PPTX notes and 2× images, tool and route).
- By hand on a throwaway copy (`127.0.0.12:8912`): the export route with `slide`, `slide: "all"`, a custom `viewport`, and `tweaks` over HTTP with a signed-in owner; an invalid slide is a clear 400.
- Real pages: `site/index.html` and `site/architecture.html` (900 elements, no system): the findings were real (a real horizontal overflow at 390 px, 17 px footer links, grey text at 2.05:1).

## What is still weak

- **No real `loadDesignSystem` yet**, so `design_preview` has no off-system rules until T lands (tested with an injected system).
- **Token naming is a guess**: which dimension tokens are the type, spacing, and radius scales comes from path names (`lengthKind` in `lint-color.ts`: `space`, `spacing`, `radius`, `font.size`, `text.*`…). A system that names them otherwise gets no size rule. Worth one look when T's names are final.
- **Gradients are not parsed**: a color inside `linear-gradient()` is not compared with the system, and text on a gradient or image is not judged for contrast.
- **Box shadows, SVG fills, and outlines of the default focus ring** are not compared with the system.
- **Caps**: 4,000 elements and 300 groups for each kind; beyond that the rest is not checked, and the report does not say so.
- **Fluid sizes** (`clamp()` in a page) are compared at the checked viewport only, so a fluid font size is off-system unless a token resolves to the same pixels.
- **Backgrounds come from the DOM chain and rectangle overlap**, not from hit testing (scrolling would change the page), so a sibling overlay is found only when it is positioned or has an image.
- `font-fallback` for a family with no `@font-face` guesses by measuring text, with an allow list of common system fonts; a font installed only on the reader's machine is a warning.
- `focus-visible` focuses one element of each tag-and-class kind (up to 40 kinds, 20 findings), so a state that only some instances lack is missed.
- The preview does not run the checks per slide beyond the slide it shows (`checkDesign` can: `slide: "all"`).

## Round 2: the bench's lint phase (0.772 before, 1.0 after)

Before: precision 0.815, recall 0.733, 5 false findings (2 on clean designs). After: precision 1, recall 1, 0 findings on the clean designs in both color schemes (`node test/design-system-bench/run.ts --only lint`). One suggestion is not the bench's (below); it does not change the score. Every change is a general fix for a cause, with a test; nothing names a design.

Root causes, found in a real browser:

1. **A real bug: the walk skipped `<body>`.** `body.querySelectorAll("*")` does not include the body, so the page's background (almost always on `body`) was never part of the backdrop and every text was judged on white. That gave `title` at 1.18:1 and `lede` at 2.43:1 in the dark runs (light text on a white backdrop). Fix: the body is in the walk. This was the cause of all three contrast false positives on text.
2. **The form-field edge heuristic** (`#name`, 1.40:1) was my own extra rule and is not in the plan or the bench. It is kept only for borders that are not the system's: when every color that makes the edge is a system color, the system owns the look (its contrast pairs are checked by the system validator), so the page is not blamed. A border that is not a system color is still judged.
3. **Tap targets:** the plan says under 24 px is an error and under 44 px a warning, on any viewport. I had added WCAG's spacing exception and a "phone only" condition for the 44 px warning. Both removed. Links inside a sentence stay exempt (WCAG's inline exemption), as does a native checkbox without a label.
4. **One finding for each `data-pid` scope, not for each value.** Equal values were merged across the whole page, so the finding named the first element and the others were lost (`title` `#151a22`, `avatar-img`: same `src` as `hero-img`). The group key now includes the nearest `data-pid`: the same value in one scope is still one finding with a count, in another scope it is another finding. This fits how people and Pi name elements (comments and pins use the pid).
5. **`missing-pid` needs the element's own `data-pid`** (the plan: "a control, heading, image or landmark without its own"). A parent's does not count.
6. **A literal is not a token, even when equal.** `color: #151a22` written in a rule equals `--color-gray-900` in light, but it does not follow the token (dark mode, a change in the system). With a system, the page's own CSS rules and inline styles are read (CSSOM, not computed styles) for colors, lengths (font size, spacing, radius), and font families written without `var()`. A computed value that equals such a literal is reported: an error when it is not a system value, a warning ("written as a literal") with the token to use when it is. `--custom-property` definitions are not uses. Color tolerance for "the same color" is now 1.0 (was 1.5).

Where I disagree with the bench, with evidence: the seeded `banner` expects `color.accent.subtle` or `color.blue.100` for `#e9f0fd`. By OKLab distance the nearest token is `color.bg.subtle` / `gray.100` (`#eceef2`, 1.41) and `blue.100` (`#dce7fb`) is 2.99 away: the color is nearer to the neutral. I report `var(--color-bg-subtle)`, so the bench's suggestion count is 4 of 5. A hue-aware distance (OKLCH with a hue weight) would pick the blue; I did not add one for one case. The integrator decides.

## Round 2b: the held-out result

The integrator's held-out run used the round 1 code, before the fixes above. Its misses are explained by them: the missed tap targets (the spacing exception and the "phone only" condition), the missed off-system colors (a literal that equals a token), and the missed `missing-pid` (a parent's `data-pid` counted). The 11 contrast false findings (8 on clean designs) were the missing `<body>` backdrop: a dark page's text was judged on white.

To prove the contrast rule on other styles, `design-lint.test.ts` has a page of 20 cases ("contrast is judged only where the background is certain"). Judged, with a certain background: light text on a dark section, a white card inside it (and pale text on that card, which is a finding), text in a scope that sets its own variables, a translucent parent over dark, a button label on its own fill, a ghost button. Not judged, because the background is not known: an overlay drawn by `::before` or `::after`, text over an image or a gradient, `backdrop-filter`, `mix-blend-mode`, `clip-path`, a mask, a positioned panel over the text, a parent with partial `opacity`, and screen-reader-only text (`clip`, `clip-path`, `text-indent`, 1 px). A placeholder is never judged (it is not text of the element). Two rules changed for this: partial opacity on the element or an ancestor now means "not known" (before, the faded color was judged), and a positioned or transformed box with a fill counts as something that may cover text.

Also checked: the docs page of the flagship (about 3,000 elements, light and dark, phone and desktop) gives two contrast findings, a swatch label at 3.59:1 and a field edge, both real. Logical properties (`padding-inline`, `border-block-start`) are read as literals too.

## Round 3: suggestions by role, real-world pages, ids, the scheme

1. **Suggestions by role.** The page script now groups a color by how it is used too (text, background, border, outline), so a color used as a background and as text in one scope is two findings, each with its own role. `lint.ts` gives every color token a role from the words of its path (`colorRoleOf`: border, text, background; none for a palette step such as `blue.500`). A text use looks first at text tokens, a background at background tokens, a border at border tokens. A token with no role may stand in. A role token wins when it is within 6 of the best stand-in. Only when no token of the role (or without a role) is within 20 does it offer a token of another role, and then the message says so ("It is a text token, and the system has no background token this close"). Tested with `#1c1e26` used as a background next to a near background token, and with none.
2. **25 real-world pages** are in `test/fixtures/design-lint-pages/` with the findings that I checked by hand (`expected.json`, run by `test/design-lint-pages.test.ts`): utility classes (Tailwind-like), Bootstrap-like markup, a long docs page, a dashboard, a form, marketing pages in light and dark, a blog with an overlay, pricing, chat, kanban, a shop, a newsletter table, custom toggles, a sticky header with a fixed button, a theme set by attribute, `light-dark()`, CSS nesting with layers and container queries, a status table, tabs and an accordion, overlapping avatars, a hero with a background image, an RTL form, a footer; plus the flagship's ten component specimens composed into one page (light and dark). **False findings before: 51 over the runs (3 causes). After: 0.** The causes: (a) a faint token color (`#343b5812`, alpha 0.07) was read from the canvas, which loses digits at low alpha (the token read as `rgb(57 57 85 / 0.07)`, the page's own `rgb(52 59 88 / 0.07)`), so the hover state looked off-system (12 findings): hex and `/ alpha` colors are now read exactly; (b) a specimen of the focus state (class `is-focus`) has its ring at rest, so focusing it changed nothing (36 findings): a focus-named class or `data-focus` is skipped; (c) a 43.99 px box, from fractional text widths, was reported as 44×44 under 44 (3 findings): sizes are compared in whole pixels. Also tightened without a case in the set: a native range slider is a browser control (like a checkbox without a label); hidden overflow of decoration (a glow or blob that runs past the edge and holds no text, control, or image) is not a finding, hidden text is.
   What the pages still report is true: a link 21 px tall inside a flex label, footer links 28 px tall, a page 415 px wide in 390, a `code` with light text on a light fill, a heading level skipped, `Inter` used and not loaded. In the flagship page the code block's inner `pre` and `code` use the browser's `monospace` (the browser's rule beats the component's `font-family` on the parent: a real finding for the flagship), the menu row's hover text is 4.48:1 in dark, and the switch button is 20 px tall.
3. **The scheme.** `test/design-check-scheme.test.ts` calls the dock's route (`system/check`) with `colorScheme` light, dark, and none, on a page whose grey text reads on the light canvas and not on the dark one: light and none give no finding, dark gives the contrast error, and the report names the scheme it ran in.
4. **Ids.** Every finding has `id`: `<rule>-<10 hex>`, a hash of the rule, the scope (the `data-pid`, else the selector), and the value; a repeat in one report gets `-2`. It does not change with the scheme, the viewport, or the wording, so a pin can follow a finding across runs; a changed value is a new id. `CheckFinding.id` is new and optional in `system-types.ts` (one added field), and `cleanReport` in `system-routes.ts` passes it through (one added line): both are other streams' files, for the integrator to check.

## Duplicates with stream T's `color.ts` (done)

`lint-color.ts` now imports from `color.ts` and the duplicates are deleted: `luminance` and `contrastRatio` (a small wrapper `contrastOf` takes 0 to 255 channels and calls T's `contrastRatio`), `colorCss` (now `colorObjectCss`; the hex fallback for an unknown space stays), and `formatColor` (uses `toHex` for opaque colors; a translucent one is `rgb(r g b / a)`). Kept in `lint-color.ts` because `color.ts` has no equal: `toOklab` and `colorDistance` (OKLab distance with alpha), `dimensionCss`, `familyList`, `isGenericFamily`, `lengthKind`, `tokenSet`, and the token types. The tuple type is now `RgbaTuple` (T's `Rgba` is an object, 0 to 1).

Other bench notes: the full tree has three failing tests that are not from this stream and fail without my changes: `design-docsite` (1), `design-guide` (3), and `design-system-bench` ("with nothing in the tree every phase scores 0": the contrast phase now scores 1 from the bench's own system).
