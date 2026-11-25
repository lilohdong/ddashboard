# verify-010: team features after the refactor (steps 8-9, 11)

Commit 9c0bb9b (git archive in a temp dir, `git init`, temp board dir). Evidence and the scripts used:
`docs/teams/skill-ddashboard/qa/notes/verify-010-team/` (evidence.txt = all command output).
No real Claude, Orca or window was started; `claude` was a fake node script (sleeps 120 s, records argv/stdin).

**Port deviation:** the server ran on **7361**, not 7360. 7360 was already LISTENING (pid 31260) from a stale
server of the earlier QA member (temp dir `qa010-27rG`, still on disk). It is not mine, so I left it running.
Please stop it and delete that dir. 7357 and the installed copy were not touched.

| # | Item | Result |
|---|------|--------|
| 1 | group create / duplicate (case-insensitive) refused / rename / rename onto an existing name refused / delete (archived to `_archived/<g>-<date>`) / delete unknown refused / list | PASS |
| 2 | same through `POST /api/groups` (create, rename, delete, bad action 400, unknown project 404) | PASS |
| 3 | group prune: keeps 3 newest handoffs, removes older handoffs and 90-day-old notes; nothing to prune otherwise | PASS |
| 4 | headless spawn with `--group`: argv has `--session-id`, `--permission-mode auto`, allowedTools; stdin starts with `[ddash role=qa-a lead=L1 stay=0 group=qa]` | PASS |
| 5 | send to a running member -> queued ("1 queued" in list); send to a finished member -> resumed (new pid) | PASS |
| 6 | end (CLI and `POST /api/team/end`): run stopped; a second end says `already`; end of a never-running member says "nothing was running" | PASS |
| 7 | HTTP spawn: ok; bad runner 400 `bad_runner`; unknown lead 404 | PASS |
| 8 | lead handoff (`performHandoff` L1 -> L2): old lead `ended/handoff`, 3 members re-pointed to L2, `L2 list` shows them, `L1 list` is empty, new lead gets `last_handoff` | PASS |
| 9 | dead member: non-headless member with a dead claude pid -> ended, `end_reason: gone` (list text says `ended`) | PASS (see N2) |
| 10 | stopped badge colour: light stopped rgb(122,92,194) vs wip rgb(99,108,118); dark stopped rgb(179,157,219) vs wip rgb(154,163,173). Headless Chrome 158, computed style of the real style.css | PASS |

## Notes (none block)
- **N1 (safety, tooling):** `team.js <lead> handoff` on a lead that has no recorded claude pid resolved the pid of the
  *real* `claude.exe` up the process tree (the one running this QA) and printed "this session (Claude pid 9112) is
  stopped" for when the new lead registers. That is correct for a real lead, but my fake lead was a stand-in, so I did not
  run the registration hook. I ran `performHandoff` directly after pointing L1's `claude_pid` at a dummy node process;
  the dummy was left alive (claude_killed false, because it is not a Claude image) and the real one was never touched.
- **N2:** a killed *headless* member is shown `finished` and stays `working` in sessions.json (by design: supervisor
  `gone()` skips headless, "finished = resumable"). `gone` applies to orca/window/pid-recorded members. The task text said
  a dead member shows "gone": in the list it reads `ended`, with the reason in the data only.
- **N3:** the handoff step 9 in `team.js` was exercised through the library call, not the SessionStart hook path.
- The archive folder date is the UTC date (`20261125` at 08:5x KST on 11-26); cosmetic.

## Cleanup
Server (pid 2716) and the dummy node process stopped; all fake members ended; the temp dir and Chrome profiles deleted.
