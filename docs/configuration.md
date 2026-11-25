# Configuration

<!-- Generated from scripts/core/config.js: node scripts/core/config.js --doc > docs/configuration.md -->

Environment variables, read by `scripts/core/config.js` only. Dashboard choices (language) live in
`settings.json`, per-project choices (runners, team rules) in `projects.json`. An empty value means the default.

| Variable | Type | Default | Meaning |
|---|---|---|---|
| `DDASH_BOARD_DIR` | path | `~/.ddashboard` | Board folder (sessions, cards, inbox, logs). Tests point it at a temp folder. |
| `DDASH_PORT` | pos | `7357` | Dashboard server port (127.0.0.1 only). |
| `DDASH_RECENT_DAYS` | num | `14` | Cards older than this many days count as archived. |
| `DDASH_TICK_MS` | pos | `10000` | Server liveness tick: sessions that died without SessionEnd are ended (ms). |
| `DDASH_SWEEP_MS` | pos | `60000` | Server sweep interval for orphan wait commands (ms). |
| `DDASH_CONTEXT_WARN` | pos | `150000` | Context size (tokens) at which the dashboard marks a session. |
| `DDASH_STALE_MIN` | pos | `60` | Minutes without activity after which an idle session without a waiter is unresponsive. |
| `DDASH_NAME` | str | — | Session name shown on the dashboard (default: the folder name, or the member role). |
| `DDASH_POLL_MS` | pos | `1500` | Wait command inbox poll interval (ms). |
| `DDASH_WAIT_CHECK_MS` | pos | `60000` | Wait command owner identity re-check interval (ms, pid reuse). |
| `DDASH_WAIT_OWNER` | pos | `0` | Pid the wait command watches instead of its Claude ancestor (tests). |
| `DDASH_CLAUDE_BIN` | str | `claude` | The claude command for members (a .js file runs with node; tests). |
| `DDASH_ORCA` | off | on | Set to 0 to turn the Orca runner off. |
| `DDASH_ORCA_BIN` | str | `orca` | The orca command (a .js file runs with node; tests). |
| `DDASH_WINDOW` | off | on | Set to 0 to turn the OS terminal window runner off. |
| `DDASH_WINDOW_BIN` | str | — | Window launcher override (a .js file runs with node and gets <title> <cwd> <argv JSON>; tests). |
| `DDASH_BRIEF_STALE_COMMITS` | pos | `20` | Commits after which a group brief is reported as possibly stale. |
| `DDASH_HANDOFF_MAX_TOKENS` | num | `6000` | Largest lead handoff doc (estimated tokens); 0: no cap. |
| `DDASH_LEAD_WORK_BUDGET` | num | `100000` | Tokens a lead may grow above its starting context before it is told to hand off. |
| `DDASH_LEAD_CONTEXT_LIMIT` | num | `0` | Absolute lead handoff point (tokens); 0: relative (start + work budget). |
| `DDASH_CONTEXT_WINDOW` | num | `0` | Model context window (tokens); 0: detect (200k, 1M for [1m] models). |

Types: num = number ≥ 0 (0 is a value), pos = number > 0 (0 means the default), str = text, path = folder
(leading `~` = home), off = on unless `0`, `false`, `off` or `no`.
