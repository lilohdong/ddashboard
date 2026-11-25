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

// A fake Claude process that starts the real wait command for sid as its child (owner found as an ancestor).
function claudeWithWaiter(sid) {
  const file = path.join(BOARD, 'claude-code', 'spawner.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `const { spawn } = require('child_process');
spawn(process.execPath, [${JSON.stringify(WAIT)}, process.argv[2]], { stdio: 'ignore', env: { ...process.env, DDASH_WAIT_OWNER: '' } });
setInterval(() => {}, 1000);
`);
  return track(spawn(process.execPath, [file, sid], { stdio: 'ignore', env: { ...process.env, DDASH_POLL_MS: '100' } }));
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
  const claude = claudeWithWaiter('W6');
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

// --- F-4: ending or forgetting a session stops its waiter ---

// A process that looks like a wait command for sid to the process table (an older-version waiter: no wait.info),
// started by this test (no Claude above it, so it is an orphan). Optionally under a wrapper that runs the same
// command, like Claude's bash -c "... node bin/wait.js <sid>".
function fakeWaiterFiles() {
  const dir = path.join(BOARD, 'old', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wait-inbox.js');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  const wrap = path.join(BOARD, 'old', 'wrap.js');
  // The wrapper's own command line names "<dir>/bin/wait.js <sid>"; it starts the waiter detached (Windows node
  // would kill a non-detached child with it, which would hide what is being tested).
  fs.writeFileSync(wrap, `const { spawn } = require('child_process');
const c = spawn(process.execPath, [${JSON.stringify(file)}, process.argv[3]], { stdio: 'ignore', detached: true });
c.unref();
console.log(c.pid);
setInterval(() => {}, 1000);
`);
  return { file, wrap };
}
function startFakeWaiter(sid, { lock = true } = {}) {
  const { file } = fakeWaiterFiles();
  const p = track(spawn(process.execPath, [file, sid], { stdio: 'ignore' }));
  if (lock) {
    fs.mkdirSync(paths.inbox(sid), { recursive: true });
    fs.writeFileSync(lib.waitLockPath(sid), String(p.pid));
  }
  return p;
}
async function startWrappedWaiter(sid) {
  const { wrap } = fakeWaiterFiles();
  const w = track(spawn(process.execPath, [wrap, path.join(BOARD, 'bin', 'wait.js'), sid], { stdio: ['ignore', 'pipe', 'ignore'] }));
  const pid = await new Promise((r) => w.stdout.once('data', (d) => r(Number(String(d).trim()))));
  started.push({ kill: () => { try { process.kill(pid); } catch {} } });
  fs.mkdirSync(paths.inbox(sid), { recursive: true });
  fs.writeFileSync(lib.waitLockPath(sid), String(pid));
  return { wrapper: w, pid };
}

test('waitCommandSid: every plugin version and Claude\'s bash wrapper', () => {
  const sid = 'd0504315-19ba-41a2-b07f-656b621ac05f';
  assert.equal(lib.waitCommandSid(`"C:\\Program Files\\nodejs\\node.exe" C:/Users/u/.ddashboard/bin/wait.js ${sid}`), sid);
  assert.equal(lib.waitCommandSid(`"C:\\Program Files\\nodejs\\node.exe" C:/Users/u/.claude/plugins/cache/ddashboard/ddashboard/0.1.0/scripts/wait-inbox.js ${sid}`), sid);
  assert.equal(lib.waitCommandSid(`bash -c "source /c/x/shell-snapshots/snapshot-bash-1.sh && { eval 'node \\"C:/Users/u/.ddashboard/bin/wait.js\\" ${sid}' < /dev/null; } && pwd -P"`), sid);
  assert.equal(lib.waitCommandSid('/usr/bin/node /home/u/.ddashboard/bin/wait.js abc_1'), 'abc_1');
  assert.equal(lib.waitCommandSid('node server.js'), '');
  assert.equal(lib.waitCommandSid('node await.js x'), '');
});

test('stopWaiter: stops the waiter and its wrapper, removes the lock; never kills a pid that is not a waiter', async () => {
  reset({ X1: session('X1') });
  const { wrapper, pid } = await startWrappedWaiter('X1');
  const table = lib.processTable();
  assert.deepEqual(lib.waiterChain(pid, table), [pid, wrapper.pid]);
  assert.equal(lib.orphanWaiter(pid, table), true); // no Claude above it
  assert.equal(lib.stopWaiter('X1'), true);
  assert.equal(lib.alive(pid), false);
  assert.ok(await until(() => !lib.alive(wrapper.pid)), 'wrapper shell left running');
  assert.equal(fs.existsSync(lib.waitLockPath('X1')), false);
  // pid reuse: the lock names a live process that is not this session's wait command.
  reset({ X2: session('X2') });
  const other = startFakeWaiter('SOMEONE-ELSE', { lock: false });
  const sleeper = startFakeClaude();
  await sleep(300);
  fs.mkdirSync(paths.inbox('X2'), { recursive: true });
  for (const p of [other, sleeper]) {
    fs.writeFileSync(lib.waitLockPath('X2'), String(p.pid));
    assert.equal(lib.stopWaiter('X2'), false);
    assert.equal(lib.alive(p.pid), true);
  }
});

test('forgetSessions stops an orphan waiter and removes the inbox (was: waiter kept, inbox kept)', async () => {
  reset({ X3: session('X3', { state: 'ended', ended: new Date().toISOString() }) });
  const w = startFakeWaiter('X3');
  await sleep(300);
  assert.equal(lib.waitPid('X3'), w.pid);
  assert.deepEqual(lib.forgetSessions(['X3']).forgotten, ['X3']);
  assert.ok(await until(() => !lib.alive(w.pid)), 'waiter of a forgotten session still runs (bug-005)');
  assert.equal(fs.existsSync(paths.inbox('X3')), false);
});

test('markEnded: an orphan waiter (older version, no wait.info) does not block it, and is stopped', async () => {
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  reset({ X4: session('X4', { last_seen: old }) });
  const w = startFakeWaiter('X4');
  await sleep(300);
  assert.equal(lib.waitPid('X4'), w.pid); // legacy rule: the lock pid alone says waiting
  const r = lib.markEnded('X4');
  assert.equal(r.ok, true, r.error);
  assert.ok(await until(() => !lib.alive(w.pid)), 'orphan waiter left running');
  reset({ X5: session('X5', { last_seen: old }) });
  // A waiter under a live Claude still blocks it (the waiter must have a real Claude ancestor).
  const c2 = claudeWithWaiter('X5');
  assert.ok(await until(() => lib.readWaitInfo('X5')?.owner === c2.pid, 15000));
  assert.equal(lib.markEnded('X5').code, 409);
  c2.kill();
});

test('SessionEnd hook stops the session\'s waiter', async () => {
  reset({ X6: session('X6') });
  const w = startFakeWaiter('X6');
  await sleep(300);
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'session-end.js')], { input: JSON.stringify({ session_id: 'X6' }), env: process.env });
  assert.equal(r.status, 0);
  assert.equal(readJson(paths.sessions, {}).X6.state, 'ended');
  assert.ok(await until(() => !lib.alive(w.pid)), 'waiter left running after SessionEnd');
});

test('a new waiter takes over from an orphan waiter instead of saying "Already waiting"', async () => {
  reset({ X7: session('X7') });
  const orphan = startFakeWaiter('X7');
  await sleep(300);
  const claude = startFakeClaude();
  const w = startWaiter('X7', claude.pid);
  assert.ok(await until(() => lockOf('X7') === w.pid, 15000), `new waiter did not take over: ${w.out}`);
  assert.equal(lib.alive(orphan.pid), false);
  assert.doesNotMatch(w.out, /Already waiting/);
  claude.kill();
});

test('reapToolShells: a dead Claude\'s tool shells are stopped (Windows keeps the dead parent pid)', async () => {
  if (process.platform !== 'win32') return; // POSIX re-parents orphans: they are found by the waiter sweep instead
  reset({});
  const snap = path.join(BOARD, 'shell-snapshots', 'snapshot-bash-1.js');
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.writeFileSync(snap, 'setInterval(() => {}, 1000);\n');
  const other = path.join(BOARD, 'other-tool.js');
  fs.writeFileSync(other, 'setInterval(() => {}, 1000);\n');
  const file = path.join(BOARD, 'claude-code', 'parent.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `const { spawn } = require('child_process');
const a = spawn(process.execPath, [${JSON.stringify(snap)}], { stdio: 'ignore', detached: true });
const b = spawn(process.execPath, [${JSON.stringify(other)}], { stdio: 'ignore', detached: true });
console.log(a.pid + ' ' + b.pid);
setInterval(() => {}, 1000);
`);
  const claude = track(spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'] }));
  const [shell, tool] = await new Promise((r) => claude.stdout.once('data', (d) => r(String(d).trim().split(' ').map(Number))));
  started.push({ kill: () => { for (const p of [shell, tool]) try { process.kill(p); } catch {} } });
  assert.deepEqual(lib.reapToolShells(claude.pid), []); // alive: never
  claude.kill();
  await exited(claude);
  assert.deepEqual(lib.reapToolShells(claude.pid), [shell]);
  assert.equal(lib.alive(shell), false);
  assert.equal(lib.alive(tool), true); // not a Claude tool shell: left alone
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
