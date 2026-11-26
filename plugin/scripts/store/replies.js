// Dashboard replies: replies/YYYY-MM.jsonl, one file per month like cards (board schema 2).
// The 0.2.x replies.jsonl is copied into the monthly files by migration 2 and then kept as it is, read-only, for
// older plugins (like the 0.1.0 cards.jsonl). Lines an older server appends to it later are read too (recent()
// merges them by id) and copied over by the retention job (fold()).
const fs = require('fs');
const path = require('path');
const { paths } = require('../core/paths');
const { appendJsonl, readJsonl } = require('../core/fsx');
const { withLock } = require('../core/lock');
const migrate = require('./migrate');

const MONTH = /^\d{4}-\d{2}\.jsonl$/;
const keyOf = (r) => (r && r.id ? `id:${r.id}` : JSON.stringify(r));

// Monthly reply files, oldest first.
function files() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.repliesDir).filter((f) => MONTH.test(f)).sort(); } catch { /* none yet */ }
  return monthly.map((f) => path.join(paths.repliesDir, f));
}

function append(reply) {
  migrate.ensure();
  appendJsonl(paths.repliesFor(reply.ts || new Date().toISOString()), reply);
  return reply;
}

// The newest n replies, oldest first. Reads only as many monthly files as needed, plus the legacy file.
// Writes nothing (GET /api/state).
function recent(n = 1000) {
  const seen = new Set();
  const out = [];
  const add = (r) => {
    const k = keyOf(r);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  const monthly = files();
  for (let i = monthly.length - 1; i >= 0 && out.length < n; i--) readJsonl(monthly[i]).forEach(add);
  readJsonl(paths.replies).forEach(add);
  out.sort((a, b) => String(a?.ts || '').localeCompare(String(b?.ts || '')));
  return out.slice(-n);
}

// Copy lines of the legacy replies.jsonl that are not in the monthly files yet (idempotent). Returns how many.
function fold() {
  return withLock('replies', () => {
    const legacy = readJsonl(paths.replies);
    if (!legacy.length) return 0;
    const have = new Set();
    for (const f of files()) for (const r of readJsonl(f)) have.add(keyOf(r));
    let n = 0;
    for (const r of legacy) {
      if (!r || typeof r !== 'object' || have.has(keyOf(r))) continue;
      const ts = typeof r.ts === 'string' && /^\d{4}-\d{2}/.test(r.ts) ? r.ts : new Date().toISOString();
      appendJsonl(paths.repliesFor(ts), r);
      have.add(keyOf(r));
      n++;
    }
    return n;
  });
}

module.exports = { files, append, recent, fold };
