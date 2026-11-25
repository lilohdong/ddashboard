#!/usr/bin/env node
// Local dashboard server (no model calls)
//   GET  /            dashboard page
//   GET  /api/state   sessions, replies, recent active cards, last card per session, archived count
//   GET  /api/search  ?q=&archived=include|only|exclude&limit=100 -> matching cards, newest first
//   POST /api/reply   {session_id, text, card_id?, card_title?} -> saved to that session's inbox
//   POST /api/archive {card_id, archived} -> archive or unarchive a card
const http = require('http');
const fs = require('fs');
const path = require('path');
const { BOARD_DIR, PORT, paths, readJson, readJsonl, writeJson, appendJsonl, ensureDir, safeId } = require('./lib');
const cards = require('./cards');

const HTML = path.join(__dirname, 'dashboard.html');
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

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const sessions = readJson(paths.sessions, {});
    for (const s of Object.values(sessions)) {
      s.pending = pendingCount(s.session_id);
      s.waiting = waiting(s.session_id);
      s.project = s.project || s.name;
      // Displayed state: ended > working > listening (wait command alive) > idle
      s.view = s.ended || s.state === 'ended' ? 'ended' : s.state === 'working' ? 'working' : s.waiting ? 'waiting' : 'idle';
    }
    const { cards: recent, last_by_session, archived_count } = cards.state(300);
    return send(res, 200, {
      sessions,
      replies: readJsonl(paths.replies, 1000),
      cards: recent,
      last_by_session,
      archived_count,
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
