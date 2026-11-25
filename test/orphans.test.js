#!/usr/bin/env node
// BUG-005: orphan processes (see docs/qa/bug-005-orphan-processes.md). Run: node test/orphans.test.js
// Uses a temporary board dir and fake processes it starts itself; never touches ~/.ddashboard, never starts claude,
// never kills a process it did not start.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-orph-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-orph-proj-'));
process.env.DDASH_BOARD_DIR = BOARD;
process.env.DDASH_WINDOW = '0';
process.env.DDASH_ORCA = '0';
delete process.env.DDASH_NAME;

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'scripts', 'lib.js'));
const { paths, readJson, writeJson } = lib;
const KEY = lib.projectKey(CWD);
const WAIT = path.join(ROOT, 'scripts', 'wait-inbox.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const started = [];
const track = (p) => { started.push(p); return p; };
const exited = (p) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.on('exit', r)));
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

// A process that looks like Claude Code to lib.isClaudeProcess (node running a file under "claude-code").
function fakeClaudeFile() {
  const dir = path.join(BOARD, 'claude-code');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cli.js');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  return file;
}
const startFakeClaude = () => track(spawn(process.execPath, [fakeClaudeFile()], { stdio: 'ignore' }));

// The real wait command for sid, watching owner (DDASH_WAIT_OWNER), started in cwd.
function startWaiter(sid, owner, { cwd = os.tmpdir(), env = {} } = {}) {
  const p = spawn(process.execPath, [WAIT, sid], {
    cwd, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, DDASH_POLL_MS: '100', DDASH_WAIT_OWNER: owner ? String(owner) : '', ...env },
  });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  return track(p);
}

function session(sid, extra = {}) {
  const now = new Date().toISOString();
  return { session_id: sid, name: sid, cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', started: now, last_seen: now, ...extra };
}
function reset(sessions = {}) {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  writeJson(paths.projects, { [KEY]: { since: new Date().toISOString(), cwd: CWD } });
  writeJson(paths.sessions, sessions);
  writeJson(paths.serverPid, { pid: process.pid });
}
const lockOf = (sid) => { try { return Number(fs.readFileSync(lib.waitLockPath(sid), 'utf8')); } catch { return 0; } };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- F-1 / F-2 / F-3: the wait command watches its owner ---

test('F-1: the waiter exits by itself when its Claude process dies, and removes its lock', async () => {
  reset({ W1: session('W1') });
  const claude = startFakeClaude();
  const w = startWaiter('W1', claude.pid);
  assert.ok(await until(() => lockOf('W1') === w.pid && lib.readWaitInfo('W1')), 'waiter did not start');
  assert.equal(lib.readWaitInfo('W1').owner, claude.pid);
  assert.equal(lib.waitPid('W1'), w.pid);
  claude.kill();
  await exited(claude);
  assert.ok(await until(() => w.exitCode !== null), 'waiter kept running after its owner died (bug-005)');
  assert.equal(w.exitCode, 0);
  assert.equal(w.out, ''); // nothing printed: nobody listens
  assert.equal(fs.existsSync(lib.waitLockPath('W1')), false);
  assert.equal(fs.existsSync(lib.waitInfoPath('W1')), false);
});

test('F-1: with a live owner the waiter keeps waiting and delivers a message (regression)', async () => {
  reset({ W2: session('W2') });
  const claude = startFakeClaude();
  const w = startWaiter('W2', claude.pid);
  assert.ok(await until(() => lockOf('W2') === w.pid));
  await sleep(500);
  assert.equal(w.exitCode, null);
  lib.deliver('W2', { type: 'reply', text: 'hello there', ts: new Date().toISOString() });
  assert.ok(await until(() => w.exitCode !== null), 'waiter did not wake up');
  assert.match(w.out, /hello there/);
  claude.kill();
});

test('F-2: the waiter does not keep the session folder as its cwd', async () => {
  reset({ W3: session('W3') });
  const claude = startFakeClaude();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-orph-wt-'));
  const w = startWaiter('W3', claude.pid, { cwd: dir });
  assert.ok(await until(() => lockOf('W3') === w.pid && lib.readWaitInfo('W3')));
  // Windows refuses to remove a folder that is a process's cwd; elsewhere this passes either way.
  fs.rmSync(dir, { recursive: true });
  assert.equal(fs.existsSync(dir), false);
  claude.kill();
  await exited(claude);
  assert.ok(await until(() => w.exitCode !== null));
});

test('F-3: a waiter whose owner is dead is not "waiting"; markEnded is not refused', async () => {
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  reset({ W4: session('W4', { last_seen: old }) });
  // A live process in wait.lock (this test) but wait.info names a dead owner.
  const claude = startFakeClaude();
  const dead = claude.pid;
  claude.kill();
  await exited(claude);
  fs.mkdirSync(paths.inbox('W4'), { recursive: true });
  fs.writeFileSync(lib.waitLockPath('W4'), String(process.pid));
  fs.writeFileSync(lib.waitInfoPath('W4'), JSON.stringify({ pid: process.pid, owner: dead }));
  assert.equal(lib.waitPid('W4'), 0);
  assert.equal(lib.markEnded('W4').ok, true);
  // Without wait.info (an older waiter) the lock pid alone still counts, as before.
  reset({ W5: session('W5', { last_seen: old }) });
  fs.mkdirSync(paths.inbox('W5'), { recursive: true });
  fs.writeFileSync(lib.waitLockPath('W5'), String(process.pid));
  assert.equal(lib.waitPid('W5'), process.pid);
});

test('F-3: the waiter records its owner as the session\'s claude_pid when none is known', async () => {
  reset({ W6: session('W6'), W7: session('W7', { claude_pid: 4242 }) });
  // Owner found as a Claude ancestor: start the waiter from a fake claude process.
  const file = path.join(BOARD, 'claude-code', 'spawner.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `const { spawn } = require('child_process');
spawn(process.execPath, [${JSON.stringify(WAIT)}, process.argv[2]], { stdio: 'ignore', env: { ...process.env, DDASH_WAIT_OWNER: '' } });
setInterval(() => {}, 1000);
`);
  const claude = track(spawn(process.execPath, [file, 'W6'], { stdio: 'ignore', env: { ...process.env, DDASH_POLL_MS: '100' } }));
  assert.ok(await until(() => readJson(paths.sessions, {}).W6?.claude_pid === claude.pid, 15000), 'claude_pid not recorded');
  assert.equal(lib.readWaitInfo('W6').owner, claude.pid);
  claude.kill();
  await exited(claude);
  const wp = lib.readWaitInfo('W6').pid;
  // (On Windows node kills a non-detached child with its parent, so the lock may stay behind: waitPid ignores it.)
  assert.ok(await until(() => !lib.alive(wp)), 'waiter of a fake claude did not exit');
  assert.equal(lib.waitPid('W6'), 0);
  assert.equal(readJson(paths.sessions, {}).W7.claude_pid, 4242); // a known pid is never overwritten
});

// --- run ---

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}\n${err.stack}`);
    }
  }
  for (const p of started) { try { p.kill(); } catch {} }
  await sleep(200);
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
