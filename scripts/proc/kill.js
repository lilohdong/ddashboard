// Stopping processes: one pid, a process tree, a Claude Code process (only if the pid still is one).
const { execFileSync } = require('child_process');
const { alive, processTable, isClaudeProcess, napUntil } = require('./table');

function killPid(pid) {
  try { process.kill(pid); return true; } catch { return false; }
}

// Pids below pid in a process table (children, grandchildren, ...).
function descendants(pid, table = processTable()) {
  const out = [];
  const queue = [Number(pid)];
  while (queue.length) {
    const p = queue.shift();
    for (const q of table.values()) if (q.ppid === p && q.pid !== p && !out.includes(q.pid)) { out.push(q.pid); queue.push(q.pid); }
  }
  return out;
}

// Kill pid and everything it started (tool commands of a Claude process, the program in a terminal window).
// Windows: taskkill /T /F. Elsewhere: its process group when it leads one, then each descendant, then pid;
// SIGKILL when SIGTERM is ignored for 1 s. Returns true if pid was alive and is gone.
function killTree(pid, table) {
  pid = Number(pid);
  if (!(pid > 0) || !alive(pid)) return false;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch { /* checked below */ }
    if (alive(pid)) killPid(pid);
  } else {
    const kids = descendants(pid, table || processTable());
    try { process.kill(-pid, 'SIGTERM'); } catch { /* not a group leader */ }
    for (const k of kids.reverse()) { try { process.kill(k, 'SIGTERM'); } catch { /* gone */ } }
    killPid(pid);
    if (!napUntil(() => !alive(pid), 1000)) {
      // SIGTERM ignored: force it (bug-005, nothing may stay behind).
      for (const k of [...kids, pid]) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
  napUntil(() => !alive(pid), 1000); // up to 1 s for the exit to show
  return !alive(pid);
}

// Kill pid and its tool processes, only if it is still a Claude Code process (the pid may have been reused).
function killClaude(pid) {
  const table = alive(pid) ? processTable() : null;
  if (!table || !isClaudeProcess(table.get(pid))) return false;
  return killTree(pid, table);
}

module.exports = { killPid, descendants, killTree, killClaude };
