// Wait commands (bug-005): lock files, the owner-aware "waiting" check, waiter chains, orphan detection, the
// sweep and stopping one session's waiter and the tool shells its dead Claude left. Moved out of lib.js (step 5).
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const { BOARD_DIR, paths, safeId } = require('../core/paths');
const { readJson } = require('../core/fsx');
const { alive, processTable, isClaudeProcess, napUntil } = require('./table');
const { killPid, killTree } = require('./kill');
// --- Wait commands (bug-005: a waiter must never outlive the Claude process that started it) ---
// inbox/<sid>/wait.lock holds the waiter's pid (format kept for older readers); wait.info next to it (not .json: inbox messages are the .json files) holds
// { pid, owner, owner_name, ppid, started } written by wait-inbox.js. owner = the Claude process it serves.
const waitLockPath = (sid) => path.join(paths.inbox(sid), 'wait.lock');
const waitInfoPath = (sid) => path.join(paths.inbox(sid), 'wait.info');
const readWaitInfo = (sid) => readJson(waitInfoPath(sid), null);

// Pid of the session's wait command, if it is running and its owner (when known) is alive. A waiter whose
// Claude process died is an orphan, not "waiting" (it exits by itself; older waiters are swept).
function waitPid(sid) {
  let pid;
  try { pid = Number(fs.readFileSync(waitLockPath(sid), 'utf8')); } catch { return 0; }
  if (!alive(pid)) return 0;
  const info = readWaitInfo(sid);
  if (info && Number(info.pid) === pid && Number(info.owner) > 0 && !alive(Number(info.owner))) return 0;
  return pid;
}

// --- Orphans (bug-005) ---

// The session id a command line runs the wait command for ('' if it is none). Matches every plugin version
// (.../scripts/wait-inbox.js <sid>, ~/.ddashboard/bin/wait.js <sid>), also inside Claude's bash -c "..." wrapper.
const WAIT_CMD = /(?:wait-inbox\.js|[\\/]bin[\\/]wait\.js)[\\"']*\s+[\\"']*([A-Za-z0-9_-]{1,80})/i;
const waitCommandSid = (cmd) => (String(cmd || '').match(WAIT_CMD) || [])[1] || '';
const isNodeLike = (p) => /^(node|bun)(\.exe)?$/i.test(String(p?.name || ''));

// A waiter process (node running the wait command) and the shell wrappers above it that run the same command
// (Claude starts it as bash -c "... node wait.js <sid> ..."). [] if pid is not a waiter. Waiter first.
function waiterChain(pid, table) {
  const p = table.get(Number(pid));
  const sid = p && isNodeLike(p) ? waitCommandSid(p.cmd) : '';
  if (!sid) return [];
  const chain = [p.pid];
  let q = table.get(p.ppid);
  for (let i = 0; i < 10 && q && !chain.includes(q.pid) && !isClaudeProcess(q) && waitCommandSid(q.cmd) === sid; i++) {
    chain.push(q.pid);
    q = table.get(q.ppid);
  }
  return chain;
}

// Kill a waiter and its wrapper shells. Only pids whose command line is the wait command are touched.
function killWaiterChain(pid, table) {
  const chain = waiterChain(pid, table);
  if (!chain.length) return false;
  for (const k of chain) killPid(k);
  return napUntil(() => !alive(pid), 1000);
}

// A waiter whose session is provably gone (it would wait forever): the process that started its chain is dead
// (Windows keeps the dead pid as parent; a live process with that pid started later is a reuse), or it was
// re-parented to init/launchd/systemd (POSIX). A chain under a live Claude, or under a live program that is not
// recognized as Claude, is never called an orphan (no guessing: a wrong answer would kill a working session's waiter).
function orphanWaiter(pid, table) {
  const chain = waiterChain(pid, table);
  if (!chain.length) return false;
  const top = table.get(chain[chain.length - 1]);
  const parent = table.get(top.ppid);
  if (!top.ppid || !parent || !alive(top.ppid)) return true;
  if (parent.start && top.start && parent.start > top.start) return true; // pid reused after the parent died
  if (isClaudeProcess(parent)) return false;
  return top.ppid === 1 || /^(init|systemd|launchd)$/i.test(parent.name);
}

// Stop every orphan waiter in the process table (any plugin version, see orphanWaiter) with its wrapper shells, and
// remove lock files whose waiter is dead. Run by the server at start and every minute. Returns { killed, locks }.
// With DDASH_BOARD_DIR set (tests, a second board), only waiters whose command line lies under that board are
// touched, so a test never stops the real install's waiters or another run's. The real install never sets it.
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const inScope = (p) => !config.isSet('DDASH_BOARD_DIR') || norm(p.cmd).includes(norm(BOARD_DIR));
function sweepWaiters(table) {
  const killed = [];
  if (table?.size) {
    for (const p of table.values()) {
      const sid = isNodeLike(p) && inScope(p) ? waitCommandSid(p.cmd) : '';
      if (sid && alive(p.pid) && orphanWaiter(p.pid, table) && killWaiterChain(p.pid, table)) killed.push({ pid: p.pid, sid });
    }
  }
  let locks = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(BOARD_DIR, 'inbox')); } catch { /* no inbox yet */ }
  for (const d of dirs) {
    let pid = 0;
    try { pid = Number(fs.readFileSync(waitLockPath(d), 'utf8')); } catch { continue; }
    if (pid > 0 && alive(pid)) continue;
    try { fs.unlinkSync(waitLockPath(d)); locks++; } catch { /* gone */ }
    try { if (!alive(Number(readWaitInfo(d)?.pid))) fs.unlinkSync(waitInfoPath(d)); } catch { /* gone */ }
  }
  return { killed, locks };
}

// Stop the session's wait command, if it runs (pid-reuse safe: the pid must still run the wait command for
// this session), and remove its lock files. Returns true if a waiter was stopped.
function stopWaiter(sid, table) {
  sid = safeId(sid);
  let pid = 0;
  try { pid = Number(fs.readFileSync(waitLockPath(sid), 'utf8')); } catch { /* no lock */ }
  let stopped = false;
  if (pid > 0 && alive(pid)) {
    table = table || processTable();
    if (waitCommandSid(table.get(pid)?.cmd) === sid) stopped = killWaiterChain(pid, table);
  }
  if (!(pid > 0) || !alive(pid)) {
    try { if (Number(fs.readFileSync(waitLockPath(sid), 'utf8')) === pid) fs.unlinkSync(waitLockPath(sid)); } catch { /* gone */ }
    try { if (Number(readWaitInfo(sid)?.pid) === pid) fs.unlinkSync(waitInfoPath(sid)); } catch { /* gone */ }
  }
  return stopped;
}

// Tool shells a dead Claude process left behind. Windows keeps the dead pid as their parent pid, so they can be
// found; a Claude Code tool shell is recognizable by its command (bash -c "source .../shell-snapshots/snapshot-...").
// Each is killed with everything under it. Returns the pids killed. Does nothing while claudePid is alive.
function reapToolShells(claudePid, table) {
  claudePid = Number(claudePid);
  if (!(claudePid > 0) || alive(claudePid)) return [];
  const out = [];
  for (const p of (table || processTable()).values()) {
    if (p.ppid === claudePid && /shell-snapshots[\\/]snapshot-/.test(p.cmd) && killTree(p.pid, table)) out.push(p.pid);
  }
  return out;
}

// Everything a finished session may have left running: its wait command and, if its Claude process is dead,
// that process's tool shells. Returns { waiter, shells }.
// True when a session may have something left to stop (a lock file, or a recorded Claude pid that is dead).
const needsProcesses = (s) => Boolean(s?.session_id) && (fs.existsSync(waitLockPath(s.session_id)) || (Number(s.claude_pid) > 0 && !alive(Number(s.claude_pid))));

function stopSessionProcesses(s, table) {
  if (!needsProcesses(s)) return { waiter: false, shells: [] };
  table = table || processTable();
  return { waiter: stopWaiter(s.session_id, table), shells: reapToolShells(s.claude_pid, table) };
}

module.exports = {
  waitLockPath, waitInfoPath, readWaitInfo, waitPid, WAIT_CMD, waitCommandSid, waiterChain, killWaiterChain, orphanWaiter,
  sweepWaiters, stopWaiter, reapToolShells, needsProcesses, stopSessionProcesses,
};
