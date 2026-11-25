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

async function start() {
  if (serverPid()) return `Dashboard is already running: ${URL}`;
  ensureDir(path.dirname(paths.serverLog));
  const log = fs.openSync(paths.serverLog, 'a');
  const child = spawn(process.execPath, [SERVER], {
    detached: true,
    cwd: os.homedir(), // not the session's worktree: the server outlives it (bug-005)
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  // Wait briefly for the server to write its pid file.
  for (let i = 0; i < 30; i++) {
    if (serverPid()) return `Dashboard started: ${URL}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  return `Could not start the dashboard. See ${paths.serverLog}`;
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

module.exports = { start, stop, status, serverPid };
