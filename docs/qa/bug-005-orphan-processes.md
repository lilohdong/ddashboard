# BUG-005: orphan processes (wait.js and others)

Severity: critical. Phase 1 = analysis and fix design only (no code changed). Author: member `proc` (46141d34).

## Symptom

After a session's Claude process dies (e.g. `orca terminal close`), its background
`node ~/.ddashboard/bin/wait.js <sid>` keeps running. Effects:

1. The dashboard shows the session as **waiting** forever, and it cannot be ended or forgotten.
2. On Windows the orphan (and its orphan `bash.exe` parents) hold the worktree as their cwd, so Orca cannot delete the worktree.

## Live evidence (2026-11-26, after the lead killed 4 orphans by hand)

Process table at analysis time (`Get-CimInstance Win32_Process`, ancestors walked):

| pid | what | parent | started | note |
|---|---|---|---|---|
| 30268 | node `.../ddashboard/0.1.0/scripts/wait-inbox.js 0bb36ce9…` | 5076 **gone** | 11-25 21:22 | 0.1.0 waiter, survived the plugin update |
| 26612 | node `.../0.1.0/scripts/wait-inbox.js 5f9391e7…` | 25672 **gone** | 11-25 21:25 | same |
| 10876 → 21864 → 13848 → 11892 | bash → bash → bash → node `bin/wait.js d0504315…` | 23996 **gone** | 11-25 23:09 | whole bash chain orphaned |

None of the three sessions is in `sessions.json` any more (forgotten), but each still has `inbox/<sid>/wait.lock`
pointing at the live waiter. They are invisible on the dashboard and still hold their cwd. **Still running now; not
killed (read-only phase) — the lead should kill 30268, 26612 and 10876 (tree).**

A healthy waiter looks like this (the lead):
`Orca.exe → cmd.exe → node orca-launch.js → claude.exe (21408) → bash.exe → bash.exe → bash.exe → node bin/wait.js`.

Lead's notes: the two 0.1.0 waiters (30268, 26612) are the likely reason Orca cannot delete the empty folder of
worktree `archive-ui` ("open in another program"). The d0504315 chain is old lead #001. Orphans survive plugin
upgrades, so the sweep (F-5) must match waiters from **any** plugin version, not only the current one.

## Root causes

### RC-1: nothing ties wait.js to the life of its Claude process
`scripts/wait-inbox.js` polls the inbox every 1.5 s forever. It exits only when a message arrives, or on SIGINT/SIGTERM.
It never checks whether the session that started it still exists.

- **Windows**: there is no parent-death signal and no automatic tree kill. Claude Code runs background Bash commands in a
  Git Bash chain that is not attached to the terminal's console (hidden), so when the console/ConPTY closes
  (`orca terminal close`, closing a window by X, killing claude.exe) only processes attached to that console get
  CTRL_CLOSE. The bash chain and node keep running with a dead parent pid (seen above).
- **POSIX**: Claude Code starts background commands in their own process group, so the terminal's SIGHUP does not reach
  them; they are re-parented to init/subreaper. wait.js only writes to stdout once (at the end), so it never gets the
  EPIPE that would tell it the reader (Claude) is gone.

### RC-2: the dashboard's "waiting" is "the pid in wait.lock is alive", nothing more
`server.js waiting(sid)` and `lib.waitPid(sid)` read `inbox/<sid>/wait.lock` and `process.kill(pid, 0)`. An orphan
waiter therefore means:
- `s.view = 'waiting'` (server.js:155) forever;
- `markEnded` refuses: "session is active (working, waiting or seen recently)" (lib.js:1329) → **cannot be ended,
  therefore cannot be forgotten** (forget requires ended);
- `memberGone` returns false when a waiter is alive (lib.js:1300) → the bug-001 "dead member" detection is masked;
- solo/lead sessions outside team mode have no `claude_pid` at all (`recordClaudePid` runs only in team mode,
  session-start.js:24), so nothing can prove them dead. b53964ef, cec9394b, e75ecde6 had no `claude_pid`.

There is no connection between waiter and server: the protocol is files only (inbox dir + wait.lock). "Drop waiting when
the connection closes" has to be done as a liveness check of the waiter's owner instead (see F-3).

### RC-3: ending/forgetting a session never stops its waiter
- `session-end.js` only sets state `ended`; it leaves the waiter running (normal `/exit` is usually fine because Claude
  kills its own background shells, but SessionEnd also fires on `/clear` and on resume paths).
- `forgetSessions` deletes the record and calls `removeEmptyInbox`, which **returns early when the waiter is alive**, so
  lock + inbox + process all stay. This is exactly how the 3 sessions above became invisible orphans.
- `markEnded` (dashboard "mark ended") does not kill it either (and refuses because of it, RC-2).
- Only `endMember` (team members, `team.js end` / dashboard end) and `performHandoff` (old lead) kill the waiter.

### RC-4: the cwd of long-lived processes is a worktree
- wait.js inherits the worktree cwd from bash (`cwd` is the session's folder). Its bash parents hold it too.
- **The dashboard server** is started by `control.start()` from the UserPromptSubmit hook (`/ddashboard:dashboard`) or by
  the skill; `spawn(..., { detached: true })` has no `cwd`, so `server.js` inherits the **worktree of whichever session
  turned the dashboard on** and keeps it until stopped. On Windows that worktree cannot be deleted while the server runs.
  Same bug class, different process.

### RC-5: killTree cannot reach a tree whose root is already dead (Windows)
`killTree(pid)` uses `taskkill /PID pid /T /F`. When the Claude pid is already dead (the normal "gone" case), taskkill
fails and the `alive(pid)` guard returns early — the orphan children (which still carry the dead pid as ppid on Windows)
are never visited. POSIX: SIGTERM only, no SIGKILL escalation (wait.js handles SIGTERM, so fine for it; a hung tool
process may survive).

### RC-6: "gone" detection exists only for team members
`memberGone` (lib.js) is only called for `kind === 'member'` (server.js:147), and `claude_pid` is recorded only in team
mode (session-start.js:24). A solo session, a lead, or an untagged ("outside") session whose Claude dies without
SessionEnd (terminal closed, killed) stays `idle` forever. It is not ended, so it cannot be forgotten; "mark ended"
works only after `STALE_MIN` (60 min), and never while an orphan waiter is alive (RC-2). Seen: b53964ef, cec9394b,
e75ecde6 had no `claude_pid` and stayed idle.

## Audit: every process the plugin starts or keeps alive

| Process | Started by / parent | Parent (Claude) dies: Windows | Parent dies: POSIX | cwd held | Verdict |
|---|---|---|---|---|---|
| **wait.js** (`bin/wait.js` → `wait-inbox.js`) | Claude's background Bash (claude → bash×3 → node) | survives with bash chain (RC-1) | survives, reparented (RC-1) | worktree (node + bashes) | **orphan path A** |
| wait.js after forget / SessionEnd / markEnded | — | not killed (RC-3) | same | worktree | **orphan path B** |
| wait.js of an old plugin version (0.1.0) | same | keeps running after update; points at old cache dir | same | worktree | **orphan path C** (legacy) |
| wait.js of a `--stay` **headless** member | claude -p → bash → node | when `claude -p` exits the background waiter is left (claude -p does not own a console) | same | worktree | **orphan path D** (risk; not observed) |
| **server.js** (`control.js start`) | detached from the hook / skill process | intended to outlive (daemon) | same | **worktree of the starter** (RC-4) | **cwd lock** |
| headless member (`team.js runClaude`: `claude -p`, detached; on an unknown `.cmd`, a `cmd.exe` wrapper) | detached from lead's team.js | runs to the end of its task (by design); ends itself | same | worktree (needed) | ok; tool children die with it only if claude kills them |
| Orca member/lead (`orca terminal create` → cmd → node orca-launch.js → claude) | Orca daemon | terminal close kills console-attached procs; claude's **background bash/wait survive** (path A) | Orca pty close → SIGHUP to fg group; background group survives | worktree | launcher ok; children → path A |
| window member (`terminal.js openWindow`: `cmd /c start … cmd /k script.cmd` → node orca-launch.js → claude) | conhost/explorer (start detaches) | closing the window by X: same as Orca → path A. `team.js end` does `taskkill /T` on the shell: ok while alive | x-terminal-emulator / Terminal.app: SIGHUP to fg only → path A | worktree | children → path A |
| orca-launch.js | the terminal's shell | dies with the console; claude exits with it | dies on SIGHUP; ignores SIGINT on purpose | worktree | ok |
| hooks (session-start, prompt-submit, stop-card, session-end) | Claude, synchronous | short-lived; `execSync git`, `powershell` (processTable, 10 s timeout) | same | session cwd, seconds | ok; prompt-submit is where the server gets its bad cwd (RC-4) |
| `orca.js` CLI calls, `where`, `git`, `taskkill`, `powershell` | sync/async with timeouts | short-lived | — | — | ok |
| killTree / killClaude / killPid (lib.js) | — | taskkill /T needs a live root (RC-5) | SIGTERM group + descendants | — | gap when root is dead |

## Fix design (guarantee: no waiter outlives its Claude; nothing long-lived holds a worktree)

**F-1. wait.js watches its owner and exits (core fix).** In `wait-inbox.js` at start:
- find the owner: `findClaudePid(process.ppid)` (one process-table read, ~0.4 s on Windows, once). Also remember
  `process.ppid` at start.
- every poll: exit 0 silently if `owner` is not alive; on POSIX also exit if `process.ppid` changed (re-parented).
- every ~60 s (cheap guard against pid reuse on Windows): re-read the process table and exit if `owner` is no longer a
  Claude process (`isClaudeProcess`).
- no Claude ancestor found (tests, manual run): fall back to watching the start `ppid` + the 60 s check against the
  bash ancestor being alive; never run unwatched. `DDASH_WAIT_OWNER=<pid>` lets tests inject the owner.
- on owner death: remove `wait.lock`/`wait.info`, do **not** touch session state (the server decides gone/ended).
- the bash parents exit as soon as node exits (`{ node …; } && pwd -P` finishes), so the whole chain goes.

**F-2. wait.js does not hold the worktree.** `process.chdir(os.homedir())` (BOARD_DIR if writable) at startup, before
polling. (The bash parents still hold it while the session lives, which is correct; they go with F-1.)

**F-3. Owner-aware "waiting".** wait.js writes `inbox/<sid>/wait.info` = `{ pid, owner, ppid, started, ver }` next to
`wait.lock` (lock format unchanged: older readers keep working). `waitPid(sid)` becomes: lock pid alive **and** (no
wait.info, or `owner` alive). So a waiter whose owner died is not "waiting" — `markEnded`/`memberGone`/forget work
again, and the dashboard shows idle/gone instead of waiting. wait.js also records `owner` as the session's
`claude_pid` when none is known (solo sessions get a pid → gone detection works for them too).

**F-4. End/forget kill the waiter tree.**
- new `lib.stopWaiter(sid)`: kill the waiter pid (verify its cmdline is a wait command first, pid-reuse safe) and its
  orphaned bash ancestors whose cmdline contains `wait.js <sid>`/`wait-inbox.js <sid>`, then remove lock/json.
- call it from `forgetSessions` (before `removeEmptyInbox`), `markEnded`, `markGone`, `session-end.js`, `endMember`
  (replaces `killTree(wp)`), `performHandoff` (replaces `kill(wp)`).

**F-5. Orphan sweep.** `lib.sweepWaiters(table)`: in the process table, every node process whose args run
`wait-inbox.js` or `bin/wait.js` (any plugin version, incl. 0.1.0) and that has **no live Claude ancestor** is killed
with its wait-command bash ancestors; stale lock/json files with dead pids are removed. Runs:
- once at server start (cleans legacy orphans like 30268/26612),
- every 60 s in the server, using an **async** process-table read (don't block requests for 0.4 s),
- in `markEnded`/forget when the user acts on a session.
Only processes whose command line is our wait command are ever killed.

**F-6. Server cwd.** `control.start()` spawns server.js with `cwd: os.homedir()`; server.js also `chdir`s to the
homedir at startup (covers servers started another way).

**F-7. killTree with a dead root.** If `pid` is dead, kill its surviving descendants from the table (their ppid still
names the dead pid on Windows) — only for callers that verified identity (`killClaude` path passes a table taken while
it was alive; the sweep passes cmdline-matched pids). POSIX: SIGTERM, wait 1 s, then SIGKILL what remains.

**F-9. Gone detection for every session (RC-6).**
- SessionStart records `claude_pid` for **every** registered session (solo, lead, outside, member), not only in team
  mode. UserPromptSubmit records it too when it is missing (sessions started before the dashboard was turned on). The
  waiter fills it in as a fallback (F-3).
- Generalize `memberGone` to `sessionGone(s, isOpen)`: not ended, not headless, and the recorded Claude pid is dead
  (or, for a pid that is alive, no longer a Claude process — checked against the sweep's process table, guarding
  against pid reuse). The Orca-handle rule stays for members without a pid. An orphan waiter no longer counts as
  alive, because of F-3.
- `/api/state` runs it for all sessions → `state: 'ended', end_reason: 'gone'`, and `stopWaiter(sid)` kills a leftover
  waiter. Then the session can be forgotten as usual.
- `markEnded` accepts a gone session at once (already does via memberGone; it now applies to every kind).
- Headless sessions keep their own rule (pid exited = finished, resumable).

**F-8. Stay headless members.** Covered by F-1 (owner = the `claude -p` pid; it exits → waiter exits). No extra code.

## Tests to add (test/team.test.js unless noted)

1. **owner dies → waiter exits** (F-1): start a fake owner `node -e "setInterval(()=>{},1e3)"`, run wait-inbox.js with
   `DDASH_WAIT_OWNER=<owner>` and a temp `DDASH_BOARD_DIR`; kill owner; assert waiter exits < 5 s and wait.lock/json gone.
2. **owner alive → waiter keeps waiting, delivers a message** (regression).
3. **cwd** (F-2): waiter started with cwd = temp dir; assert the temp dir can be removed while the waiter runs
   (Windows-meaningful; on POSIX assert `process.cwd()` reported via a debug line / wait.info `cwd` is the homedir).
4. **waitPid owner-aware** (F-3): wait.lock with a live pid + wait.info with a dead owner → `waitPid` = 0;
   `markEnded` succeeds; server `/api/state` view is not `waiting`.
5. **forget/markEnded/session-end stop the waiter** (F-4): live fake waiter (a node process whose argv contains
   `wait-inbox.js <sid>`) → after `forgetSessions([sid])` it is dead and the inbox dir is removed.
6. **stopWaiter is pid-reuse safe**: wait.lock pointing at a live process that is *not* a wait command → not killed.
7. **sweep** (F-5): table fixture (pure function over a fake process table) with: waiter under live claude (kept),
   waiter with dead ancestor chain (killed + its bash ancestors), 0.1.0 waiter path (killed), unrelated node (kept).
8. **server cwd** (F-6): `control.start()` with temp BOARD_DIR/port → server `/api/state` exposes nothing new; instead
   assert via a test hook env (`DDASH_DEBUG_CWD=1` makes server log its cwd) that cwd = homedir.
9. **killTree dead root** (F-7): spawn parent→child, kill parent only, `killTree(parent, tableTakenBefore)` kills child.
10. qa-dead-member.test.js: dead member **with an orphan waiter** is detected as gone (was masked by RC-2).
11. **gone for solo/lead/outside** (F-9): a solo session and a lead with a dead `claude_pid` → `/api/state` shows them
    `ended` (`end_reason: 'gone'`), forget succeeds; a live pid that is not a Claude process (reused) → also gone; a live
    Claude pid → stays idle; a headless session is untouched.
12. **SessionStart records the pid in solo mode** (F-9): session-start hook run under a fake Claude ancestor
    (`DDASH_WAIT_OWNER`-style override for `findClaudePid`) writes `claude_pid` with the project in solo mode.
13. **sweep catches old plugin versions** (F-5): table fixture with `.../ddashboard/0.1.0/scripts/wait-inbox.js <sid>`
    and no live Claude ancestor → killed.

## Implementation order (phase 2, separate commits)

1. wait-inbox.js: owner watch + chdir + wait.info (F-1, F-2) + tests 1-3.
2. lib.js: owner-aware waitPid, stopWaiter, killTree dead root (F-3, F-4, F-7) + hooks/forget/markEnded/endMember/
   handoff call sites + tests 4-6, 9, 10.
2b. Gone detection for every session: SessionStart/UserPromptSubmit pid recording, sessionGone in server (F-9) +
   tests 11-12.
3. sweep in server + server/control cwd (F-5, F-6) + tests 7-8, 13.
Waits for `dev` to finish lib.js/cards.js/dashboard.html before step 2 touches lib.js.

## Implementation (phase 2)

Commits on `feature/team-mode`: 95f4866 (F-1..F-3), 212d51d (F-4, F-7), 759df96 (F-9), edb3000 (F-5, F-6).
Tests: `node test/orphans.test.js` (new, 20 tests), `team.test.js` 92/92 and `qa-dead-member.test.js` 7/7 still pass.

Changes from the design:
- The waiter's info file is `inbox/<sid>/wait.info`, not `wait.json`: every `.json` file in the inbox is read as a message.
- F-7 became `reapToolShells(claudePid)`: only children of a dead Claude pid whose command is a Claude Code tool shell
  (`shell-snapshots/snapshot-…`) are killed, with their trees. Killing every descendant of a dead pid was not safe
  on Windows, where pids are reused. Called from forget, markEnded and `team end`.
- An orphan is decided strictly (`orphanWaiter`): the waiter chain's parent is dead, its pid was reused (Windows
  creation time, now in the process table), or it is init/launchd/systemd. "No Claude found above it" alone does not
  count, because a Claude host the plugin doesn't recognize would lose its waiter every minute.
- The waiter checks its owner every poll (`alive`) and checks the owner's image name every 60 s (`tasklist`/`ps`, cheap).
  A whole process-table read happens only once, at start.
- A new waiter takes over from an orphan that holds the lock. Before, it said "Already waiting" and the session never
  got its messages.
- Test note: on Windows, node kills a child that is not detached when the parent dies, so the fixtures start orphans
  through a launcher that exits. The tests pass with or without a Claude process above the test runner.
