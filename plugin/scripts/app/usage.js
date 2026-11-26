// In-memory token usage index for the server.
// Reads usage/YYYY-MM.jsonl and, on each refresh, only the bytes appended since the last read
// (same approach as store/cards.js). Keeps running totals per session and per local day.
const fs = require('fs');
const { files: usageFiles } = require('../store/usage');
const { USAGE_KEYS } = require('../domain/transcript');

const NL = 0x0a;

const files = new Map(); // file -> { offset, partial: Buffer }
let bySession = {}; // session_id -> totals
let byDay = {}; // YYYY-MM-DD (server local time) -> totals

const empty = () => ({ input: 0, cache_read: 0, cache_write: 0, output: 0, turns: 0 });

function reset() {
  files.clear();
  bySession = {};
  byDay = {};
}

function dayKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addTo(t, row) {
  for (const k of USAGE_KEYS) t[k] += Number(row[k]) || 0;
  t.turns += 1;
}

function add(row) {
  if (!row || typeof row !== 'object') return;
  if (row.session_id) addTo((bySession[row.session_id] ||= empty()), row);
  const day = dayKey(row.ts);
  if (day) addTo((byDay[day] ||= empty()), row);
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
  try { size = fs.statSync(file).size; } catch { return true; }
  if (!state) files.set(file, (state = { offset: 0, partial: Buffer.alloc(0) }));
  if (size < state.offset) return false; // truncated or replaced: rebuild
  if (size === state.offset) return true;
  const buf = Buffer.alloc(size - state.offset);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, state.offset); } finally { fs.closeSync(fd); }
  state.offset = size;
  parseLines(state.partial.length ? Buffer.concat([state.partial, buf]) : buf, state);
  return true;
}

function refresh() {
  const list = usageFiles();
  let ok = true;
  for (const f of list) if (!(ok = readFile(f))) break;
  if (!ok) {
    reset();
    for (const f of list) readFile(f);
  }
}

// usage_total: sum over the given (connected) session ids; usage_today: every turn logged today.
function state(sessionIds) {
  refresh();
  const total = empty();
  for (const sid of sessionIds) {
    const t = bySession[sid];
    if (!t) continue;
    for (const k of [...USAGE_KEYS, 'turns']) total[k] += t[k];
  }
  return { usage_total: total, usage_today: { ...(byDay[dayKey(Date.now())] || empty()) } };
}

module.exports = { refresh, state, dayKey };
