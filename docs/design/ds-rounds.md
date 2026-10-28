# Design systems hill climb: rounds

The plan and the rubric are in `design-system.md`. Each round records the streams, the merge, the bench numbers, and the judges' scores.

## Round 1: build (started)

| Stream | Branch | Linked session |
|---|---|---|
| T: tokens engine | `ds/tokens` | `session-5a05dce4-b1c8-456a-8420-20cd0f421aab` |
| V: verify and export | `ds/verify` | `session-e215fa63-fe4d-4eef-8c8c-2d6b826691f8` |
| U: System view | `ds/ui` | `session-9234a764-0b5d-4034-b421-962973805499` |
| G: guide, docs page, flagship | `ds/guide` | `session-f7f6426c-3294-43d2-acfc-c0575639c47f` |
| B: bench | `ds/bench` | `session-97947ee5-d638-4e0f-8fa7-39361867d98c` |

All on `anthropic/claude-sonnet-5-5`; T and U at xhigh thinking, the others at high.

Baseline (0.27.0-beta.1, before round 1): no token model, no compile, no lint, no System view, no docs page. Scan read 16 files of this repo and returned one flat list of 60 variables in walk order. Every rubric line is at 0 to 2.
