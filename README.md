# ddashboard

**English** | [한국어](README.ko.md)

**A local dashboard for Claude Code: see each session's results as a short card, and reply on the card to instruct that session.**

![version](https://img.shields.io/badge/version-0.2.1-blue) ![claude code](https://img.shields.io/badge/Claude_Code-plugin-d97757) ![node](https://img.shields.io/badge/node-%3E%3D18-339933) ![license](https://img.shields.io/badge/license-MIT-green)

AI writes code faster than people can follow, and leaves more text in the terminal than anyone wants to read. ddashboard keeps only **what you need to know**: a status, a three-line summary, and what you should check. You watch the dashboard, and reply on a card to tell that session what to do next.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshot-dark.png">
  <img alt="ddashboard: live sessions grouped by project in the sidebar, and result cards with reply boxes" src="assets/screenshot-light.png">
</picture>

## Features

- **Almost no extra tokens.** Hooks and local scripts record cards, refresh the page, and wait for replies. The model only adds a short card block at the end of a reply, plus about 200 tokens of instructions once per session.
- **Replies go straight to the right session.** An idle session wakes up when a reply arrives; a busy one picks it up as soon as it finishes its current turn.
- **Only where you turn it on.** Sessions in other projects are untouched (no output, no tokens). Worktrees of the same repository are connected together, so you can follow several sessions on one screen.
- **Everything stays on your machine.** Nothing is sent to an external service. The server listens on `127.0.0.1` only, and data lives in `~/.ddashboard`.
- **No dependencies.** Node 18 or later is all you need.

## Install

Run inside Claude Code:

```
/plugin marketplace add lilohdong/ddashboard
/plugin install ddashboard@ddashboard
```

## Quick start

1. In a Claude Code session in the project you want to follow, type:
   ```
   /ddashboard:dashboard
   ```
2. Open http://127.0.0.1:7357 in your browser.
3. When the session asks for permission to run the wait command (`wait-inbox.js`), choose **always allow**. It only waits quietly for your replies.
4. Work as usual. A card shows up whenever there's a result worth reporting.
5. Reply on a card (Ctrl+Enter) and that session handles it.

To turn it off, type `/ddashboard:dashboard off`. The server stops once no project is connected.

## The dashboard

- **Sidebar:** connected sessions, grouped by project. Click a project or a session to see only its cards. Collapse it with the button at the top left or the `[` key.
  | Mark | Meaning |
  |---|---|
  | Blue dot | Working |
  | Green dot | Listening — a reply is delivered immediately |
  | Gray dot | Idle — a reply is delivered when the next turn ends |
  | Hollow dot | Ended (hidden by default) |
  | `needs you` | The session's latest card is "Needs review" or "Blocked" and you haven't replied yet |
- **Token meter:** each session line shows its context size after the last turn (e.g. `ctx 120k`) and its cumulative tokens since it connected. The context size turns red above `DDASH_CONTEXT_WARN` (150k by default). Below the session list, `Today` shows today's input, cache-read, and output tokens across all sessions. Hover over either for the exact numbers (cache writes and turns included). The Stop hook reads these from the session transcript; nothing calls the model.
- **Search:** the search box at the top (`/` to focus, `Esc` to clear) searches every card, archived ones included.
- **Filters:** narrow cards by status, with a count for each.
- **Archive:** each card has an Archive button. Cards older than 14 days, and cards replaced by a newer version, are archived automatically. `Archived (N)` at the bottom of the sidebar opens the archive, where you can unarchive.
- **Cards:** project, session, branch, time, and diff stats, plus the summary, what to check, and a collapsible `Details` section for longer content. Cards from ended sessions don't show a reply box.
- **Language:** English, 한국어 (Korean) or 简体中文 (Simplified Chinese), picked in the header; until you pick one it follows the browser. The choice is saved in `~/.ddashboard/settings.json` and also sets the language sessions write new cards in (each session gets the updated instructions once).

## Multiple sessions and projects

Once the dashboard is on, any session you open in the same repository connects automatically, including sessions in other worktrees. Run one `claude` per feature worktree, and every session's results land on one screen, where you can instruct each session separately.

Turn the dashboard on in several projects and they all share one dashboard, split by project in the sidebar. Adding projects doesn't change the token cost per session.

To give a project its own dashboard instead, set a different port and data directory in that project's `.claude/settings.json`:

```json
{ "env": { "DDASH_PORT": "7358", "DDASH_BOARD_DIR": "~/.ddashboard-blog" } }
```

A session's name defaults to its folder name; override it with the `DDASH_NAME` environment variable.

## Solo and team mode

Each project runs in one of two modes. You can switch at any time, with a command or from the dashboard (the `solo`/`team` switch next to the project name in the sidebar).

| | solo (default) | team |
|---|---|---|
| Turn on | `/ddashboard:dashboard` (or `... solo`) | `/ddashboard:dashboard team <lead name>` in the lead session |
| Who posts to the dashboard | every connected session | the lead only; member cards go to the lead |
| Your replies go to | the session that posted the card | the lead |
| Members | — | started by the lead with a tag that sets their role |

**Team mode** is for one lead session that you talk to, and member sessions (planner, frontend, backend, QA…) that do parts of the work and report to the lead. Delivery between them uses the same file inbox and wait command as dashboard replies, so it costs no tokens.

- **Members** start with a first prompt tag: `[ddash role=<role> lead=<lead session id> stay=0|1]`. The lead starts them with `team.js`: if Orca is running, as a visible interactive `claude` in a new Orca terminal in the lead's worktree; otherwise headless (`claude -p` in the background, no terminal needed). You can also paste the tagged prompt into any terminal.
- **The lead** gets these commands (the exact command line is in its instructions; it runs from the fixed path `~/.ddashboard/bin/team.js`):
  | Command | What it does |
  |---|---|
  | `spawn --role <role> [--group <g>] [--model <m>] [--stay] [--headless\|--orca] "<task>"` | Starts a member: in an Orca terminal when Orca runs, else headless (output in `~/.ddashboard/logs/<session id>.log`). `--headless` / `--orca` force one |
  | `send <session id\|role> "<text>"` | Sends an instruction: into the inbox if the member is waiting or running; typed into its Orca terminal if it sits idle there; otherwise resumes it (`claude --resume` in a new Orca terminal, or `claude -p --resume`) |
  | `list` | Members with role, state, waiting, and last card |
  | `show <card id>` | A card in full (long report details are not copied into the report) |
  | `handoff <doc>` | Hands the lead over to a new session (see the guide) |
  | `group create\|rename\|delete [--purge]\|list\|prune <name>` | Manages groups (below) |
- **Member reports** reach the lead as `[Team report]`, lead instructions reach members as `[Lead instruction]`, and your replies stay `[Dashboard reply]`. Reports are kept as cards but hidden from the feed; the `Member reports` button shows them, dimmed.
- **Headless permissions** default to `--permission-mode auto` (auto mode: a classifier approves safe actions) plus `Bash(git *)`, `Bash(node *)` and `Bash(npm *)`. Change them per project in `~/.ddashboard/projects.json`: `"spawn": { "permission_mode": "...", "allowed_tools": ["..."], "model": "..." }`.
- **Sidebar:** members are indented under their lead with a role badge. Sessions without a tag are marked `outside team` and still post directly. If the lead ends, members post directly and are marked `lead missing`. `+ member` under the lead starts a member from the dashboard (role, optional model, stay, task); the lead is told about it. The lead picker lists sessions newest first with a short id and when they were last seen; sessions not seen for `DDASH_STALE_MIN` minutes (60) are grouped as stale. An idle session with no wait command that has not been seen for that long is marked `unresponsive`.
- **Cleaning up:** `×` removes an ended session from the sidebar and `Clear N ended` removes all of a project's ended sessions (their cards and token counts stay). An idle session not seen for `DDASH_STALE_MIN` minutes offers `Mark ended` first.
- **Groups (optional):** a group (e.g. `front`) is a team's shared memory: `docs/groups/<name>/` in the lead's worktree with `brief.md` (scope, key files, rules, current state), `handoff-NNN.md` and `notes/`. `spawn --group <name>` gives a new member the brief (up to about 4000 tokens; the lead is told when it needs trimming) and the latest handoff before its task, and the member writes the next handoff when it finishes. Only the newest 3 handoffs and 30 days of notes are kept (`keep_handoffs` and `notes_days` in the group's entry in `projects.json`). Renaming moves the folder (`git mv` when tracked); deleting moves it to `docs/groups/_archived/` (`--purge` deletes it) and unassigns the members. Nothing is committed for you: the lead commits the docs. The sidebar shows lead → group → members, with `unassigned` for members without a group.
- **Lead handoff:** when the lead's context gets large, it writes a handoff doc and runs `team.js ... handoff <doc>`. A new session that starts with `[ddash lead-handoff from=<old id> doc=<path>]` becomes the lead, takes over the members and pending messages, and the old lead is ended and stopped. When the lead's context passes `DDASH_LEAD_CONTEXT_LIMIT` (150k), the Stop hook tells it once to do this, and the sidebar marks it `handoff due`.
- **Cost guards:** every session is told to restart the wait command in the same response that handles its output (one model call per reply, not two). Member reports are at most 3 summary lines with the evidence in the group's `notes/` and its path. When git HEAD gets `DDASH_BRIEF_STALE_COMMITS` (20) commits past the last change of a group's `brief.md`, the lead is told once that the brief may be stale.

Recommended workflow: [Team mode guide](docs/team-mode-guide.md).

## How it works

```
 A session ends its turn ── card block at the end of the reply
          │
          ▼  Stop hook (no model calls)
 ~/.ddashboard/cards/YYYY-MM.jsonl ── branch and diff stats attached automatically
          │
          ▼
 Local server + dashboard (127.0.0.1:7357)
          │  you reply on a card
          ▼
 ~/.ddashboard/inbox/<session id>/
          │
          ├─ session idle → the background wait command exits and wakes the session
          └─ session busy → when the turn ends, the Stop hook hands the reply over as the next instruction
```

| Hook | What it does |
|---|---|
| `SessionStart` | Registers new sessions in connected projects and gives them the card rules (team mode: on the first prompt instead, to read the member tag) |
| `UserPromptSubmit` | Turns the dashboard on/off, switches solo/team mode, registers members and lead handoffs from their tag, connects sessions that started earlier, marks the session "Working" |
| `Stop` | Records cards and the turn's token usage (`usage/YYYY-MM.jsonl`), sends member cards to their lead (team mode), delivers waiting messages, marks the session "Idle" |
| `SessionEnd` | Marks the session "Ended" |

No hook calls the model, and none of them print anything in sessions that aren't connected.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `DDASH_PORT` | `7357` | Dashboard port |
| `DDASH_BOARD_DIR` | `~/.ddashboard` | Where cards, replies, and session info are stored |
| `DDASH_NAME` | folder name | Session name shown on the dashboard |
| `DDASH_POLL_MS` | `1500` | How often the wait command checks for replies (ms) |
| `DDASH_RECENT_DAYS` | `14` | Cards older than this are archived automatically |
| `DDASH_CONTEXT_WARN` | `150000` | Context size (tokens) above which a session's `ctx` turns red. Read by the server |
| `DDASH_STALE_MIN` | `60` | Minutes without activity after which a session counts as stale (lead picker, `Mark ended`, `unresponsive`). Read by the server |
| `DDASH_LEAD_CONTEXT_LIMIT` | `150000` | Lead context (tokens) above which the lead is told once to hand off |
| `DDASH_BRIEF_STALE_COMMITS` | `20` | Commits past a group brief's last change before the lead is told it may be stale |
| `DDASH_ORCA` | on | `0` never starts members in Orca terminals (always headless) |

To manage the server directly:

```
node <plugin path>/scripts/control.js start | stop | status
```

## FAQ

**Does it really cost no tokens?**
The dashboard itself never calls the model. What's added is about 200 tokens of instructions per session and the card block on turns that report a result (usually 100–200 tokens). Handling a reply costs the same as typing it into the terminal.

**What if I reply after closing a session?**
In this version, replies to a closed session are not delivered; they stay in the inbox (`~/.ddashboard/inbox/<session id>/`). Reply to sessions with a green dot (listening) for instant delivery. Automatic handling is on the roadmap.

**It says the port is already in use.**
Pick another port with `DDASH_PORT`.

**How do I delete my data?**
Delete the `~/.ddashboard` folder.

## Roadmap

- [ ] Handle replies to closed sessions automatically with `claude -p --resume`
- [x] Team mode: a lead session that splits work and launches member sessions
- [x] Archive and search cards (0.2.0)

## Contributing

Issues and pull requests are welcome. Branches follow Git Flow: branch `feature/*` off `develop`, and open pull requests against `develop`.

## License

[MIT](LICENSE)
