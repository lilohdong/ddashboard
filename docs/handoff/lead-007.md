# Lead handoff #007 (2026-11-27)

Previous lead: `46386eb9-3de3-4aa6-b218-96a29870b7c8` (context limit). Read `docs/teams/skill-ddashboard/lead-rules.md` first (updated: install via `claude plugin update`, repo layout with the `notes` branch, external posting limits).

## 1. Where we are

- **0.3.1 is released.** main = develop = tag `v0.3.1` = eddca0c, all pushed; branches `notes` and `release/0.3.1` are pushed too. There is a GitHub Release v0.3.1 with notes, and topics were added (claude, ai-agents, multi-agent, developer-tools).
- Installed via `claude plugin update` into `~/.claude/plugins/cache/ddashboard/ddashboard/0.3.1`. The server on 7357 runs from there. Sessions started before the update still use the 0.2.0 hooks until they restart (`~/.ddashboard/bin` shims are rewritten then).
- Internal docs (this file, lead-rules, qa, research) are **gitignored on main-line branches** and live on `notes`. This file and the lead-rules edit are local only and not yet on `notes` (see next steps).
- **This worktree is on branch `hotfix/readme-screenshots`** (from main), with 1 commit: 3ae7644, new README screenshots of the 0.3.1 UI (EN, light/dark, 2560x1600, about 310 KB each, fictional demo data). Not pushed. The master liked it ("굿굿").

## 2. Pending master decisions (latest card key `roadmap`, and `readme-shots`)

1. **Roadmap proposal** (card "진행 방향 제안"), awaiting approval:
   - v0.3.2 = issue #5 plus two items. (a) Move the runtime into `plugin/` and set the marketplace source to `"./plugin"`, so the install cache gets only runtime files (per the official docs, files outside the plugin dir aren't copied; the marketplace clone still holds the whole repo). (b) Move the screenshots (EN+KO × light/dark) to an orphan `media` branch and load them in the READMEs from raw.githubusercontent URLs. Korean-UI screenshots get added there.
   - v0.4 = #6 (team-mode onboarding), ending with a demo GIF, a README rework, and then promotion.
   - v0.5 = #7 (resume replies to ended sessions, notifications, remote access).
   - v0.6 = new issue: agent adapters, Codex CLI first, then Gemini CLI. Lay out the adapter seam during the v0.4 refactor.
   - Asked: keep Codex at v0.6 (recommended) or move it before v0.5.
   - On approval: add the 0.3.2 items to #5, open the v0.6 issue, ship the screenshot hotfix (ff main + develop, no version bump; it could also be folded into v0.3.2 if the media-branch move happens first, so ask whether to push 3ae7644 now or redo it in 0.3.2), then start v0.3.2.
2. The master asked whether to use Korean screenshots for README.ko.md; the recommendation was yes (separate KO-UI shots). Then they asked about download size, which led to the `plugin/` + `media` proposal above.

## 3. Research results (for planning)

- Plugin sources (official docs): relative path, github (repo/ref/sha), url, git-subdir (url/path/ref), npm, archive. A relative subdir means only that dir is copied to the cache. There is no ignore mechanism. A `#dist` branch install (`/plugin marketplace add lilohdong/ddashboard#dist`) shrinks the clone but would make existing users re-add the marketplace, so it is not recommended now.
- Other agents (Nov 2026):
  - Codex CLI and Gemini CLI are both feasible: hooks with session_id/transcript_path, context injection at prompt time, and the Stop/AfterAgent hook gets the reply text; headless runs with resume.
  - Copilot CLI is Claude-hook compatible, but its userPromptSubmitted can't inject context.
  - opencode needs its own TS plugin and SDK.
  - Cursor CLI hooks are unreliable in the CLI.
  - Gaps: transcript formats, token usage, and the background wait command behaviour differ per agent.

## 4. Promotion status (card key `promo`)

- Drafts for r/ClaudeAI (EN) and GeekNews (KO) were approved by the master. Nothing has been posted.
  - Reddit is blocked for Claude in Chrome, so the master posts it themselves.
  - GeekNews (account aaa0903) can't post until the account is a week old. Retry around 2026-12-03 when the master says "게시", as a "Show" post.
- awesome-claude-code: its maintainer asks for users first and accepts submissions through the web issue form only. Submit after traction.
- The current session runs with `--chrome` (Claude in Chrome connected).

## 5. Members

None active; all members are ended (fix, docs, shots, and the old qa ones). Spawn new members with `--orca`.

## 6. Open items

1. Leftover QA servers 7360/7362/7363 (pids 31260, 5768, 30128; verified as old QA `server.js` processes). The master approved stopping them, but the auto-mode classifier blocked `Stop-Process`. The card asked the master to run `! taskkill /PID 31260 /PID 5768 /PID 30128`; unconfirmed whether they did.
2. Update `notes` with the local internal docs (lead-007.md, the lead-rules edit) and push it.
3. Old 0.2.0 / 0.1.0 plugin cache dirs remain; leave them unless the master asks.
4. From before: delete the exp-a/b/c worktrees and branches; refresh the stale qa group brief; follow-up from fix: scope the unscoped server sweep (no DDASH_BOARD_DIR) to its own board.
5. Learned this session: replies sent while the lead's wait command isn't running (e.g. during a session restart) wait in the inbox and arrive when wait restarts. This is not a bug, but the master noticed the delay. Maybe the SessionStart:resume hook could tell the lead to restart wait first (it already does).
