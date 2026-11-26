# Lead handoff #005 (2026-11-26, ~21:55 UTC)

Previous lead: `b0b81ba8-863d-416f-bf5d-587563ac40dd`. Reason: context limit (50k start + 100k).
Read `docs/teams/skill-ddashboard/lead-rules.md` first, then `docs/architecture.md` (§5 target, §6 plan, §6.1 track briefs, §7 decisions).

## 1. Master's standing order (given before going to sleep)

"Run the members and build up to 0.3.1. When finished, write on a card what progress was made, how far you got and what is complete. I'll read it when I wake up."
- Do NOT deploy/tag/release/merge to main (needs approval; master tests first). Local install + restart is allowed.
- 0.3.0 = architecture steps 0-6 (lock, supervisor, card rule); 0.3.1 = steps 7-13. All 10 §7 recommendations were approved.

## 2. State

- Branch `feature/team-mode`, pushed up to 6342b88; later local commits not pushed yet (push after tests pass).
- Installed copy: still 2e2ba9e-era 0.2.0. NOT yet installed: A adoption (0f8c70d, 441fd44), BUG-004 (82d947a), BUG-005 (95f4866, 212d51d, 759df96, edb3000, 98d06e5). Install once front's route commit and proc's test fix land and all 4 test files pass (`team`, `qa-dead-member`, `orphans`, `web`). The new wait.js only takes effect after install; running waiters are old.
- Last lead test run at 98d06e5: team 91/92 (flaky timing, passed on rerun), orphans 19/21 — `sweepWaiters` test failed: "sweep stopped a process this test did not start: pid 15704 sid SOMEONE-ELSE". proc had uncommitted edits in test/orphans.test.js. **Make sure the sweep can never kill real processes outside the test** before installing.

## 3. Members

| sid | role | task / state |
|---|---|---|
| 46141d34 | proc (Opus, headless) | BUG-005 done; fixing orphans.test.js sweep test (uncommitted). Ask for status if no report |
| ff0fdcb7 | front (headless) | Track D: web modules done (8a9ab80, 698663d). Approved to change the static route in server.js, delete dashboard.html, move 3 dashboard tests to web.test.js. Then QA: light/dark screenshot compare + verify-007-repro-b.mjs |
| de4d5069 | arch (Opus, headless) | Wrote docs/architecture.md (6342b88, cd5aefa). Waiting for "go" for steps 0-3 (sequential). Give go after front's server.js commit |
| 0a88f369 | qa (Sonnet, group qa) | Idle. Verified BUG-004 (verify-007). Use for browser QA |
| 7aeb8889 | handoff (Orca) | Idle, large context; don't reuse for big work |

After step 3: spawn members for tracks A (cards, incl. wip fold/'stopped'), B (lifecycle), C (team) per §6.1; D is front. Then steps 11, 13.

## 4. Decisions this shift

- Experiment 001: method A adopted + C's tests; F1 (rules version re-sent), F2 (exact key+project_key history), F4 (key normalized), F5 fixed. F3/F6 unchanged.
- Card rule: a newer card from the same session folds its older open wip cards and they take its outcome; session ends with no newer card -> 'stopped'. Handoff: 'stopped' unless new lead posts same key.
- Architecture refactor approved in full (master: "we should have designed architecture first").
- QA in parallel: one QA member per verification target, each with an isolated server (`DDASH_PORT` 7358+, temp `DDASH_BOARD_DIR`).

## 5. Open items

1. Sidebar: exp sessions b53964ef, cec9394b, e75ecde6 are 'idle' and could not be marked ended (seen <60 min). After 22:15 UTC: `POST /api/sessions/end` then `/api/sessions/forget` (Origin header http://127.0.0.1:7357), or the BUG-005 install marks them gone. ac640681 already ended.
2. exp-a/b/c worktrees and branches exp/a, exp/b, exp/c: delete (`orca worktree rm --worktree path:... --force --delete-branch`) — A and C commits are already cherry-picked/ported. Terminals already closed.
3. qa group brief.md is stale (21 commits); update its Current state.
4. Add measurements to docs/research/lead-handoff-001.md §5: #005 master inputs ~17, context 5.0万 -> 15.1万.
5. Killing processes by PID is blocked by auto-mode unless the master approved it in that message.
