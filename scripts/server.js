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
const http = require('http');
const os = require('os');

// Never keep a worktree as the current folder (Windows could not delete it while the server runs; bug-005).
try { process.chdir(os.homedir()); } catch { /* stay */ }
const fs = require('fs');
const path = require('path');
const {
  BOARD_DIR, PORT, paths, readJson, writeJson, appendJsonl, ensureDir, safeId, teamRole, setMode,
  isEnded, forgetSessions, markEnded, deliver, readSettings, saveSettings,
  readProjects, teamsOf, own, setRunners, processTableAsync, sweepWaiters,
} = require('./lib');
const orca = require('./runners/orca');
const cards = require('./cards');
const usage = require('./usage');
const members = require('./app/members');
const config = require('./core/config');
const { newId } = require('./core/ids');
const serverState = require('./app/server-state');
const lifecycle = require('./app/lifecycle');

const { teams } = serverState;

// Static files: the page, its text table, and the web/ modules and style sheet. Names are matched, never joined
// from the URL as given, so nothing outside this list is served.
const WEB = path.join(__dirname, 'web');
const JS = 'text/javascript; charset=utf-8';
function staticFile(pathname) {
  if (pathname === '/') return [path.join(WEB, 'index.html'), 'text/html; charset=utf-8'];
  if (pathname === '/i18n.js') return [path.join(__dirname, 'i18n.js'), JS];
  if (pathname === '/web/style.css') return [path.join(WEB, 'style.css'), 'text/css; charset=utf-8'];
  const m = /^\/web\/([a-z0-9-]+\.mjs)$/.exec(pathname);
  return m ? [path.join(WEB, m[1]), JS] : null;
}
const MAX_BODY = 64 * 1024;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Accept same-origin requests only, so other websites cannot post through the browser.
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function readBody(req, res, handle) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
    if (!msg || typeof msg !== 'object') return send(res, 400, { error: 'bad json' });
    try { handle(msg); } catch (err) { send(res, 500, { error: String(err.message || err) }); }
  });
}

const projectKeyOf = (projects, sessions, name) => (own(projects, name) ? name : own(teams(projects, sessions), name)?.key);

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const file = req.method === 'GET' && staticFile(url.pathname);
  if (file) {
    let body;
    try { body = fs.readFileSync(file[0], 'utf8'); } catch { return send(res, 404, { error: 'not found' }); }
    return send(res, 200, body, file[1]);
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return send(res, 200, { lang: readSettings().lang || null });
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      if (msg.project !== undefined) {
        const key = projectKeyOf(readProjects(), readJson(paths.sessions, {}), String(msg.project));
        const r = setRunners(key, { runner_lead: msg.runner_lead, runner_member: msg.runner_member });
        return r.ok ? send(res, 200, r) : send(res, r.code || 400, { error: r.error });
      }
      const r = saveSettings({ lang: msg.lang || null });
      if (!r.ok) return send(res, 400, { error: r.error });
      send(res, 200, { ok: true, lang: r.settings.lang || null });
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    // Read-only: sessions found gone are ended by the liveness tick, not here.
    return send(res, 200, serverState.build({ reports: url.searchParams.get('reports') === '1' }));
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const mode = ['include', 'only', 'exclude'].includes(url.searchParams.get('archived')) ? url.searchParams.get('archived') : 'include';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const filter = { key: url.searchParams.get('key') || '', project_key: url.searchParams.get('project_key') || '' };
    return send(res, 200, { cards: cards.search(url.searchParams.get('q') || '', mode, limit, filter) });
  }

  if (req.method === 'POST' && url.pathname === '/api/archive') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const id = String(msg.card_id || '');
      if (!id) return send(res, 400, { error: 'card_id required' });
      if (typeof msg.archived !== 'boolean') return send(res, 400, { error: 'archived must be true or false' });
      if (!cards.exists(id)) return send(res, 404, { error: 'unknown card' });
      cards.setArchived(id, msg.archived);
      send(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/mode') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      // project: its key in projects.json, or its name as shown on the dashboard
      const projects = readProjects();
      const sessions = readJson(paths.sessions, {});
      const key = projectKeyOf(projects, sessions, String(msg.project || ''));
      if (!key || !projects[key]) return send(res, 404, { error: 'unknown project' });
      if (msg.mode !== 'team' && msg.mode !== 'solo') return send(res, 400, { error: 'mode must be solo or team' });
      let lead;
      if (msg.mode === 'team') {
        lead = safeId(msg.lead);
        const s = sessions[lead];
        if (!s || s.project_key !== key) return send(res, 400, { error: 'lead must be a session of this project' });
        if (s.ended || s.state === 'ended') return send(res, 409, { error: 'lead session has ended' });
      }
      const team = msg.team ? String(msg.team) : msg.lead_name ? String(msg.lead_name) : undefined;
      const r = setMode(key, msg.mode, { lead, team });
      if (!r.ok) return send(res, r.code || 400, { error: r.error });
      send(res, 200, r);
    });
  }

  // Remove ended sessions from the sidebar: {session_id} or {project, ended: true}. Cards and usage stay.
  if (req.method === 'POST' && url.pathname === '/api/sessions/forget') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const sessions = readJson(paths.sessions, {});
      let ids;
      if (msg.session_id) {
        const sid = safeId(msg.session_id);
        if (!sessions[sid]) return send(res, 404, { error: 'unknown session' });
        if (!isEnded(sessions[sid])) return send(res, 409, { error: 'session has not ended' });
        ids = [sid];
      } else if (msg.project && msg.ended === true) {
        const projects = readProjects();
        const name = String(msg.project);
        const key = projectKeyOf(projects, sessions, name);
        ids = Object.values(sessions).filter((s) => isEnded(s) && (key ? s.project_key === key : s.project === name)).map((s) => s.session_id);
      } else return send(res, 400, { error: 'session_id, or project with ended: true, required' });
      const r = forgetSessions(ids);
      if (msg.session_id && r.refused.length) return send(res, 409, { error: 'session has not ended' });
      send(res, 200, { ok: true, forgotten: r.forgotten.length });
    });
  }

  // Mark an idle, stale session the user considers dead as ended (so it can be forgotten).
  if (req.method === 'POST' && url.pathname === '/api/sessions/end') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const r = markEnded(safeId(msg.session_id));
      if (!r.ok) return send(res, r.code, { error: r.error });
      send(res, 200, { ok: true });
    });
  }

  // Stop a team member (same code as `team.js <lead> end`).
  if (req.method === 'POST' && url.pathname === '/api/team/end') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const sid = safeId(msg.session_id);
      const m = readJson(paths.sessions, {})[sid];
      if (!m || m.kind !== 'member' || !m.lead) return send(res, 404, { error: 'not a team member' });
      try {
        const r = members.endMember(m.lead, sid);
        send(res, 200, { ok: true, done: r.done, already: Boolean(r.already) });
      } catch (err) { send(res, 400, { error: String(err.message || err) }); }
    });
  }

  // Start a member for a live lead (same code as `team.js <lead> spawn`), and tell the lead.
  if (req.method === 'POST' && url.pathname === '/api/team/spawn') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const sessions = readJson(paths.sessions, {});
      const projects = readProjects();
      const leadSid = safeId(msg.lead);
      const lead = sessions[leadSid];
      if (!lead) return send(res, 404, { error: 'unknown lead session' });
      if (isEnded(lead) || teamRole(lead, projects[lead.project_key]) !== 'lead') return send(res, 409, { error: 'not a live team lead' });
      const role = String(msg.role || '').trim();
      const task = String(msg.task || '').trim();
      if (!role || !task) return send(res, 400, { error: 'role and task required' });
      if (msg.runner !== undefined && msg.runner !== null && msg.runner !== '' && !members.RUNNERS.includes(msg.runner)) {
        return send(res, 400, { error: `runner must be one of ${members.RUNNERS.join(', ')}` });
      }
      let r;
      try {
        r = members.spawnMember(leadSid, { role, model: msg.model || undefined, stay: msg.stay === true, task: task.slice(0, 8000), group: msg.group || undefined, runner: members.RUNNERS.includes(msg.runner) ? msg.runner : undefined });
      } catch (err) { return send(res, 400, { error: String(err.message || err) }); }
      const first = task.split(/\r?\n/)[0].slice(0, 200);
      deliver(leadSid, {
        type: 'report', from: r.sid, role: role.slice(0, 40), status: 'wip',
        title: `member ${role} ${r.sid.slice(0, 8)}${msg.group ? ` (group ${msg.group})` : ''} spawned by the user: ${first}`,
      });
      send(res, 200, { ok: true, session_id: r.sid, runner: r.runner, pid: r.pid, terminal: r.terminal, log: r.log, note: r.note || undefined });
    });
  }

  // Create, rename or delete a team group (same code as `team.js <lead> group ...`). Needs a live lead.
  if (req.method === 'POST' && url.pathname === '/api/groups') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const projects = readProjects();
      const sessions = readJson(paths.sessions, {});
      const key = projectKeyOf(projects, sessions, String(msg.project || ''));
      if (!key || !projects[key]) return send(res, 404, { error: 'unknown project' });
      const list = teamsOf(projects[key]);
      const names = Object.keys(list);
      const tn = msg.team ? String(msg.team) : names.length === 1 ? names[0] : '';
      if (!names.length) return send(res, 409, { error: 'groups need team mode with a live lead' });
      if (!own(list, tn)) return send(res, tn ? 404 : 400, { error: tn ? `no team ${tn}` : 'team required: this project has several teams' });
      const lead = sessions[list[tn].lead];
      if (!lead || isEnded(lead)) return send(res, 409, { error: 'groups need team mode with a live lead' });
      if (!['create', 'rename', 'delete'].includes(msg.action)) return send(res, 400, { error: 'action must be create, rename or delete' });
      try {
        const r = members.groupAction(list[tn].lead, msg.action, { name: String(msg.name || ''), newName: String(msg.new_name || ''), purge: msg.purge === true });
        send(res, 200, r);
      } catch (err) { send(res, 400, { error: String(err.message || err) }); }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/reply') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const sid = safeId(msg.session_id);
      const text = String(msg.text || '').trim();
      if (!text) return send(res, 400, { error: 'empty' });
      const sessions = readJson(paths.sessions, {});
      if (!sessions[sid]) return send(res, 404, { error: 'unknown session' });
      if (sessions[sid].ended || sessions[sid].state === 'ended') return send(res, 409, { error: 'session ended' });
      const reply = {
        type: 'reply',
        id: newId(),
        ts: new Date().toISOString(),
        session_id: sid,
        card_id: msg.card_id ? String(msg.card_id) : null,
        card_title: msg.card_title ? String(msg.card_title).slice(0, 200) : null,
        text: text.slice(0, 4000),
      };
      ensureDir(paths.inbox(sid));
      writeJson(path.join(paths.inbox(sid), `${reply.id}.json`), reply);
      appendJsonl(paths.replies, reply);
      send(res, 200, { ok: true, id: reply.id });
    });
  }

  send(res, 404, { error: 'not found' });
});

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

liveness(null); // before the first request: a session that died while no server ran shows ended at once
server.listen(PORT, '127.0.0.1', () => {
  writeJson(paths.serverPid, { pid: process.pid, port: PORT, started: new Date().toISOString() });
  console.log(`ddashboard: http://127.0.0.1:${PORT}  (board: ${BOARD_DIR})`);
  sweep();
  setInterval(sweep, SWEEP_MS).unref();
  setInterval(tick, TICK_MS).unref();
});
