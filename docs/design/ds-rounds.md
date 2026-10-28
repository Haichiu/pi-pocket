# Design systems hill climb: rounds

The plan and the rubric are in `design-system.md`. Each round records the streams, the merge, the bench numbers, and the judges' scores.

## Round 1: build (started)

| Stream                        | Branch      | Linked session                                 |
| ----------------------------- | ----------- | ---------------------------------------------- |
| T: tokens engine              | `ds/tokens` | `session-5a05dce4-b1c8-456a-8420-20cd0f421aab` |
| V: verify and export          | `ds/verify` | `session-e215fa63-fe4d-4eef-8c8c-2d6b826691f8` |
| U: System view                | `ds/ui`     | `session-9234a764-0b5d-4034-b421-962973805499` |
| G: guide, docs page, flagship | `ds/guide`  | `session-f7f6426c-3294-43d2-acfc-c0575639c47f` |
| B: bench                      | `ds/bench`  | `session-97947ee5-d638-4e0f-8fa7-39361867d98c` |

All on `anthropic/claude-sonnet-5-5`; T and U at xhigh thinking, the others at high.

### Round 1 merge (T, V, G, B; U pending)

Merged into `feat/design-system` at 98e61e3. The two `tokens-stub.ts` stand-ins are gone; `guide.ts`, `index.ts`, and the test loader use `tokens.ts`. Test systems gained T's new `schemes` field. The bench reads `scanTokens(root).draft`.

Bench (`node test/design-system-bench/run.ts`): overall **0.926**. Scan 0.869 (colors precision 0.48 to 0.72; roles wrong on 2 fixtures; scss-ts dark mode missed; messy radii 0.2). Format 0.99. Lint 0.772 (precision 0.815, recall 0.733: 5 contrast false positives, tap-target recall 0, 5 clean-design findings). Contrast 1. Docs 1 (structural).

**Held-out set** (B, outside the repo; 3 scan projects, 4 lint designs; `--reference` scores 1.0): the round 1 code scores **0.853** (scan **0.544**, format 0.987, lint 0.734, contrast 1, docs 1). The scan's round 1 rules do not generalize (roles P 0.46 R 0.44, dark roles R 0.11; a dark theme object read as the default). The contrast false positives are general (8 of 11 on clean designs). T and V got general causes, not held-out details.

### Round 1 complete (U merged, ed6b2e3)

U's stand-ins replaced by the real engines. Full suite: 1155 of 1162 pass; 6 failures are U's tests meeting the real engines, 1 is V's render-queue timing test (sent back to U and V). Bench: overall 0.926 (unchanged). Held-out, `--no-browser`: scan 0.544, lint 0.734 (format and docs read low only because `--no-browser` skips their browser checks; run the held-out set with the browser from now on).

Hands-on findings for U: the Check dock checks Light while the canvas shows Dark; section tabs overflow at about 650 px; the warnings box fills a third of a phone screen.

### Round 2: V merged

V's lint fixes (root cause: the DOM walk skipped `<body>`, so text was judged on white; findings now one per `data-pid` scope; tap targets per the plan; authored literals read). Bench lint 0.772 → **1.0**. Held-out lint 0.734 → **1.0** (precision 1, recall 1, 0 findings on clean designs): the fix generalizes. V's duplicate color math now imports T's `color.ts`.

### Judges after round 2 (tree at about ab20007; scan fix not merged)

| Line | Judge A (sonnet-5-5) | Judge B (glm-5.3-flash) | Score |
|---|---|---|---|
| 1 Token model | 8 | 9 | **8** |
| 2 Import (scan) | 4 | 4 | **4** |
| 3 Enforcement | 7 | 9 | **7** |
| 4 Accessibility | 7 | 9 | **7** |
| 5 Agent experience | 7 | 8 | **7** |
| 6 People experience | 6 | 7 | **6** |
| 7 Documentation output | 8 | 8 | **8** |
| 8 Code handoff | 6 | 8 | **6** |
| 9 Engineering | 6 | 6 | **6** |

Shared top items: the scan does not generalize; Check checks Light while the canvas shows Dark (and has no high-contrast choice); phone layout (tabs, warnings box, Check dock); Colors opens on primitives; `tailwind.css` doubles every variable and `tokens.css` adds a `--dim-*` layer; docs copy errors; `features.md` and `map.md` out of date; the suite was red at the time of judging.

Check-in (T's working tree, round 2 scan, not merged): bench scan 0.995, held-out scan **0.795** (from 0.544). The gap shows some bench fitting; T got four general causes (scales only as literals or SCSS/JS, SCSS dark forms, too many colors in a dark-first project, one role).

T at e5e92b1 (27 blind projects written by 9 agents, 0.738 → 0.978 on them): held-out scan **0.869**. The integrator read the remaining failures and confirmed the expectations; 4 general faults remain (shadows by value syntax; status role words; `--dark-*` twins duplicated; vendor-prefixed theme attributes).

Round 3 merged so far: G (flagship names, docs page phone layout and copy, guide example, counting rule, 2 flagship fixes from V's real-page check), V (role-aware suggestions, 25 pages: 51 false findings → 0, stable ids, concrete edits, named modes), U (roles first, palette strips, phone Check sheet, a11y, all modes in Check), B (CSS probe fix: the flagship's format is 1.0). The release's own suite has a pre-existing flaky deck test (fails under load at 7bd4e0b too).

### Round 3 evaluation (0262a6c)

`npm run check`, `npm run lint`, `npm test` green: **1258 of 1258**. Bench: **1.0** in every phase. Held-out: overall **0.974** (scan 0.869, format 0.999, lint 1.0, contrast 1.0, docs 1.0). Shots: 46 of 50 (Harbor's Radii and Shadows timed out). Flaky `mobile-ui` reconnect test: a timing bug in the test, exposed because the Design browser module grew from 129 KB to 366 KB and loads late (fixed in ddf81c9; U makes the module load lazily in round 4).

Scan after T's rounds 3b and 3c (`ds/tokens` 995c1d8, not merged yet): held-out scan **0.994** (0.869 → 0.978 → 0.994). Bench 0.998; T's own 37 blind projects 0.975. The held-out set has now guided several fixes (described as general classes, with a synthetic example for the last two), so it is no longer fully independent: a fresh held-out set is needed before the final judging.

### Judges after round 3 (0262a6c)

| Line | R2 | R3 judge A | R3 judge B | **R3** |
|---|---|---|---|---|
| 1 Token model | 8 | 8 | 9 | **8** |
| 2 Import (scan) | 4 | 7 | 8 | **7** (judged at held-out 0.869; now 0.994) |
| 3 Enforcement | 7 | 8 | 9 | **8** |
| 4 Accessibility | 7 | 8 | 9 | **8** |
| 5 Agent experience | 7 | 8 | 9 | **8** |
| 6 People experience | 6 | 7 | 8 | **7** |
| 7 Documentation output | 8 | 8 | 8 | **8** |
| 8 Code handoff | 6 | 7 | 9 | **7** |
| 9 Engineering | 6 | 8 | 9 | **8** |

Every line rose or held. Disputed: the docs page's component frames are blank in the bench tiles and Harbor's Radii and Shadows shots timed out. Judge A traced both to capture (frames not painted off-screen; the shots script waited for 40 characters); judge B suspected real defects. Round 4 settles it with assertions.

Merged after judging: T 995c1d8 (scan 0.994 held-out), U 00433fa and 49b3174 (shadow parts, inherited modes, all contrast pairs, exempt badges, lazy start), G f633029 (exempt pair, notes, use-it blocks).

**Second held-out set** (B, `/mnt/games/Development/ds-holdout-2/`, made after all scan work; 5 projects: shadcn HSL triplets, Tokens Studio, vanilla-extract, Less with a vendored library, WordPress theme.json; 5 lint designs on the flagship): on 30617b7, overall **0.952**: scan **0.818** (Tokens Studio 0.44: one set read; theme.json 0.75: no font sizes or families; the other 3 at 0.95 to 0.98), lint **1.0** (28 of 28, 0 false findings), contrast 0.952 (the bench counted the exempt disabled pair; rule fixed in round 4), format 0.989, docs 1. T got the two formats as classes.

Round 4 assignments: T (Tailwind namespaces and role utilities, one JSON convention plus a Tokens Studio export, committed flagship `dist/` with a diff test, DTCG 2025.10 forms, an example per tool action, component entry points in the summary, split `scan-infer.ts` and `scan-facts.ts`); U (roles count, shadow values on tiles, phone mode control and tab cue and Check sheet height, compact spacing rows, a fixed save bar, one-tap fixes through V's engine, Harbor tabs); V (`applyExactFixes`, reduced motion, non-text contrast, a small check CLI); G (docs component frames for certain, hero by role, shadow and radius layout, page under 600 KB, split `docsite.ts`); B (second held-out set, painted frames check, the shots script in the bench with per-tab assertions).

Round 3 assignments: U (people experience), G (docs page, flagship naming, guide), V (role-aware suggestions, 15+ real pages, stable ids), T (scan, then handoff outputs), integrator (docs).

Round 2 started at once on the bench's weakest phases: V on lint, T on scan, B on a held-out set outside the repo (`/mnt/games/Development/ds-holdout/`, never shown to T or V).

Baseline (0.27.0-beta.1, before round 1): no token model, no compile, no lint, no System view, no docs page. Scan read 16 files of this repo and returned one flat list of 60 variables in walk order. Every rubric line is at 0 to 2.
