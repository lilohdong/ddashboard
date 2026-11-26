// inbox/<sid>/*.json: pending messages (reply | report | order); inbox/<sid>/done/: taken ones. The protocol stays
// file based (atomic rename) because the waiter and the Stop hook have no connection to the server.
const fs = require('fs');
const path = require('path');
const { paths, safeId } = require('../core/paths');
const { ensureDir, readJson, writeJson } = require('../core/fsx');
const { newId } = require('../core/ids');

// Put a message into a session's inbox. type: reply | report | order.
function deliver(sid, msg) {
  const m = { id: newId(), ts: new Date().toISOString(), type: 'reply', ...msg, session_id: safeId(sid) };
  ensureDir(paths.inbox(sid));
  writeJson(path.join(paths.inbox(sid), `${m.id}.json`), m);
  return m;
}

// Move pending messages from the inbox to done/. rename is atomic, so each message is taken exactly once even with
// competing processes.
function take(sid) {
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

// Move pending messages from one inbox to another. Returns how many moved.
function move(from, to) {
  let files;
  try { files = fs.readdirSync(paths.inbox(from)).filter((f) => f.endsWith('.json')); } catch { return 0; }
  ensureDir(paths.inbox(to));
  let n = 0;
  for (const f of files) {
    try { fs.renameSync(path.join(paths.inbox(from), f), path.join(paths.inbox(to), f)); n++; } catch { /* taken meanwhile */ }
  }
  return n;
}

module.exports = { deliver, take, move };
