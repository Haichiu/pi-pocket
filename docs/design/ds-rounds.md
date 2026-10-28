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

Round 2 started at once on the bench's weakest phases: V on lint, T on scan, B on a held-out set outside the repo (`/mnt/games/Development/ds-holdout/`, never shown to T or V).

Baseline (0.27.0-beta.1, before round 1): no token model, no compile, no lint, no System view, no docs page. Scan read 16 files of this repo and returned one flat list of 60 variables in walk order. Every rubric line is at 0 to 2.
