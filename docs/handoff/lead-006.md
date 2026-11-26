# Lead handoff #006 (2026-11-26)

Previous lead: `5eb5d89e-0303-42be-a2bc-8caab5078aea`. Reason: context limit (50k start + 100k).
Read `docs/teams/skill-ddashboard/lead-rules.md` first (two new rules: spawn members with `--orca`; QA never kills by image name or pattern).

## 1. Where we are

- 0.3.1 code is complete: architecture steps 0-13 are all on `feature/team-mode` (see `docs/architecture.md` §6). Pushed up to 5db405f; later local commits are docs only (9e31875) plus whatever `fix` lands.
- Installed locally (plugin cache `~/.claude/plugins/cache/ddashboard/ddashboard/0.2.0`, from 5db405f), server restarted, and the real board migrated to schema 2 (`~/.ddashboard/meta.json`).
  - Backups are in the previous lead's scratchpad: `C:/Users/rhkdr/AppData/Local/Temp/claude/d9af20467118e0fe/5eb5d89e-0303-42be-a2bc-8caab5078aea/scratchpad/` (`backup-0.2.0` = old plugin copy, `board-backup-pre031` = board before migration).
- Release QA, all GO: verify-008 to verify-013 in `docs/qa/` (013 = upgrade from v0.2.0, 012 = full E2E: solo 39/39, team 46/46).

## 2. Master's orders in force

- "Have the QA team do QA, run a final test, then go through the release sequence." Master approved all recommendations:
  - **Repo cleanup option A**: main and develop keep the plugin runtime (`.claude-plugin/ hooks/ scripts/ skills/ assets/ README* LICENSE .gitattributes`), plus `test/` and the public docs `docs/architecture.md`, `docs/configuration.md` and `docs/team-mode-guide.md`.
  - Internal docs (`docs/teams/ docs/qa/ docs/handoff/ docs/research/ docs/plan-0.2.0.md docs/plan-0.3.0.md docs/brief-token-meter.md`) go to a remote orphan branch `notes`. On the release branch, untrack them with `git rm -r --cached` and add them to `.gitignore`; the local files stay. No history rewrite.
- **Before the main push and tag, confirm with the master again** (that was promised).

## 3. Release sequence (next steps)

1. Wait for `fix` (below) to land and `node test/run.js` to pass.
2. Build the `notes` orphan branch from committed HEAD's internal paths. Use a temp `GIT_INDEX_FILE`: `read-tree --empty`, add the `ls-tree -r HEAD <paths>` entries via `update-index --index-info`, then `write-tree`, `commit-tree`, and `update-ref refs/heads/notes`. Push `notes`.
3. Fast-forward `develop` to `feature/team-mode`. Branch `release/0.3.1` from develop. Commit the cleanup (option A), bump `.claude-plugin/plugin.json` and `marketplace.json` from 0.2.1 to 0.3.1, and update both READMEs (EN/KO in sync). Run the tests from a clean `git archive` copy, after a `git init`.
4. Ask the master. Then: main ff-only, tag `v0.3.1`, develop ff, push.
5. Reinstall into the plugin cache from the tag. Stale files (`lib.js cards.js orca.js terminal.js usage.js dashboard.html`) remain in the cache scripts/: the auto-mode classifier blocked their deletion, so ask the master or install into a fresh `0.3.1` dir if the plugin system uses versioned dirs.

## 4. Members

| sid | role | state |
|---|---|---|
| 4ea514d4 | fix (Opus, Orca) | Fixing the flaky `test/orphans.test.js` stopWaiter (waiterChain [] at line 249; fails 2 of 5 full runs). Lands with ff-only into the lead tree; must pass run.js 5× in a row |

All others have ended. The `front` sid ff0fdcb7 is no longer listed as a member; spawn new members instead.

## 5. Open items

1. Leftover QA servers (not ours to kill without approval): 7360 pid 31260, 7362 pid 5768, 7363 pid 30128. Killing by PID needs the master's OK.
2. Harness finding H1 (verify-012): a hook run from inside a Claude session records that Claude as the session's `claude_pid`, so a QA driver that kills the "member pid" kills itself. Real sessions are unaffected. Consider documenting it in the qa group brief.
3. Not done from #005: delete the exp-a/b/c worktrees and branches, clean up the old exp sessions in the sidebar, refresh the stale qa group `brief.md`, add measurements to docs/research/lead-handoff-001.md §5 (#006: context 5.0万 → 15.1万).
4. QA members can't write the qa group handoff (`next-handoff` is denied by the classifier); the lead writes it when needed.
5. Low (verify-010): a dead headless member shows `finished`, not `gone` (by design).
