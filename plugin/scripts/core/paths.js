// Board paths. BOARD_DIR and PORT are read once at load (as before): a process works on one board.
const path = require('path');
const config = require('./config');

const BOARD_DIR = config.get('DDASH_BOARD_DIR');
const PORT = config.get('DDASH_PORT');
const URL = `http://127.0.0.1:${PORT}`;

function safeId(sid) {
  return String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';
}

const paths = {
  legacyCards: path.join(BOARD_DIR, 'cards.jsonl'), // 0.1.0 card log, read-only from 0.2.0 on
  cardsDir: path.join(BOARD_DIR, 'cards'),
  cardsFor: (iso) => path.join(BOARD_DIR, 'cards', `${String(iso).slice(0, 7)}.jsonl`), // cards/YYYY-MM.jsonl
  archived: path.join(BOARD_DIR, 'archived.json'),
  waitBin: path.join(BOARD_DIR, 'bin', 'wait.js'),
  teamBin: path.join(BOARD_DIR, 'bin', 'team.js'),
  settings: path.join(BOARD_DIR, 'settings.json'),
  models: path.join(BOARD_DIR, 'models.json'), // session id -> model from SessionStart (context window)
  logsDir: path.join(BOARD_DIR, 'logs'),
  log: (sid) => path.join(BOARD_DIR, 'logs', `${safeId(sid)}.log`),
  appLog: path.join(BOARD_DIR, 'logs', 'ddashboard.log'), // core/log
  locksDir: path.join(BOARD_DIR, 'locks'), // core/lock
  replies: path.join(BOARD_DIR, 'replies.jsonl'), // 0.2.x reply log, read-only from schema 2 on
  repliesDir: path.join(BOARD_DIR, 'replies'),
  repliesFor: (iso) => path.join(BOARD_DIR, 'replies', `${String(iso).slice(0, 7)}.jsonl`), // replies/YYYY-MM.jsonl
  sessions: path.join(BOARD_DIR, 'sessions.json'),
  meta: path.join(BOARD_DIR, 'meta.json'), // board schema version (store/meta)
  projects: path.join(BOARD_DIR, 'projects.json'),
  serverPid: path.join(BOARD_DIR, 'server.pid'),
  serverLog: path.join(BOARD_DIR, 'server.log'),
  usageDir: path.join(BOARD_DIR, 'usage'),
  usageFor: (iso) => path.join(BOARD_DIR, 'usage', `${String(iso).slice(0, 7)}.jsonl`), // usage/YYYY-MM.jsonl
  inboxDir: path.join(BOARD_DIR, 'inbox'),
  inbox: (sid) => path.join(BOARD_DIR, 'inbox', safeId(sid)),
  done: (sid) => path.join(BOARD_DIR, 'inbox', safeId(sid), 'done'),
};

module.exports = { BOARD_DIR, PORT, URL, paths, safeId };
