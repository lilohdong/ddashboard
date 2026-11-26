# verify-006: experiment 001 method B (exp/b, card task key)

Base dc9e3e7, head 96827ea (B2 02e8d39 + B1 96827ea). Worktree exp-b. Isolated server: DDASH_PORT=7360, temp DDASH_BOARD_DIR, headless Edge.

| Item | Result |
|---|---|
| `node test/team.test.js` (re-run on combined code) | PASS 83/83 |
| `node test/qa-dead-member.test.js` | PASS 7/7 |
| Valid key stored, malformed key ("Bad Key") dropped, card kept (live hook) | PASS |
| Same project+key replaces older board card across sessions; newest has key_prev (1 id); archived_count=1 | PASS |
| Browser: key tag rendered on keyed card with ko tooltip (`card.keyTitle`), none on keyless card | PASS |
| Member report to lead inbox carries no key (unit test) | PASS |
| **B1/B2 boundary bug: member card with lead_missing keeps its key** | **FAIL (still present)** |

## BUG: lead_missing member card keeps key and replaces other cards
`scripts/hooks/stop-card.js` deletes `stored.key` only inside `if (route.to === 'lead')`. `routeCard` (lib.js ~408) returns `{to:'board', lead_missing:true}` when the lead ended, so the key is kept and the card is not `via_lead`, i.e. it counts as a board card in cards.js.

Repro (live, port 7360): lead L1 card key=login, outside O1 card key=login (replaces L1's). Then end L1 and let member M1 (lead L1) post key=login -> stored with `"key":"login","lead_missing":true`; /api/state shows only M1's card with key_prev length 2, archived_count=2. The member card replaced the outside/lead card, breaking "no key on member report cards incl. lead_missing".

Fix: in stop-card.js delete the key whenever `route.role === 'member'` (covers lead_missing), e.g. `if (route.to === 'lead' || route.lead_missing) delete stored.key;` (put the delete after the lead_missing assignment). Add a test with the lead ended. No test covers this case now (the "member report" test only covers a live lead), which is why 83/83 passes.

Not checked: handoff/instruction-text test gaps noted in experiment-001.md.
