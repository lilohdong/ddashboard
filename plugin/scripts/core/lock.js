// Cross-process lock for read-modify-write of a board file: BOARD_DIR/locks/<name>.lock, created exclusively
// ('wx') and holding { pid, ts, token }. Synchronous (hooks and CLIs are sync): waiting uses Atomics.wait.
// - A lock whose holder pid is dead, or that is older than STALE_MS, is broken.
// - A caller waits at most TIMEOUT_MS, then breaks the lock and logs it: hooks must never hang Claude.
// - Re-entrant inside one process (a nested withLock of the same name just runs fn).
// Critical sections must stay short: read, change, write. No git, transcript parsing or process calls inside.
const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');
const { sleep } = require('./fsx');
const { log } = require('./log');

const STALE_MS = 10000;
const TIMEOUT_MS = 5000;
const held = new Map(); // name -> depth (this process)
let seq = 0;

const lockFile = (name) => path.join(paths.locksDir, `${name}.lock`);

function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function readHolder(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Remove the lock file if it still holds the given content (another process may have taken it meanwhile).
function breakLock(file, seen) {
  try {
    if (fs.readFileSync(file, 'utf8') === seen) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

function acquire(name, { timeoutMs = TIMEOUT_MS, staleMs = STALE_MS } = {}) {
  const file = lockFile(name);
  const body = JSON.stringify({ pid: process.pid, ts: Date.now(), token: `${process.pid}-${Date.now()}-${seq++}` });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      return body;
    } catch (err) {
      if (err.code === 'ENOENT') { fs.mkdirSync(path.dirname(file), { recursive: true }); continue; }
      if (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
    }
    let seen;
    let age;
    try {
      seen = fs.readFileSync(file, 'utf8');
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch { continue; } // released meanwhile
    const h = readHolder(seen); // null while the holder is still writing it: fresh until it is old
    const dead = h && !alive(Number(h.pid));
    if (dead || age > staleMs) {
      log('lock', `broke stale lock ${name} (holder ${h?.pid ?? '?'} ${dead ? 'dead' : 'alive'}, age ${age} ms)`);
      breakLock(file, seen);
      continue;
    }
    if (Date.now() - start > timeoutMs) {
      log('lock', `timeout after ${timeoutMs} ms waiting for ${name} (holder ${h?.pid ?? '?'}, age ${age} ms); breaking it`);
      breakLock(file, seen);
      continue;
    }
    sleep(10 + Math.floor(Math.random() * 21));
  }
}

// Run fn while holding the named lock; returns fn's result.
function withLock(name, fn, opts) {
  const depth = held.get(name) || 0;
  if (depth) {
    held.set(name, depth + 1);
    try { return fn(); } finally { held.set(name, depth); }
  }
  const body = acquire(name, opts);
  held.set(name, 1);
  try { return fn(); } finally {
    held.delete(name);
    breakLock(lockFile(name), body);
  }
}

const isHeld = (name) => (held.get(name) || 0) > 0;

module.exports = { withLock, isHeld, lockFile, STALE_MS, TIMEOUT_MS };
