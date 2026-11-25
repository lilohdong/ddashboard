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

- Install from committed HEAD only (another member may have uncommitted edits in the worktree):
  `git archive HEAD scripts skills/dashboard/SKILL.md README.md README.ko.md` → extract → copy into `~/.claude/plugins/cache/ddashboard/ddashboard/0.2.0` (scripts/, skills/dashboard/SKILL.md, READMEs).
- Restart from the installed scripts: `node -e "const c=require('./control');(async()=>{c.stop();console.log(await c.start())})()"`
- Run `node test/team.test.js` first, not at the same time as a restart (a timing test can fail then).

## Members and terminals

- `T send` text arrives as an instruction, never as a slash command; use `T end <sid|role>` to stop a member.
- In Git Bash, prefix commands whose arguments start with `/` with `MSYS_NO_PATHCONV=1`.
- New Orca worktrees: `orca worktree create --repo id:<repo> --name <n> --base-branch <branch> --branch <branch> --setup skip` (with `--agent` the launch check fails). Then `orca terminal create --worktree path:<dir> --command "claude ..."`; a new folder shows a trust prompt (send Down, then Enter).
- For a lead handoff use `T handoff <doc> --orca` so the new lead is visible in Orca (the project's runner setting defaults to headless).
