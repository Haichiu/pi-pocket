# Stream B (bench): notes

Branch `ds/bench`. All files are in `test/design-system-bench/` and `test/design-system-bench.test.ts`, plus this page. Nothing outside them changed. The scoring rules are in `test/design-system-bench/README.md`.

## What it is

`node test/design-system-bench/run.ts [--out dir] [--only scan,format,lint,contrast,docs] [--flagship dir] [--no-browser] [--reference]` prints one JSON object (`scores`, `targets`, every metric, `notes`) and writes the docs screenshots (390×844 and 1440×900, light and dark), each scan draft and each lint report to `--out` (default `/tmp/ds-bench`). It runs in about one second on the current tree and about five with everything present. No model, no server.

| Phase    | Rubric line | Score (0 to 1)                                                                                                                                        |
| -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| scan     | 2           | Mean F1 over colors, roles, type, spacing, radii, dark colors, dark roles, shadows, fonts                                                             |
| format   | 1, 8, 9     | Mean over systems of: load, no error, names agree, compile, round trip, idempotent write, `dist/`, CSS parses, defined, valid, correct, dark by media |
| lint     | 3           | F1 of precision and recall over 30 seeded findings, counting every false finding on the clean designs                                                 |
| contrast | 4           | Share of declared pairs that pass in every mode. **Earns 0 until the flagship is in the tree**                                                        |
| docs     | 7           | Eight checks plus the seven expected sections; the PNGs are for the judges                                                                            |

Baseline on this tree (`ds/bench` on `107048c`, nothing from T, V, G, or U): overall 0.087; scan 0.435 using the 0.26 scan (`scanTokens`) as a baseline (colors P 0.87 R 0.95; roles P 0.83 R 0.31; type R 0.50; spacing R 0.29; radii R 0.70; dark colors and dark roles 0; shadows R 0.50; fonts P 0.60); every other phase 0 with a note.

## What is in it

- **Fixtures** (`fixtures/`): `plain-css` (`:root` + `.dark`), `tailwind-v4` (`@theme` with oklch/hex/hsl, shadcn-style roles through `@theme inline`, `--spacing` base unit), `scss-ts` (SCSS variables, one computed, plus a TS theme with light/dark and an object spread), `messy` (one page, two stylesheets, inline styles, near-duplicate colors, mixed units, a small dark media query). Each has a hand-labelled `expected.json` and traps (comments, data URIs, `&#169;`, `href="#menu"`, a vendored file in `node_modules/`, line-height companions, IE hacks). The `node_modules` trap is committed with `git add -f`. The Tailwind oklch values were converted by hand with a separate program; the test checks the bench's converter against them.
- **Lint** (`lint/`): the bench's own small system (`lint/system/.pi/design/`), its golden `tokens.css`, six seeded designs (30 findings, all twelve rules), two clean designs (light and dark). Each design is a folder with `index.html` and `expected-findings.json`.
- **Format** (`format/`): `classic` (string forms) and `modern` (2025.10 object forms, composite types, references inside composites, three modes, `$root`, `$deprecated`) as hand-written systems for T.
- **Runner and libs** (`run.ts`, `lib/`): own color math (ΔE 2000, WCAG), own DTCG reader, scoring, a headless Chromium on `src/server/browser/` only, the CSS check, the five phases.
- **Reference code** (`lib/reference*.ts`): an engine (load, write, compile), an oracle scan, a linter, and a docs page, all built on the bench's reader. `--reference` runs the bench on them and must print 1 everywhere. This is the proof that the expected values are right: a plain, independent linter finds exactly the 30 seeded findings, and nothing on the clean designs.
- **Test** (`test/design-system-bench.test.ts`, 26 tests, about 10 s): color math, the reader, every scoring rule on small hand cases, the fixtures against their own sources (every expected color is written in the sources; every color in the sources is expected), the nearest-token check of each expected fix, the golden CSS is current, the floor (nothing in the tree gives 0, with notes, no throw), the ceiling (reference gives 1), and a sabotaged reference that must score lower.

## What differs from the plan

- **Lint runs on the bench's own system for good**, not on the flagship. The expected findings name values and tokens (`#2b6ae0` is near `--color-accent-default`), so they must not move when G changes the flagship. The plan said to switch later; I did not, and added `lint.cleanOnFlagship`: when the flagship defines every `var(--…)` that the clean designs use (the plan's names: `--color-bg-default`, `--color-text-primary`, `--font-size-md`, …), the clean designs are also checked against its own CSS and the findings are reported (not scored). G can make that run by following the names in `lint/system/golden/tokens.css`.
- **The system handed to `checkDesign` is read by the bench**, not by T's `loadDesignSystem`, so a T bug cannot lower V's score. The format phase checks T's reader on the same system (`bench-lint`).
- **Contrast earns 0 without the flagship.** Its pass rate for the bench system is still shown. With the flagship in the tree and T missing, the bench reads the flagship itself.
- The runner does **not** screenshot the System view (U): it needs a running app. The docs page is covered.
- `--reference` uses the bench system as the flagship, so the ceiling is reachable.

## Contracts the bench assumes (T, V, G, check these)

- **Scan (T).** The plan does not fix its name. `lib/modules.ts` looks in `scan.ts` (then `tokens.ts`) for the first of `scanDesignSystem`, `scanProjectTokens`, `scanToDtcg`, `scanDraft`, `draftTokens`, `scanForDesignSystem`, `scanProject`, calls it with the project folder (a copy without `expected.json`; sync or async; 60 s), and reads the result as a DTCG draft: `{ tokens, modes }`, `{ tokens, dark }`, `{ files: { "tokens.json", "tokens.dark.json" } }`, or JSON text. **If T names it otherwise, add the name to `SCAN_NAMES`.** Until then the 0.26 `scanTokens` is the baseline.
- **Naming in a draft** (the bench scores by name and type): roles as `color.bg.*`, `color.surface.*`, `color.text.*`, `color.text.muted`, `color.border.*`, `color.accent.*`, `color.danger.*`, `color.warning.*`, `color.success.*`; type sizes as `dimension` tokens with `font`/`text`/`type` in the path (`font.size.md`) or `typography` tokens; `space.*`; `radius.*`; `shadow.*`; `fontFamily` tokens. A palette step such as `color.blue.500` is not a role. Pair tokens (`primary-foreground`, `text.on-accent`) have no role. A dark mode is `tokens.dark.json` (or the second mode). See the README for every rule.
- **Engine (T).** `writeDesignSystem(cwd, { tokens, modes, components, guidelines })` must accept the files as read; `load` after `write` must be JSON-equal; a second `write` of the same change changes no byte; `dist/` holds `tokens.css`, `tailwind.css`, `tokens.resolved.json`. The CSS must be `:root {…}` for the default mode, `[data-theme="<mode>"] {…}` for each other mode, and, for a mode named `dark`, the same inside `@media (prefers-color-scheme: dark)`; every variable must resolve to a valid value for its type (a composite such as `typography` is not checked). `DesignSystem.name` must be the same for two copies of a folder with the same name.
- **Lint (V).** `checkDesign(bundle, system, options, host, signal)`. The bundle is `{ meta, version, content, assets: [{ name: "ds/tokens.css", type, bytes }] }`. Options shapes tried, in order: `{ viewport: { width, height }, colorScheme }`, `{ viewport: "WxH", colorScheme }`, `{ width, height, colorScheme }`. The system's default mode is `system.modes[0]`; the run for `colorScheme: "dark"` must use the dark values (the bench's CSS has the media query). Findings are matched by rule + `pid` (or a selector holding `data-pid="…"`) + value. Page-level findings (`overflow`, `missing-viewport`) need no pid. The bench's rule definitions are in the README ("The bench's definition of each rule"): V may disagree with one; then change the definition and the expected file together, with a reason, not just the code. Two traps found while building the reference: read authored values from `cssText` (a shorthand holding `var()` reads back as empty longhands), and compare `scrollWidth` with the width that was asked for, not `innerWidth` (a phone zooms out to fit wide content).
- **Docs (G).** `renderSystemDoc(system)` → `{ html, assets }`, no request leaves the page (the bench refuses every address but its own and counts 404s), works at 390 px with no horizontal scroll, has a `nav`, headings that name colors, type, spacing, radii, shadows, motion, components, at least 1,500 characters and 1,800 px of height at 1440 px, and names at least five tokens. Dark is set by `prefers-color-scheme` and by `data-theme="dark"` on `<html>`; either must change the page.
- **Flagship (G).** Found in `test/fixtures/design-system/flagship/` or `docs/examples/design-system/pocket/`, either as a project (`.pi/design/tokens.json`) or as the contents of `.pi/design/` (`tokens.json` at the top). `--flagship <dir>` overrides.

## What I checked

- `npm run format:check`, `npm run check`, `npm run lint` clean; `npm test` 945 of 945 pass (the new file adds 26 tests).
- `node test/design-system-bench/run.ts --reference`: 1 in every phase, every target true. A run with nothing in the tree: 0 with notes. A run with modules that throw or return garbage: no crash, a note, 0.
- By hand: the docs PNGs of the reference page; the lint reports; the Tailwind oklch hexes against an independent Python conversion.
- I did not start `node test/serve.ts`: the bench needs no app.

## What is still weak

- **Roles by name is a heuristic.** It decides roles from the words in a token's path. It is documented and tested, but a scan that names a role in a way the word lists do not know loses points that a person would give. The lists are in `lib/score.ts`; widen them when a stream's names are reasonable.
- **Four fixtures are few.** The score is the macro mean of four projects, and `messy` is hard on purpose. One fixture failing moves a category by 0.25. More fixtures (Less, Vue single-file components, a Bootstrap-style project) would help the next round.
- **`messy` encodes a judgment**: values within about one step are merged (`near`). A scan that keeps every raw value loses precision on that fixture only.
- **The docs phase is structural.** It cannot judge beauty; the judges read the PNGs. The section check is a regular expression on headings.
- **The format phase scores `typography`, `border`, `transition`, and `gradient` tokens only for load and compile**, not for CSS values: their CSS form is the engine's choice.
- **`font-fallback` depends on the machine** not having the first family ("Bellweather Serif", a made-up name). The other rules do not depend on the machine's fonts.
- **`focus-visible` is the least pinned rule** (the plan's list does not name it, `CheckRule` does). One seeded case: a button with `outline: none`.
- **The bench has no timeout for synchronous engine calls** (`load`, `write`): a loop there hangs the run. The scan and the check have limits.
