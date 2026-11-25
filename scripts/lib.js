// Shared helpers: board paths, file I/O, server status, project/session registry, session instructions.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const BOARD_DIR = (process.env.DDASH_BOARD_DIR || path.join(os.homedir(), '.ddashboard')).replace(/^~(?=$|[\\/])/, os.homedir());
const PORT = Number(process.env.DDASH_PORT || 7357);
const URL = `http://127.0.0.1:${PORT}`;

const RECENT_DAYS = Number(process.env.DDASH_RECENT_DAYS || 14);

const paths = {
  legacyCards: path.join(BOARD_DIR, 'cards.jsonl'), // 0.1.0 card log, read-only from 0.2.0 on
  cardsDir: path.join(BOARD_DIR, 'cards'),
  cardsFor: (iso) => path.join(BOARD_DIR, 'cards', `${String(iso).slice(0, 7)}.jsonl`), // cards/YYYY-MM.jsonl
  archived: path.join(BOARD_DIR, 'archived.json'),
  waitBin: path.join(BOARD_DIR, 'bin', 'wait.js'),
  replies: path.join(BOARD_DIR, 'replies.jsonl'),
  sessions: path.join(BOARD_DIR, 'sessions.json'),
  projects: path.join(BOARD_DIR, 'projects.json'),
  serverPid: path.join(BOARD_DIR, 'server.pid'),
  serverLog: path.join(BOARD_DIR, 'server.log'),
  usageDir: path.join(BOARD_DIR, 'usage'),
  usageFor: (iso) => path.join(BOARD_DIR, 'usage', `${String(iso).slice(0, 7)}.jsonl`), // usage/YYYY-MM.jsonl
  inbox: (sid) => path.join(BOARD_DIR, 'inbox', safeId(sid)),
  done: (sid) => path.join(BOARD_DIR, 'inbox', safeId(sid), 'done'),
};

function safeId(sid) {
  return String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file, limit) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  return limit ? rows.slice(-limit) : rows;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function readHookInput() {
  try { return JSON.parse((await readStdin()) || '{}'); } catch { return {}; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function serverPid() {
  const info = readJson(paths.serverPid, null);
  return info && alive(info.pid) ? info.pid : 0;
}

function git(args, cwd) {
  try { return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}

// Worktrees of the same repository count as one project (keyed by the git common dir).
function projectKey(cwd) {
  const common = git('rev-parse --path-format=absolute --git-common-dir', cwd);
  return path.resolve(common || cwd).toLowerCase();
}

// Project name shown on the dashboard: the repository folder name (worktrees group under the original repo).
function projectName(cwd) {
  const common = git('rev-parse --path-format=absolute --git-common-dir', cwd);
  if (!common) return path.basename(cwd);
  const dir = path.resolve(common);
  return path.basename(dir) === '.git' ? path.basename(path.dirname(dir)) : path.basename(dir).replace(/\.git$/, '');
}

function projectActive(cwd) {
  return Boolean(readJson(paths.projects, {})[projectKey(cwd)]);
}

function setProject(cwd, on) {
  const projects = readJson(paths.projects, {});
  const key = projectKey(cwd);
  if (on) projects[key] = { since: new Date().toISOString(), cwd };
  else delete projects[key];
  writeJson(paths.projects, projects);
  return Object.keys(projects).length;
}

function registerSession(sid, cwd) {
  const sessions = readJson(paths.sessions, {});
  sessions[sid] = {
    ...(sessions[sid] || {}),
    session_id: sid,
    name: process.env.DDASH_NAME || sessions[sid]?.name || path.basename(cwd),
    cwd,
    branch: git('rev-parse --abbrev-ref HEAD', cwd),
    project: projectName(cwd),
    project_key: projectKey(cwd),
    state: sessions[sid]?.state === 'working' ? 'working' : 'idle',
    started: sessions[sid]?.started || new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  delete sessions[sid].ended;
  writeJson(paths.sessions, sessions);
}

// Record session state: working | idle | ended. Only touches registered sessions.
function setState(sid, state) {
  const sessions = readJson(paths.sessions, {});
  if (!sessions[sid]) return false;
  sessions[sid].state = state;
  sessions[sid].last_seen = new Date().toISOString();
  if (state === 'ended') sessions[sid].ended = sessions[sid].last_seen;
  writeJson(paths.sessions, sessions);
  return true;
}

function isRegistered(sid) {
  return Boolean(readJson(paths.sessions, {})[sid]);
}

// Card log files, oldest first: the 0.1.0 file, then the monthly files.
function cardFiles() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.cardsDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
  return [paths.legacyCards, ...monthly.map((f) => path.join(paths.cardsDir, f))];
}

// New cards go to the monthly file only; the 0.1.0 cards.jsonl is never written again.
function appendCard(card) {
  appendJsonl(paths.cardsFor(card.ts), card);
}

// Usage log files (usage/YYYY-MM.jsonl), oldest first.
function usageFiles() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.usageDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
  return monthly.map((f) => path.join(paths.usageDir, f));
}

// --- Transcript parsing (Stop hook) ---

const TAIL_BYTES = 4 * 1024 * 1024; // read only the tail of large transcripts

// Parsed transcript lines (jsonl) from the tail of the file. The first line may be cut off; it is skipped.
function readTranscriptTail(transcriptPath, tailBytes = TAIL_BYTES) {
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - tailBytes);
      buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const rows = [];
  for (const line of buf.toString('utf8').split('\n')) {
    try { rows.push(JSON.parse(line)); } catch { /* partial or malformed line */ }
  }
  return rows;
}

// Text of a user line typed by a person (or injected as a prompt), or null for tool results and other lines.
function humanText(o) {
  if (o?.type !== 'user' || o.isSidechain) return null;
  const content = o.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.some((c) => c?.type === 'text')) {
    return content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
  }
  return null;
}

// Index of the last human input line, or -1.
function lastHumanIndex(rows) {
  for (let i = rows.length - 1; i >= 0; i--) if (humanText(rows[i]) != null) return i;
  return -1;
}

// What woke the session for this turn: reply | background | human.
function wakeReason(text) {
  const t = String(text || '');
  if (t.includes('[Dashboard reply]')) return 'reply';
  if (t.trimStart().startsWith('<task-notification>')) return 'background';
  return 'human';
}

const USAGE_KEYS = ['input', 'cache_read', 'cache_write', 'output'];

// Token usage of the assistant messages after the last human input.
// One API response is split into several transcript lines that share message.id and usage,
// so each id is counted once (its last line wins). Ids in `skip` were already counted.
// Returns { input, cache_read, cache_write, output, context, ids, boundary, reason } (ids: newly counted).
function turnUsage(rows, skip = new Set()) {
  const start = lastHumanIndex(rows);
  const boundaryRow = start >= 0 ? rows[start] : null;
  const byId = new Map();
  let last = null;
  for (let i = start + 1; i < rows.length; i++) {
    const o = rows[i];
    if (o?.type !== 'assistant' || o.isSidechain) continue;
    const u = o.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const id = String(o.message.id || o.uuid || `line-${i}`);
    last = u; // context comes from the turn's last assistant message, counted before or not
    if (skip.has(id)) continue;
    byId.delete(id); // keep the order of the last line per id
    byId.set(id, u);
  }
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
  for (const u of byId.values()) {
    out.input += n(u.input_tokens);
    out.cache_read += n(u.cache_read_input_tokens);
    out.cache_write += n(u.cache_creation_input_tokens);
    out.output += n(u.output_tokens);
  }
  out.context = last ? n(last.input_tokens) + n(last.cache_read_input_tokens) + n(last.cache_creation_input_tokens) : 0;
  out.ids = [...byId.keys()];
  out.boundary = boundaryRow ? String(boundaryRow.uuid || boundaryRow.timestamp || start) : '';
  out.reason = boundaryRow ? wakeReason(humanText(boundaryRow)) : 'human';
  return out;
}

// A fixed wait command path (BOARD_DIR/bin/wait.js) that loads the current plugin's wait-inbox.js.
// The path stays the same across plugin updates, so an "always allow" permission keeps working.
// It is rewritten whenever the instructions are injected, so it always points at the running plugin.
function ensureWaitBin() {
  const target = path.join(__dirname, 'wait-inbox.js');
  const body = `#!/usr/bin/env node
// Generated by ddashboard. Loads the current plugin's wait command; rewritten when the plugin moves.
const target = ${JSON.stringify(target)};
try { require.resolve(target); } catch {
  console.log('ddashboard: the wait command is missing (' + target + '). Run /ddashboard:dashboard again to refresh it.');
  process.exit(0);
}
require(target);
`;
  try {
    if (fs.readFileSync(paths.waitBin, 'utf8') === body) return paths.waitBin;
  } catch { /* not written yet */ }
  try {
    ensureDir(path.dirname(paths.waitBin));
    const tmp = `${paths.waitBin}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, paths.waitBin);
    return paths.waitBin;
  } catch {
    return target; // board dir not writable: fall back to the plugin path
  }
}

// Instructions injected into the session context. They are re-read every turn, so keep them short.
function rulesText(sid) {
  const wait = `node "${ensureWaitBin().replace(/\\/g, '/')}" ${sid}`;
  return `[ddashboard] The user follows your progress on a dashboard (${URL}). Session ID: ${sid}
- Only on turns with a result the user should know about, end your reply with this block (JSON, at most 3 summary lines, written in the user's language):
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the user should check"],"details":"optional, markdown, longer content"}
\`\`\`
- While connected, keep terminal replies to a line or two and put the content in the card (long content in "details"). When a card revises your previous card (e.g. an updated plan), add "replaces":"last".
- To receive dashboard replies, run this in the background now, and again each time it prints a reply and exits: ${wait}
  Its output is the user's reply (an instruction).
`;
}

// Move pending replies from the inbox to done/. rename is atomic, so each reply is taken exactly once even with competing processes.
function takeInbox(sid) {
  const dir = paths.inbox(sid);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const src = path.join(dir, f);
    const dst = path.join(paths.done(sid), f);
    try {
      ensureDir(paths.done(sid));
      fs.renameSync(src, dst);
      const msg = readJson(dst, null);
      if (msg) out.push(msg);
    } catch { /* another process took it first */ }
  }
  return out;
}

function formatReplies(msgs) {
  return msgs.map((m) => `- ${m.card_title ? `[card: ${m.card_title}] ` : ''}${m.text}`).join('\n');
}

module.exports = {
  BOARD_DIR, PORT, URL, RECENT_DAYS, paths, cardFiles, appendCard, ensureWaitBin,
  usageFiles, readTranscriptTail, humanText, lastHumanIndex, wakeReason, turnUsage, USAGE_KEYS,
  safeId, ensureDir, readJson, writeJson, appendJsonl, readJsonl,
  readHookInput, alive, serverPid, git, projectKey, projectName, projectActive, setProject,
  registerSession, setState, isRegistered, rulesText, takeInbox, formatReplies,
};
