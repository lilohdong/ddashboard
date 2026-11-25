# Team mode guide

ddashboard only provides the plumbing: roles, routing, and a zero-token inbox. How your team works is up to you. This guide describes the workflow we recommend and the reasons behind it.

## The cost model

What a team costs is roughly **how often a session wakes up × how big its context is when it does**. Delivering messages is free (files and a wait command), so the levers are:

- Wake the lead as rarely as possible, and keep its context small.
- Don't start a member for a small task: a new member pays to read the repository again.
- Keep reports short: at most 3 summary lines, evidence in the group's `notes/` (or a file) and only its path.
- Handle a wait command's output and restart it in the same response (parallel tool calls): one model call per message instead of two. Every session's instructions say so.

## Roles

| Role | Does | Doesn't |
|---|---|---|
| **You** | Talk to the lead on the dashboard, decide, review | Talk to members directly |
| **Lead** | Plans, splits work, does small tasks itself, reviews member reports, posts only what you must know, decide or review | Post every member result to the dashboard |
| **Member** | One focused task per run, a short card at the end | Post to the dashboard (it goes to the lead) |

## Setting up

1. In the session that will lead, type `/ddashboard:dashboard team <lead name>`. Open http://127.0.0.1:7357.
2. Let the lead write a **project brief** first (structure, one line per important file, rules, current state) to a file such as `docs/brief.md`. Members read the brief instead of exploring the repository. When every member prompt starts with the same brief text, the prompt cache is shared across members, so from the second member on the brief costs about a tenth.
3. The lead starts members for the big pieces:
   ```
   node ~/.ddashboard/bin/team.js <lead id> spawn --role backend "Read docs/brief.md. Add the /api/mode endpoint ..."
   ```
   Use `--model` for a lighter model on simple roles (QA, docs). Use `--stay` only for a member that should keep waiting for instructions; by default a member finishes and exits, and `send` resumes it later.
   If Orca is running, the member opens as a visible interactive `claude` in a new Orca terminal in the lead's worktree, so you can watch it and step in; otherwise it runs headless. `--headless` or `--orca` picks one (`DDASH_ORCA=0` turns Orca off).

## Groups

Members are cheapest when they are short-lived (small context) but then each new one starts from zero. A **group** gives them a memory instead:

1. `team.js <lead id> group create front` makes `docs/groups/front/` in the lead's worktree with a `brief.md` template. Fill in the scope, the key files, the rules and the current state. Keep it under about 4000 tokens: it is put into every new member, and the lead is told when it has to be cut.
2. `team.js <lead id> spawn --group front --role ui "..."` starts a member that gets the brief and the latest handoff before its task. The hook puts them in at session start, ahead of the task, so every member of the group starts with the same text and can share the prompt cache (this only works for members started in the same worktree and commit).
3. When a member finishes, it writes the next `handoff-NNN.md` (what was done, open items, where things are), updates `brief.md` if the facts changed, and keeps evidence in `notes/`. The next member continues from there.
4. Old files are cleaned up as new ones are written: the newest 3 handoffs and 30 days of notes stay (`keep_handoffs`, `notes_days`; `group prune` to run it by hand). Git still has the history.
5. The lead commits `docs/groups/` with its other docs. Members never commit these files.

Groups are optional; members without one are listed as `unassigned`. `role` stays as a sub-role inside a group.

## Working

- **Reports** arrive at the lead as `[Team report]` through its wait command. A report has the status, title, up to 3 summary lines and what to check. Long details stay on the card; the lead reads them with `team.js <lead id> show <card id>` only when needed.
- **Instructions** go out with `team.js <lead id> send <role or id> "<text>"`. A waiting or running member gets it from its inbox; an Orca member idle at its prompt gets it typed into its terminal; a finished member is resumed with the same options (in a new Orca terminal when Orca runs).
- **Blocked members** use the `blocked` status with the question in the summary. The lead answers with `send`, or asks you on the dashboard if it is your call.
- **What reaches you:** decisions, review requests, problems, and finished milestones. Turn on `Member reports` on the dashboard when you want to look over the lead's shoulder.
- **Permissions:** members run in auto mode (`--permission-mode auto`): a classifier approves safe actions, and `git`, `node` and `npm` commands are always allowed. A denied action is reported as blocked. Adjust per project in `~/.ddashboard/projects.json` (`"spawn": { "permission_mode", "allowed_tools", "model" }`). Avoid `bypassPermissions` unless the work is sandboxed.

## Lead handoff

A lead's context grows with every report. When its context passes `DDASH_LEAD_CONTEXT_LIMIT` (150k tokens by default), the Stop hook tells it once to hand over and the sidebar marks it `handoff due`:

1. The lead writes a handoff doc: goals, decisions so far, open tasks, member ids and roles, where things are. Short; the new lead reads only this.
2. The lead runs `team.js <lead id> handoff <doc>`. It prints the first prompt for the new lead; `--spawn` starts the new lead headless instead.
3. Start the new lead with that prompt, e.g. in a new terminal:
   ```
   claude "[ddash lead-handoff from=<old id> doc=<path>] Read the handoff doc and take over as team lead. Start the wait command from your instructions."
   ```
4. When the new lead's first prompt is submitted, the hook makes it the project lead, moves the members and any pending messages to it, marks the old lead ended, and stops the old lead's wait command and Claude process. If the old process cannot be stopped, the old session is told to stop on its next turn and its prompts are refused.

## Tips

- **Small things:** the lead does them itself. Spawning costs a fresh read of the brief and the files.
- **Member to member:** route questions through the lead for now. Direct member talk tends to ping-pong and re-reads both contexts on every message.
- **Untagged sessions** in a team project are marked `outside team` and still post directly, so you can always open a side session for something unrelated.
- **Stale briefs:** when git HEAD is `DDASH_BRIEF_STALE_COMMITS` (20) commits past the last change of a group's `brief.md`, the lead is told once. Update the brief and the warning resets.
- **Unresponsive sessions:** an idle session with no wait command, not seen for `DDASH_STALE_MIN` minutes, is marked `unresponsive` in the sidebar. Check its terminal, or `Mark ended` it.
- **If the lead ends** without a handoff, members post straight to the dashboard and are marked `lead missing`. Pick a new lead with the switch next to the project name.
- **Back to solo:** `/ddashboard:dashboard solo` or the switch. Every session gets the solo instructions once on its next turn.
