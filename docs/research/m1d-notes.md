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
