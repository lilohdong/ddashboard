#!/usr/bin/env node
// app/server-control: a failed start says why in one line; control.js with no command prints its usage.
// Run: node test/server-control.test.js
// Uses a temporary board dir and a port this test holds itself; never touches the installed server (7357).
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-control-'));
const CONTROL = path.join(__dirname, '..', 'plugin', 'scripts', 'control.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Runs control.js in its own process (paths and port are read when it loads).
const control = (args, port) => spawnSync(process.execPath, [CONTROL, ...args], {
  encoding: 'utf8',
  env: { ...process.env, DDASH_BOARD_DIR: BOARD, DDASH_PORT: String(port || 1) },
  timeout: 20000,
});

test('start on a port in use fails with the reason (EADDRINUSE) in one line', async () => {
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  const { port } = holder.address();
  try {
    const t0 = Date.now();
    const r = control(['start'], port);
    const out = r.stdout.trim();
    assert.equal(out.split('\n').length, 1, out);
    assert.match(out, /^Could not start the dashboard: could not start the server \(EADDRINUSE\)\..*Log: /);
    assert.ok(Date.now() - t0 < 2900, 'stops waiting once the server exits');
  } finally {
    holder.close();
  }
});

test('failReason: the last error line written after the offset, without the ddashboard: prefix', () => {
  process.env.DDASH_BOARD_DIR = BOARD;
  const { paths } = require('../plugin/scripts/core/paths');
  const { failReason } = require('../plugin/scripts/app/server-control');
  fs.mkdirSync(path.dirname(paths.serverLog), { recursive: true });
  fs.writeFileSync(paths.serverLog, 'ddashboard: old error from before\n');
  const from = fs.statSync(paths.serverLog).size;
  assert.equal(failReason(from), '');
  fs.appendFileSync(paths.serverLog, 'ddashboard: board migrated to schema 3\r\nddashboard: could not start the server (EACCES). x\r\n');
  assert.equal(failReason(from), 'could not start the server (EACCES). x');
});

test('control.js with no command or an unknown one prints its usage and exits 1', () => {
  for (const args of [[], ['nope']]) {
    const r = control(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stdout, /usage: node control\.js start\|stop\|status/i);
  }
  const s = control(['status']);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /Not running/);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(BOARD, { recursive: true, force: true }); } catch { /* busy on Windows */ }
  process.exitCode = failed ? 1 : 0;
})();
