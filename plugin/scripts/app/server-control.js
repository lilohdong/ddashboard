// Start and stop the dashboard server (use cases behind control.js and the activation prompt in app/hooks.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL, paths } = require('../core/paths');
const { ensureDir, readJson } = require('../core/fsx');
const { alive } = require('../proc/table');

// The server's pid from its pid file, or 0 when it is not running.
function serverPid() {
  const info = readJson(paths.serverPid, null);
  return info && alive(info.pid) ? info.pid : 0;
}

const SERVER = path.join(__dirname, '..', 'server.js');

// The reason a start failed, in one line: the last line the server wrote to its log after `from` (its error
// message, e.g. "could not start the server (EADDRINUSE)"), or '' when it wrote nothing.
function failReason(from) {
  try {
    const fd = fs.openSync(paths.serverLog, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size - from, 64 * 1024);
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return (lines.filter((l) => /error|could not|EADDRINUSE|EACCES/i.test(l)).pop() || lines.pop() || '').replace(/^ddashboard:\s*/, '');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

async function start() {
  if (serverPid()) return `Dashboard is already running: ${URL}`;
  ensureDir(path.dirname(paths.serverLog));
  const log = fs.openSync(paths.serverLog, 'a');
  const from = fs.fstatSync(log).size;
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    cwd: os.homedir(), // not the session's worktree: the server outlives it (bug-005)
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();
  fs.closeSync(log);
  // Wait briefly for the server to write its pid file; stop waiting as soon as it exits.
  for (let i = 0; i < 30 && !exited; i++) {
    if (serverPid()) return `Dashboard started: ${URL}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (serverPid()) return `Dashboard started: ${URL}`;
  const why = failReason(from);
  return `Could not start the dashboard${why ? `: ${why}` : ''}. Log: ${paths.serverLog}`;
}

function stop() {
  const pid = serverPid();
  if (!pid) return 'Dashboard is not running.';
  try { process.kill(pid); } catch {}
  try { fs.unlinkSync(paths.serverPid); } catch {}
  return 'Dashboard stopped.';
}

function status() {
  return serverPid() ? `Running: ${URL}` : 'Not running';
}

module.exports = { start, stop, status, serverPid, failReason };
