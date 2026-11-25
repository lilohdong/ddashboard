// In-memory card index for the server.
// Reads the 0.1.0 cards.jsonl and the monthly cards/YYYY-MM.jsonl files, and on each refresh
// reads only the bytes appended since the last read. A line still being written (no trailing
// newline yet) is kept as a byte buffer and finished on the next refresh.
const fs = require('fs');
const { RECENT_DAYS, paths, cardFiles, readJson, writeJson } = require('./lib');

const DAY_MS = 24 * 60 * 60 * 1000;
const NL = 0x0a;

const files = new Map(); // file -> { offset, partial: Buffer }
let cards = []; // all cards, oldest first
let replaced = new Set(); // ids retired by a later card's "replaces" or by a newer card with the same key
let byKey = new Map(); // project_key + key -> { latest card, count of cards }
let lastBySession = {}; // session_id -> latest card of that session
let unsorted = false;

function reset() {
  files.clear();
  cards = [];
  replaced = new Set();
  byKey = new Map();
  lastBySession = {};
}

// Same project and same key: only the newest card stays, every other one counts as replaced.
// Cards without project_key (written before keys existed) never take part.
const keyOf = (card) => (card.key && card.project_key && !card.via_lead ? `${card.project_key}\n${card.key}` : '');

function addKeyed(card) {
  const k = keyOf(card);
  if (!k) return;
  const g = byKey.get(k);
  if (!g) { byKey.set(k, { latest: card, count: 1 }); return; }
  g.count++;
  if (card.ts >= g.latest.ts) { replaced.add(g.latest.id); g.latest = card; } else replaced.add(card.id);
}

function add(card) {
  if (!card || typeof card !== 'object' || !card.id) return;
  card.id = String(card.id);
  card.ts = String(card.ts || '');
  if (cards.length && card.ts < cards[cards.length - 1].ts) unsorted = true;
  cards.push(card);
  if (card.replaces) replaced.add(String(card.replaces));
  addKeyed(card);
  const sid = card.session_id;
  if (sid && (!lastBySession[sid] || card.ts >= lastBySession[sid].ts)) {
    lastBySession[sid] = card;
  }
}

function parseLines(buf, state) {
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== NL) continue;
    const line = buf.toString('utf8', start, i).trim();
    start = i + 1;
    if (!line) continue;
    try { add(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  state.partial = buf.subarray(start);
}

function readFile(file) {
  let state = files.get(file);
  let size;
  try { size = fs.statSync(file).size; } catch { return true; } // missing file: nothing to read
  if (!state) files.set(file, (state = { offset: 0, partial: Buffer.alloc(0) }));
  if (size < state.offset) return false; // truncated or replaced: caller rebuilds everything
  if (size === state.offset) return true;
  const buf = Buffer.alloc(size - state.offset);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, state.offset); } finally { fs.closeSync(fd); }
  state.offset = size;
  parseLines(state.partial.length ? Buffer.concat([state.partial, buf]) : buf, state);
  return true;
}

function refresh() {
  const list = cardFiles();
  let ok = true;
  for (const f of list) if (!(ok = readFile(f))) break;
  if (!ok) {
    reset();
    for (const f of list) readFile(f);
  }
  if (unsorted) {
    cards.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    unsorted = false;
  }
}

// archived.json: { <card_id>: { archived: true|false, ts } }. An explicit entry wins over
// "replaced" and "older than RECENT_DAYS", so Unarchive works on those cards too.
function readArchived() {
  const data = readJson(paths.archived, {});
  return data && typeof data === 'object' ? data : {};
}

function archiver(now = Date.now()) {
  const manual = readArchived();
  const cutoff = new Date(now - RECENT_DAYS * DAY_MS).toISOString();
  return (card) => {
    const m = manual[card.id];
    if (m && typeof m.archived === 'boolean') return m.archived;
    return replaced.has(card.id) || card.ts < cutoff;
  };
}

// A keyed card carries key_prev: how many earlier cards of its project share its key.
function withHistory(card) {
  const g = keyOf(card) && byKey.get(keyOf(card));
  return g && g.count > 1 ? { ...card, key_prev: g.count - 1 } : card;
}

// Recent active cards. Member reports to a lead (via_lead) are left out unless reports is true.
function state(limit = 300, { reports = false } = {}) {
  refresh();
  const isArchived = archiver();
  const recent = [];
  let archivedCount = 0;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (isArchived(cards[i])) archivedCount++;
    else if (recent.length < limit && (reports || !cards[i].via_lead)) recent.push(withHistory(cards[i]));
  }
  const last = {};
  for (const [sid, c] of Object.entries(lastBySession)) {
    last[sid] = { id: c.id, status: c.status, title: c.title, ts: c.ts, archived: isArchived(c) };
    if (c.via_lead) last[sid].via_lead = c.via_lead;
  }
  return { cards: recent.reverse(), last_by_session: last, archived_count: archivedCount };
}

const SEARCH_FIELDS = ['title', 'details', 'project', 'session_name', 'branch', 'key'];

function matches(card, q) {
  if (!q) return true;
  for (const f of SEARCH_FIELDS) if (card[f] && String(card[f]).toLowerCase().includes(q)) return true;
  for (const f of ['summary', 'review']) {
    for (const s of [].concat(card[f] || [])) if (String(s).toLowerCase().includes(q)) return true;
  }
  return false;
}

// Newest first. mode: include (all cards) | only (archived only) | exclude (active only).
function search(query, mode = 'include', limit = 100) {
  refresh();
  const q = String(query || '').trim().toLowerCase();
  const isArchived = archiver();
  const out = [];
  for (let i = cards.length - 1; i >= 0 && out.length < limit; i--) {
    const c = cards[i];
    const archived = isArchived(c);
    if ((mode === 'only' && !archived) || (mode === 'exclude' && archived)) continue;
    if (matches(c, q)) out.push({ ...c, archived });
  }
  return out;
}

function exists(id) {
  refresh();
  return cards.some((c) => c.id === id);
}

function setArchived(id, archived) {
  const data = readArchived();
  data[id] = { archived: Boolean(archived), ts: new Date().toISOString() };
  writeJson(paths.archived, data);
}

module.exports = { refresh, reset, state, search, exists, setArchived };
