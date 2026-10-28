# Design systems, stream T (tokens engine): notes

Branch `ds/tokens`. The engine, the tool, the scan, and the `ds/` auto-attach are built and tested.
`system-types.ts` and a first working `loadDesignSystem` were committed early (`5440256`).
The other streams can import them now.

## What I built

| File (all in `src/server/design/` unless noted)                                                                                     | What it does                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system-types.ts`                                                                                                                   | The shared types. Changes listed below.                                                                                                                                                    |
| `tokens.ts`                                                                                                                         | The contract: `loadDesignSystem`, `writeDesignSystem`, `compileDesignSystem`, `systemSummary`, plus `DesignSystemError` (has `.problems`), `problemLine`, `defaultModeName`, `DESIGN_DIR`. |
| `tokens-model.ts`                                                                                                                   | DTCG parse, types, references, tiers, modes, contrast, validation, and the `DesignSystem` build. Pure.                                                                                     |
| `tokens-values.ts`                                                                                                                  | One converter for each DTCG type (both value forms) to CSS. Every message says how to fix the value.                                                                                       |
| `tokens-compile.ts`                                                                                                                 | `tokens.css`, `tailwind.css` (v4), `tokens.resolved.json`, `components.css`. Pure.                                                                                                         |
| `tokens-io.ts`                                                                                                                      | Bounded, symlink-safe reads and atomic writes of `.pi/design/`. `readDesignFile`, `hasDesignFolder`.                                                                                       |
| `tokens-summary.ts`                                                                                                                 | `systemSummary(system, maxBytes)`.                                                                                                                                                         |
| `tokens-base.ts`                                                                                                                    | Limits and small helpers. `utf8Cut` and `boundedText` moved here; `system.ts` re-exports them.                                                                                             |
| `components.ts`                                                                                                                     | The component specimen parser.                                                                                                                                                             |
| `color.ts`                                                                                                                          | Color math: every CSS syntax, DTCG color objects, WCAG 2.2 contrast, Oklch, `color-mix()`. V can reuse it (`parseColor`, `toHex`, `contrastRatio`, `toOklch`).                             |
| `scan.ts`, `scan-files.ts`, `scan-parse.ts`, `scan-facts.ts`, `scan-import.ts`, `scan-colors.ts`, `scan-scales.ts`, `scan-infer.ts` | The structured scan (see below).                                                                                                                                                           |
| `system.ts`                                                                                                                         | The `design_system` tool. The 0.26 file functions are unchanged.                                                                                                                           |
| `../extensions/artifacts.ts`                                                                                                        | The `ds/` auto-attach.                                                                                                                                                                     |

### Changes in `system-types.ts` (all additive except `schemes`)

- `ModeValue`: `literal` (CSS with every reference resolved, so a swatch needs no variable), `hex` (colors), `parts` (a typography token's members as CSS), `contrast` (`{ on, ratio, min, pass }` in that mode).
- `ResolvedToken.tailwind` (an explicit Tailwind variable name).
- `DesignSystem.schemes`: **new required field**. Whether each mode is `light` or `dark`. A test fixture that builds a `DesignSystem` by hand needs it.
- `SystemChange`: `name`, `description`, `remove`, and `set[].type` / `set[].description`. The fields are applied in this order: `tokens`, `modes`, `name`/`description`, `set`, `remove`, `components`, `guidelines`.
- `ModeValue.literal`, `hex`, `parts`, and `contrast` are optional in the type but the engine always sets `literal`.

### The `design_system` tool

Actions: `read`, `write`, `scan`, `init`, `set`, `validate`, `compile`, `component`, `guidelines`.

- `read`: the summary (fenced as project data), or `file` for one file of the folder (a whitelist of names). With no folder it reads the 0.26 file, as before.
- `scan`: the structured report with the DTCG draft, fenced.
- `init`: `tokens` and `modes` (DTCG objects), or `fromScan: true` (and `path`). `changes` apply after, so one call saves a scan and corrects a role. It **refuses to overwrite** a system unless `replace: true`.
- `set`: `changes: [{ token, value, mode?, type?, description? }]` and `remove: [{ token, mode? }]`. A `mode` that is new makes `tokens.<mode>.json`. A value can be a whole token object (`{ $value, $type }`).
- `validate`: reports, writes nothing. `compile`: rewrites `dist/`.
- `component`: `slug` and `content` (the specimen HTML), or `drop: true`. `guidelines`: `content`.
- `write` (the 0.26 file) is refused while `.pi/design/` exists, with a message that names the new actions.
- Not replay-safe, as before (a restart gives "interrupted" rather than a second write).

### The `ds/` auto-attach

`publish()` in `artifacts.ts`: when an HTML page contains `ds/tokens.css`, `ds/tailwind.css`, or `ds/components.css`, the current files are compiled from the sources in `.pi/design/` (never stale) and added as assets under those names. Not added when the call brings an asset of that name or lists it in `removeAssets`. The result text says what was attached, says so when the project has no system, and says when the system has errors. The work happens before the commit, so a replayed call finds the version it wrote (tested).

### The scan

Reads CSS, SCSS, Less, HTML/Vue/Svelte `<style>` and `style=""`, CSS-in-JS templates and style objects, Tailwind v4 `@theme` and v3 `theme.extend` (a static literal reader, no code runs), JS/TS theme objects, and token files (DTCG, Style Dictionary, Tokens Studio). A project with 8 or more tokens in a token file gets them back as they are.

- Variables are grouped by scope: default, dark (`.dark`, `[data-theme=dark]`, `prefers-color-scheme: dark`), explicit light, or a component (reported, not drafted). A dark-first project (dark default plus a light scope) is detected: its default mode is `dark` and the other file is `tokens.light.json`.
- Colors: all syntaxes, `color-mix()` and `var()` computed like the browser (checked against Chromium), shadcn-style `H S% L%` channels, color names where a color is a value. Near duplicates (Oklab distance under 0.0065, about 2 levels per channel) merge; variables are never merged.
- Roles (background, surface, text, muted, border, accent, danger, warning, success): by the name of a variable first (a scored word match, with color sanity: hue for the status colors, chroma for the accent, contrast for the text), by use second (the root background, the most used text, the most used chromatic color, the hue nearest the status centers). Output as `color.bg.page`, `color.bg.surface`, `color.text.primary`, `color.text.muted`, `color.border.default`, `color.accent.default`, `color.danger|warning|success.default`, plus `color.text.on-accent`, each an alias of a palette primitive. Contrast pairs are declared on the text roles.
- The project's own variable names are kept (`radius.md`, `space.4`, `font.sans`, `color.brand.500`); what it does not name is read from use (type scale with a base size and a ratio, a 4 px spacing scale with the off-grid values reported, radii, shadows parsed into layers, durations, easings, breakpoints, weights, line heights). Tailwind utility classes (`text-sm`, `rounded-lg`, `p-4`) fill the scales for a Tailwind project.
- The draft is run through the engine and any token it refuses is dropped, so `init fromScan` always saves a system that loads.
- Safety as before: bounded walk (400 files, 3000 candidates, 20 000 entries, depth 8, 200 KB a file, 8 MB in all), no symlink followed, files ranked so the theme is read before a deep component, report fenced and defanged.
- `scanTokens(root)` still returns `files`, `partial`, `variables`, `colors`, `fonts`, `radii`, and now `draft`, `inferred` (roles, scales, notes), and `tailwind`. `draftDesignSystem` (the 0.26 Markdown draft) is gone: nothing used it.

## What differs from the plan

- A **contrast failure is a warning**, not an error. A person who picks a failing color in the System view must still be able to save. Both are in `problems`; the bench should count the pass or fail in `ModeValue.contrast`.
- `writeDesignSystem` refuses a change only when it **adds** an error. A system that already has an error can be repaired one token at a time. It writes no file at all when it refuses.
- `tokens.css`: the default block is `:root, [data-theme="<default>"]`. Each mode block repeats every token whose **resolved** value differs, so a token that only holds `var(--x)` is declared again. Without that, a nested `[data-theme="dark"]` scope keeps the outer value (a custom property that holds `var()` is computed where it is declared). Checked in Chromium. The media query is `:root:not([data-theme])`, so an explicit `data-theme` always wins.
- The default mode's name is `$extensions["com.pi-pocket"].mode` in `tokens.json` (`light` when absent). A dark-first system sets it to `dark`.
- `tailwind.css` has the default mode in `@theme static { … }`, other modes as plain rules, and `@custom-variant dark` for `[data-theme="dark"]`. A token in a Tailwind namespace (`--color-*`, `--font-*`, `--text-*`, `--font-weight-*`, `--spacing-*`, `--radius-*`, `--shadow-*`, `--ease-*`, `--breakpoint-*`, `--leading-*`, `--tracking-*`) is declared under that name; if the name differs from the token's own variable, the own variable is declared too as `var(--tailwind-name)`, so `var(--space-4)` works in a Tailwind project. A typography token also gets `--text-<name>`, `--text-<name>--line-height`, and so on. `$extensions["com.pi-pocket"].tailwind` names a variable by hand.
- Typography tokens compile to `--type-body` (a `font` shorthand) and `--type-body-font-size` etc.
- Tokens may omit `$type` when the value shows it (a warning says which type was read). A unitless dimension is read as pixels (a warning).
- Extra files in `src/server/design/` beyond `tokens.ts`: the table above. They are all mine.
- Component specimens: scripts, inline event handlers, `@import`, and markup in the CSS are errors; raw colors, unknown `var(--…)`, and unscoped selectors are warnings.

## Stubs

None. I own the contracts. I did not touch `guide.ts` or `index.ts`: `designSystemTool()` is registered there as before.

## What I checked

- Tests: `design-color`, `design-tokens`, `design-tokens-write`, `design-system-tool`, `design-system-attach`, `design-scan-infer` (new), and the 0.26 `design-scan`, `design-system`, `design-system-safety` (kept; `design-scan` updated for the new scan). `npm run format`, `check`, `lint`, and the whole `npm test` are green (one browser test, `design-bridge-ui` "a deck shows one slide at a time", timed out once under load and passes alone).
- Colors against Chromium: 148 named colors, hex/rgb/hsl/hwb/lab/lch/oklab/oklch/`color()` conversions, and `color-mix()` results, read back from a canvas.
- The compiled CSS in Chromium: variables resolve, a nested `data-theme` scope recomputes the aliases, `color-scheme` follows, the `font` shorthand with `var()` is valid.
- The scan on four fixtures of my own (plain CSS with `.dark`, Tailwind v4, SCSS plus a TypeScript theme, a messy page with near-duplicate colors), on Pi Pocket's `web/` (dark first, `color-mix()`, `--err`/`--ok`/`--warn`: 9 of 9 roles) and on `site/`.
- A throwaway copy of the app (`node test/serve.ts 8911 127.0.0.11`) boots, and the `artifacts` module loads with its tools.

## What is weak

- The Tailwind output was never run through Tailwind (it is not installed here). It follows the v4 docs: `@theme static`, the namespaces, `--text-*--line-height`, `@custom-variant`.
- The scan's role rules are tuned on my fixtures and on two real folders. The bench (stream B) is the real test. Weakest spots: a project whose only surface is called `surface` (the scan makes it the page too), names it has never met, a dark mode written as separate `--dark-*` variables, a light override in a dark-first project that sets only some roles.
- Dark-mode uses of literal colors (not variables) are read only for dark-first-less projects (`.dark body { … }`, the media query). For a dark-first project, light uses are not.
- `color-mix()` in `lch`, `hsl`, and `hwb` is done as Oklch; the Oklab and sRGB cases match the browser.
- A multi-file write is atomic for each file, not as a set. A crash between two renames leaves new sources and an older `dist/`. A load compiles from the sources and never reads `dist/`, so nothing in Pi Pocket sees the mix; the next write fixes it.
- No `$extends`, no group aliases, no `string` token type, no `z-index` scale inferred by the scan (a `number` token holds one).
- `systemSummary` is a plain bounded list. It has no ranking by use yet.

## For the integrator and the other streams

- **G** (`guide.ts`): use `loadDesignSystem(cwd)`; when it returns a system, put `systemSummary(system, <budget>)` in the section (it is already defanged; fence it anyway), else keep the 0.26 text. The tool's `read` already fences its output as `<design_system_data>`.
- **U**: a token edit is `writeDesignSystem(cwd, { set: [{ mode, token, value }] })`. It throws `DesignSystemError` (message ready for a toast; `.problems` has `{ level, file?, token?, message }`) and writes nothing on an error. The result is the new `DesignSystem`. A swatch can use `ModeValue.hex` or `.literal`; the contrast badge is `ModeValue.contrast`.
- **V**: `color.ts` has the sRGB conversion and the WCAG ratio for "nearest token" suggestions. `system.tokens[i].modes[mode].hex` and `.literal` give the values to compare with.
- **B**: the scan result for a fixture is `scanTokens(root).inferred.roles` (role → `{ token, value, dark?, basis, source }`; `dark` is the other mode's value), `.draft.tokens` and `.draft.modes`, `.inferred.typeScale/spacing/radii/...`. Load a draft with `buildSystem` from `tokens-model.ts`, or save it with `writeDesignSystem`.
- `docs/features.md` (the Design bullet): `design_system` now reads, scans, and changes a structured system in `.pi/design/` (tokens in DTCG, modes, component specimens, guidelines, compiled to CSS variables, a Tailwind v4 theme, and JSON), and the artifact tools attach `ds/tokens.css`, `ds/tailwind.css`, and `ds/components.css` to a page that links them. The 0.26 single file still works while there is no folder.

## Group names of the scales, and the flagship check (added after the first report)

The scan writes these groups. The flagship uses the same ones or a close name, and `scaleOf(token)` (exported from `tokens.ts`, from `tokens-compile.ts`) is the one rule for a dimension token: `font.size.*` or `text.*` is the type scale, `space.*`, `spacing.*`, or `gap.*` is spacing, `radius.*`, `radii.*`, or `rounded.*` is corners, `breakpoint.*` or `screen.*` is breakpoints, and `container.*`, `tracking.*`, `blur.*`. `size.*`, `dim.*`, and `border.width.*` are dimensions that belong to no scale.

| Group                 | Type                  | The scan writes                                        | The flagship uses                                 |
| --------------------- | --------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `color`               | color                 | `color.<hue>.<step>`, `color.bg.page`, `color.text.*`… | `color.*`                                         |
| `text`                | dimension             | `text.sm`, `text.base`, `text.lg`… (font sizes)        | `font.size.2xs` … `font.size.3xl` (also accepted) |
| `font`                | fontFamily            | `font.sans`, `font.mono`, `font.body`, `font.heading`  | `font.family.sans`, `font.family.mono`            |
| `weight`              | fontWeight            | `weight.regular`, `weight.bold`                        | `font.weight.regular` … (also accepted)           |
| `leading`, `tracking` | number, dimension     | `leading.normal`, `tracking.tight`                     | in `font.*` and `type.*`                          |
| `space`               | dimension             | `space.4` (16 px; step n is n × 4 px)                  | `space.*`                                         |
| `radius`              | dimension             | `radius.sm`, `radius.md`, `radius.lg`, `radius.full`   | `radius.card`, `radius.control`… (named by use)   |
| `shadow`              | shadow                | `shadow.sm`, `shadow.md`, `shadow.lg`                  | `shadow.*`                                        |
| `duration`, `ease`    | duration, cubicBezier | `duration.fast`, `ease.standard`                       | `duration.*`, `easing.*` (both map to `--ease-*`) |
| `breakpoint`          | dimension             | `breakpoint.sm`, `breakpoint.md`                       | `breakpoint.*`                                    |
| `type`                | typography            | none                                                   | `type.body`, `type.heading`… (composites)         |

The flagship in `pi-pocket-ds-g` (380 tokens, modes `light`, `dark`, `high-contrast`, 10 components) loads with **no problem at all**, error or warning. Its default mode comes from `$extensions["com.pi-pocket"].mode`, `$type` and the tier come from the groups, and every composite (shadow, typography, border, transition, gradient) comes back resolved in every mode, with no reference left (a test checks this, including a string-form shadow and a `calc()` with a reference). Two changes came out of that run: a variable that a specimen sets in its own CSS (`--notice-bg: …`) is no longer reported as a missing token, and a string-form value now holds its references resolved.

`color.ts` exports `luminance`, `contrastRatio`, `over`, `parseColor`, `toHex`, `toOklab`, `fromOklab`, `toOklch`, `toOklchCss`, and `mixColors`.

## The bench (stream B): scan and format

I ran the bench on this branch (a copy of its folder in the worktree, not committed): `scan` **0.996**, `format` **1.0** (all seven systems: load, no error, round trip, idempotent, compiled, `dist/`, and every variable correct in Chromium in every mode, with the dark values by the media query alone). The other phases need `lint.ts`, `docsite.ts`, and the flagship, which are in other branches.

- **The exported scan function** is `scanDesignSystem(folder)` in `scan.ts`. It returns `{ tokens, modes }`: `tokens` is the `tokens.json` object and `modes` has one object for each mode file, by mode name. `scanTokens(folder)` returns the same draft in `.draft`, with the report data (`inferred`).
- **Role token paths**: `color.bg.page`, `color.bg.surface`, `color.text.primary`, `color.text.muted`, `color.border.default`, `color.accent.default`, `color.danger.default`, `color.warning.default`, `color.success.default`. The bench reads a role from the words of a path, so these are read as bg, surface, text, muted, border, accent, danger, warning, success (checked: all nine are right on three of four fixtures and eight of nine on the last). `color.text.on-accent` is text on a color, not a role. A color that is named for a role but is not the role itself is put one level down (`color.accent.hover`, `color.primary.dark`, `color.brand.default`), so it never takes the role's place when the bench picks the token nearest the plain name.
- **`tokens.css`** puts `:root` first (the default mode's block is `:root,` then `[data-theme="<default>"]`), then one `[data-theme="<mode>"]` block for each other mode, then `@media (prefers-color-scheme: dark)` (or `light`, for a dark-first system).
- **A second write with the same input changes no byte** in any file: a file with the same bytes is not written again (a test checks the modification times).

What the bench changed in the scan: the other mode's colors are written as they are in the mode file (not as new palette colors of the default mode); the draft keeps a color that the project uses once (as a literal in a rule); near-duplicate sizes, spacings (a pixel apart), radii, shadows, and breakpoints merge; a percent radius is a circle and not a size; the project's own pill value (`999px`) is kept; SCSS arithmetic (`$space-1 * 3`) is computed; a TypeScript theme object named for dark (`darkTheme`) is the dark mode; a list of numbers in a theme (`space: [0, 4, 8]`) is counted like a scale; Tailwind's arbitrary colors (`bg-[#fff4d6]`) count; the surface is the background of cards and panels; the text on the accent is a color the project already has.

Known misses (on the bench): the dark value of a role that the project sets only by use in a dark media query is named even when its hue differs from the light one (`messy` darkRoles precision 0.75); the link color of a dark mode has no token of its own.

## Round 2: the scan, held-out projects, and Tailwind compiled for real

**Numbers** (merged tree, `feat/design-system` at `f80d0a9`, bench copy in `test/design-system-bench/`, not edited): `scan` **1.0** (all four fixtures, every category), `format` **0.99** (1.0 on the seven other systems; the flagship loses 0.084 of its own score, see below). The reading of 0.869 that the integrator gave was taken before my commit `a6c9ed2` or on an older bench: on every tree that holds that commit, `scan` was 0.993 to 0.996 before this round's last commit, and colors precision was 1.0 on all four fixtures. The same checks on **seven projects I wrote myself** (the bench fixtures do not contain them, and no code names them): a shadcn/Next theme, a Material UI theme, a Bootstrap theme, a Vue base stylesheet, a brochure page with no variables, a Tailwind 3 project with a config and class names only, and native CSS with nesting. Their scan scores went from 0.714 and 0.928 (the two sets, before the round's changes) to 0.995 and 1.0. I wrote them so that I could not tune the scan to the four fixtures alone; the left-over 0.005 is my own Bootstrap expectation (a dark accent for the link color, see below).

What I changed, each as a general cause (no fixture name appears in the code):

- **A library prefix is not part of a name.** `--bs-body-bg`, `--ifm-*`, `--sl-*`, `--mui-*`, `--ant-*`, `--chakra-*`, `--mantine-*`, `--pico-*`, `--vt-*` read as `body-bg` and so on.
- **How a variable is used outranks its name.** A variable that is used as a background is not the text, and the reverse (`--text-light` used as a band color). The kinds of use are counted for each variable.
- **`secondary`/`tertiary` mean muted only after a word for text** (`text-secondary`); a `secondary` alone is a brand color. `paper`, `soft`, `mute` are surface words.
- **A surface that is the page's own color is not the surface** (`--surface-1` is the page, `--surface-2` the card). With no named background, the page is the most used root neutral.
- **`calc(var(--x) * 2)`, `rem`/`em`/`px` mixed, and `calc(var(--r) - 4px)`** are computed and counted as uses of the size they come to. They are deferred until all variables are known.
- **Scales merge what the project names and what it uses** (named `text.sm` plus a used 16px, in one scale). A bare `--radius` takes its name after the named ones, so `--radius-md` is never lost.
- **Theme libraries:** a Material UI `typography`, a scalar `spacing: 8` and `borderRadius: 4` (steps of a unit), and `shadows: [...]` (one token for each layer set, `none` skipped); `sx={{ p: 2 }}` numbers are steps of the theme, not pixels.
- **Tailwind's default colors by class** (`bg-slate-200`, `text-white`): the class is a use of the color. The palettes of Tailwind 3 (hex) and 4 (Oklch) are in `scan-tailwind.ts` (copied from the packages `tailwindcss` 3.4 `colors.js` and 4 `theme.css`, MIT; a new generator was not needed because the data does not change often). A name the project defines itself is its own, not the default.
- **Colors a hair apart are one color** (about two levels of a channel; the same gray a shade apart up to three levels). Pure white and pure black are decisions: only one level apart is the same.
- **Dark mode:** a dark value that already exists in the light palette is not used as a stand-in if that color is itself different in the dark (a light `ink-1` that has a dark `ink-1`). A role that use decided and a variable that holds it with a dark value gives the dark role.
- **A status color that is a shade of the accent** is decided by hue too (under 8°), so a red is not dropped next to an orange accent. **A chromatic dark color that is no role's** is the dark value of the light color of its hue (within 25°).

**Tailwind v4 compiled for real.** I installed `tailwindcss` and `@tailwindcss/cli` 4.3.3 in `/tmp/tw`, outside the repo (nothing was added to `package.json`), and compiled `@import "tailwindcss"; @import "./tailwind.css";` against a page that uses our names. The flagship's `tailwind.css` compiles with no warning, and the `--color-*`, `--spacing-*`, `--radius-*`, `--font-*`, `--text-*`, `--shadow-*`, and `--ease-*` namespaces all produce utilities: `bg-bg-page`, `text-text-primary`, `rounded-card`, `text-body`, `shadow-md`, `ease-out`, and `dark:` through `@custom-variant`. A `tailwind.css` from a scan draft compiles too. One thing is by design: a token named `ease.out` makes `ease-out`, so a project token `ease.standard` makes `ease-standard`, and nothing else.

**Weak spots left.**

- `messy` `darkRoles` was 0.75: the page's dark query turns the links light blue and leaves the buttons brown, and the scan named the link blue as the accent's dark value. Now a role keeps its hue across modes (a dark value 40° or more away in hue is not the role's), and that dark color goes on the light color of its hue (the link blue's token), so `darkColors` stays complete.
- In my Bootstrap project the scan gives a dark accent (`--bs-link-color` shifts to `#6ea8fe`) where my own expectation said none. Bootstrap's buttons stay the same, its links change. I kept it as the scan gives it.
- `format` on the flagship: **the bench probe reads `--space-0` as `0.4px` after a number token** in Chromium (the value of `font.tracking.wide`, probed a few tokens earlier; in the browser by hand, and with the same probe code on a short list, the compiled CSS gives `0px`). The compiled `tokens.css` is right: `--space-0: 0px`. This costs 0.084 on the flagship (4 of 1244 comparisons, and the media-dark check). It is a quirk of the probe order, not of the engine. I did not change the compile for it.
- Tests that fail on the merged tree without my scan changes were `design-system-routes` (5) and `design-system-ui` (1); after the second merge of `feat/design-system` (round 3) they pass. One deck test (`a deck shows one slide at a time`) timed out under load in one run and passes alone.

### `systemSummary`: the roles and the components survive a cut (asked by stream G)

The order is now: how to link it; the **semantic tokens** (colors first, then the other types); the **components**; the **scales** (raw sizes, fonts, motion); the **guidelines**; the **palette** (collapsed); and last the **component tokens** (set by one component). When the summary is cut (12,000 bytes in the guide), the cut falls at the end of that list, so the flagship's 52 semantic colors and all 10 components stay (before, the components, the guidelines and part of the tokens were lost at 12,000).

- **Use ranks a token inside its group.** A token's use is the number of components whose `tokens` list it, plus the number of tokens that are an alias of it. Ties keep the declared order. A system with no components keeps the declared order everywhere.
- **Descriptions go from the last token first.** When the whole summary does not fit, the descriptions (`// …`) stay on the tokens that come first (the most used), and are dropped from the others, until the header, the roles, and the components take four fifths of the space. The scales and the guidelines get the rest.
- **A system that has only raw colors** lists them as the roles (as before) and has no palette line.
- `test/design-tokens-summary.test.ts` has the tests (a cut at 3,600, 4,500 and 6,000 bytes holds every semantic color role and every component; the order; the ranking; the descriptions). I changed one line of stream G's `test/design-guide.test.ts`: its hostile description is now on `color.text.primary` (the most used token) and not on `color.bg.base` (used by nothing), since the unused token's description is dropped at 12,000.
