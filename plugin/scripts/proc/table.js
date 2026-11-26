// The process table: pid -> { pid, ppid, name, start, cmd }, read with one OS call.
//   Windows: one CIM query through PowerShell (~0.4 s); start = creation time as FILETIME (100 ns units).
//   POSIX:   ps -A; start = start time in ms (from lstart, 1 s resolution).
// start tells a process from a later one that reused its pid (see proc/identity).
const path = require('path');
const { execFileSync, execFile } = require('child_process');

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const PS_LIST = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })`t$(($_.CommandLine -replace "[`r`n`t]", " "))" }';

// How to list every process: [file, args].
const PROC_CMD = (platform = process.platform) => (platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST]]
  : ['ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm=,args=']]);

// lstart: "Thu Nov 26 07:03:19 2026" (always 5 words).
const POSIX_LINE = /^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(\S+)\s*(.*)$/;
const POSIX_OLD = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/; // without lstart (older callers' output)

// pid -> { pid, ppid, name, cmd, start } from the list command's output. table.taken = when the read started (ms).
function parseProcessList(out, taken = Date.now(), platform = process.platform) {
  const table = new Map();
  table.taken = taken;
  if (platform === 'win32') {
    for (const line of String(out).split(/\r?\n/)) {
      const [pid, ppid, name, start, ...cmd] = line.split('\t');
      if (Number(pid)) table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), name: name || '', start: Number(start) || 0, cmd: cmd.join(' ') });
    }
  } else {
    for (const line of String(out).split('\n')) {
      const t = line.trim();
      let m = t.match(POSIX_LINE);
      if (m) {
        table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[4]), start: Date.parse(m[3]) || 0, cmd: m[5] });
        continue;
      }
      m = t.match(POSIX_OLD);
      if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]), start: 0, cmd: m[4] });
    }
  }
  return table;
}

function emptyTable() {
  const empty = new Map();
  empty.taken = 0;
  return empty;
}

// Every process (sync). Empty on failure (table.taken is then 0).
function processTable() {
  const taken = Date.now();
  const [file, args] = PROC_CMD();
  try {
    const out = execFileSync(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    return parseProcessList(out, taken);
  } catch {
    return emptyTable();
  }
}

// Same without blocking (the dashboard server): cb(table), or a promise when no callback is given.
function processTableAsync(cb) {
  if (!cb) return new Promise((resolve) => processTableAsync(resolve));
  const taken = Date.now();
  const [file, args] = PROC_CMD();
  execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
    cb(err ? emptyTable() : parseProcessList(stdout, taken));
  });
  return undefined;
}

// The Claude Code process: native claude(.exe), or node/bun running the claude-code package.
function isClaudeProcess(p) {
  if (!p) return false;
  const name = String(p.name).toLowerCase().replace(/\.exe$/, '');
  if (name === 'claude') return true;
  return /^(node|bun)$/.test(name) && /claude-code/i.test(p.cmd);
}

// Nearest Claude Code ancestor of a process (hooks and tool commands run under it through a shell). 0 if none.
function findClaudePid(startPid = process.ppid, table = processTable()) {
  let pid = Number(startPid);
  for (let i = 0; i < 30 && pid; i++) {
    const p = table.get(pid);
    if (!p) return 0;
    if (isClaudeProcess(p)) return pid;
    if (p.ppid === pid) return 0;
    pid = p.ppid;
  }
  return 0;
}

// The image name of a live process ('' when it is gone or cannot be read). Cheap (one tasklist/ps call), for
// checking that a remembered pid still is the same program (pids are reused).
function processName(pid) {
  pid = Number(pid);
  if (!(pid > 0) || !alive(pid)) return '';
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).toString('utf8');
      const m = out.match(/^"([^"]+)","(\d+)"/m);
      return m && Number(m[2]) === pid ? m[1] : '';
    }
    return path.basename(execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString('utf8').trim());
  } catch { return ''; }
}

// Sleep in small steps (sync) until done() or ms passed. Returns done().
function napUntil(done, ms) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < ms / 50 && !done(); i++) Atomics.wait(nap, 0, 0, 50);
  return done();
}

module.exports = { alive, PROC_CMD, parseProcessList, processTable, processTableAsync, isClaudeProcess, findClaudePid, processName, napUntil };
