#!/usr/bin/env node
// Start, stop, or check the dashboard server (app/server-control.js).
//   node control.js start   start the server detached from the session
//   node control.js stop    stop the server
//   node control.js status
const { start, stop, status } = require('./app/server-control');

const USAGE = `Usage: node control.js start|stop|status
  start   start the dashboard server, detached from the session
  stop    stop the server
  status  say whether it is running`;

async function main(cmd) {
  if (cmd === 'start') return start();
  if (cmd === 'stop') return stop();
  if (cmd === 'status') return status();
  process.exitCode = 1;
  return USAGE;
}

module.exports = { start, stop };

if (require.main === module) {
  main(process.argv[2]).then((msg) => console.log(msg));
}
