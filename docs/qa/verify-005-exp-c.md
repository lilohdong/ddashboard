# verify-005: experiment 001 method C (card task key), exp/c eece7ed

Env: exp-c worktree, DDASH_PORT=7359, temp DDASH_BOARD_DIR, Edge headless. Port 7357, installed copy, exp-a untouched.

| Item | Result |
|---|---|
| Diff read (stop-card, cards, lib, html, i18n) | no bug found |
| node test/team.test.js | 87/87 pass |
| Hook end to end (real stop-card.js): S1 v1 key=login-fix, S2 v2 same key | v1 archived, v2 active (across sessions) |
| Other key / no key / invalid key "Bad Key" | untouched; invalid key dropped, card kept |
| Browser (Edge headless, ko): key tag | `login-fix`, `other` tags shown; tooltip ko text; no tag on keyless card |
| Archive search (archived=only) | retired v1 appears, still has key |
| Stale card arriving late (older ts appended to jsonl) | archived itself, newer card stays (archived count 2) |

Not checked: en/zh tooltip in a real browser (covered by unit test only), member report/lead_missing (unit tests only), live-reload of a key card via the server watcher beyond the append above (worked).

Notes (not bugs): session `last_card` JSON keeps `key` only for dashboard cards; rules text is English-only (known judgment call).
