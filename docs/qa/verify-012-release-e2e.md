# verify-012: ddashboard 0.3.1 release E2E (commit 5db405f)

Server: `git archive 5db405f` into a temp dir, port 7364, temp `DDASH_BOARD_DIR`, fake `claude` (DDASH_CLAUDE_BIN). Never 7357 or ~/.ddashboard. Temp dir, server and my dummies cleaned up afterwards.
Evidence and scripts: `docs/teams/skill-ddashboard/qa/notes/verify-012-release-e2e/` (`evidence.txt`, `solo.js`, `teamstage.js`, `chrome.js`, `lib.js`, `testrun*.txt`, `board-light.png`, `board-dark.png`; `run1/` = the earlier, incomplete run on 7363).

## Result: GO

| Item | Result |
|---|---|
| Solo stage A-F (activation, cards/fold/key/stopped, archive/search, reply to wait.js/Stop hook, usage) | PASS 39/39 |
| Team stage G-M (language, solo<->team, groups, spawn/send/resume/end, lead handoff, back to solo) | PASS 46/46 |
| Headless Chrome light + dark, no JS exceptions | PASS (one minor log line, N2) |
| `node test/run.js` x3 (plus 2 extra) | 19/19, 18/19, 19/19; extra 19/19, 18/19. The only failure is a flaky `orphans.test.js` (N1) |

The solo stage was rerun on a fresh board (the earlier solo state belonged to the old temp dir and the team stage needs the solo board). Earlier result was also 39/39 (`run1/`).

## Findings
- **H1 (test-harness issue, fixed in the driver; not a product bug on its own).** Hooks run by the driver from inside my Claude session walk up the process tree and record MY real Claude as the fake session's `claude_pid` (reproduced: a new session-start hook got claude_pid = my claude.exe, an ancestor). Then `team end`, lead handoff (`claude_killed`) and the supervisor stop kill that pid, which is what killed the two earlier QA members. Driver fixes: `lib.js` `sanitize()` runs after every hook/team call and re-pins any session whose claude_pid is an ancestor of the driver to a dummy node process the driver spawned (logs `GUARD ...`); `teamstage.js` K4 now kills only the pid returned by the spawn call and refuses an ancestor pid. In this run the guard did not need to fire during the stages (sessions were already pinned or headless), and only the explicit probe triggered it; my claude.exe stayed alive throughout.
  - Product angle (low): for a real session the recorded pid is correct. It is wrong only when a hook is run by a different process than the session's own Claude (like this driver, or a lead running a script that invokes hooks). Consider documenting it; no change needed for 0.3.1.
- **N1 (flaky test, low).** `test/orphans.test.js` "stopWaiter: stops the waiter and its wrapper..." fails intermittently in the full-suite run: `waiterChain(pid, table)` returned `[]` instead of `[pid, wrapper]` (test line 249). 2 of 5 full runs failed; 4 of 4 standalone runs passed. Looks like a process-table snapshot race under load (the whole suite runs files in parallel), not a product defect. Suggest a retry or wait-until on the table in that test.
- **N2 (cosmetic).** The board page requests `/favicon.ico` and gets 404 (one "Failed to load resource" log entry in light mode; cached afterwards). No JS exception, no console.error.

## Notes
- Unrelated to this run: an older server is still listening on 7363 (pid 30128) from an earlier QA member; I did not touch it.
