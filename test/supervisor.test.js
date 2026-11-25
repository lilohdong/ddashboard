#!/usr/bin/env node
// proc/supervisor + the server's liveness tick (refactor step 5). Run: node test/supervisor.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { startServer, freePort } = require('./helpers');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-sup-'));
const BOARD = path.join(TMP, 'board');
process.env.DDASH_BOARD_DIR = BOARD;
process.env.DDASH_ORCA = '0';

const supervisor = require('../scripts/proc/supervisor');
const waiter = require('../scripts/proc/waiter');
const lifecycle = require('../scripts/app/lifecycle');
const sessions = require('../scripts/store/sessions');
const { writeJson, readJson } = require('../scripts/core/fsx');
const { paths } = require('../scripts/core/paths');
const { alive } = require('../scripts/proc/table');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(50); } return false; };
const children = [];
const track = (p) => (children.push(p), p);
const exited = (p) => (p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once('exit', r)));

const NOW = () => new Date().toISOString();
const session = (sid, more = {}) => ({ session_id: sid, name: sid, cwd: TMP, project: 'proj', project_key: 'k', state: 'idle', started: NOW(), last_seen: NOW(), ...more });
function reset(map = {}) {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  writeJson(paths.sessions, map);
}
// A process that is not Claude (plain node idling).
const idle = () => track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
async function deadPid() {
  const p = idle();
  await sleep(100);
  p.kill();
  await exited(p);
  return p.pid;
}

async function withServer(env, fn) {
  const srv = await startServer({ env, track });
  try {
    await fn(srv.base);
  } finally { await srv.stop(); }
}
const state = async (base) => (await fetch(`${base}/api/state`)).json();

test('GET /api/state is read-only: sessions.json mtime unchanged, a gone session waits for the tick', async () => {
  reset({ A: session('A') });
  await withServer({ DDASH_TICK_MS: '600000' }, async (base) => {
    const dead = await deadPid();
    sessions.patch('A', { claude_pid: dead }); // dies after the server started: only the tick may end it
    await sleep(50);
    const before = fs.statSync(paths.sessions).mtimeMs;
    for (let i = 0; i < 5; i++) assert.notEqual((await state(base)).sessions.A.view, 'ended');
    assert.equal(fs.statSync(paths.sessions).mtimeMs, before, 'GET /api/state wrote sessions.json');
    assert.equal(readJson(paths.sessions, {}).A.state, 'idle');
  });
});

test('the server tick ends a gone session (any kind) within one tick', async () => {
  reset({ S: session('S'), L: session('L', { kind: 'lead' }), M: session('M', { kind: 'member', lead: 'L' }), H: session('H', { headless: true }) });
  await withServer({ DDASH_TICK_MS: '300' }, async () => {
    const dead = await deadPid();
    for (const sid of ['S', 'L', 'M', 'H']) sessions.patch(sid, { claude_pid: dead, pid: dead });
    const t0 = Date.now();
    assert.ok(await until(() => ['S', 'L', 'M'].every((sid) => sessions.get(sid).end_reason === 'gone'), 5000), 'not ended by the tick');
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    assert.equal(sessions.get('H').state, 'idle'); // headless: "finished", resumable, never gone
  });
});

test('reapGone with a fake table: a reused Claude pid (now another program) is gone; the live pid is not killed', () => {
  const me = process.pid;
  reset({ R: session('R', { claude_pid: me, last_seen: new Date(Date.now() - 60000).toISOString() }), K: session('K', { claude_pid: me }) });
  const table = new Map([[me, { pid: me, ppid: 0, name: 'notepad.exe', cmd: 'notepad', start: 1 }]]);
  table.taken = Date.now() - 1000; // after R was last seen, before K was
  assert.deepEqual(lifecycle.reapGone(null, table), ['R']);
  assert.equal(sessions.get('R').end_reason, 'gone');
  assert.equal(sessions.get('K').state, 'idle');
  assert.ok(alive(me));
  assert.deepEqual(lifecycle.reapGone(null, table), [], 'an ended session is not ended again');
});

test('stop(stopped) checks identity: a live pid that is not Claude, and a window shell that is not ours, are left alone', async () => {
  const other = idle();
  await sleep(200);
  const s = session('I', { runner: 'window', claude_pid: other.pid, window_shell_pid: other.pid });
  const r = supervisor.stop(s, 'stopped', { windowShell: () => 0 });
  assert.equal(r.claude, false);
  assert.deepEqual(r.done, []);
  assert.ok(alive(other.pid), 'a non-Claude process was killed');
  other.kill();
  await exited(other);
});

test('stop(handoff) calls the kill hooks; stop(exit) never kills Claude', () => {
  const calls = [];
  const s = session('H2', { claude_pid: process.pid });
  const r = supervisor.stop(s, 'handoff', { killClaude: (pid) => (calls.push(pid), true) });
  assert.deepEqual(calls, [process.pid]);
  assert.equal(r.claude, true);
  const r2 = supervisor.stop(s, 'exit', { killClaude: (pid) => (calls.push(pid), true) });
  assert.equal(r2.claude, false);
  assert.equal(calls.length, 1);
});

test('entering ended through lifecycle runs supervisor.stop (a waiter lock of a dead waiter is removed)', () => {
  reset({ W: session('W', { state: 'working' }) });
  fs.mkdirSync(paths.inbox('W'), { recursive: true });
  fs.writeFileSync(waiter.waitLockPath('W'), '999999');
  const r = lifecycle.apply('W', 'end', { reason: 'exit' });
  assert.equal(r.ok, true);
  assert.ok(r.stopped, 'no stop effect ran');
  assert.equal(fs.existsSync(waiter.waitLockPath('W')), false);
});

test('sweep recognizes the wait command of every plugin version', () => {
  assert.equal(waiter.waitCommandSid('node "C:/x/plugins/ddashboard/0.1.0/scripts/wait-inbox.js" abc-1'), 'abc-1');
  assert.equal(waiter.waitCommandSid('node /home/u/.ddashboard/bin/wait.js S2'), 'S2');
  assert.equal(waiter.waitCommandSid('bash -c "source x && node \\"C:/Users/u/.ddashboard/bin/wait.js\\" S3"'), 'S3');
  assert.equal(waiter.waitCommandSid('node server.js'), '');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  for (const p of children) try { p.kill(); } catch { /* gone */ }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* busy on Windows */ }
  process.exitCode = failed ? 1 : 0;
})();
