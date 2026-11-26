# verify-007: BUG-004 fix (82d947a) — PASS

Environment: isolated server from this worktree, `DDASH_PORT=7361`, temp `DDASH_BOARD_DIR`
(seeded: 7 cards, keys `fix`/`fix-2` in PK1, `fix` in PK2). Headless Chrome + CDP. Port 7357 and the installed copy untouched. Server stopped afterwards.
Evidence: `docs/teams/skill-ddashboard/qa/notes/verify-007-output.json`, scripts `bug-004-repro.mjs` and `verify-007-repro-b.mjs`.

| Case | Result |
|---|---|
| T1 selection kept across a 3.5 s poll | PASS: selection text unchanged, same DOM node, #cards re-rendered 0 times |
| T2 mouse drag held across a poll | PASS: selection kept while held, 0 re-renders |
| T3 Details scrollTop kept | PASS: details 100 -> 100, window 1026 -> 1026, same node |
| Select text, post a new card | PASS: after ~7.5 s (2+ polls) selection intact and new card NOT shown; after clearing the selection, the card appears within one poll |
| Key tag click (441fd44) | PASS: tags `fix|PK1`, `fix-2|PK1`, `fix|PK2`; clicking `fix`/PK1 lists only Card 1 and Card 2 (no `fix-2`, no PK2 card) |

Notes: aside scrollTop was 0 in the run (the aside was not scrollable with the seed), so the aside scroll case is untested. No bugs found.
