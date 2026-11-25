# verify-008: Track D (c5f4e43, dashboard served from scripts/web, dashboard.html deleted) — PASS

Env: servers from `git archive` of HEAD (new) and 698663d (old), `DDASH_PORT=7358`, temp `DDASH_BOARD_DIR`, headless Chrome + CDP. 7357 and the installed copy untouched; server and temp dirs removed.
Evidence: `docs/teams/skill-ddashboard/qa/notes/verify-008/` (screenshots, outputs, scripts).

| Case | Result |
|---|---|
| Light/dark screenshots, old vs new | PASS: same layout, text, colors (body bg identical in both schemes); only diff is "2분 전" vs "3분 전" (elapsed time). No JS errors |
| verify-007-repro-b.mjs (port 7358) | PASS: selection kept while new card arrives, card shows after clearing; key tag click lists only `fix` cards |
| +member form (lead-level and group-level) | PASS: opens, role focused, draft kept across polls, spawn body correct (lead, group, role, model, stay, task), closes and resets (spawn POST stubbed in page) |
| Group delete | PASS: panel opens, cancel keeps group, OK removes g2 (folder gone); group add by prompt works |
| Runner select | PASS: change saved (runner_member orca), select keeps value |
| Mode select | PASS: solo -> team led by beta (prompt name, projects.json updated), back to solo (confirm) clears teams |
| Archive / restore | PASS: archive hides card and count rises, archived view lists it, restore returns it |

Notes: my first old/new run was invalid (a leftover server held 7358, both starts hit EADDRINUSE); redone with PIDs checked. Server start logged "stopped an orphan wait command" for fixture pids (SOMEONE-ELSE, X3) that were not from my board; the BUG-005 sweep looks machine-wide, worth confirming it only kills this board's waits.
