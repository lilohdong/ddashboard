#!/usr/bin/env node
// Stop hook (no model calls, zero tokens). Only acts on dashboard-connected sessions.
// 1) Find the ```card block in this turn's reply and append it to cards/YYYY-MM.jsonl.
//    "replaces":"last" retires this session's previous card (the server treats it as archived).
// 2) If replies are waiting in the inbox, keep the session going and hand them over as the next instruction.
const fs = require('fs');
const path = require('path');
const { paths, readJson, writeJson, appendCard, readHookInput, safeId, git, takeInbox, formatReplies } = require('../lib');

const TAIL_BYTES = 4 * 1024 * 1024; // read only the tail of large transcripts
const MAX_DETAILS = 4000;

// Collect assistant text after the last human input, from the tail of the transcript (jsonl).
function lastTurnText(transcriptPath) {
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
  } catch { return ''; }
  let texts = [];
  for (const line of buf.toString('utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o.message?.content;
    if (o.type === 'user') {
      const isHuman = typeof content === 'string' || (Array.isArray(content) && content.some((c) => c.type === 'text'));
      if (isHuman) texts = [];
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c.type === 'text') texts.push(c.text);
    }
  }
  return texts.join('\n');
}

function parseCard(text) {
  const blocks = [...String(text).matchAll(/```card\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  const raw = blocks[blocks.length - 1][1].trim();
  try {
    const c = JSON.parse(raw);
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
  const text = input.last_assistant_message || lastTurnText(input.transcript_path);
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

  // 2) Hand over waiting replies (the session then stays "working").
  const msgs = takeInbox(sid);
  if (branch) sessions[sid].branch = branch;
  sessions[sid].state = msgs.length ? 'working' : 'idle';
  sessions[sid].last_seen = new Date().toISOString();
  writeJson(paths.sessions, sessions);

  if (msgs.length) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `[Dashboard reply]\n${formatReplies(msgs)}` }));
  }
})();
