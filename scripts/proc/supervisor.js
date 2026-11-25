// Process lifecycle (docs/architecture.md §3.4). The only "end" effect handler: when a session enters ended,
// app/lifecycle calls stop(s, reason) here. Also the liveness check the server tick uses (gone).
const fs = require('fs');
const { alive, processTable, isClaudeProcess } = require('./table');
const { killTree, killClaude } = require('./kill');
const { waitPid, waitLockPath, stopWaiter, reapToolShells } = require('./waiter');

const ended = (s) => Boolean(s && (s.ended || s.state === 'ended'));

// True when a session (any kind: solo, lead, member, outside) is known to be gone without its SessionEnd hook
// having run (bug-001, bug-005: a terminal closed by hand kills claude before the hook): its recorded Claude
// process is dead, or its pid now belongs to another program (table: a process table taken after the session was
// last seen), or, with no recorded pid, its Orca terminal is closed (isOpen(handle) -> true | false | null for
// unknown; left out: not checked). Never guesses: a live wait command with a live owner, an old record with no pid
// and no terminal, or an unknown terminal state count as alive. Headless sessions keep their own rule (pid exited
// = "finished", resumable).
function gone(s, isOpen, table) {
  if (!s || ended(s) || s.headless) return false;
  const cp = Number(s.claude_pid);
  if (cp > 0) {
    if (!alive(cp)) return true;
    const p = table?.get(cp);
    const fresh = table?.taken && table.taken > new Date(s.last_seen || 0).getTime();
    return Boolean(fresh && p && !isClaudeProcess(p));
  }
  if (waitPid(s.session_id)) return false;
  if (isOpen && s.runner === 'orca' && s.orca?.handle) return isOpen(s.orca.handle) === false;
  return false;
}

// Stop what an ended session may have left running. Every reason: its wait command (and lock files), and the tool
// shells of its Claude process when that is dead. stopped (team end / dashboard end): also its Orca terminal, its
// terminal window, its Claude process tree and its headless run. handoff: also its Claude process.
// Nothing is killed unless it still is what was recorded: the wait command for this session (command line), a
// Claude process (image name), a window shell (opts.windowShell checks it).
// opts: { table, kill(waitPid) (tests), killClaude(pid) (tests), closeTerminal(handle), windowShell(s) -> pid }.
// Returns { waiter, claude, shells: [pids], done: [what was stopped, as text] }.
function stop(s, reason, opts = {}) {
  const out = { waiter: false, claude: false, shells: [], done: [] };
  if (!s?.session_id) return out;
  const sid = s.session_id;
  const full = reason === 'stopped';
  const cp = Number(s.claude_pid) > 0 ? Number(s.claude_pid) : 0;
  let table = opts.table || null;
  const tableNow = () => (table = table || processTable());

  if (full && s.runner === 'orca' && s.orca?.handle && opts.closeTerminal) {
    try { opts.closeTerminal(s.orca.handle); out.done.push(`closed its Orca terminal (${s.orca.handle})`); } catch (err) { out.done.push(`could not close its Orca terminal: ${err.message}`); }
  }
  // A terminal window: its shell (recorded by orca-launch.js) and everything under it, so no empty window stays.
  const shell = full && s.runner === 'window' && opts.windowShell ? opts.windowShell(s) : 0;
  if (shell && killTree(shell)) out.done.push(`closed its terminal window (pid ${s.window_shell_pid})`);

  const wp = waitPid(sid);
  if (wp && opts.kill) out.waiter = Boolean(opts.kill(wp));
  else if (fs.existsSync(waitLockPath(sid))) out.waiter = stopWaiter(sid, tableNow());
  if (out.waiter) out.done.push('stopped its wait command');

  if ((full || reason === 'handoff') && cp) {
    out.claude = Boolean((opts.killClaude || killClaude)(cp));
    if (out.claude) out.done.push(`stopped Claude and its tool processes (pid ${cp})`);
  }
  // Claude already dead (bug-005): the tool shells it left behind (a fresh table when we just stopped it).
  if (out.claude) table = null;
  if (cp && !alive(cp)) out.shells = reapToolShells(cp, tableNow());
  if (out.shells.length) out.done.push(`stopped ${out.shells.length} tool process(es) left by its dead Claude`);
  if (full && s.headless && Number(s.pid) > 0 && alive(Number(s.pid)) && killTree(Number(s.pid))) {
    out.done.push(`stopped the headless run and its tool processes (pid ${s.pid})`);
  }
  return out;
}

module.exports = { gone, stop };
