# Design system bench

Scores the design system work of the other streams with numbers, without a model. It is stream B's part of
[the plan](../../docs/design/design-system.md). The bench is independent on purpose: it has its own color math, its own
DTCG reader, its own reference linter, and its own Chromium. It imports the other streams' code only by path, at run
time, and counts a missing part as 0 with a note.

```sh
node test/design-system-bench/run.ts                       # all phases, JSON on stdout, files in /tmp/ds-bench
node test/design-system-bench/run.ts --out dir --only scan,lint
node test/design-system-bench/run.ts --reference           # the ceiling: every contract from the bench's own reference code
node test/design-system-bench/run.ts --no-browser          # skip the CSS check and the docs page
node test/design-system-bench/run.ts --flagship <dir>      # a flagship in another place
```

`--reference` must print 1 for every phase. If it does not, the bench is wrong, not a stream. A run with nothing in the tree
prints 0 with notes. The test `test/design-system-bench.test.ts` checks both.

## What the output holds

One JSON object: `bench`, `environment`, `notes` (what is missing and why), the five phases, `scores` (0 to 1 each, and
`overall`, their mean), `targets` (true or false for each rubric target), and `matching` (the tolerances). Files go to
`--out`: `docs/*.png` (the documentation page at 390×844 and 1440×900, light and dark), `scan/<fixture>/tokens*.json`
(each scan draft), `lint/<design>-<scheme>.json` (each lint run).

| Phase    | Rubric line     | What it measures                                                                        |
| -------- | --------------- | --------------------------------------------------------------------------------------- |
| scan     | 2 Import        | Precision and recall of a scan on four fixture projects                                 |
| format   | 1, 8, 9         | Load, validate, round trip, compile, and the CSS in Chromium, for every system          |
| lint     | 3 Enforcement   | Precision and recall of `checkDesign` on eight designs; zero findings on the clean ones |
| contrast | 4 Accessibility | The share of declared contrast pairs that pass in every mode                            |
| docs     | 7 Documentation | The documentation page renders in four conditions and passes eight checks               |

The score of a phase is one number to climb. The targets are the plan's: colors and roles ≥ 0.9, scales ≥ 0.85, lint
precision ≥ 0.95 and recall ≥ 0.9 with no finding on the clean designs, every contrast pair passing.

## 1. Scan

Each fixture in `fixtures/<name>/` is a small project plus `expected.json`, written by hand from what a careful designer
would extract. **The scan runs on a copy without `expected.json`.** The fixtures have traps (a color in a comment, a
data URI, `&#169;`, `href="#menu"`, a vendored file in `node_modules/`, a line-height variable, an IE hack); a scan that
reports a trap loses precision.

| Fixture       | What it is                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `plain-css`   | `:root` tokens and a `.dark` class; one color that is a literal in a rule                                |
| `tailwind-v4` | `@theme` with oklch, hex and hsl; shadcn-style roles through `@theme inline`; spacing as one `--spacing` |
| `scss-ts`     | SCSS variables (one computed) and a TypeScript theme with light and dark and an object spread            |
| `messy`       | One page, inline styles, two stylesheets, many near-duplicate colors, mixed units, a small dark query    |

**What the bench reads from a draft.** A draft is DTCG: `tokens.json` and one file for each mode (the first mode other
than the default whose name has `dark` or `night`, else the only other mode, is the dark mode). The bench's own reader
resolves references, `$type` inheritance and mode overrides. The scan may return the draft as `{ tokens, modes }`,
`{ tokens, dark }`, `{ files: { "tokens.json": …, "tokens.dark.json": … } }` or as JSON text, from any of the functions in
`SCAN_NAMES` in `lib/modules.ts` (called with the folder). Until one exists, the 0.26 scan (`scanTokens`) is scored as a
baseline, so `scores.scan` shows where the climb starts.

**Categories and how a token is assigned to one** (by type and by the words in its path; words split at `.`, `-`, `_`, and
camel-case humps):

- colors: every token of type `color`, in the default mode, deduplicated (ΔE ≤ 0.5, alpha within 0.01).
- dark colors: the dark value of a color token, when it differs from the default value.
- type scale: `dimension` tokens with a type word (`font`, `text`, `type`, `typography`, `fs`) and no word of line height,
  spacing, radius, shadow and so on; plus the `fontSize` of `typography` tokens.
- spacing: `dimension` tokens with `space`, `spacing`, `gap`, `inset`, `pad`, `padding`, `margin` or `unit`.
- radii: `radius`, `radii`, `rounded` or `corner`. Shadows: type `shadow`, or `shadow` / `elevation` in the name.
- fonts: type `fontFamily` (first family of the stack, case-insensitive); the `fontFamily` of `typography` tokens.
- Zero is not a step of a scale. `rem` and `em` are 16 px, `pt` is 4/3 px.

**Matching.** Always one to one, by the largest possible matching (so the order does not matter). Precision is matched ÷
found, recall is matched ÷ expected; an empty side gives 1 for precision, and F1 follows. A category that is empty on
both sides is left out. The aggregate is the macro average over the fixtures that the category applies to.

- Colors: equal when ΔE 2000 ≤ **2** (a just-noticeable difference is about 2.3) and alpha within **0.02**. An expected
  color may list `near` values that a careful designer merges into it (`#323232` and `#343434` into `#333333`): a found color
  that matches the value or any near value fills the entry, and a second one for the same entry is a **false positive**.
- Sizes: equal within **0.26 px**. An entry may list `near` sizes (`12` with `11`, `12.5`) in the same way. A spacing
  **base unit** (a token named `spacing`, `space.base` or `space.unit`) credits the entries that its multiples
  (0.5, 1, 1.5, 2, … 24) reach; the multiples are never counted against precision.
- Shadows: the same number of layers; each layer's offsets within 0.5 px, blur within 1 px, spread within 0.5 px, `inset` the
  same, color within ΔE 4 and alpha within 0.04.
- Fonts: the first family, case-insensitive.

**Roles** (bg, surface, text, muted, border, accent, danger, warning, success) are matched **by name**. The bench finds the
role of every color token from the words in its path, then takes one **representative** token for each role.

- A role word list is in `lib/score.ts` (`ROLE_WORDS`). `primary`, `link` and `action` name the accent only when no
  other role word is present (`color.text.primary` is text).
- A name with two role words takes the first of: danger, warning, success, border, muted, accent, surface, text, bg
  (`danger.border` is danger, `muted-foreground` is muted). `muted` next to a fill word (`bg.subtle`) is not muted text.
- A pair token — `primary-foreground`, `card-foreground`, `danger.text`, `on-accent`, `text.inverse` — names text on a
  color, not a role, and has none.
- Among the tokens of one role, the representative is the one nearest the plain name: it holds the role's own word
  (`border`, not `hairline`), has the fewest other words (`accent`, not `accent-hover`), and a short path. A palette step
  such as `blue-500` is not a role; the scan has to name the role.
- The role is **right** when the representative's default value matches an accepted value of the fixture. A role that the
  scan names but the fixture does not expect is **wrong**. Dark roles the same way, on the representative's dark value.
  Precision is right ÷ named; recall is right ÷ expected.

## 2. Format

For each of: the hand-written systems in `format/` (`classic` uses the string forms; `modern` uses the 2025.10 object forms,
composite types, references inside composites, three modes, `$root`, a deprecated token), the lint system, each scan's
draft (saved through `writeDesignSystem` when it exists), and the flagship when it is in the tree. Each part is 0 or 1
except the rates; the system's score is their mean.

1. `loadDesignSystem` returns a system. 2. No `error` in `problems`. 3. The bench's reader and the engine see the same
   token names (Jaccard). 4. Compiled output is complete: `:root` in the CSS, `@theme` in Tailwind, valid JSON,
   `components.css`. 5. **Round trip**: the source files, written to a second folder with `writeDesignSystem`, load to a system
   that is equal (JSON-equal, compiled output included). 6. **Idempotent**: writing the same change twice changes no byte.
2. `dist/` holds the compiled files. 8. Chromium parses the CSS. 9–11. **In every mode** — the default, `[data-theme="<mode>"]`,
   and, for a dark mode, `prefers-color-scheme: dark` alone — each variable is defined (no `var()` left), valid for its type
   (`CSS.supports`), and **correct**: the browser's computed color (ΔE 0.5), length, weight, duration, family, or shadow equals
   the bench's reading of the same DTCG files. 12. The dark values apply by the media query alone.

## 3. Lint

`lint/designs/<name>/index.html` and `expected-findings.json`. The designs link `ds/tokens.css`, served from
`lint/system/golden/tokens.css`: the bench's own compile of its own system (`lint/system/.pi/design/`), so the lint score
does not depend on the tokens engine. (`lint/system/make-golden.ts` rewrites it; the test checks it is current.)
`checkDesign(bundle, system, options, host, signal)` is called once for each color scheme in the file: the options
shapes `{ viewport: { width, height }, colorScheme }`, `{ viewport: "WxH", colorScheme }`, `{ width, height, colorScheme }`
are tried in that order until one is accepted. The `host` is offline.

Six seeded designs hold 30 findings between them, covering all twelve rules. Two clean designs (light and dark) must
give none; they use keyword and zero values, a decorative empty `alt`, an `aria-hidden` icon, and a disabled control.

**Matching.** A reported finding is right when the rule is the same, the element is the same (`pid`, or the selector holds
`data-pid="…"`; a page-level expectation has no pid and needs none), and, when the expectation names a value, the value
is the same (colors ΔE ≤ 3; lengths within 0.5 px; ratios within 0.3; else the same text or first font family). Exact values
are matched first, then a value that one side leaves out. **One value, one finding**: a second finding with the same rule,
element and value is dropped before scoring. Anything reported that nothing expected is a false finding, on seeded and
clean designs alike. Precision and recall are totals over all runs (and per rule). Beside the score, `cleanOnFlagship` says whether the clean designs also stay clean on the flagship's own `tokens.css`; it runs only when the flagship defines every variable that they use (the plan's names), because a missing variable would be the design's fault. The report also gives how often the value,
the fix token (any of the equal tokens in the expectation), and the level were right; these do not change the score.

**The bench's definition of each rule** (the reference linter in `lib/reference-lint.ts` follows it, and finds exactly the
seeded findings):

- `off-system-color`, `-size`, `-font`: an authored value that is not a `var()`. A literal equal to a token's value is still a
  literal. `transparent`, `currentColor`, `inherit`, `0`, `auto`, `%` and keywords are not values. Font size, padding,
  margin, gap, and radius are checked against the scales; width and height are not.
- `contrast`: the text color over its effective background, 4.5:1 (3:1 at 24 px, or 18.66 px bold). Disabled controls are exempt.
- `tap-target`: under 24 px is an error, under 44 px a warning. `image-alt`: no `alt` attribute (`alt=""` is fine).
  `heading-order`: a level skipped going down. `overflow`: the page is wider than the viewport that was asked for.
  `missing-viewport`; `missing-pid` (a control, heading, image or landmark without its own `data-pid`);
  `font-fallback` (the first declared family is not installed); `focus-visible` (no outline, shadow, or color change when
  focused).

Notes for the linter's author, learned from the reference: read authored values from `cssText` (a shorthand that holds a
`var()` reads back as empty longhands); on a phone the page zooms out to fit wide content, so compare `scrollWidth` with the
width that was asked for, not `innerWidth`.

## 4. Contrast

Every token with `contrast: { on, min }` is checked in every mode with the bench's own WCAG math (alpha is composited). The
pair passes when it passes in all modes. `passRate` is the share of pairs that pass; 0 when none are declared. The report also
gives `implied`: text roles over fill roles that the names imply, declared or not. The system is the flagship when it is in
the tree, else the bench's own (`system` says which).

## 5. Docs

`renderSystemDoc(system)` is served from loopback (the HTML and its assets) with every other request refused, and
screenshotted full page at 390×844 and 1440×900 with `prefers-color-scheme` light and dark and `data-theme` set. Checks, each
0 or 1, with the share of the seven expected sections (colors, type, spacing, radii, shadows, motion, components) that have a
heading counting as three more: it rendered in all four; no script error; **self-contained** (no request left the
server, no 404); no horizontal scroll at 390; dark differs from light; it has a `nav`; it is substantial (over 1,500
characters, taller than 1,800 px); it names at least five tokens. The PNGs are for the judges: the bench cannot judge beauty.

## Why it is hard to game

- The scan cannot read its answers (`expected.json` is removed from the copy it sees).
- The fixtures have traps and near-duplicates, so dumping every string that looks like a value loses precision.
- A second finding for the same value, a second color for the same cluster, and a second token for the same role do not count twice.
- The lint score includes every false finding on the clean designs, in both color schemes; missing the dark run costs recall.
- The CSS check compares the browser's computed values with the bench's own reading of the source files, not with the
  engine's resolved JSON.
- `--reference` proves that 1.0 is reachable on exactly these files, and a trivial run proves that 0 is the floor.

## Layout

```
run.ts                    the CLI and runBench()
lib/modules.ts            the contracts, loaded by path; the scan adapter; the 0.26 baseline
lib/score.ts, lint-score.ts   the scoring rules above
lib/color.ts, dtcg.ts, system.ts   color math, the DTCG reader, golden CSS, contrast pairs
lib/chromium.ts, css-check.ts      the bench's headless Chromium, the CSS check
lib/phase-*.ts            the five phases
lib/reference*.ts         the reference engine, scan, linter and docs page
fixtures/<name>/          four projects with expected.json
format/<name>/.pi/design/ two hand-written systems
lint/system/              the lint system, its golden CSS
lint/designs/<name>/      six seeded and two clean designs with expected-findings.json
```

To add a fixture: make the folder, write `expected.json` by hand (not from any code's output), and run the test: it checks
that every expected color is in the sources, that every hex color in the sources is accounted for, and that the oracle scores 1.
