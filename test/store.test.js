#!/usr/bin/env node
// core/lock + store/* tests (refactor step 2). Run: node test/store.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-store-'));
const BOARD = path.join(TMP, 'board');
process.env.DDASH_BOARD_DIR = BOARD;

const { withLock, lockFile } = require('../scripts/core/lock');
const sessions = require('../scripts/store/sessions');
const projects = require('../scripts/store/projects');
const { paths } = require('../scripts/core/paths');
const { readJson, writeJson } = require('../scripts/core/fsx');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const reset = () => {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
};
const appLog = () => { try { return fs.readFileSync(paths.appLog, 'utf8'); } catch { return ''; } };

// A pid that is surely dead: a process that has exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim() * 1;
}

const WORKER = `
const sessions = require(${JSON.stringify(path.join(ROOT, 'scripts', 'store', 'sessions.js'))});
const [, , w, n] = process.argv;
for (let i = 0; i < Number(n); i++) {
  sessions.patch('S', { ['w' + w + '_' + i]: i });
  if (i % 10 === 0) sessions.update((m) => { m.S['count_' + w] = (m.S['count_' + w] || 0) + 1; });
}
`;

test('8 processes x 50 patches of different fields: no field lost, no lost increments', async () => {
  reset();
  writeJson(paths.sessions, { S: { session_id: 'S' } });
  const script = path.join(TMP, 'worker.js');
  fs.writeFileSync(script, WORKER);
  const W = 8;
  const N = 50;
  await Promise.all(Array.from({ length: W }, (_, w) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, String(w), String(N)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}: ${err}`))));
  })));
  const s = readJson(paths.sessions, {}).S;
  const missing = [];
  for (let w = 0; w < W; w++) {
    for (let i = 0; i < N; i++) if (s[`w${w}_${i}`] !== i) missing.push(`w${w}_${i}`);
    assert.equal(s[`count_${w}`], N / 10, `count_${w}`);
  }
  assert.deepEqual(missing, []);
  assert.equal(fs.existsSync(lockFile('sessions')), false, 'lock released');
});

test('a lock left by a dead process is broken at once (and logged)', () => {
  reset();
  fs.mkdirSync(paths.locksDir, { recursive: true });
  fs.writeFileSync(lockFile('sessions'), JSON.stringify({ pid: deadPid(), ts: Date.now(), token: 'x' }));
  const t0 = Date.now();
  assert.equal(withLock('sessions', () => 'ran'), 'ran');
  assert.ok(Date.now() - t0 < 1000, 'no waiting for a dead holder');
  assert.match(appLog(), /broke stale lock sessions \(holder \d+ dead/);
  assert.equal(fs.existsSync(lockFile('sessions')), false);
});

test('an old lock of a live process is broken (stale age)', () => {
  reset();
  fs.mkdirSync(paths.locksDir, { recursive: true });
  const f = lockFile('projects');
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid || 1, ts: 0, token: 'old' }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(f, old, old);
  assert.equal(withLock('projects', () => 1), 1);
  assert.match(appLog(), /broke stale lock projects/);
});

test('a live holder that never lets go: the waiter breaks the lock after the timeout and logs it', () => {
  reset();
  fs.mkdirSync(paths.locksDir, { recursive: true });
  // Held by a live process (our parent), fresh.
  fs.writeFileSync(lockFile('sessions'), JSON.stringify({ pid: process.ppid, ts: Date.now(), token: 'held' }));
  const t0 = Date.now();
  assert.equal(withLock('sessions', () => 'late', { timeoutMs: 300 }), 'late');
  const waited = Date.now() - t0;
  assert.ok(waited >= 300 && waited < 3000, `waited ${waited} ms`);
  assert.match(appLog(), /timeout after 300 ms waiting for sessions/);
});

test('a held lock makes another process wait until it is released', async () => {
  reset();
  writeJson(paths.sessions, { S: { session_id: 'S', n: 0 } });
  const script = path.join(TMP, 'holder.js');
  fs.writeFileSync(script, `
const sessions = require(${JSON.stringify(path.join(ROOT, 'scripts', 'store', 'sessions.js'))});
const { sleep } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'core', 'fsx.js'))});
sessions.update((m) => { console.log('locked'); sleep(600); m.S.n += 1; m.S.holder = true; });
`);
  const p = spawn(process.execPath, [script], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => p.stdout.once('data', resolve));
  const t0 = Date.now();
  sessions.update((m) => { m.S.n += 1; m.S.me = true; });
  assert.ok(Date.now() - t0 >= 300, 'waited for the holder');
  await new Promise((resolve) => p.on('exit', resolve));
  assert.deepEqual(readJson(paths.sessions, {}).S, { session_id: 'S', n: 2, holder: true, me: true });
});

test('update: nested updates share one map and write once; reads inside see it; no write when unchanged', () => {
  reset();
  writeJson(paths.sessions, { A: { x: 1 } });
  const mtime = () => fs.statSync(paths.sessions).mtimeMs;
  const r = sessions.update((m) => {
    m.A.x = 2;
    assert.equal(sessions.read().A.x, 2, 'read inside the update sees the change');
    sessions.patch('A', { y: 3 });
    assert.equal(m.A.y, 3);
    return 'r';
  });
  assert.equal(r, 'r');
  assert.deepEqual(readJson(paths.sessions, {}), { A: { x: 2, y: 3 } });
  const t = mtime();
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(paths.sessions, old, old);
  sessions.update(() => {});
  assert.notEqual(mtime(), t, 'sanity');
  assert.equal(Math.round(mtime()), Math.round(old.getTime()), 'unchanged map is not written');
});

test('patch: undefined deletes a field; unknown record → false', () => {
  reset();
  writeJson(paths.sessions, { A: { x: 1, ended: 'yes' } });
  assert.equal(sessions.patch('A', { ended: undefined, state: 'working' }), true);
  assert.deepEqual(sessions.get('A'), { x: 1, state: 'working' });
  assert.equal(sessions.patch('B', { x: 1 }), false);
  assert.equal(sessions.get('B'), undefined);
  assert.equal(sessions.get('constructor'), undefined);
});

test('patchDiff: writes only the fields the slow code changed; keeps fields others wrote meanwhile; guard can veto', () => {
  reset();
  writeJson(paths.sessions, { A: { state: 'working', usage: { t: 1 }, old: 1 } });
  const before = JSON.parse(JSON.stringify(sessions.get('A')));
  const mine = { ...before, usage: { t: 2 }, state: 'idle', last_card: 'c' };
  delete mine.old;
  // Meanwhile another process ends the session and records a pid.
  sessions.patch('A', { state: 'ended', ended: 'ts', claude_pid: 42 });
  sessions.patchDiff('A', before, mine, (cur, changes) => { if (cur.state === 'ended') delete changes.state; });
  assert.deepEqual(sessions.get('A'), { state: 'ended', usage: { t: 2 }, ended: 'ts', claude_pid: 42, last_card: 'c' });
  sessions.update((m) => { delete m.A; });
  assert.equal(sessions.patchDiff('A', before, mine), false, 'a forgotten session is not re-created');
  assert.deepEqual(readJson(paths.sessions, {}), {});
});

test('lock order: projects then sessions, nested, both written', () => {
  reset();
  projects.update((p) => sessions.update((s) => { p.K = { cwd: '/x' }; s.A = { project_key: 'K' }; }));
  assert.deepEqual(readJson(paths.projects, {}), { K: { cwd: '/x' } });
  assert.deepEqual(readJson(paths.sessions, {}), { A: { project_key: 'K' } });
  assert.deepEqual(fs.readdirSync(paths.locksDir), []);
});

test('an exception inside update leaves the file unchanged and releases the lock', () => {
  reset();
  writeJson(paths.sessions, { A: { x: 1 } });
  assert.throws(() => sessions.update((m) => { m.A.x = 9; throw new Error('boom'); }), /boom/);
  assert.deepEqual(readJson(paths.sessions, {}), { A: { x: 1 } });
  assert.equal(fs.existsSync(lockFile('sessions')), false);
  sessions.patch('A', { x: 2 });
  assert.equal(sessions.get('A').x, 2);
});

test('lib writers go through the store: setState / markGone / forgetSessions keep a concurrent field', () => {
  reset();
  const lib = require('../scripts/lib');
  writeJson(paths.sessions, { A: { session_id: 'A', state: 'idle' }, B: { session_id: 'B', state: 'idle' } });
  sessions.update((m) => {
    // Nested: lib calls inside an update work on the same map.
    lib.setState('A', 'working');
    m.B.extra = 1;
  });
  assert.equal(sessions.get('A').state, 'working');
  assert.equal(sessions.get('B').extra, 1);
  assert.deepEqual(lib.markGone(['B']), ['B']);
  assert.equal(sessions.get('B').end_reason, 'gone');
  assert.deepEqual(lib.forgetSessions(['A', 'B']).forgotten, ['B']);
  assert.deepEqual(Object.keys(readJson(paths.sessions, {})), ['A']);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
