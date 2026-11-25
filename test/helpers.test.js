#!/usr/bin/env node
// test/helpers.js: free ports and starting a test server. Run: node test/helpers.test.js
// Uses a temporary board dir; never touches ~/.ddashboard or port 7357.
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

process.env.DDASH_BOARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-helpers-'));
process.env.DDASH_ORCA = '0';
process.env.DDASH_WINDOW = '0';
const helpers = require('./helpers');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('freePort: a port nothing listens on, that can be listened on', async () => {
  const port = await helpers.freePort();
  assert.ok(port > 0 && port < 65536);
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.on('error', reject); s.listen(port, '127.0.0.1', resolve); });
  await new Promise((r) => s.close(r));
});

test('startServer: resolves after the listen line, answers at once, stop() ends the process', async () => {
  const srv = await helpers.startServer();
  try {
    assert.match(srv.output(), new RegExp(`ddashboard: http://127\\.0\\.0\\.1:${srv.port} `));
    const r = await fetch(`${srv.base}/api/state`); // no retry loop: it is listening already
    assert.equal(r.status, 200);
    assert.equal(typeof (await r.json()).sessions, 'object');
  } finally { await srv.stop(); }
  assert.ok(srv.proc.exitCode !== null || srv.proc.signalCode !== null, 'server process ended');
});

test('startServer: a port taken by another server is never used; the start retries on a free one', async () => {
  // A foreign HTTP server holds the first port handed out (losing the race between freePort and the server's listen).
  const taken = http.createServer((q, s) => s.end('<!DOCTYPE html>not ddashboard'));
  await new Promise((r) => taken.listen(0, '127.0.0.1', r));
  const busy = taken.address().port;
  const handed = [];
  const nextPort = async () => { const p = handed.length ? await helpers.freePort() : busy; handed.push(p); return p; };
  const srv = await helpers.startServer({ nextPort, attempts: 3 });
  try {
    assert.equal(handed[0], busy);
    assert.equal(handed.length, 2, 'one retry');
    assert.equal(srv.port, handed[1]);
    const r = await fetch(`${srv.base}/api/state`);
    assert.equal(r.status, 200);
    assert.equal(typeof (await r.json()).sessions, 'object');
  } finally { await srv.stop(); taken.close(); }
  // Every attempt on a taken port: a clear error, no hang.
  const t2 = http.createServer(() => {});
  await new Promise((r) => t2.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(helpers.startServer({ nextPort: async () => t2.address().port, attempts: 2 }), /did not start after 2 attempts[\s\S]*EADDRINUSE/);
  } finally { t2.close(); }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
