#!/usr/bin/env node
// Start, stop, or check the dashboard server (app/server-control.js).
//   node control.js start   start the server detached from the session
//   node control.js stop    stop the server
//   node control.js status
const { start, stop, status } = require('./app/server-control');

async function main(cmd) {
  if (cmd === 'start') return start();
  if (cmd === 'stop') return stop();
  return status();
}

module.exports = { start, stop };

if (require.main === module) {
  main(process.argv[2]).then((msg) => console.log(msg));
}
