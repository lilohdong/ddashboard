# M-1c notes: fixed-size lead handoffs, relative lead context limit

Implementation of plan-0.3.0 section M-1c on `feature/team-mode`. Tests: `node test/team.test.js` (62/62 pass after the review fixes; `M-1c:` tests, plus updated performHandoff and `/api/state` tests).

## Handoff point (rows 5–7)

- (Superseded by the review fixes below: no MIN_GROWTH floor, window from the model.)
- `lib.leadLimit(baseline, window)` → `{ baseline, window, at, budget, big }`.
- Baseline: the Stop hook records `s.lead_baseline` = the lead's context at its first stop as lead (first turn of a new lead after handoff; for a session made lead later, its context at that moment). Old leads without a baseline get one on their next turn after install.
- Budget: `DDASH_LEAD_WORK_BUDGET` (100000). `MIN_GROWTH = min(budget, 20000)`.
- **Conflict resolved:** "never above 80%" and "never before the context grew by the budget" cannot both hold when baseline + budget > 80%. I applied the 80% cap to the budget, but the notice always waits for at least `MIN_GROWTH` (20k) of growth. A new lead is therefore never told at once (no loop), and a lead with a huge start gets the `large start` warning instead. If the lead wants the full budget always, change `at` to `baseline + budget`.
- Window: `DDASH_CONTEXT_WINDOW` (200000). The transcript does not show whether the model runs with 1M context, so once a context above the window is seen (baseline or last turn) the window is taken as 1M.
- `DDASH_LEAD_CONTEXT_LIMIT` is kept as an absolute override of `baseline + budget` (default now unset); the 80% cap and the `MIN_GROWTH` floor still apply.
- The Stop hook stores `lead_handoff_at` and `context_window` on the session; `/api/state` recomputes them for leads with a baseline and adds `baseline_big`. `lead_context_limit` was removed from `/api/state`.
- Notice text names the start, the handoff point, the 6000-token cap, "write a NEW doc, do not copy older ones" and lead-rules.md.

## Handoff doc (rows 1–4)

- `T handoff <doc>` estimates tokens (`lib.estimateTokens`: ASCII 3.5 chars/token, every other character 1.5 tokens, so Korean counts high) and refuses above `DDASH_HANDOFF_MAX_TOKENS` (6000) with a message to shorten it.
- `docs/teams/<team>/lead-rules.md`: template created by `addTeam` (in the team worktree, `wx`: an existing file is kept) and, for teams made before M-1c, by `T handoff` and `performHandoff`.
- New lead prompt: "Read only this handoff doc and the team rules <path> (not older handoff docs)". The takeover note from the UserPromptSubmit hook says the same. Lead instructions gained one line on handoff docs and lead-rules.md.

## Dashboard

- `handoff due` uses each lead's `lead_handoff_at` (tooltip shows point and start). New `large start` badge (en/ko/zh-CN) when `baseline_big`, telling the user to turn off unused MCP servers and skills.

## Open items

- Dashboard not checked in a browser (server not restarted, plugin not installed, per instructions).
- Not done: rows 1/3 are enforced only by instructions (the hook cannot tell whether a doc references older docs).

## handoff --spawn in Orca (added by the lead)

- `T handoff <doc> --spawn` picks the runner like `spawn` (`pickRunner`): Orca up → interactive `claude --session-id <sid> ...` (no `-p`) in a new Orca terminal titled `lead <team>` at the worktree root; Orca down → headless `claude -p` as before. `--orca` / `--headless` force one and imply `--spawn`; both together are refused; `--orca` with Orca down is refused before the handoff is recorded. A failed Orca terminal (no flag) falls back to headless with a note.
- The new lead is not pre-registered (unlike members): its first-prompt hook does the takeover as before.
- Test: `M-1c: team.js handoff --spawn: ...` (57/57 pass).

## Review fixes (9ccd685 review)

1. Window: `contextWindow({ models, stored, seen })`: `DDASH_CONTEXT_WINDOW` if set; 1M when a model name has `[1m]` (SessionStart `input.model`, kept in `BOARD/models.json` because team sessions are not registered yet at SessionStart; the transcript's `message.model`; Claude settings `model` from `CLAUDE_CONFIG_DIR`/`~/.claude` and the project's `.claude/settings(.local).json`; `ANTHROPIC_MODEL`); else the stored `s.context_window` (at least 200k). A context above the window still means 1M.
2. `large start` uses the same window (`leadLimit(baseline, window)`).
3. `addTeam`, `removeTeams` and `performHandoff` (new lead) clear `lead_baseline`, `lead_baseline_unknown`, `lead_handoff_at`, `context_handoff_told`.
4. Baseline = first main-thread assistant context in the transcript (first 4 MB), for new and already-running leads alike. None → `lead_baseline: 0`, `lead_baseline_unknown: true`, handoff point = 80% of the window (dashboard tooltip shows start `?`).
5. `/api/state` uses the stored `context_window`.
6. `at = min(baseline + budget, 80% of window)`; the 20k floor is gone. A lead whose start is above the cap is told on its first turn. Note: with an unchanged setup the next lead also starts above the cap, so it is told at once too; the `large start` badge is the way out (turn off MCP servers/skills).
7. `envNum`: empty/invalid → default, `0` kept. Budget 0 = told on the first turn; `DDASH_HANDOFF_MAX_TOKENS=0` = no cap.
8. Handoffs never create lead-rules.md (`existingLeadRules`); `T handoff` warns on stderr and leaves it out of the prompt.

Tests isolate Claude settings (`CLAUDE_CONFIG_DIR` = test board, `ANTHROPIC_MODEL` and `DDASH_*` limits unset). 62/62 pass.
