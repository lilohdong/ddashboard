#!/usr/bin/env node
// Stop hook (no model calls, zero tokens). Only acts on dashboard-connected sessions.
// 1) Find the ```card block in this turn's reply and append it to cards/YYYY-MM.jsonl.
//    "replaces":"last" retires this session's previous card (the server treats it as archived).
// 2) Add this turn's token usage to usage/YYYY-MM.jsonl and the session's running totals (cards or not).
// 3) If replies are waiting in the inbox, keep the session going and hand them over as the next instruction.
const path = require('path');
const {
  paths, readJson, writeJson, appendCard, appendJsonl, readHookInput, safeId, git, takeInbox, formatReplies,
  readTranscriptTail, lastHumanIndex, turnUsage, USAGE_KEYS,
} = require('../lib');

const MAX_DETAILS = 4000;
const MAX_MARK_IDS = 500;

// Assistant text after the last human input.
function lastTurnText(rows) {
  const texts = [];
  for (let i = lastHumanIndex(rows) + 1; i < rows.length; i++) {
    const o = rows[i];
    if (o?.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue;
    for (const c of o.message.content) if (c?.type === 'text') texts.push(c.text);
  }
  return texts.join('\n');
}

// Record this turn's usage. A turn continued by this hook (dashboard reply handed over) has no new
// human input in the transcript, so message ids already counted since the same input are skipped.
function recordUsage(s, sid, rows) {
  const mark = s.usage_mark || {};
  const probe = turnUsage(rows);
  const sameTurn = probe.boundary && probe.boundary === mark.boundary;
  const u = sameTurn ? turnUsage(rows, new Set(mark.ids || [])) : probe;
  let reason = u.reason;
  if (sameTurn && s.reply_handed) reason = 'reply';
  delete s.reply_handed;
  s.usage_mark = { boundary: u.boundary, ids: [...(sameTurn ? mark.ids || [] : []), ...u.ids].slice(-MAX_MARK_IDS) };
  if (!u.ids.length) return; // nothing new (e.g. no transcript)

  const ts = new Date().toISOString();
  appendJsonl(paths.usageFor(ts), {
    ts, session_id: sid, project: s.project || '',
    input: u.input, cache_read: u.cache_read, cache_write: u.cache_write, output: u.output,
    context: u.context, reason,
  });
  const total = s.usage || {};
  s.usage = Object.fromEntries(USAGE_KEYS.map((k) => [k, (Number(total[k]) || 0) + u[k]]));
  s.usage.turns = (Number(total.turns) || 0) + 1;
  s.last_context = u.context;
}

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

function parseCard(text) {
  const blocks = [...String(text).matchAll(/```card\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  const raw = blocks[blocks.length - 1][1].trim();
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
    return card;
  } catch {
    return { status: 'done', title: raw.split('\n')[0].slice(0, 200), summary: raw.split('\n').slice(1, 4), review: [] };
  }
}

(async () => {
  const input = await readHookInput();
  const sid = safeId(input.session_id);
  const sessions = readJson(paths.sessions, {});
  if (!sessions[sid]) return; // not a dashboard session
  const cwd = input.cwd || process.cwd();

  // 1) Record the card. Skip it if it is the same card again (e.g. a reply-driven turn without a new card).
  const rows = input.transcript_path ? readTranscriptTail(input.transcript_path) : [];
  const text = input.last_assistant_message || lastTurnText(rows);
  const card = parseCard(text);
  const cardKey = card && JSON.stringify(card);
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  if (card && sessions[sid].last_card !== cardKey) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // "replaces":"last" is stored as the id of the card it replaces, so the server can archive that one.
    if (card.replaces === 'last') {
      if (sessions[sid].last_card_id) card.replaces = sessions[sid].last_card_id;
      else delete card.replaces;
    }
    appendCard({
      id,
      ts: new Date().toISOString(),
      session_id: sid,
      session_name: sessions[sid].name || path.basename(cwd),
      project: sessions[sid].project || '',
      branch,
      diffstat: git('diff --shortstat HEAD', cwd),
      ...card,
    });
    sessions[sid].last_card = cardKey;
    sessions[sid].last_card_id = id;
    sessions[sid].last_status = card.status;
    sessions[sid].last_title = card.title;
  }

  // 2) Token usage of this turn (never blocks the rest of the hook).
  try { recordUsage(sessions[sid], sid, rows); } catch { /* usage is best effort */ }

  // 3) Hand over waiting replies (the session then stays "working").
  const msgs = takeInbox(sid);
  if (msgs.length) sessions[sid].reply_handed = true;
  if (branch) sessions[sid].branch = branch;
  sessions[sid].state = msgs.length ? 'working' : 'idle';
  sessions[sid].last_seen = new Date().toISOString();
  writeJson(paths.sessions, sessions);

  if (msgs.length) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[Dashboard reply]\n${formatReplies(msgs)}` }));
  }
})();
