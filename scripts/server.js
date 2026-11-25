#!/usr/bin/env node
// Local dashboard server (no model calls)
//   GET  /            dashboard page (web/index.html); static files: /i18n.js (its text in en, ko, zh-CN),
//                     /web/<name>.mjs, /web/style.css (whitelist, nothing else)
//   GET  /api/settings, POST /api/settings {lang: en|ko|zh-CN|null} -> dashboard and card language
//                     POST /api/settings {project, runner_lead?, runner_member?: headless|orca|window} -> how a
//                     project's new leads (handoff --spawn) and members start (projects.json spawn)
//   GET  /api/state   sessions, replies, recent active cards, last card per session, archived count,
//                     token usage (usage_total for connected sessions, usage_today), context_warn, lead sessions' lead_baseline, lead_handoff_at,
//                     context_window and baseline_big (start over half the window),
//                     teams (mode and teams per project: lead, worktree, groups). ?reports=1 also returns member
//                     reports (via_lead cards).
//   POST /api/mode    {project, mode: team, lead, team?} -> add a team led by that session (a name in use is refused)
//                     {project, mode: solo, team?} -> remove that team (no team: every team); solo when none is left
//   POST /api/sessions/forget {session_id} | {project, ended: true} -> drop ended sessions from the sidebar
//   POST /api/sessions/end    {session_id} -> mark an idle, stale session (or one whose Claude process is dead) as ended
//   POST /api/team/end        {session_id} -> stop a team member (same as `team.js <lead> end <sid>`)
//   POST /api/team/spawn      {lead, role, model?, stay?, task, group?, runner?: headless|orca|window} -> start a member
//                             for a live lead (runner left out: the project's runner_member)
//   POST /api/groups          {project, team, action: create|rename|delete, name, new_name?, purge?} -> manage a team's
//                             groups (team may be left out when the project has one team)
//   GET  /api/search  ?q=&archived=include|only|exclude&limit=100[&key=&project_key=] -> matching cards, newest first
//                     (key: exact key and project_key match, one task's history)
//   POST /api/reply   {session_id, text, card_id?, card_title?} -> saved to that session's inbox
//   POST /api/archive {card_id, archived} -> archive or unarchive a card
// Routes live in http/routes/*.js (one per resource) and run through http/router.js (same-origin check on every
// POST, JSON body <= 64 KB, errors {error, code}). Process work (spawn, end, kill) runs off the request path.
const http = require('http');
const os = require('os');

// Never keep a worktree as the current folder (Windows could not delete it while the server runs; bug-005).
try { process.chdir(os.homedir()); } catch { /* stay */ }
const fs = require('fs');
const { BOARD_DIR, PORT, paths, readJson, writeJson, processTableAsync, sweepWaiters } = require('./lib');
const orca = require('./runners/orca');
const config = require('./core/config');
const lifecycle = require('./app/lifecycle');
const { createRouter } = require('./http/router');
const migrate = require('./store/migrate');
const routes = require('./http/routes');

// Orca terminal state per handle, never blocking a request: the cached answer is returned (null = not known
// yet, so nobody is marked gone) and a stale or missing entry is refreshed in the background (orca CLI, async).
const TERM_TTL = 10000;
const termCache = new Map(); // handle -> { open, ts, busy }
function terminalOpen(handle) {
  const hit = termCache.get(handle) || { open: null, ts: 0, busy: false };
  if (!hit.busy && Date.now() - hit.ts >= TERM_TTL) {
    hit.busy = true;
    termCache.set(handle, hit);
    orca.terminalOpenAsync(handle, (open) => {
      termCache.set(handle, { open, ts: Date.now(), busy: false });
      if (open === false) setImmediate(liveness); // a closed terminal: its session is ended now, not at the next tick
    });
  }
  return hit.open;
}

// The last process table (read in the background by sweep and tick); null until the first read.
let procTable = null;

// Liveness (docs/architecture.md §3.4): sessions of any kind that died without their SessionEnd hook (bug-001,
// bug-005) are ended (reason gone) and their leftovers stopped, at start, every DDASH_TICK_MS and when Orca reports
// a terminal closed. GET /api/state never writes.
const TICK_MS = config.get('DDASH_TICK_MS');
function liveness(table = procTable) {
  try {
    for (const sid of lifecycle.reapGone(terminalOpen, table)) console.log(`ddashboard: session ${sid} is gone (ended)`);
  } catch (err) { console.log(`ddashboard: liveness check failed: ${err.message}`); }
}
let ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  processTableAsync((table) => {
    ticking = false;
    if (table.size) procTable = table;
    liveness(table.size ? table : null);
  });
}

// bug-005: at start and every minute, stop wait commands whose session is gone (any plugin version) and drop stale
// lock files. The process table is read without blocking requests.
const SWEEP_MS = config.get('DDASH_SWEEP_MS');
let sweeping = false;
function sweep() {
  if (sweeping) return;
  sweeping = true;
  processTableAsync((table) => {
    sweeping = false;
    if (!table.size) return;
    procTable = table;
    try {
      const r = sweepWaiters(table);
      for (const k of r.killed) console.log(`ddashboard: stopped an orphan wait command (pid ${k.pid}, session ${k.sid})`);
    } catch (err) { console.log(`ddashboard: sweep failed: ${err.message}`); }
  });
}

const server = http.createServer(createRouter(routes));

// Leave a pid file so hooks and control.js can tell whether the server is up; remove it on exit.
const removePid = () => {
  try { if (readJson(paths.serverPid, {}).pid === process.pid) fs.unlinkSync(paths.serverPid); } catch {}
};
process.on('exit', removePid);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.on('error', (err) => {
  console.error(`ddashboard: could not start the server (${err.code}). If port ${PORT} is in use, set DDASH_PORT to another port.`);
  process.exit(1);
});

try { for (const to of migrate.run()) console.log(`ddashboard: board migrated to schema ${to}`); } catch (err) { console.log(`ddashboard: migration failed: ${err.message}`); }
liveness(null); // before the first request: a session that died while no server ran shows ended at once
server.listen(PORT, '127.0.0.1', () => {
  writeJson(paths.serverPid, { pid: process.pid, port: PORT, started: new Date().toISOString() });
  console.log(`ddashboard: http://127.0.0.1:${PORT}  (board: ${BOARD_DIR})`);
  sweep();
  setInterval(sweep, SWEEP_MS).unref();
  setInterval(tick, TICK_MS).unref();
});
