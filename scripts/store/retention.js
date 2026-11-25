// Retention (docs/architecture.md §5.2), run by the server at start and once a day. Each part is best effort.
// - inbox/<sid>/done/: taken messages older than DDASH_RETAIN_DONE_DAYS (and the done/ folder once empty)
// - logs/: files older than DDASH_RETAIN_LOG_DAYS, then the oldest until the folder is under DDASH_RETAIN_LOG_MB
//   (ddashboard.log caps itself and is never removed here)
// - replies.jsonl lines an older server appended after the schema 2 migration go to replies/YYYY-MM.jsonl
// - archived.json entries of cards that are in no card file any more
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const { paths } = require('../core/paths');
const { bestEffort } = require('../core/log');
const replies = require('./replies');
const cards = require('./cards');

const DAY_MS = 24 * 60 * 60 * 1000;

const ls = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const rm = (f) => { try { fs.unlinkSync(f); return true; } catch { return false; } };

function pruneDone(now) {
  const cut = now - config.get('DDASH_RETAIN_DONE_DAYS') * DAY_MS;
  let n = 0;
  for (const sid of ls(paths.inboxDir)) {
    const dir = paths.done(sid);
    for (const f of ls(dir)) {
      const st = stat(path.join(dir, f));
      if (st?.isFile() && st.mtimeMs < cut && rm(path.join(dir, f))) n++;
    }
    try { fs.rmdirSync(dir); } catch { /* not empty or missing */ }
  }
  return n;
}

function pruneLogs(now) {
  const cut = now - config.get('DDASH_RETAIN_LOG_DAYS') * DAY_MS;
  const cap = config.get('DDASH_RETAIN_LOG_MB') * 1024 * 1024;
  const keep = path.basename(paths.appLog);
  let n = 0;
  let list = [];
  for (const f of ls(paths.logsDir)) {
    const file = path.join(paths.logsDir, f);
    const st = stat(file);
    if (!st?.isFile()) continue;
    if (f !== keep && st.mtimeMs < cut) { if (rm(file)) n++; continue; }
    list.push({ f, file, size: st.size, mtime: st.mtimeMs });
  }
  let total = list.reduce((a, e) => a + e.size, 0);
  list = list.filter((e) => e.f !== keep).sort((a, b) => a.mtime - b.mtime);
  for (const e of list) {
    if (total <= cap) break;
    if (rm(e.file)) { n++; total -= e.size; }
  }
  return n;
}

function pruneArchived() {
  const ids = new Set();
  const rd = cards.reader();
  rd.read((c) => { if (c?.id) ids.add(String(c.id)); });
  if (!ids.size) return 0; // no card readable: keep everything
  return cards.archivedStore.update((m) => {
    let n = 0;
    for (const id of Object.keys(m)) if (!ids.has(id)) { delete m[id]; n++; }
    return n;
  });
}

// Returns { done, logs, replies, archived }: how many files, lines or entries each part removed or moved.
function run(now = Date.now()) {
  return {
    done: bestEffort('retention done', () => pruneDone(now), 0),
    logs: bestEffort('retention logs', () => pruneLogs(now), 0),
    replies: bestEffort('retention replies', () => replies.fold(), 0),
    archived: bestEffort('retention archived', () => pruneArchived(), 0),
  };
}

module.exports = { run, pruneDone, pruneLogs, pruneArchived, DAY_MS };
