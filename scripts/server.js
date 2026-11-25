#!/usr/bin/env node
// Local dashboard server (no model calls)
//   GET  /            dashboard page (GET /i18n.js: its text in en, ko, zh-CN)
//   GET  /api/settings, POST /api/settings {lang: en|ko|zh-CN|null} -> dashboard and card language
//   GET  /api/state   sessions, replies, recent active cards, last card per session, archived count,
//                     token usage (usage_total for connected sessions, usage_today), context_warn, lead_context_limit,
//                     teams (mode, lead and groups per project). ?reports=1 also returns member reports (via_lead cards).
//   POST /api/mode    {project, mode: solo|team, lead?, lead_name?} -> switch a project's mode
//   POST /api/sessions/forget {session_id} | {project, ended: true} -> drop ended sessions from the sidebar
//   POST /api/sessions/end    {session_id} -> mark an idle, stale session as ended
//   POST /api/team/spawn      {lead, role, model?, stay?, task, group?} -> start a headless member for a live lead
//   POST /api/groups          {project, action: create|rename|delete, name, new_name?, purge?} -> manage team groups
//   GET  /api/search  ?q=&archived=include|only|exclude&limit=100 -> matching cards, newest first
//   POST /api/reply   {session_id, text, card_id?, card_title?} -> saved to that session's inbox
//   POST /api/archive {card_id, archived} -> archive or unarchive a card
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  BOARD_DIR, PORT, paths, readJson, readJsonl, writeJson, appendJsonl, ensureDir, safeId, teamRole, routeCard, setMode,
  isEnded, isStale, forgetSessions, markEnded, deliver, STALE_MIN, readSettings, saveSettings, LEAD_CONTEXT_LIMIT,
} = require('./lib');
const cards = require('./cards');
const usage = require('./usage');
const team = require('./team');

const CONTEXT_WARN = Number(process.env.DDASH_CONTEXT_WARN) || 150000;

const HTML = path.join(__dirname, 'dashboard.html');
const I18N = path.join(__dirname, 'i18n.js');
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

function pendingCount(sid) {
  try { return fs.readdirSync(paths.inbox(sid)).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

// Mode and lead per connected project, keyed by the project name the dashboard groups sessions by.
function teams(projects, sessions) {
  const nameOf = {};
  for (const s of Object.values(sessions)) if (s.project_key && s.project) nameOf[s.project_key] ||= s.project;
  const out = {};
  for (const [key, p] of Object.entries(projects)) {
    const name = p.name || nameOf[key] || path.basename(p.cwd || key);
    const groups = Object.fromEntries(Object.entries(p.groups || {}).map(([n, g]) => [n, { dir: g.dir, created: g.created }]));
    out[name] = { key, mode: p.mode === 'team' ? 'team' : 'solo', lead: p.lead || null, lead_name: p.lead_name || null, mode_ver: Number(p.mode_ver) || 0, groups };
  }
  return out;
}

function waiting(sid) {
  try {
    const pid = Number(fs.readFileSync(path.join(paths.inbox(sid), 'wait.lock'), 'utf8'));
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, fs.readFileSync(HTML, 'utf8'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/i18n.js') {
    return send(res, 200, fs.readFileSync(I18N, 'utf8'), 'text/javascript; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return send(res, 200, { lang: readSettings().lang || null });
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const r = saveSettings({ lang: msg.lang || null });
      if (!r.ok) return send(res, 400, { error: r.error });
      send(res, 200, { ok: true, lang: r.settings.lang || null });
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const sessions = readJson(paths.sessions, {});
    const projects = readJson(paths.projects, {});
    for (const s of Object.values(sessions)) {
      s.pending = pendingCount(s.session_id);
      s.waiting = waiting(s.session_id);
      s.project = s.project || s.name;
      // Displayed state: ended > working > listening (wait command alive) > idle
      s.view = s.ended || s.state === 'ended' ? 'ended' : s.state === 'working' ? 'working' : s.waiting ? 'waiting' : 'idle';
      // Unresponsive: idle, no live wait command, not seen for stale_min minutes.
      s.unresponsive = s.view === 'idle' && isStale(s);
      // Place in the team: solo | lead | member | outside (team mode, untagged)
      s.team = teamRole(s, projects[s.project_key]);
      if (s.team === 'member' && routeCard(sessions, projects, s.session_id).lead_missing) s.lead_missing = true;
    }
    const { cards: recent, last_by_session, archived_count } = cards.state(300, { reports: url.searchParams.get('reports') === '1' });
    const { usage_total, usage_today } = usage.state(Object.keys(sessions));
    return send(res, 200, {
      teams: teams(projects, sessions),
      sessions,
      replies: readJsonl(paths.replies, 1000),
      cards: recent,
      last_by_session,
      archived_count,
      usage_total,
      usage_today,
      context_warn: CONTEXT_WARN,
      lead_context_limit: LEAD_CONTEXT_LIMIT,
      stale_min: STALE_MIN,
      settings: { lang: readSettings().lang || null },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const mode = ['include', 'only', 'exclude'].includes(url.searchParams.get('archived')) ? url.searchParams.get('archived') : 'include';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    return send(res, 200, { cards: cards.search(url.searchParams.get('q') || '', mode, limit) });
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
      const projects = readJson(paths.projects, {});
      const sessions = readJson(paths.sessions, {});
      const name = String(msg.project || '');
      const key = projects[name] ? name : teams(projects, sessions)[name]?.key;
      if (!key || !projects[key]) return send(res, 404, { error: 'unknown project' });
      if (msg.mode !== 'team' && msg.mode !== 'solo') return send(res, 400, { error: 'mode must be solo or team' });
      let lead;
      if (msg.mode === 'team') {
        lead = safeId(msg.lead);
        const s = sessions[lead];
        if (!s || s.project_key !== key) return send(res, 400, { error: 'lead must be a session of this project' });
        if (s.ended || s.state === 'ended') return send(res, 409, { error: 'lead session has ended' });
      }
      const r = setMode(key, msg.mode, { lead, leadName: msg.lead_name ? String(msg.lead_name) : undefined });
      if (!r.ok) return send(res, 400, { error: r.error });
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
        const projects = readJson(paths.projects, {});
        const name = String(msg.project);
        const key = projects[name] ? name : teams(projects, sessions)[name]?.key;
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

  // Start a headless member for a live lead (same code as `team.js <lead> spawn`), and tell the lead.
  if (req.method === 'POST' && url.pathname === '/api/team/spawn') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const sessions = readJson(paths.sessions, {});
      const projects = readJson(paths.projects, {});
      const leadSid = safeId(msg.lead);
      const lead = sessions[leadSid];
      if (!lead) return send(res, 404, { error: 'unknown lead session' });
      if (isEnded(lead) || teamRole(lead, projects[lead.project_key]) !== 'lead') return send(res, 409, { error: 'not a live team lead' });
      const role = String(msg.role || '').trim();
      const task = String(msg.task || '').trim();
      if (!role || !task) return send(res, 400, { error: 'role and task required' });
      let r;
      try {
        r = team.spawnMember(leadSid, { role, model: msg.model || undefined, stay: msg.stay === true, task: task.slice(0, 8000), group: msg.group || undefined });
      } catch (err) { return send(res, 400, { error: String(err.message || err) }); }
      const first = task.split(/\r?\n/)[0].slice(0, 200);
      deliver(leadSid, {
        type: 'report', from: r.sid, role: role.slice(0, 40), status: 'wip',
        title: `member ${role} ${r.sid.slice(0, 8)}${msg.group ? ` (group ${msg.group})` : ''} spawned by the user: ${first}`,
      });
      send(res, 200, { ok: true, session_id: r.sid, pid: r.pid, log: r.log });
    });
  }

  // Create, rename or delete a team group (same code as `team.js <lead> group ...`). Needs a live lead.
  if (req.method === 'POST' && url.pathname === '/api/groups') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    return readBody(req, res, (msg) => {
      const projects = readJson(paths.projects, {});
      const sessions = readJson(paths.sessions, {});
      const name = String(msg.project || '');
      const key = projects[name] ? name : teams(projects, sessions)[name]?.key;
      if (!key || !projects[key]) return send(res, 404, { error: 'unknown project' });
      const p = projects[key];
      const lead = sessions[p.lead];
      if (p.mode !== 'team' || !lead || isEnded(lead)) return send(res, 409, { error: 'groups need team mode with a live lead' });
      if (!['create', 'rename', 'delete'].includes(msg.action)) return send(res, 400, { error: 'action must be create, rename or delete' });
      try {
        const r = team.groupAction(p.lead, msg.action, { name: String(msg.name || ''), newName: String(msg.new_name || ''), purge: msg.purge === true });
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
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

server.listen(PORT, '127.0.0.1', () => {
  writeJson(paths.serverPid, { pid: process.pid, port: PORT, started: new Date().toISOString() });
  console.log(`ddashboard: http://127.0.0.1:${PORT}  (board: ${BOARD_DIR})`);
});
