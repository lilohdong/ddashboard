# ddashboard architecture

Status: approved by the master 2026-11-26 (design and all §7 recommendations). Author: role `arch`, branch
`feature/team-mode`. Written against commit 95f4866 plus the
BUG-005 design in `docs/qa/bug-005-orphan-processes.md` (F-1..F-9), which is assumed to land first.

Contents: 1 current state · 2 problems · 3 target architecture · 4 state machines · 5 data model · 6 refactor plan ·
7 open questions.

---

## 1. Current state

### 1.1 Modules (≈5,000 lines, zero runtime dependencies, Node built-ins only)

| File | Lines | What it does today |
|---|---|---|
| `scripts/lib.js` | 1,513 | Everything shared: paths, JSON/JSONL I/O, git, project/session registry, transcript parsing + token usage, `bin/` shims, settings + language, **rules text** (solo/lead/member/outside) + version stamping, teams (add/remove/migrate), tag parsing, inbox (deliver/take/move), report formatting, waiter lock, **process table / kill / Claude pid**, handoff, groups (create/rename/delete/prune/briefs/handoff files), sidebar housekeeping (forget/markEnded/markGone/memberGone), lead context limit |
| `scripts/team.js` | 630 | Lead CLI (`spawn/send/list/end/show/handoff/group/next-handoff`) **and** the member services the server calls (`spawnMember`, `endMember`, `groupAction`), runner choice, `claude` command discovery, headless runs |
| `scripts/server.js` | 370 | HTTP server: one `if` chain of 13 routes, state assembly for `/api/state`, Orca terminal cache, gone detection (writes!), own `waiting()` |
| `scripts/cards.js` | 177 | In-memory card index (incremental tail read of JSONL), `replaces`/`key` retirement, archive overlay, search |
| `scripts/usage.js` | 89 | In-memory usage index (same tail-read approach) |
| `scripts/hooks/stop-card.js` | 210 | Card parsing (lenient JSON, fences), card routing (board vs lead), usage recording, group prune, brief check, lead context notice, inbox hand-over, session state write |
| `scripts/hooks/prompt-submit.js` | 104 | `/ddashboard:dashboard [team|solo|off]`, member/handoff tags, late registration, rules re-injection, `working` |
| `scripts/hooks/session-start.js` | 26 | Register + inject rules (deferred in team mode), remember model, record Claude pid |
| `scripts/hooks/session-end.js` | 7 | `setState(ended)` |
| `scripts/wait-inbox.js` | 100 | The waiter (`bin/wait.js`): polls the inbox, owner watch (BUG-005 F-1..F-3) |
| `scripts/control.js` | 48 | start/stop/status of the server (detached spawn) |
| `scripts/orca.js` | 103 | Orca CLI adapter (status, terminal create/show/send/close) |
| `scripts/terminal.js` | 104 | OS terminal window adapter (Windows `.cmd`, macOS osascript, Linux x-terminal-emulator) |
| `scripts/orca-launch.js` | 34 | Started inside a terminal: reads a spec file, runs interactive `claude`; records window pids |
| `scripts/i18n.js` | 461 | Dashboard strings en/ko/zh-CN (UMD: page global + CommonJS for tests) |
| `scripts/dashboard.html` | 964 | One file: 160 lines CSS, markup, ~770 lines of global-scope JS |
| `skills/dashboard/SKILL.md` | — | Skill text; falls back to `control.js start` |

### 1.2 Data under `~/.ddashboard` (`DDASH_BOARD_DIR`)

| Path | Format | Written by | Read by |
|---|---|---|---|
| `sessions.json` | `{sid: session}` | lib (15 call sites), team.js (5), stop-card (2), wait-inbox, orca-launch | everyone |
| `projects.json` | `{projectKey: {cwd,name,since,mode,mode_ver,teams,rules,spawn}}` | lib (11 sites, incl. **migration on read**) | everyone |
| `settings.json` | `{lang, ver}` | lib.saveSettings (server) | rules text, server |
| `models.json` | `{sid:{model,ts}}` capped 300 | session-start | lead context |
| `cards.jsonl` | 0.1.0 legacy, read-only | — | cards.js, team.js show |
| `cards/YYYY-MM.jsonl` | append-only cards | stop-card | cards.js, team.js `findCard` (own reader) |
| `archived.json` | `{cardId:{archived,ts}}` | server | cards.js |
| `replies.jsonl` | append-only replies, unbounded | server | server (last 1000) |
| `usage/YYYY-MM.jsonl` | per-turn usage | stop-card | usage.js |
| `inbox/<sid>/*.json` | pending messages | server (reply), lib.deliver (reports, orders, notices) | waiter, stop-card (`takeInbox`, atomic rename) |
| `inbox/<sid>/done/` | taken messages, never pruned | takeInbox | nobody |
| `inbox/<sid>/wait.lock`, `wait.info` | waiter pid / owner | wait-inbox | lib.waitPid, **server.waiting() (not owner-aware)** |
| `bin/wait.js`, `bin/team.js` | generated shims → current plugin | lib.ensureBin (on rules injection) | sessions (permission-stable paths) |
| `logs/<sid>.log`, `logs/*.json/.prompt.txt/.cmd` | runner logs and launch specs, never pruned | team.js | humans, orca-launch |
| `server.pid`, `server.log` | | server/control | hooks (`serverPid()` gates everything) |

Repo-side files: `docs/teams/<team>/lead-rules.md`, `docs/teams/<team>/<group>/{brief.md,handoff-NNN.md,notes/}`.

### 1.3 Processes

```
Claude (interactive, in a terminal / Orca / window)            Claude -p (headless member; detached from lead's team.js)
 ├─ hooks (sync, short): session-start, prompt-submit,           └─ same hooks, same waiter rules
 │   stop-card, session-end  → may spawn: git, powershell
 │   (processTable), tasklist, orca CLI
 │   └─ prompt-submit → control.start() → server.js (detached daemon, outlives everything; cwd = starter's worktree until F-6)
 └─ background Bash → bash ×3 → node bin/wait.js <sid>   (waiter; exits on message or owner death after F-1)
Lead's team.js (CLI, run via Bash) → claude -p | orca terminal create → cmd → node orca-launch.js → claude
                                    | cmd /c start → script.cmd → node orca-launch.js → claude
server.js → (in request path) team.spawnMember → orca CLI / spawn claude; endMember → taskkill / kill
```

### 1.4 Hook entry points (`hooks/hooks.json`)

SessionStart → `session-start.js`; UserPromptSubmit → `prompt-submit.js`; Stop → `stop-card.js`; SessionEnd →
`session-end.js`. All gate on `serverPid() && projectActive(cwd)` or on the session being registered.

### 1.5 HTTP API (127.0.0.1:7357, same-origin check on POST)

`GET /`, `GET /i18n.js`, `GET|POST /api/settings`, `GET /api/state[?reports=1]`, `GET /api/search`, `POST /api/archive`,
`/api/mode`, `/api/sessions/forget`, `/api/sessions/end`, `/api/team/end`, `/api/team/spawn`, `/api/groups`,
`/api/reply`. The dashboard polls `/api/state` every 3 s.

### 1.6 dashboard.html

`<style>` (L7-167) · static markup (sidebar, toolbar, search, cards) · `<script src=/i18n.js>` · one inline script:
UI store (localStorage), global mutable state (`scope, filter, showEnded, spawnFor, drafts, results, overrides…`),
render functions returning HTML strings (`renderSide`, `cardHtml`, `renderMain`, `renderCards` with scroll keeping),
actions (`sideAction` ~150 lines of delegated click handling, `submitSpawn`, reply), search, poll loop with
selection/pointer guards (BUG-004).

---

## 2. Problems

1. **lib.js is a god module.** 12 unrelated concerns; every change in any area touches it, so parallel work
   conflicts there (proc vs dev today). 140 exported names.
2. **Unsafe concurrent writes (lost updates).** `writeJson` is atomic per write (tmp + rename) but every writer does
   read-modify-write of the whole file with no lock. Up to ~6 processes write `sessions.json` concurrently (hooks of
   N sessions, N waiters, team.js, server, orca-launch). Worst case: `stop-card.js` reads `sessions.json` at start,
   then runs git, parses a 4 MB transcript tail, prunes groups, checks briefs (git), and writes the whole map at the
   end — clobbering anything written meanwhile (a spawn's pre-registration, `markGone`, a waiter's `working`, another
   session's state). On Windows `renameSync` over a file another process has open can fail with EPERM/EBUSY and is
   not retried.
3. **Implicit session state machine.** State = `state` (`working|idle|ended`) + `ended` + `end_reason` +
   `replaced_by` + `pending` + `headless`/`pid` + waiter files. Transitions are written ad hoc in ~12 places
   (`registerSession` revives ended sessions, `setState`, `markGone`, `markEnded`, `endMember`, `performHandoff`,
   `cmdSend`/`sendOrca`/`resumeWindow` resume, wait-inbox, stop-card). Display states are derived in two places with
   different rules (`server` view: ended/working/waiting/idle/unresponsive; `team.js list`: + `finished`).
4. **Duplicated logic.** `server.waiting()` duplicates `lib.waitPid` without the owner check (an orphan waiter still
   shows "waiting" on the dashboard after F-3). Pending-count in server and team.js. Gone detection in server and
   `team list`. Ended check inline (`s.ended || s.state === 'ended'`) vs `isEnded`. Three id generators. Rules
   version stamping in `injectRules`, `memberStart`, `rulesUpdate`. Card file reading in cards.js and team.js.
   `git` vs `gitIn`. `/api/reply` builds an inbox message by hand instead of `deliver`.
5. **Side effects on reads.** `GET /api/state` marks sessions gone (writes `sessions.json`); `readProjects()` migrates
   and writes; `injectRules` writes the session; `ensureWaitBin` writes files while building rules text.
6. **Blocking server.** Synchronous `execFileSync` in request handlers (Orca CLI up to 15 s in spawn/end, `taskkill`,
   powershell process table ~0.4 s, git in `readProjects` migration) stalls every request including the poll.
7. **Entry points import each other.** `server.js` requires `team.js` (a CLI); `orca-launch.js` requires `team.js`.
   Business logic lives in hooks (`stop-card.js` parses cards and decides routing), so it is only testable end to end.
8. **No process ownership model.** Long-lived processes (server, waiters, headless runs, terminals) are tracked by
   bare pids in different fields (`claude_pid`, `pid`, `window_shell_pid`, `window_launch_pid`, `wait.lock`), with
   per-call-site pid-reuse checks. BUG-005 adds owner watch + sweep; nothing central guarantees it.
9. **Card lifecycle is implicit and incomplete.** `replaces`, `key`, archive and age rules live in the index;
   `answered` lives in the browser; a `wip` card never resolves: after the work finishes or the session dies it stays
   "wip" forever (the motivation for the approved rule in §4.2).
10. **No schema versions.** Migrations are ad hoc (`migrateProject` on read, legacy `cards.jsonl`, 0.1.0 waiters);
    several plugin versions run against the same board at once (old sessions keep their plugin path).
11. **Unbounded growth:** `replies.jsonl`, `inbox/*/done/`, `logs/`, `archived.json`.
12. **Silent failure.** ~60 empty `catch {}`; when something fails there is no trace (hooks must not fail Claude, but
    they can log).
13. **Config scattered.** 19 `DDASH_*` env vars read in 8 files at module load; per-project config in
    `projects.json`; user config in `settings.json`.
14. **Front end is one 964-line file** with global mutable state; render logic cannot be unit-tested.

---

## 3. Target architecture

### 3.1 Principles

- **Zero runtime dependencies** stays. Everything needed (locks, process tables, HTTP, ES modules) is doable with
  Node built-ins; a dependency would have to be vendored into the plugin cache anyway.
- **Pure core, thin edges.** State transitions, card lifecycle, rules text, routing are pure functions over plain
  objects. Files and processes are touched only by the store and the supervisor. Hooks, CLI, HTTP are adapters.
- **Every write goes through one store with a lock.** No module calls `fs.writeFileSync` on board files directly.
- **Entry file paths stay stable** (`hooks.json`, `bin/` shims, skill text and old shims reference them):
  `scripts/hooks/*.js`, `scripts/wait-inbox.js`, `scripts/team.js`, `scripts/control.js`, `scripts/server.js`,
  `scripts/orca-launch.js` remain, but shrink to a few lines each.
- **Backward compatible on disk**: additive fields only, so an older plugin version running in an old session keeps
  working (§5).

### 3.2 Layers and modules

```
L4 entry      hooks/*.js   team.js (cli)   control.js   wait-inbox.js   orca-launch.js   server.js   web/*
                 │             │               │             │               │              │
L3 app        app/hooks.js  app/members.js  app/handoff.js  app/groups.js  app/server-state.js  http/routes/*.js
              (use cases: one function per user-visible action; orchestrate store + domain + supervisor)
                 │
L2 domain     domain/session.js  domain/card.js  domain/team.js  domain/rules.js  domain/messages.js
  (pure)      domain/usage.js  domain/transcript.js  domain/lead-context.js  domain/tags.js
                 │
L1 infra      store/{index,sessions,projects,settings,cards,usage,inbox,replies,archived,models,meta,migrate}.js
              proc/{table,identity,kill,supervisor,waiter}.js   runners/{headless,orca,window}.js
              core/{config,fsx,lock,git,log,ids,paths}.js
```

Dependency rules (checked by `test/layers.test.js`, which parses `require()` calls):

- A module may require only its own layer or lower layers. `domain/*` requires nothing but other `domain/*` and
  `core/config` (values, not I/O). No `fs`, `child_process`, `http` in `domain/`.
- No entry point requires another entry point (server must not require `team.js`; `orca-launch` must not either:
  `claudeCommand`/`interactiveArgs` move to `runners/claude-cmd.js`).
- Only `store/*` writes board files; only `proc/*` and `runners/*` spawn or kill processes.
- `web/*` talks to the server only through `/api/*`.

### 3.3 Module responsibilities

**core/**
- `config.js`: the only reader of `process.env.DDASH_*` (table of name, default, parser, doc); `envNum` lives here.
  Read lazily (tests change env between cases).
- `paths.js`: board paths (today's `paths`), `safeId`.
- `fsx.js`: `readJson`, `atomicWrite` (tmp + rename, retry EPERM/EBUSY/EACCES 10× with 20-50 ms backoff on
  Windows), `appendJsonl`, `readJsonl`, `readTail`, `ensureDir`.
- `lock.js`: `withLock(name, fn)`: `fs.openSync(locks/<name>.lock, 'wx')` holding `{pid, ts}`; retry every 10-30 ms
  (jittered, `Atomics.wait` for sync callers); a lock whose pid is dead or older than 10 s is broken. Wait at most
  5 s, then break it and log (hooks must never hang Claude). Critical sections are read-modify-write only: no git,
  no transcript parsing, no process calls inside a lock.
- `git.js` (one `git(args, cwd)` via `execFileSync`), `ids.js` (one `newId()`), `log.js` (append to
  `logs/ddashboard.log`, size-capped; `bestEffort(label, fn)` replaces empty catches).

**store/** (owns every board file; each file module exports `read()`, `update(fn)`, and narrow helpers)
- `sessions.js`: `get(sid)`, `all()`, `update(fn)`, `patch(sid, fields)` — patch is what hooks use, so a slow hook
  never writes fields it did not change.
- `projects.js`, `settings.js`, `models.js`, `archived.js`: same pattern.
- `cards.js`: `append(card)` + the incremental index (today's cards.js minus lifecycle rules, which move to
  `domain/card.js`); `findById` replaces team.js's own reader.
- `usage.js`: append + index. `replies.js`: append, `recent(n)`.
- `inbox.js`: `deliver`, `take` (atomic rename, unchanged protocol), `move`, `pendingCount`, `prune(done older than
  7 days)`, waiter files (`wait.lock`/`wait.info` read/remove) — the inbox protocol stays file based because the
  waiter and the Stop hook have no connection to the server.
- `meta.js` + `migrate.js`: board schema version and ordered migrations (§5).

**proc/**
- `table.js`: `processTable()` sync and `processTableAsync()` (server); `alive`, `processName`, `findClaudePid`,
  `isClaudeProcess`.
- `identity.js`: a remembered process is `{pid, name, started}` (creation time from the same CIM/`ps -o lstart`
  query); `same(identity, table)` is the single pid-reuse check used everywhere.
- `kill.js`: `killTree(identity, table)` incl. dead-root descendants (F-7) and POSIX TERM→KILL escalation.
- `supervisor.js`: the owner of process lifecycle (§3.4). `waiter.js`: the waiter loop (today's wait-inbox body).

**runners/**: `headless.js` (`claude -p`, detached, `cwd` = worktree), `orca.js` (today's adapter, plus async
variants), `window.js` (today's terminal.js), `claude-cmd.js` (command discovery, args). All return a process
identity or terminal handle recorded on the session as `proc: {...}` (§5.2).

**domain/**
- `session.js`: state machine (§4.1): `transition(s, event, ctx) -> {s, effects}`; `view(s, live)` derives the
  displayed state (one function for dashboard and `team list`).
- `card.js`: `parseCard(text)` (today in stop-card), normalisation (`key`), and `lifecycle(cards, sessions)`
  computing replaced/folded/stopped/archived/answered (§4.2).
- `team.js`: roles (`teamRole`), `routeCard`, team/member lookup, name rules, `migrateProject` logic (pure part).
- `rules.js`: all injected texts (solo, lead, member, outside, group context, handoff notes, replaced notice, lead
  context notice) + `stamp(s, p, settings)` / `needsUpdate(s, p, settings)` — the single place that knows
  `rules_ver`/`lang_ver`/`text_ver`. `RULES_TEXT_VER` bump is enforced by a snapshot test of the texts.
- `messages.js` (format replies/reports/orders), `tags.js` (`parseTag`), `transcript.js` + `usage.js` (turn usage),
  `lead-context.js` (limit maths).

**app/** (use cases; the only layer that combines store + domain + supervisor)
- `hooks.js`: `onSessionStart(input)`, `onPrompt(input)`, `onStop(input)`, `onSessionEnd(input)` → `{stdout}`.
  `onStop` order: compute everything outside the lock (parse transcript, card, usage, git), then one
  `sessions.patch` and one `cards.append`, then `inbox.take`.
- `members.js` (spawn/send/end/list), `handoff.js`, `groups.js`, `dashboard.js` (mode switch, forget, mark ended,
  reply, archive, settings), `server-state.js` (builds `/api/state` from store + supervisor snapshot; read-only).

**http/**: `router.js` (table of `{method, path, sameOrigin, body, handler}`; JSON body ≤ 64 KB; errors →
`{error, code}`), `routes/*.js` one per resource, each 5-20 lines calling `app/*`. Async handlers; anything that
spawns or kills processes is awaited off the request path (`child_process.execFile`, not `execFileSync`).
`GET /api/state` performs **no writes**. Static files: whitelist (`/`, `/i18n.js`, `/web/*.mjs`, `/web/style.css`).

**web/** (no build step): `index.html` (markup only), `style.css`, `i18n.js` (unchanged UMD), and ES modules with the
`.mjs` extension (served as `text/javascript`; importable from the CommonJS tests via `import()`):
`main.mjs` (boot, poll loop, selection guards), `api.mjs` (fetch wrappers), `ui-state.mjs` (one state object +
localStorage), `render-side.mjs`, `render-cards.mjs`, `render-search.mjs` (pure: `(state, ui, t) -> html`),
`actions.mjs` (event delegation), `dom.mjs` (`setHtml`, scroll keeping, `esc`). Pure render modules get unit tests.

### 3.4 Process supervisor (no orphans)

Guarantees: (G1) a waiter never outlives its owner Claude process; (G2) no long-lived plugin process keeps a worktree
as cwd; (G3) every session entering `ended` has its waiter stopped; (G4) any orphan from any plugin version is found
and killed within 60 s while the server runs; (G5) nothing is killed unless its identity (pid + name + start time,
or cmdline matching our wait command) is verified.

- **Waiter** (F-1..F-3): owner watch, `chdir(home)`, `wait.info`. Owner identity uses `proc/identity`.
- **Server**: `control.start` spawns with `cwd: os.homedir()`; server `chdir`s too (F-6). One server per board:
  the pid file plus `listen` failure on the port.
- **Supervisor tick in the server** (async, every 10 s for liveness, 60 s for the full sweep):
  1. async process table snapshot (shared by all checks in the tick);
  2. for each non-ended session: `domain/session.liveness(s, table, terminals)` → `gone` events applied through
     the state machine (moves gone detection out of `GET /api/state`, covers all kinds: F-9);
  3. sweep (F-5): wait commands of any plugin version without a live Claude ancestor → killed with their bash chain;
     stale `wait.lock`/`wait.info` removed;
  4. Orca terminal states refreshed in the background (today's cache).
- **Without a server** (server stopped, sessions still running): the waiter's owner watch still holds G1; hooks apply
  `stopWaiter` on SessionEnd; the sweep runs at next server start.
- `supervisor.stop(sid, reason)` is the only "end" effect handler: stop waiter, then (for `stopped`/`handoff`) kill
  the Claude tree / headless run / window shell / Orca terminal — identities from `s.proc`.

### 3.5 Error handling

- Hooks: `runHook(fn)` wrapper — never throws, always exit 0, prints nothing on error, logs the stack with the hook
  name and session id. Output contract per hook tested.
- Store: lock timeout → broken lock + log entry; corrupt JSON → keep the file as `<name>.corrupt-<ts>` and start from
  the last good backup (`<name>.bak`, written every N minutes by the server) rather than `{}` (today a corrupt
  `sessions.json` silently becomes empty and the next write erases everything).
- HTTP: `{error: message, code: 'session_active' | 'not_found' | ...}`; the dashboard translates `code` via i18n.
- CLI: non-zero exit with one-line message; stack only with `DDASH_DEBUG=1`.
- `bestEffort(label, fn)` for genuinely optional work (prune, brief check, usage): logs, never throws.

### 3.6 i18n

- Dashboard: `i18n.js` as today (en/ko/zh-CN, English fallback, test that every key exists in en).
- Cards: language of new cards via `settings.lang` in the rules text (as today).
- Model-facing text (rules, notices, CLI output read by Claude) stays English on purpose: it is instructions, and
  English is the most token-efficient and reliable.
- Server errors: stable `code` + English `error`; the page shows `t('err.' + code)` when the key exists.

### 3.7 Configuration

Three sources, one reader each: `core/config` (env, process-wide, for tests and power users), `store/settings`
(user choices from the dashboard: language), `store/projects` (per project: runners, team rules). Precedence for
anything that exists in two places: env > settings/projects > default. `docs/configuration.md` is generated from
the config table (test asserts every `DDASH_*` used in code is in the table).

---

## 4. State machines

### 4.1 Session lifecycle

Persisted phase: `pending | working | idle | ended` (`ended` carries `end_reason`). Derived (never stored):
`waiting` (waiter alive and its owner alive), `unresponsive` (idle, no waiter, not seen for `STALE_MIN`),
`finished` (headless, pid exited, not ended). `forgotten` = record deleted.

```
                 spawn (team.js / dashboard)
        ┌──────────────────────────────────► pending ──── first hook (SessionStart/prompt) ───┐
        │                                       │ spawn failed (forced runner)                 │
        │                                       ▼                                              ▼
  register (SessionStart / prompt / /dashboard)  (deleted)                                  working
        │                                                                                  │  ▲
        └────────────────────────────────────────────────────────────────────────► idle ◄─┘  │
                                      Stop hook, inbox empty, no notice                  │    │
                                                                                          │    │ prompt submitted
            Stop hook with inbox messages or lead notice: stays working                   └────┤ waiter delivers
                                                                                               │ team send (typed / queued)
 any non-ended ──SessionEnd──────────────► ended(exit)                                         │
 any non-ended ──supervisor: owner dead──► ended(gone)      ─┐                                 │
 any non-ended ──team end / dashboard end► ended(stopped)    ├── resume (team send, claude ────┘
 idle+stale or gone ──user "mark ended"──► ended(marked)    ─┘   --resume → SessionStart)
 lead ──handoff──────────────────────────► ended(handoff)   ── terminal: replaced_by set, never revived;
                                                               its prompts and Stop are blocked with a notice
 ended (any reason) ──forget──────────────► forgotten (record deleted; cards and usage stay)
```

Rules: every transition goes through `domain/session.transition`, which returns effects; `app/*` applies them
(store patch + `supervisor.stop` on entry to `ended`, `inbox.prune` on forget). Illegal events are ignored and
logged (e.g. `prompt` on `ended(handoff)` → block notice; `forget` on a non-ended session → 409 `not_ended`).
`mark ended` guard: `idle && !waiting && stale`, or liveness says gone. Headless: process exit without SessionEnd
is `finished` (resumable), not `gone`.

### 4.2 Card lifecycle

A card is immutable once appended. Its displayed lifecycle is computed by `domain/card.lifecycle` from the card log
and the sessions map on every index refresh (nothing extra is written, so older readers are unaffected).

```
                       posted (status wip | review | blocked | done)
                                    │
             ┌──────────────────────┼─────────────────────────────────────┐
         status = wip            status = review/blocked             status = done
             │                      │                                     │
           open ◄─ resume ─┐     active ── user replied ──► answered    active
             │             │        │                                     │
 newer card from the       │        │                                     │
 same session (any status) │        │                                     │
             ▼             │        │                                     │
   folded under the newer  │        │                                     │
   card; outcome = newer   │        │                                     │
   card's (final) status   │        │                                     │
             │             │        │                                     │
 session ended, no newer   │        │                                     │
 card ──► stopped ─────────┘ (a newer card after a resume folds it like any open wip card)
             
 any card ── "replaces":"last" / newer card with same project+key ──► replaced (archived, kept in key history)
 any card ── user archive ──► archived ── user unarchive ──► previous state   (explicit choice wins over all rules)
 any card ── older than RECENT_DAYS ──► archived
```

Approved folding rule, precisely:
- Per session, the **open set** = its `wip` cards not yet folded. When the session posts a newer card C (any status,
  including another `wip`), every card in the open set folds under C (`folded_into = C.id`) and takes C's outcome.
  The open set becomes `{C}` if C is `wip`, else empty. Chains collapse: if C is later folded under D, all of them
  show D's outcome and render under D.
- When the session is `ended` and its open set is non-empty, those cards show **stopped** (outcome `stopped`). A
  forgotten session (no record) counts as ended. If the session is resumed and posts again, they fold as usual.
- Folded cards are not top-level in the active list; the newer card shows "N earlier progress cards" (expandable).
  Search still finds them (`folded_into` set). They do not count as `archived`.
- Precedence: explicit archive/unarchive > `replaces`/`key` > folding > stopped > age. A keyed `wip` card replaced
  by a same-key card from another session (e.g. after a lead handoff) is `replaced`, not `stopped`.
- Member reports (`via_lead`) follow the same rule among the member's own cards (visible with `?reports=1`).
- `needs you` (urgent) uses the effective outcome: a `wip` folded into a `review` card is not urgent by itself; the
  `review` card is.

---

## 5. Data model

### 5.1 Versioning and migration

- `~/.ddashboard/meta.json` = `{schema: <int>, migrated: [{to, by_version, ts}]}`. Missing = schema 1 (0.2.x).
- Migrations live in `store/migrate.js` as an ordered list `{to, run(board)}`; each is idempotent and runs under the
  global lock at server start (and lazily by the store when a hook finds `schema` lower than the code's). Before a
  migration the affected files are copied to `<file>.bak-s<N>`.
- **Compatibility rule:** a migration may add fields or files, never rename/remove fields that a released version
  reads, never change a file's top-level shape. Old plugins keep running in old sessions; their read-modify-write
  spreads unknown fields back (verified pattern in today's code), so additive fields survive. Removal of a legacy
  field happens only two minor versions after its replacement shipped.
- Existing ad hoc migrations move here: `migrateProject` (pre-M-1b teams), legacy `cards.jsonl` read path, 0.1.0
  waiter sweep.

### 5.2 Records (target; **bold** = new, all additive)

`sessions.json[sid]`:
`session_id, name, cwd, branch, project, project_key, kind (lead|member|—), role, lead, group, stay, former_lead,
state (pending|working|idle|ended), end_reason (exit|gone|stopped|marked|handoff), started, last_seen, ended,
replaced_by, handoff_from, handoff_doc, runner (headless|orca|window), headless, spawn{…}, log, usage{…},
last_context, usage_mark, last_card*, rules_ver, lang_ver, text_ver, start_rules, lead_* context fields,
claude_pid (kept for old readers), **proc: {claude: identity, run: identity, window_shell: identity, orca: {handle}}**,
**v** (record schema)`. `pending: true` is replaced by `state: 'pending'` with the flag still written for old
readers until the removal window passes.

`projects.json[key]`: `cwd, name, since, mode, mode_ver, rules{peer_talk, qa_direct}, spawn{runner_lead,
runner_member, permission_mode, allowed_tools}, teams{name: {lead, worktree, created, handoff, last_handoff,
groups{g: {dir, created, keep_handoffs, notes_days, brief_*}}}}`.

Cards (`cards/YYYY-MM.jsonl`): `id, ts, session_id, session_name, project, project_key, branch, diffstat, status,
title, summary[], review[], details, replaces, key, via_lead, lead_missing`, **`v`**. Lifecycle fields
(`folded_into, outcome, stopped, replaced, archived, answered, key_prev`) are computed, never stored.

Inbox message: `id, ts, type (reply|report|order), session_id, from, role, text | card fields, card_id, card_title`.

Retention (server, daily): `inbox/*/done` > 7 days, `logs/` > 30 days or 50 MB, `replies.jsonl` rotated monthly like
cards (`replies/YYYY-MM.jsonl`, schema 2 migration), `archived.json` entries for cards older than the oldest card file.

**As built (step 13).** Schema 2 copies `replies.jsonl` into `replies/YYYY-MM.jsonl` and leaves `replies.jsonl` in
place, read-only (like the 0.1.0 `cards.jsonl`), so a 0.2.x server still sees the old replies; lines an old server
appends later are merged by id on read and copied over by the retention job. The projects migration (0.2.x and
pre-M-1b projects without `teams`) stays shape-driven on every read (`store/migrate.projects`; transform in
`domain/team.migrateProject`, file/git work in `app/teams`), because an old plugin can write that shape again.
Retention drops `archived.json` entries whose card is in no card file (card files are never deleted, so this only
removes entries of cards that are gone). `store/retention.js`, config `DDASH_RETAIN_DONE_DAYS`, `DDASH_RETAIN_LOG_DAYS`,
`DDASH_RETAIN_LOG_MB`; runs 5 s after server start and every 24 h.

---

## 6. Refactor plan

Each step is one commit (or a short series), behaviour-preserving unless stated, and must keep green:
`node test/team.test.js`, `node test/qa-dead-member.test.js`, `node test/orphans.test.js` (and every test file added
on the way). Step 0 adds `node test/run.js` that runs all `test/*.test.js`. While a step moves code out of `lib.js`,
`lib.js` re-exports it, so callers and tests keep working until the last step.

| # | Step | Touches | Tests to add |
|---|---|---|---|
| 0 | Prerequisite: BUG-005 phase 2 (proc) lands. Add `test/run.js`. Replace `server.waiting()` with `lib.waitPid` (owner-aware; one line) | server.js | `/api/state` view is not `waiting` with an orphan waiter |
| 1 | `core/config`, `core/paths`, `core/fsx` (incl. Windows rename retry), `core/ids`, `core/git`, `core/log`; lib re-exports | lib.js, new core/* | config table covers every `DDASH_*` in code; atomicWrite retries on EPERM (fault-injected fs) |
| 2 | `core/lock` + `store/sessions`, `store/projects` with `update`/`patch`; convert all writers (lib, team.js, stop-card, wait-inbox, orca-launch). stop-card writes via `patch` of its own fields only | lib.js, team.js, hooks, wait-inbox, orca-launch | `test/store.test.js`: 8 child processes × 50 patches of different fields → no field lost; stale lock (dead pid) broken; lock timeout breaks and logs |
| 3 | `proc/table|identity|kill` out of lib (async table added); `layers.test.js` introduced (warn-only until step 13) | lib.js | identity rejects reused pid; async table equals sync table shape |
| 4 | `domain/session.js` state machine + `view()`; route every state write through it (setState, markGone, markEnded, endMember, performHandoff, resume paths, registerSession) | lib.js, team.js, server.js, hooks | `test/session.test.js`: table-driven transitions incl. illegal ones; `view()` parity with old server/list output |
| 5 | `proc/supervisor.js`: `stop(sid, reason)`, liveness tick + sweep in server; `GET /api/state` becomes read-only | server.js, lib.js | `/api/state` leaves `sessions.json` mtime unchanged; tick marks gone within 1 tick (fake table) |
| 6 | `domain/card.js` (parseCard from stop-card + lifecycle), cards index uses it; **folding + stopped rule**; dashboard renders folded cards and outcome | stop-card, cards.js, dashboard.html, i18n.js | `test/cards.test.js`: wip→done folds; wip→wip→review chain; ended → stopped; resume after stopped folds; key replacement beats stopped; archive override; urgency uses outcome; parseCard fixtures moved from hook tests |
| 7 | `domain/rules.js` + single `stamp/needsUpdate`; injectRules/memberStart/rulesUpdate/pendingRules use it; ensureBin moved to app layer | lib.js | snapshot hash of every rules text → failing test reminds to bump `RULES_TEXT_VER` |
| 8 | `domain/team.js`, `domain/tags.js`, `domain/messages.js`, `domain/lead-context.js`, `app/handoff.js`, `app/groups.js` out of lib | lib.js | existing tests; group/handoff tests move to `test/groups.test.js` |
| 9 | `runners/*` (orca.js, terminal.js, headless, claude-cmd) + `app/members.js`; `team.js` becomes a CLI only; server and orca-launch stop requiring team.js | team.js, orca.js, terminal.js, orca-launch, server.js | layer test: no entry point requires another |
| 10 | Hooks thin: `app/hooks.js`; each hook file = `runHook(app.onX)` | hooks/*, new app/hooks.js | unit tests of `onStop` with fixture transcripts (no child process); hook error → exit 0 + log line |
| 11 | `http/router.js` + `routes/*`, async process work (worker thread: `http/jobs.js`), error codes | server.js | router table test (every route, same-origin enforced on POST); slow fake orca does not block `/api/state` during spawn |
| 12 | Front end split into `web/` (.mjs modules, style.css, index.html); server static whitelist | dashboard.html → web/*, server static route | `test/web.test.js`: `import()` render modules, render fixtures (card folded, urgent, ended); server serves every module with JS MIME; BUG-004 repro script still passes |
| 13 | `store/meta` + `store/migrate` (move migrateProject, legacy cards); retention job; `replies/` rotation (schema 2); layer test strict; delete `lib.js` façade | lib.js (deleted), store/* | migration idempotence; old-shape fixtures (0.1.0, 0.2.0, pre-M-1b) load; an "old writer" fixture (whole-file rewrite without new fields' knowledge) keeps new fields |

**Parallelisation.** Steps 0-3 are sequential (they move the foundations out of `lib.js` and every later step
depends on them); one member. After step 3, three tracks can run at once without file conflicts if each track
extracts its own section of `lib.js` in a single small commit, rebased promptly (lib.js is the only shared file, and
it only shrinks):

- Track A — cards: step 6 (`domain/card.js`, `cards.js`, card part of stop-card, card rendering), then step 7.
- Track B — lifecycle: steps 4 → 5 (`domain/session.js`, `proc/supervisor.js`, server state), then 10.
- Track C — team: steps 8 → 9 (`domain/team.js`, `app/members|handoff|groups.js`, runners, team.js).
- Track D — front end: step 12 can start right after step 0 **if** track A does its dashboard part after D lands
  (or A ships the folding UI inside D's new `render-cards.mjs`). Recommended: D before A's UI sub-step.
- Step 11 (router) after B and C; step 13 last.

Conflict rules: new tests go to new files (`test/<area>.test.js`), never into `team.test.js` (only fixture-helper
extraction to `test/helpers.js` in step 0). `stop-card.js` is touched by A (card part) and B (state patch): B goes
first in that file, or A only replaces the `parseCard` call. i18n.js additions: one block per track at the end of
each language table.

### 6.1 Track briefs (after step 3)

Common to every track: start from the commit that finishes step 3; keep `node test/run.js` green on every commit;
move code out of `lib.js` in one small commit per section and leave a re-export; add tests only in the track's own
test file; follow the layer rules in §3.2 (`test/layers.test.js` warns). Shared files and their owner for edits:
`lib.js` (everyone may only *remove* their own section), `i18n.js` (append your keys at the end of each language),
`stop-card.js` (B first, then A), `dashboard.html` / `web/*` (D, then A's card UI).

**Track A — cards** (steps 6, 7; on the 0.3.0 path)
- Owns: `scripts/domain/card.js`, `scripts/cards.js` (→ `store/cards.js` + lifecycle use), `scripts/domain/rules.js`,
  card parsing in `scripts/hooks/stop-card.js`, `web/render-cards.mjs` (after D) or the card part of
  `dashboard.html` (if D has not landed).
- Tests: `test/cards.test.js` (all §4.2 cases: wip→done fold, wip→wip→review chain, ended → stopped, resume after
  stopped, key beats stopped, archive override, urgency uses outcome, parseCard fixtures), `test/rules.test.js`
  (text snapshot hash ⇒ `RULES_TEXT_VER` bump).
- Done when: the §4.2 rules hold in `/api/state` and `/api/search` (`folded_into`, `outcome`, `stopped` computed,
  never stored); the dashboard shows folded cards under the newer card and stopped wip cards; nothing new written to
  card files; rules texts live only in `domain/rules.js`, version stamping in one function.

**Track B — lifecycle** (steps 4, 5, 10; on the 0.3.0 path)
- Owns: `scripts/domain/session.js`, `scripts/proc/supervisor.js`, `scripts/app/server-state.js`, `scripts/app/hooks.js`,
  the state/gone parts of `scripts/server.js`, `scripts/hooks/*.js` (state writes; card part stays A's).
- Tests: `test/session.test.js` (table-driven transitions incl. illegal events; `view()` parity with old
  server/`team list` output), `test/supervisor.test.js` (fake process table: gone within one tick, sweep of any
  plugin version, identity check before kill), `/api/state` leaves `sessions.json` mtime unchanged, `test/hooks.test.js`
  (`onStop` with fixture transcripts, hook error → exit 0 + log line).
- Done when: every write of `state`/`ended`/`end_reason` goes through `transition()`; entering `ended` always calls
  `supervisor.stop`; `GET /api/state` is read-only; gone detection covers solo/lead/outside/member; hook files are
  ≤ 15 lines each.

**Track C — team** (steps 8, 9)
- Owns: `scripts/domain/{team,tags,messages,lead-context}.js`, `scripts/app/{members,handoff,groups}.js`,
  `scripts/runners/*` (from `orca.js`, `terminal.js`, headless and claude-command code in `team.js`), `scripts/team.js`,
  `scripts/orca-launch.js`, the team/group routes' calls in `server.js`.
- Tests: `test/groups.test.js` (group and handoff tests moved out of `team.test.js` unchanged), `test/members.test.js`
  (spawn/send/end per runner through `app/members.js` with the fake orca/window launchers), layer test: no entry point
  requires another.
- Done when: `team.js` is a CLI only (argument parsing + printing); `server.js` and `orca-launch.js` do not require
  `team.js`; all team/group/handoff code is out of `lib.js`; process kills go through `supervisor.stop` (B's API; if
  B is not done yet, call the step-3 `proc/kill` and leave a TODO for B).

**Track D — front end** (step 12; may start right after step 0)
- Owns: `scripts/web/*` (new), `scripts/dashboard.html` (deleted at the end), the static-file route in `server.js`.
- Tests: `test/web.test.js` (`import()` each pure render module, fixtures: folded card, urgent, ended session,
  search results), server serves `/`, `/i18n.js`, every `/web/*.mjs` and `/web/style.css` with the right MIME and
  nothing outside the whitelist; the BUG-004 repro (`docs/teams/skill-ddashboard/qa/notes/verify-007-repro-b.mjs`)
  still passes.
- Done when: no inline script left; render modules are pure (`(state, ui, t) -> html`), no global mutable state
  outside `ui-state.mjs`; the dashboard looks and behaves the same (light and dark screenshots compared by hand).

Steps 11 (router) and 13 (schema/migrations, delete `lib.js`) are assigned after B and C are done.

---

## 7. Decisions (were: open questions for the master)

**Decided 2026-11-26: the master accepted every recommendation below.** They are binding for the refactor; the
question text is kept for the record.

1. **Folding scope.** Should a newer card fold *all* older open `wip` cards of the session, or only those with the
   same `key` when keys are used? — *Recommend all of the session's open wip cards (as approved); keys keep their own
   cross-session replacement.*
2. **`stopped` after a handoff.** When a lead hands off, its open `wip` cards would show `stopped`. — *Recommend:
   yes, unless the new lead posts a card with the same `key` (then `replaced`). Leads should use keys for ongoing
   tasks; the rules text already says so.*
3. **One `sessions.json` with a lock vs one file per session** (`sessions/<sid>.json`, no contention). — *Recommend
   the lock now (backward compatible, small); revisit per-session files only if lock waits show up in the log.*
4. **Concurrent plugin versions.** Old sessions run old hooks that write without the lock. — *Recommend accepting
   that (additive schema keeps them correct except for the race itself) and telling users in the release note to
   restart long-running sessions after upgrading.*
5. **Node version.** Code already needs Node ≥ 16.9 (`Object.hasOwn`); ES modules and `Atomics.wait` are fine there.
   — *Recommend declaring Node ≥ 18 in README and checking it in `control.start`.*
6. **Front end without a build step** (native `.mjs` modules, no framework). — *Recommend yes; the page is small
   enough, and a build step would add a dev dependency and a generated artefact to the plugin.*
7. **Gone detection latency.** Moving it from `GET /api/state` to a 10 s server tick delays "gone" by up to 10 s, and
   without a server nothing marks sessions gone. — *Recommend accepting; the waiter still exits by itself.*
8. **Retention defaults** (done/ 7 d, logs 30 d/50 MB, replies rotated monthly). — *Recommend these; make them
   config entries.*
9. **Process identity with start time** (one more field from the same process-table query). — *Recommend yes; it
   replaces the ad hoc `processName`/`windowShell` checks and the 60 s re-check in the waiter.*
10. **Release slicing.** Steps 0-5 + 6 (card rule) fit 0.3.0; 7-13 could be 0.3.x without user-visible change. —
    *Recommend shipping 0.3.0 after step 6 with the lock and supervisor in place, the rest as 0.3.1.*
