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

1. In the session that will lead, type `/ddashboard:dashboard team <team name>`. Open http://127.0.0.1:7357. This adds a team; a repository can have several (e.g. one per feature or per experiment), each with its own lead, members and groups. A name already in use is refused, and a session can lead one team.
2. Let the lead write a **project brief** first (structure, one line per important file, rules, current state) to a file such as `docs/brief.md`. Members read the brief instead of exploring the repository. When every member prompt starts with the same brief text, the prompt cache is shared across members, so from the second member on the brief costs about a tenth.
3. The lead starts members for the big pieces:
   ```
   node ~/.ddashboard/bin/team.js <lead id> spawn --role backend "Read docs/brief.md. Add the /api/mode endpoint ..."
   ```
   Use `--model` for a lighter model on simple roles (QA, docs). Use `--stay` only for a member that should keep waiting for instructions; by default a member finishes and exits, and `send` resumes it later.
   If Orca is running, the member opens as a visible interactive `claude` in a new Orca terminal in the lead's worktree, so you can watch it and step in; otherwise it runs headless. `--headless` or `--orca` picks one (`DDASH_ORCA=0` turns Orca off).

## Groups

Members are cheapest when they are short-lived (small context) but then each new one starts from zero. A **group** gives them a memory instead:

1. `team.js <lead id> group create front` makes `docs/teams/<team>/front/` in the lead's worktree with a `brief.md` template. Groups belong to one team, so two teams can each have a `front` group without sharing anything. Fill in the scope, the key files, the rules and the current state. Keep it under about 4000 tokens: it is put into every new member, and the lead is told when it has to be cut.
2. `team.js <lead id> spawn --group front --role ui "..."` starts a member that gets the brief and the latest handoff before its task. The hook puts them in at session start, ahead of the task, so every member of the group starts with the same text and can share the prompt cache (this only works for members started in the same worktree and commit).
3. When a member finishes, it runs `team.js <its id> next-handoff`, which creates the next `handoff-NNN.md` exclusively (two members finishing together never get the same number) and prints its path, and writes there what was done, open items and where things are. It updates `brief.md` if the facts changed, and keeps evidence in `notes/`. The next member continues from there.
4. Old files are cleaned up as new ones are written: the newest 3 handoffs and 30 days of notes stay (`keep_handoffs`, `notes_days`; `group prune` to run it by hand). Cleanup only touches the own team's folders. Git still has the history.
5. The lead commits `docs/teams/<team>/` with its other docs. Members never commit these files.

Folders from before teams (`docs/groups/<group>/`) move to `docs/teams/<team>/<group>/` (`git mv` when tracked) the first time the settings are read.

Groups are optional; members without one are listed as `unassigned`. `role` stays as a sub-role inside a group.

## Working

- **Reports** arrive at the lead as `[Team report]` through its wait command. A report has the status, title, up to 3 summary lines and what to check. Long details stay on the card; the lead reads them with `team.js <lead id> show <card id>` only when needed.
- **Instructions** go out with `team.js <lead id> send <role or id> "<text>"`. A waiting or running member gets it from its inbox; an Orca member idle at its prompt gets it typed into its terminal; a finished member is resumed with the same options (in a new Orca terminal when Orca runs).
- **Blocked members** use the `blocked` status with the question in the summary. The lead answers with `send`, or asks you on the dashboard if it is your call.
- **What reaches you:** decisions, review requests, problems, and finished milestones. Turn on `Member reports` on the dashboard when you want to look over the lead's shoulder.
- **Permissions:** members run in auto mode (`--permission-mode auto`): a classifier approves safe actions, and `git`, `node` and `npm` commands are always allowed. A denied action is reported as blocked. Adjust per project in `~/.ddashboard/projects.json` (`"spawn": { "permission_mode", "allowed_tools", "model" }`). Avoid `bypassPermissions` unless the work is sandboxed.

## Lead handoff

A lead's context grows with every report. The handoff point is the lead's start (its context at its first turn as lead: system prompt, tools, skills, the handoff doc) plus a work budget (`DDASH_LEAD_WORK_BUDGET`, 100k tokens). It never goes above 80% of the model context window (`DDASH_CONTEXT_WINDOW`, 200k; 1M once a larger context is seen), and never below start + 20k, so a new lead is never told to hand off right away. Past that point the Stop hook tells the lead once to hand over and the sidebar marks it `handoff due`.

A lead whose start is over half the window is marked `large start`. Handoffs do not shrink the start: turn off the MCP servers and skills that lead does not need.

Handoff docs stay the same size however many handoffs there were:

- **Current state only:** open items, members and their tasks, decisions changed since the last handoff, next steps. Write a new doc each time; do not copy or point to older ones. Finished work belongs in the plan, commits and CHANGELOG.
- **Size cap:** `T handoff` refuses a doc over 6000 tokens (`DDASH_HANDOFF_MAX_TOKENS`; estimated from the text, Korean and other non-ASCII text counted high) and asks you to shorten it.
- **Fixed rules apart:** `docs/teams/<team>/lead-rules.md` holds what does not change between leads (how to work with the user, Git rules). A template is created with the team (or on the first handoff). The new lead reads only the latest handoff doc and this file.

Steps:

1. The lead writes a new handoff doc with the current state (see above).
2. The lead runs `team.js <lead id> handoff <doc>`. It prints the first prompt for the new lead; `--spawn` starts the new lead headless instead.
3. Start the new lead with that prompt, e.g. in a new terminal:
   ```
   claude "[ddash lead-handoff from=<old id> doc=<path>] Read only this handoff doc and the team rules <team dir>/lead-rules.md (not older handoff docs), then take over as team lead. Start the wait command from your instructions."
   ```
4. When the new lead's first prompt is submitted, the hook makes it the lead of the old lead's team (name, worktree and groups stay), moves that team's members and any pending messages to it, marks the old lead ended, and stops the old lead's wait command and Claude process. If the old process cannot be stopped, the old session is told to stop on its next turn and its prompts are refused.

## Tips

- **Small things:** the lead does them itself. Spawning costs a fresh read of the brief and the files.
- **Member to member:** route questions through the lead for now. Direct member talk tends to ping-pong and re-reads both contexts on every message.
- **Untagged sessions** in a team project are in no team: they are marked `outside team` and still post directly, so you can always open a side session for something unrelated.
- **Several teams:** each lead sees and commands only its own members (`list`, `send`, `group`, `handoff`). A member reports only to the lead that spawned it.
- **Stale briefs:** when git HEAD is `DDASH_BRIEF_STALE_COMMITS` (20) commits past the last change of a group's `brief.md`, the lead is told once. Update the brief and the warning resets.
- **Unresponsive sessions:** an idle session with no wait command, not seen for `DDASH_STALE_MIN` minutes, is marked `unresponsive` in the sidebar. Check its terminal, or `Mark ended` it.
- **If a lead ends** without a handoff, its members post straight to the dashboard and are marked `lead missing`. Start a new lead with a lead handoff, or remove the team and add a new one.
- **Removing a team:** `/ddashboard:dashboard solo` in its lead session, or `remove` on the team's header in the sidebar. Its members then post directly; other teams stay. When no team is left the project is solo (the `solo` choice in the switch removes every team at once). Every session gets the new instructions once on its next turn.
