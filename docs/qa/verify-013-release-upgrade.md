# verify-013: release QA, upgrade path v0.2.0 -> 5db405f

Target: `git archive 5db405f` (feature/team-mode), port 7363, temp board dir, no real claude, no 7357, no `~/.ddashboard`.
Evidence and the driver scripts: `docs/teams/skill-ddashboard/qa/notes/verify-013-upgrade/`.

## Method
1. `git archive v0.2.0` to a temp dir; started with its own hook `prompt-submit` (`/ddashboard:dashboard` -> `control.js start`) on the temp board.
2. Data made with the 0.2.0 hooks (session-start, prompt-submit, stop-card, session-end) and the 0.2.0 server API (`/api/reply`, `/api/archive`):
   3 repos (alpha, beta, gamma) + 1 worktree of alpha (same project); 9 sessions (5 solo, 4 team-style with `DDASH_NAME` lead/fe/be/qa-x; 0.2.0 has no real team mode);
   32 cards (done / review / blocked / wip, `replaces:"last"` wip chains, hand-written 0.1.0 `cards.jsonl` x2 and an old `cards/2026-09.jsonl` wip card);
   4 replies (2 consumed by the Stop hook, 2 still pending in inbox), 1 ended session, archived/unarchived cards (explicit `archived.json` entries).
3. Old server stopped; 3 stale waiters made (details in P5); then 5db405f started on the same board dir (`scripts/server.js`).
4. State compared with `/api/state` and `/api/search?archived=include` taken before and after.

## Results

| # | Item | Result |
|---|------|--------|
| P1 | schema 2 migration | PASS |
| P2 | all data present, same counts | PASS (one view change, see N1) |
| P3 | idempotent restart | PASS |
| P4 | no data loss | PASS |
| P5 | stale 0.2.0 orphan waiters swept | PASS |
| P6 | old `bin/wait.js` shim | PASS (works as is; refreshed on next session-start) |
| P7 | old hooks on the migrated board | PASS |
| P8 | plugin dir with leftover old files | PASS |

### P1 schema 2 migration
No `meta.json` before. First start printed `ddashboard: board migrated to schema 2`; `meta.json` = `{schema:2, migrated:[{to:2, by_version:"0.2.1", ...}]}`.
`replies.jsonl` was copied to `replies/2026-11.jsonl` (same hash), backup `replies.jsonl.bak-s2` made, original `replies.jsonl` left (hash unchanged, so 0.2.0 readers still work).
`projects.json`: 3 projects, each gained `teams` (solo mode); `since` and `cwd` unchanged; the worktree still groups under alpha. `/api/state.settings` = `{lang:null}` (no settings file in 0.2.0).

### P2 counts (0.2.0 state vs 5db405f state)
| | before | after |
|---|---|---|
| sessions | 9 | 9 (every field same except derived pending/waiting/view/last_seen; views same) |
| search include (all cards) | 32 | 32, every field of every card same, same archived flag |
| archived_count | 16 | 16 |
| replies | 4 | 4 (same list) |
| pending inbox | beta-solo 1, gamma-m 1 | same |
| active cards | 16 | 14 (N1) |

### P3 idempotent restart
Stopped the 5db405f server, snapshotted the files, started again: no migrate line in the log, `meta.json` unchanged (one `migrated` entry), the file hash list differs only in `server.pid`; state counts identical (14 / 16 / 32 / 9 / 4).

### P4 no data loss
File-by-file hashes (`files-old.json` vs `files-new1.json`): `sessions.json`, `archived.json`, `cards.jsonl`, `cards/2026-09.jsonl`, `cards/2026-11.jsonl`, `replies.jsonl`, pending inbox files, `bin/wait.js` are byte-identical. Only additions: `meta.json`, `replies/`, `replies.jsonl.bak-s2`, `logs/`, `projects.json` `teams` field. The 0.1.0 `cards.jsonl` cards and the old-month card are still found by search.

### P5 orphan waiters
Made with a spawner that exits at once (dead parent): (a) the real 0.2.0 waiter run via the old shim `board/bin/wait.js s-alpha-fe` (writes a `wait.lock`, no `wait.info`); (b) a fake node process whose command line is `<board>/bin/wait.js s-orphan-fake`, with a lock. Control: a fake waiter under a live fake `claude-code/cli.js` parent.
After the 5db405f server start (within 4 s): (a) and (b) dead, their lock files removed; the control waiter and its fake claude still alive (killed by me at the end). The server's scope guard held: it only touched waiters under my board.

### P6 old wait.js shim
- Shim as written by 0.2.0 (target = 0.2.0 `scripts/wait-inbox.js`, still on disk): reply delivered (`[Dashboard reply] - shim A reply`), exit 0, against the migrated board.
- 0.2.0 plugin dir removed (the in-place or cache update case): shim prints `the wait command is missing (...). Run /ddashboard:dashboard again to refresh it.`, exit 0 (no crash, no hang).
- 5db405f `session-start` hook rewrote the shim to the new `scripts/wait-inbox.js` (same path `board/bin/wait.js`, so an "always allow" permission still matches); the next run delivered the reply with the 5db405f wording. New-version instruction text and `/api/state` view (`working` after the reply) correct.
- 0.2.0 had no `bin/team.js`; the team shim is only made when a lead context is built (not part of this upgrade test).

### P7 old hooks on the migrated board
A 0.2.0 `stop-card` hook (an old session still running the old plugin) wrote a card to `cards/2026-11.jsonl`; 5db405f shows it. A card from the 5db405f hook and a reply from `/api/reply` also show (replies 4 -> 7 with the 3 test replies; pending count right).

### P8 leftover files in the plugin dir
Plugin dir = 5db405f tree + leftover `scripts/lib.js`, `cards.js`, `dashboard.html` (from the v0.2.0 tag) and `orca.js`, `terminal.js`, `usage.js`. These three do not exist in the v0.2.0 tag; I took them from the last commits that had them (`6ed17b2^` and `5266b3a^`, the old shims). Run against a fresh copy of the 0.2.0 board:
- `control.js start` from that dir: server up, migrated to schema 2, state 9 / 14 / 16 / 4 as above, `/` serves the new page (1483 bytes, ES modules), not the leftover `dashboard.html`.
- hooks session-start / prompt-submit / stop-card / session-end: no stderr; card recorded; `s-gamma-m` ended; reply + `bin/wait.js` (shim re-pointed to the plugin dir) delivered it; `team.js list` prints usage.
- Static check: no top-level `scripts/*.js` requires `./lib`, `./cards`, `./orca`, `./terminal`, `./usage` or `dashboard.html`; the `require('./cards')` lines found are inside `app/`, `store/`, `http/` and resolve to those folders' own files. So the leftovers are inert.

## Notes (none block the upgrade)
- **N1 view change by design:** 2 wip cards (`s-alpha-solo wip plan v2`, `s-beta-solo wip plan v2`) are no longer in the active list: the session's later card (blocked / review) folds them (`folded_into`, 0.3.0 rule, domain/card.js). They stay in search, `archived:false`, so active 16 -> 14 is no loss. A wip card of an ended session shows `outcome: stopped` (s-beta-ended, old `sep-1`).
- **N2 version string (release item):** `.claude-plugin/plugin.json` and `marketplace.json` are still `0.2.1` at 5db405f, so `meta.json` records `by_version:"0.2.1"`. Bump to 0.3.1 before tagging, or the plugin cache will not see an update.
- **N3 not testable from 0.2.0 data:** groups, card keys and settings (language, runners) do not exist in 0.2.0, so no 0.2.0 data for them; a missing `settings.json` gives `{lang:null}` and projects get `teams:{}`. Their own migration is covered by test/migrate.test.js, not here.
- **N4 stale pid file:** a force-killed server (taskkill /F) leaves `server.pid`; the next start overwrote it fine.

## Cleanup
Servers and fake processes I started are stopped (port 7363 free), all temp dirs (board, archives, projects, driver) deleted; 7357 and `~/.ddashboard` not touched. One command was refused before it ran (`control.js stop` without `DDASH_BOARD_DIR` would have hit the real server); I reran it with the board env set.

## Verdict
**GO for the upgrade path**, with N2 (version bump to 0.3.1) to be done before the tag.
