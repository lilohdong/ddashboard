# M-1b notes: several teams per repo

Implementation of plan-0.3.0 section M-1b on `feature/team-mode`. Tests: `node test/team.test.js` (47/47 pass; six new `M-1b:` tests cover row 10).

## Data

- `projects.json[key].teams = { <name>: { lead, worktree, groups, created, handoff?, last_handoff? } }`. `p.mode` is kept in sync (`team` while any team exists) so older checks keep working. `lead`, `lead_name`, `groups`, `handoff` and `last_handoff` at project level are gone.
- Team names use the group name rules (letters, digits, `-`, `_`, up to 40). Free text is turned into a slug (`my team!` → `my-team`). No name → `team1`, `team2`, ...
- Sessions keep `kind: 'lead'` / `kind: 'member'` and `lead: <sid>`. A member's team is the team whose current lead is `s.lead`; nothing new is stored on sessions. `/api/state` adds `team_name` to lead and member sessions.

## Migration (`lib.readProjects`)

- Every reader of `projects.json` now goes through `readProjects()`. A project without `teams` is migrated and the file saved once.
- Old team project (`mode: team` + `lead`): one team named `teamSlug(lead_name) || 'team1'`. Worktree = git top level of the lead session's cwd (else derived from the first group dir, else `p.cwd`). Each `docs/groups/<g>/` moves to `docs/teams/<team>/<g>/` with `moveDir` (`git mv` when tracked, plain rename otherwise); the empty `docs/groups/` is removed. Group settings (`keep_handoffs`, brief stamps, ...) are kept.
- Old solo project: gets `teams: {}`; `mode` is left unset when it was unset (0.2.0 shape).
- Known loss: groups of a project that was switched back to solo before M-1b (no lead) are dropped from the settings. Their folders stay on disk.

## Behaviour

- `/ddashboard:dashboard team <name>` → `addTeam`: refuses a name in use and a session that already leads a team; other teams untouched.
- `/ddashboard:dashboard solo` in a lead session removes only its team. In a session that leads no team it changes nothing (it says so). Removing every team is the dashboard's `solo (remove all teams)` choice or `POST /api/mode {mode: solo}` without `team`.
- Members of a removed team become `outside` (cards go to the board). If the same lead later starts a team again, they come back under it.
- `performHandoff` moves only the old lead's team (lead sid only; name, worktree, groups stay) and refuses a new lead that already leads another team.
- Groups: `createGroup/renameGroup/deleteGroup(key, team, ...)`; archive path `docs/teams/<team>/_archived/`. Rename/delete only touch sessions of that team. `checkBriefs` reports to each team's own lead. Stop hook prunes only the member's own team group.
- Handoff numbering: `lib.reserveHandoff(dir)` creates `handoff-NNN.md` with `wx` and moves to the next number on `EEXIST`. Exposed as `team.js <sid> next-handoff` (member: own group; lead: `next-handoff <group>`). Member instructions now tell members to use it.
- API: `POST /api/mode {mode: team, lead, team}` adds (409 on a duplicate), `{mode: solo, team}` removes one (404 unknown), `{mode: solo}` removes all. `POST /api/groups` takes `team` (optional when the project has one team, 400 when it has several).
- Dashboard: project → team header (`team <name>` + `remove`) → lead → groups → members; `+ member` / `+ group` per team. The project's select shows `solo` / `team ×N`, offers `+ team · <session>` for live sessions that are neither leads nor members (asks for the team name, default `teamN`) and `solo (remove all teams)`.

## Open items

- The dashboard UI was not checked in a browser (the live server was not to be restarted). Logic is covered by the server tests and the i18n key test; a visual pass is still needed after install.
- Installed plugin not updated and live server not restarted, per instructions. On the first hook run after install, the live `projects.json` is migrated (current single team → one team named after `lead_name`).
- `docs/groups/` in this repo is an empty untracked folder; nothing to move.
