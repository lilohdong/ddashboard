# Experiment 001 results: card "key" (M-2)

Start commit dc9e3e7, started 2026-11-26 05:58. Same task doc (`experiment-001-task.md`), separate worktrees `exp-a`, `exp-b`, `exp-c` (branches `exp/a`, `exp/b`, `exp/c`). Measured from session transcripts (deduplicated by message id); review by a fresh subagent against the 7 requirements.

| Approach | Commits | Tests | Bug/missing/nit | Cache read | Cache write | Output | Peak ctx | Wall | Master inputs |
|---|---|---|---|---|---|---|---|---|---|
| A (1 Opus) | 1 | 84/84 | 0/0/2 | 1.88M | 66.4k | 14.3k | 102k | 7.3 min | 1 |
| B (2 Opus, split by files) | 2 | 83/83 | 1/1/1 | 2.16M | 84.3k | 15.1k | 82k | 6.9 min | 2 |
| C (Opus lead + 1 Sonnet member) | 2 | 87/87 | 0/0/3 | 1.68M | 86.2k | 15.8k | 72k | 5.4 min | 1 |

## Issues

- **A:** nit: clicking the key tag runs a plain text search (matches other projects); nit: `key_prev` also counts manually unarchived cards. Extra: optional "N earlier" history, i18n test of the instruction line.
- **B:** bug: `hooks/stop-card.js:165-167` keeps the key on `lead_missing` member cards, which can then replace the lead's card (breaks requirement 3); missing tests for handoff and instruction text; unused `key_prev` list.
- **C:** nit: instruction wording ("your earlier cards ... in any session": scope is the project, not "your"); team docs left in the branch; no optional history. Simplest replace logic, most tests (8, incl. manual unarchive, i18n), also drops key for `lead_missing`.

## Findings

- Quality: A and C correct; B (split by files, no lead) had the only bug, at the seam between the two sessions.
- Cost: totals within ~25%; C cheapest in cache read and fastest, mainly because a Sonnet member did the work. Output ~14-16k for all.
- Small task (about 7 min): the team overhead of C did not cost more here. Larger tasks are needed to see the lead-context effect.

## Recommendation

Adopt A, add C's extra tests (manual unarchive, `lead_missing` key drop, i18n check) and C's `lead_missing` handling if A lacks it. Delete `exp/b`, `exp/c` and the three worktrees after the merge. Pending master approval.
