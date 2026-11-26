# Team skill-ddashboard: lead rules

Fixed rules for every lead of this team. Handoff docs hold only the current state.

## Working with the master

- The user is the **master**. Keep terminal replies to a line or two; put content in Korean cards.
- When asking for a decision, always give a recommendation.
- New features: write the verdict and recommendation in the plan first, get approval, then implement.
- Anything outward-facing (deploy, release, PR merge) needs the master's approval. The master tests before a deploy.

## Wait command

- Always start the wait command with Bash `run_in_background`. When it exits, read its output and restart it in the same response (parallel calls).

## Git

- Git Flow, no merge commits (rebase; main is fast-forward only).
- Commits, code, README in English; keep README.ko.md in sync.
- **Never** add a Claude co-author trailer or "Generated with Claude Code".
- The lead commits group docs (`docs/teams/skill-ddashboard/<g>/`).

## Saving context

- Delegate code review and debugging to subagents (general-purpose) or members; take only the conclusion.
- Filter big outputs to the lines you need.
- QA results are owned by the QA member (group `qa`): it handles test members, their checks and cleanup, and sends the lead a final summary only.

## Install and restart

- Released versions: install with `claude plugin marketplace update ddashboard && claude plugin update ddashboard@ddashboard` (a versioned dir under `~/.claude/plugins/cache/ddashboard/ddashboard/<ver>`). Restart the server from that dir's `scripts/`.
- Unreleased builds for testing: copy from committed HEAD only (`git archive HEAD ...`), never from a worktree with uncommitted edits.
- Restart: `node -e "const c=require('./control');(async()=>{c.stop();console.log(await c.start())})()"` from the installed `scripts/`.
- Run `node test/team.test.js` first, not at the same time as a restart (a timing test can fail then).

## Repo layout (since 0.3.1)

- main/develop/release carry only the plugin runtime, `test/` and the public docs. Internal docs (`docs/teams/ docs/qa/ docs/handoff/ docs/research/ docs/plan-*.md`) are gitignored there and live on the orphan branch `notes`. To save them, rebuild `notes` with a temp `GIT_INDEX_FILE` (read-tree --empty, update-index from the files, write-tree, commit-tree with parent `notes`, update-ref) and push `notes`.

## External posting

- Claude in Chrome blocks reddit.com (safety restriction): the master posts on Reddit. GeekNews posting needs an account older than a week.

## Members and terminals

- Spawn members with `--orca` so the master can watch them in Orca (the runner setting defaults to headless; don't pass `--headless`).
- `T send` text arrives as an instruction, never as a slash command; use `T end <sid|role>` to stop a member.
- In Git Bash, prefix commands whose arguments start with `/` with `MSYS_NO_PATHCONV=1`.
- New Orca worktrees: `orca worktree create --repo id:<repo> --name <n> --base-branch <branch> --branch <branch> --setup skip` (with `--agent` the launch check fails). Then `orca terminal create --worktree path:<dir> --command "claude ..."`; a new folder shows a trust prompt (send Down, then Enter).
- For a lead handoff use `T handoff <doc> --orca` so the new lead is visible in Orca (the project's runner setting defaults to headless).

## QA in parallel

- One QA member per verification target. Each runs its own server from the target worktree with `DDASH_PORT` (7358+) and a temp `DDASH_BOARD_DIR`; never the installed copy on 7357.
- One-off QA members are ended after their report.
- Tell every QA/test member: never kill processes by image name, window title or pattern (Claude runs as node.exe; a `taskkill /FI "IMAGENAME eq node.exe"` killed a QA member mid-run). Kill only PIDs it recorded itself.
