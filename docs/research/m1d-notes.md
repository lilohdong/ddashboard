# M-1d notes: runner settings

Plan: docs/plan-0.3.0.md M-1d. Tests: `node test/team.test.js` (67/67; five `M-1d:` tests, older Orca tests now set `runner_member`/`runner_lead` to `orca`).

- Settings: `projects.json[key].spawn.runner_lead` / `runner_member` = `headless` | `orca` | `window`, default `headless` (`lib.runnersOf`, `lib.setRunners`). **Behaviour change:** members no longer go to Orca just because it runs; set `runner_member: orca` for that.
- `team.js`: `pickRunner(forced, configured)` → `{ how, note }`. A configured runner that cannot run (Orca down, `DDASH_WINDOW=0`, no display, launcher missing) falls back to headless with a note in the output; a failed launch also falls back with a note. Flags (`--headless`/`--orca`/`--window`, one at most) override the setting and are refused when they cannot run (as `--orca` was).
- `window`: `scripts/terminal.js`. Windows `cmd /d /s /c "start "<title>" /D "<cwd>" cmd /k "<command>""` (verbatim args); macOS `osascript` Terminal `do script`; Linux `x-terminal-emulator -T <title> -e sh -c ...` (needs DISPLAY/WAYLAND_DISPLAY). The command runs `orca-launch.js` with a spec file, like Orca terminals. `DDASH_WINDOW=0` turns it off; `DDASH_WINDOW_BIN` replaces the launcher (tests).
- Window sessions: `runner: 'window'`, no handle. `send` queues to the inbox while the session lives; an ended one is resumed in a new window (headless when none can open). A window that was closed without the session ending cannot be detected (no handle): the instruction waits in the inbox until the session is marked ended.
- Leads: `handoff --spawn` uses `runner_lead` (title `lead <team>`); without `--spawn` the output names the configured runner.
- API: `POST /api/settings {project, runner_lead?, runner_member?}` (project name or key; 400 on bad values, 404 unknown project). `/api/state` teams carry `runner_lead` / `runner_member`. `POST /api/team/spawn` accepts `runner: window`.
- Dashboard: with a project selected, the bar above the cards shows "Lead runner" / "Member runner" selects (en/ko/zh-CN); a change posts to `/api/settings` and reloads.

Not checked: real windows on macOS/Linux (only the launcher arguments are tested), the dashboard in a browser, and a real Windows window (the launcher was not run; the test checks the command line).

## Review fixes (137dab4 review)

1. Windows window: the command goes into `<logs>/<sid>.window-<ts>.cmd` (`chcp 65001`, `cd /d "<cwd>"`, then node, orca-launch.js and the spec, each quoted, `%` doubled). The command line is only `cmd /d /c start "<title>" cmd /k <script name>`, run in the logs folder; the title keeps letters, digits, space and `._·:-`. Paths with `&`, `%`, `^` or spaces never reach cmd's parser. The test checks the launcher for all three platforms (`launcher({ platform })`).
2. `openWindow` checks that the folder exists and waits for the launcher where it returns at once (`start`, `osascript`, the test fake): a spawn error or a non-zero exit throws, so the configured runner falls back to headless with a note. `x-terminal-emulator` stays running, so it is checked on PATH beforehand only.
3. and 4. Window members get `claude_pid` from the SessionStart hook (pre-registered members already did; checked in `session-start.js`), so BUG-001's `memberGone` applies: `list`/`/api/state` mark them ended, and `send` to a dead one marks it ended and resumes it in a new window. `send` to an idle window member says it is read only on the member's next turn and that someone has to type in that window.
5. `lib.updateProjects(fn)` re-reads projects.json right before writing. `T handoff` writes only `teams.<t>.handoff`, and `performHandoff` only the team's `lead`/`last_handoff`. Dashboard changes made meanwhile are kept (test: a runner change in the middle of a handoff).
6. A window lead starts at the worktree root, like Orca.
7. `claudeCommand()` runs npm's `claude.cmd` as `node <dir>/node_modules/@anthropic-ai/claude-code/cli.js` (no shell). Only an unknown `.cmd` still needs cmd.exe; then `interactiveArgs` replaces a prompt containing `% & | < > ^ ! "` or a newline with "[ddash ...] Your first message is in <prompt file> ...", which keeps the tag.
8. `POST /api/team/spawn` returns 400 for an unknown `runner`.
9. Linux: `... || { echo ...; read x; }` keeps a failed window open.

Not checked: a real window on any OS (it would open a window on the user's screen). Tests 74/74, QA 7/7.

## Server: Orca checks without blocking (8b8cb52 follow-up)

`/api/state` no longer runs the orca CLI synchronously. `server.js terminalOpen` returns the cached state (null = not known yet, so nobody is marked gone) and refreshes a stale entry (10 s) in the background with `orca.terminalOpenAsync` (execFile callback, one call per handle at a time). A closed terminal is noticed on a later poll. CLI commands (`team.js list`) keep the blocking `orca.terminalOpen`. Test: a fake orca that takes 1.5 s; `/api/state` answers in under 1 s and the member turns `ended` shortly after.
