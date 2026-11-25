# Team mode guide

ddashboard only provides the plumbing: roles, routing, and a zero-token inbox. How your team works is up to you. This guide describes the workflow we recommend and the reasons behind it.

## The cost model

What a team costs is roughly **how often a session wakes up × how big its context is when it does**. Delivering messages is free (files and a wait command), so the levers are:

- Wake the lead as rarely as possible, and keep its context small.
- Don't start a member for a small task: a new member pays to read the repository again.
- Keep reports short. Put evidence in files and pass the paths.

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

## Working

- **Reports** arrive at the lead as `[Team report]` through its wait command. A report has the status, title, up to 3 summary lines and what to check. Long details stay on the card; the lead reads them with `team.js <lead id> show <card id>` only when needed.
- **Instructions** go out with `team.js <lead id> send <role or id> "<text>"`. A waiting or running member gets it from its inbox; a finished headless member is resumed with the same options.
- **Blocked members** use the `blocked` status with the question in the summary. The lead answers with `send`, or asks you on the dashboard if it is your call.
- **What reaches you:** decisions, review requests, problems, and finished milestones. Turn on `Member reports` on the dashboard when you want to look over the lead's shoulder.
- **Permissions:** headless members run with `acceptEdits` and may run `git`, `node` and `npm` commands. Anything else is denied, which the member reports as blocked. Adjust per project in `~/.ddashboard/projects.json` (`"spawn": { "permission_mode", "allowed_tools", "model" }`). Avoid `bypassPermissions` unless the work is sandboxed.

## Lead handoff

A lead's context grows with every report. When the sidebar shows its `ctx` in red (150k tokens by default), hand over:

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
- **If the lead ends** without a handoff, members post straight to the dashboard and are marked `lead missing`. Pick a new lead with the switch next to the project name.
- **Back to solo:** `/ddashboard:dashboard solo` or the switch. Every session gets the solo instructions once on its next turn.
