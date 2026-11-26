#!/usr/bin/env node
// Wait command the session runs in the background.
// It waits quietly (no tokens) until a reply arrives, prints it, and exits.
// Claude Code reports the background command's exit, which wakes the session.
// Messages are dashboard replies, team reports (to a lead) or lead instructions (to a member).
//
// bug-005: it never outlives its session. It finds the Claude process it serves (its owner: the nearest Claude
// ancestor; DDASH_WAIT_OWNER=<pid> overrides, for tests) and exits quietly as soon as the owner is gone (pid dead,
// pid reused by another program, or on POSIX re-parented). It also leaves the session's folder (cwd = home), so it
// never keeps a worktree from being deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./core/config');
const { paths, safeId } = require('./core/paths');
const { ensureDir, readJson, writeJson } = require('./core/fsx');
const { alive, processTable, findClaudePid, processName } = require('./proc/table');
const { waitLockPath, waitInfoPath, waitPid, orphanWaiter, stopWaiter } = require('./proc/waiter');
const { take: takeInbox } = require('./store/inbox');
const { formatMessages } = require('./domain/messages');
const { own } = require('./domain/team');
const { pendingRules } = require('./app/rules');
const sessionsStore = require('./store/sessions');
const lifecycle = require('./app/lifecycle');

try { process.chdir(os.homedir()); } catch { /* stay where we are */ }

const sid = safeId(process.argv[2]);
const POLL_MS = config.get('DDASH_POLL_MS');
const CHECK_MS = config.get('DDASH_WAIT_CHECK_MS'); // owner identity re-check (pid reuse)
const dir = paths.inbox(sid);
const lock = waitLockPath(sid);
const info = waitInfoPath(sid);
ensureDir(dir);

// Don't start a second waiter for the same session (a waiter whose owner died does not count: see waitPid).
// A waiter with no live Claude above it (an orphan, e.g. from an older plugin version) is stopped instead: it
// would take this session's messages and print them to nobody.
const other = waitPid(sid);
if (other && other !== process.pid) {
  const table = processTable();
  // One that exited before the table was read is missing from it (not an orphan to orphanWaiter): gone, not waiting.
  if (orphanWaiter(other, table) || !alive(other)) stopWaiter(sid, table);
  else {
    console.log('Already waiting for replies. Nothing to do.');
    process.exit(0);
  }
}

fs.writeFileSync(lock, String(process.pid));

// The owner: the Claude process this waiter serves.
const startPpid = process.ppid;
let owner = config.get('DDASH_WAIT_OWNER');
let ownerIsClaude = false;
if (!owner) {
  owner = findClaudePid(process.ppid);
  ownerIsClaude = owner > 0;
}
if (!owner) owner = startPpid; // no Claude ancestor found (manual run): watch the parent
const ownerName = processName(owner);

try {
  fs.writeFileSync(info, JSON.stringify({ pid: process.pid, owner, owner_name: ownerName, ppid: startPpid, started: new Date().toISOString() }));
} catch { /* best effort */ }

// A session without a recorded Claude pid (e.g. solo mode) gets it from here, so its death can be detected.
if (ownerIsClaude) {
  try {
    sessionsStore.update((sessions) => {
      const s = own(sessions, sid);
      if (s && !(Number(s.claude_pid) > 0) && !s.headless) s.claude_pid = owner;
    });
  } catch { /* best effort */ }
}

const mine = (file) => {
  try { return Number(file === lock ? fs.readFileSync(file, 'utf8') : JSON.parse(fs.readFileSync(file, 'utf8')).pid) === process.pid; } catch { return false; }
};
const release = () => {
  for (const f of [info, lock]) { try { if (mine(f)) fs.unlinkSync(f); } catch {} }
};
process.on('exit', release);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('SIGHUP', () => process.exit(129));

function ownerGone() {
  if (!alive(owner)) return true;
  if (process.platform !== 'win32' && process.ppid !== startPpid) return true; // re-parented: our shell is gone
  return false;
}
let lastCheck = Date.now();
function ownerReplaced() {
  if (Date.now() - lastCheck < CHECK_MS) return false;
  lastCheck = Date.now();
  if (!ownerName) return false;
  const now = processName(owner);
  return Boolean(now) && now.toLowerCase() !== ownerName.toLowerCase();
}

const timer = setInterval(() => {
  if (ownerGone() || ownerReplaced()) {
    clearInterval(timer);
    process.exit(0); // nobody is listening any more: leave quietly, messages stay in the inbox
  }
  const msgs = takeInbox(sid);
  if (!msgs.length) return;
  clearInterval(timer);
  lifecycle.apply(sid, 'prompt');
  const rules = pendingRules(sid); // new instructions once, after a mode switch
  console.log(`${formatMessages(msgs)}\n\n${rules ? `${rules}\n` : ''}(Start this wait command again in the background now, in the same response as your first tool calls for it.)`);
  process.exit(0);
}, POLL_MS);
