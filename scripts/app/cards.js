// The server's card views: an in-memory index over the card files (store/cards) with the displayed lifecycle
// of docs/architecture.md §4.2 (domain/card). Lifecycle fields (folded_into, outcome, stopped, replaced,
// archived, key_prev) are computed on every call and never written.
const config = require('../core/config');
const store = require('../store/cards');
const sessionsStore = require('../store/sessions');
const { createIndex, lifecycle } = require('../domain/card');

const DAY_MS = 24 * 60 * 60 * 1000;

let ix = createIndex();
const rd = store.reader();

function reset() {
  ix = createIndex();
  rd.reset();
}

function refresh() {
  if (!rd.read(ix.add)) {
    reset();
    rd.read(ix.add);
  }
  ix.sort();
}

// Everything a view needs about every card. Precedence (§4.2): explicit archive/unarchive > replaces/key >
// folding > stopped > age. A folded card follows its top card's archived state unless the user chose otherwise.
function views(sessions, now = Date.now()) {
  const manual = store.readArchived();
  const cutoff = new Date(now - config.get('DDASH_RECENT_DAYS') * DAY_MS).toISOString();
  const life = lifecycle(ix.cards, sessions);
  const choice = (c) => { const m = manual[c.id]; return m && typeof m.archived === 'boolean' ? m.archived : undefined; };
  const ownArchived = (c) => choice(c) ?? (ix.replaced.has(c.id) || c.ts < cutoff);
  const byId = new Map(ix.cards.map((c) => [c.id, c]));
  const out = new Map();
  for (const c of ix.cards) {
    const v = { ...(life.get(c.id) || { outcome: c.status }) };
    if (ix.replaced.has(c.id)) { // replaced beats folding and stopped
      v.replaced = true;
      v.outcome = c.status;
      delete v.folded_into;
      delete v.stopped;
    }
    const top = v.folded_into && byId.get(v.folded_into);
    v.archived = top ? choice(c) ?? ownArchived(top) : ownArchived(c);
    out.set(c.id, v);
  }
  return out;
}

const withKeyPrev = (card) => {
  const prev = ix.keyPrev(card);
  return prev ? { ...card, key_prev: prev } : card;
};

// Lifecycle fields a client sees. archived is left to the caller (state() only returns active cards).
function decorate(card, v) {
  const out = withKeyPrev(card);
  const extra = { outcome: v.outcome };
  if (v.folded_into) extra.folded_into = v.folded_into;
  if (v.stopped) extra.stopped = true;
  if (v.replaced) extra.replaced = true;
  return { ...out, ...extra };
}

// Recent active top-level cards, each with the cards folded under it (folded: oldest first).
// Member reports to a lead (via_lead) are left out unless reports is true.
function state(limit = 300, { reports = false, sessions = sessionsStore.read() } = {}) {
  refresh();
  const v = views(sessions);
  const folded = new Map(); // top id -> folded cards, newest first
  const recent = [];
  let archivedCount = 0;
  for (let i = ix.cards.length - 1; i >= 0; i--) {
    const c = ix.cards[i];
    const cv = v.get(c.id);
    if (cv.archived) { archivedCount++; continue; }
    if (!reports && c.via_lead) continue;
    if (cv.folded_into) { (folded.get(cv.folded_into) || folded.set(cv.folded_into, []).get(cv.folded_into)).push(decorate(c, cv)); continue; }
    if (recent.length < limit) recent.push(decorate(c, cv));
  }
  for (const c of recent) if (folded.has(c.id)) c.folded = folded.get(c.id).reverse();
  const last = {};
  for (const [sid, c] of Object.entries(ix.lastBySession)) {
    const cv = v.get(c.id);
    last[sid] = { id: c.id, status: c.status, outcome: cv.outcome, title: c.title, ts: c.ts, archived: cv.archived };
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

// Newest first, folded cards included (each one marked with folded_into). mode: include (all cards) |
// only (archived only) | exclude (active only). key: only cards with exactly this key and project_key.
function search(query, mode = 'include', limit = 100, { key, project_key, sessions = sessionsStore.read() } = {}) {
  refresh();
  const q = String(query || '').trim().toLowerCase();
  const v = views(sessions);
  const out = [];
  for (let i = ix.cards.length - 1; i >= 0 && out.length < limit; i--) {
    const c = ix.cards[i];
    const cv = v.get(c.id);
    if ((mode === 'only' && !cv.archived) || (mode === 'exclude' && cv.archived)) continue;
    if (key && (c.key !== key || (c.project_key || '') !== (project_key || ''))) continue;
    if (matches(c, q)) out.push({ ...decorate(c, cv), archived: cv.archived });
  }
  return out;
}

function exists(id) {
  refresh();
  return ix.cards.some((c) => c.id === id);
}

const setArchived = (id, archived) => store.setArchived(id, archived);

module.exports = { refresh, reset, state, search, exists, setArchived };
