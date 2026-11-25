#!/usr/bin/env node
// Start, stop, or check the dashboard server.
//   node control.js start   start the server detached from the session
//   node control.js stop    stop the server
//   node control.js status
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL, paths, ensureDir, serverPid } = require('./lib');

async function start() {
  if (serverPid()) return `Dashboard is already running: ${URL}`;
  ensureDir(path.dirname(paths.serverLog));
  const log = fs.openSync(paths.serverLog, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true,
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

async function main(cmd) {
  if (cmd === 'start') return start();
  if (cmd === 'stop') return stop();
  return serverPid() ? `Running: ${URL}` : 'Not running';
}

module.exports = { start, stop };

if (require.main === module) {
  main(process.argv[2]).then((msg) => console.log(msg));
}
