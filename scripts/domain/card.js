// Cards, pure: parsing the ```card block of a reply, task keys, and the displayed lifecycle
// (docs/architecture.md §4.2). No I/O: the store reads and appends card files, app/cards combines both.
const MAX_DETAILS = 4000;
const KEY_RE = /^[a-z0-9_-]{1,60}$/; // card "key": a task name; anything else is dropped, the card is kept
// Lowercased, with spaces as '-', before the check ("Login Fix" -> "login-fix").
const normKey = (k) => k.trim().toLowerCase().replace(/\s+/g, '-');

// --- Parsing ---

// Escape raw control characters that appear inside JSON string literals (models often write
// multi-line "details" with real newlines). Characters outside strings are left as they are.
function escapeControlsInStrings(raw) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === '\n') { out += '\\n'; continue; }
      else if (ch === '\r') { out += '\\r'; continue; }
      else if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function parseJsonLenient(raw) {
  try { return JSON.parse(raw); } catch { return JSON.parse(escapeControlsInStrings(raw)); }
}

// Body of the last ```card block. A ``` inside the JSON (e.g. a code block in "details") is not the
// closing fence, so try each following ``` in turn and take the first one that leaves valid JSON.
function cardBody(text) {
  const s = String(text);
  const opens = [...s.matchAll(/```card[ \t]*\r?\n/g)];
  if (!opens.length) return null;
  const start = opens[opens.length - 1].index + opens[opens.length - 1][0].length;
  let first = null;
  for (let end = s.indexOf('```', start); end !== -1; end = s.indexOf('```', end + 3)) {
    const raw = s.slice(start, end).trim();
    if (first == null) first = raw;
    try { parseJsonLenient(raw); return raw; } catch { /* not the closing fence */ }
  }
  return first ?? s.slice(start).trim();
}

// The card of a reply (null when it has none). Invalid JSON still makes a card from the raw lines.
function parseCard(text) {
  const raw = cardBody(text);
  if (raw == null) return null;
  try {
    const c = parseJsonLenient(raw);
    const card = {
      status: String(c.status || 'done'),
      title: String(c.title || '(untitled)').slice(0, 200),
      summary: [].concat(c.summary || []).map(String).slice(0, 3),
      review: [].concat(c.review || []).map(String).slice(0, 5),
    };
    if (c.details != null && String(c.details).trim()) card.details = String(c.details).slice(0, MAX_DETAILS);
    if (c.replaces === 'last') card.replaces = 'last';
    if (typeof c.key === 'string' && KEY_RE.test(normKey(c.key))) card.key = normKey(c.key);
    return card;
  } catch {
    return { status: 'done', title: raw.split('\n')[0].slice(0, 200), summary: raw.split('\n').slice(1, 4), review: [] };
  }
}

// --- Index (in memory; fed with cards in file order) ---

// Same project and same key: only the newest card stays, every other one counts as replaced.
// Cards without project_key (written before keys existed) and member reports never take part.
const keyOf = (card) => (card.key && card.project_key && !card.via_lead ? `${card.project_key}\n${card.key}` : '');

function createIndex() {
  const ix = {
    cards: [], // oldest first (after sort())
    replaced: new Set(), // ids retired by a later card's "replaces" or by a newer card with the same key
    byKey: new Map(), // keyOf -> { latest card, times: ts of every card in the group }
    lastBySession: {}, // session_id -> latest card of that session
    unsorted: false,
  };

  function addKeyed(card) {
    const k = keyOf(card);
    if (!k) return;
    const g = ix.byKey.get(k);
    if (!g) { ix.byKey.set(k, { latest: card, times: [card.ts] }); return; }
    g.times.push(card.ts);
    if (card.ts >= g.latest.ts) { ix.replaced.add(g.latest.id); g.latest = card; } else ix.replaced.add(card.id);
  }

  ix.add = (card) => {
    if (!card || typeof card !== 'object' || !card.id) return;
    card.id = String(card.id);
    card.ts = String(card.ts || '');
    if (ix.cards.length && card.ts < ix.cards[ix.cards.length - 1].ts) ix.unsorted = true;
    ix.cards.push(card);
    if (card.replaces) ix.replaced.add(String(card.replaces));
    addKeyed(card);
    const sid = card.session_id;
    if (sid && (!ix.lastBySession[sid] || card.ts >= ix.lastBySession[sid].ts)) ix.lastBySession[sid] = card;
  };

  ix.sort = () => {
    if (!ix.unsorted) return;
    ix.cards.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    ix.unsorted = false;
  };

  // A keyed card's key_prev: how many earlier cards of its project share its key.
  ix.keyPrev = (card) => {
    const g = keyOf(card) && ix.byKey.get(keyOf(card));
    return g ? g.times.filter((ts) => ts < card.ts).length : 0;
  };

  return ix;
}

// --- Lifecycle (§4.2) ---

// A session counts as ended when it is ended or forgotten (no record).
const sessionEnded = (s) => !s || s.state === 'ended' || Boolean(s.ended);

// Folding and stopped, computed from the card log (oldest first) and the sessions map; nothing is stored.
// Per session, the open set is its wip cards not yet folded. A newer card C of the same session (any status)
// folds the whole open set under itself; the open set is then {C} if C is wip, else empty. Chains collapse:
// folded_into is always the top card, and every folded card takes the top card's outcome.
// An ended session's open wip card is "stopped" (and so is everything folded under it).
// Returns Map id -> { outcome, folded_into?, stopped? } for every card with a session.
function lifecycle(cards, sessions = {}) {
  const parent = new Map(); // id -> id of the card it was folded under (direct)
  const open = new Map(); // session_id -> ids of open wip cards
  const byId = new Map();
  for (const c of cards) {
    const sid = c.session_id;
    if (!sid) continue;
    byId.set(c.id, c);
    for (const id of open.get(sid) || []) parent.set(id, c.id);
    open.set(sid, c.status === 'wip' ? [c.id] : []);
  }
  // A parent is always newer, so newest first every parent's top is known before its children's.
  const top = new Map();
  const list = [...byId.values()];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = parent.get(list[i].id);
    top.set(list[i].id, p ? top.get(p) ?? p : list[i].id);
  }
  const out = new Map();
  for (const c of list) {
    const t = byId.get(top.get(c.id));
    const stopped = t.status === 'wip' && sessionEnded(sessions[t.session_id]);
    const v = { outcome: stopped ? 'stopped' : t.status };
    if (t !== c) v.folded_into = t.id;
    if (stopped) v.stopped = true;
    out.set(c.id, v);
  }
  return out;
}

// The effective status of a card: its lifecycle outcome, else its own status.
const outcomeOf = (card) => card.outcome || card.status;

module.exports = {
  MAX_DETAILS, KEY_RE, normKey, escapeControlsInStrings, parseJsonLenient, cardBody, parseCard,
  keyOf, createIndex, sessionEnded, lifecycle, outcomeOf,
};
