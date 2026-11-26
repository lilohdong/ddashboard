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
const { startServer, freePort } = require('./helpers');
const corePaths = require(path.join(ROOT, 'scripts', 'core', 'paths.js'));
const coreFsx = require(path.join(ROOT, 'scripts', 'core', 'fsx.js'));
const procTable = require(path.join(ROOT, 'scripts', 'proc', 'table.js'));
const procWaiter = require(path.join(ROOT, 'scripts', 'proc', 'waiter.js'));
const storeInbox = require(path.join(ROOT, 'scripts', 'store', 'inbox.js'));
const appSessions = require(path.join(ROOT, 'scripts', 'app', 'sessions.js'));
const appProjects = require(path.join(ROOT, 'scripts', 'app', 'projects.js'));
const { paths } = corePaths;
const { readJson, writeJson } = coreFsx;
const KEY = appProjects.projectKey(CWD);
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

// A process that looks like Claude Code to procTable.isClaudeProcess (node running a file under "claude-code").
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
  // A process of the previous test may still be closing a file in the board (Windows): retry.
  fs.rmSync(BOARD, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  fs.mkdirSync(BOARD, { recursive: true });
  writeJson(paths.projects, { [KEY]: { since: new Date().toISOString(), cwd: CWD } });
  writeJson(paths.sessions, sessions);
  writeJson(paths.serverPid, { pid: process.pid });
}
const lockOf = (sid) => { try { return Number(fs.readFileSync(procWaiter.waitLockPath(sid), 'utf8')); } catch { return 0; } };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The fake orphan waiters below look exactly like real ones, so any other dashboard server on this machine that
// runs without DDASH_BOARD_DIR (the user's own, a QA copy) stops them in its sweep (every minute, unscoped). That is
// correct for that server and outside this test's control. A test calls need(pid, ...) where it relies on its own
// orphans still running; if one was stopped from outside, the test starts over with fresh processes (up to TRIES).
// Every assert stays as strict: need() never checks what this test's own code under test did.
// Swept is also thrown when a "dead" pid (deadPid) was reused by a new process mid-test (Windows reuses pids fast).
class Swept extends Error {}
const TRIES = 4;
function need(...pids) {
  const gone = pids.filter((pid) => !procTable.alive(pid));
  if (gone.length) throw new Swept(`stopped from outside this test: ${gone.join(', ')}`);
}

// --- F-1 / F-2 / F-3: the wait command watches its owner ---

test('F-1: the waiter exits by itself when its Claude process dies, and removes its lock', async () => {
  reset({ W1: session('W1') });
  const claude = startFakeClaude();
  const w = startWaiter('W1', claude.pid);
  assert.ok(await until(() => lockOf('W1') === w.pid && procWaiter.readWaitInfo('W1')), 'waiter did not start');
  assert.equal(procWaiter.readWaitInfo('W1').owner, claude.pid);
  assert.equal(procWaiter.waitPid('W1'), w.pid);
  claude.kill();
  await exited(claude);
  assert.ok(await until(() => w.exitCode !== null), 'waiter kept running after its owner died (bug-005)');
  assert.equal(w.exitCode, 0);
  assert.equal(w.out, ''); // nothing printed: nobody listens
  assert.equal(fs.existsSync(procWaiter.waitLockPath('W1')), false);
  assert.equal(fs.existsSync(procWaiter.waitInfoPath('W1')), false);
});

test('F-1: with a live owner the waiter keeps waiting and delivers a message (regression)', async () => {
  reset({ W2: session('W2') });
  const claude = startFakeClaude();
  const w = startWaiter('W2', claude.pid);
  assert.ok(await until(() => lockOf('W2') === w.pid));
  await sleep(500);
  assert.equal(w.exitCode, null);
  storeInbox.deliver('W2', { type: 'reply', text: 'hello there', ts: new Date().toISOString() });
  assert.ok(await until(() => w.exitCode !== null), 'waiter did not wake up');
  assert.match(w.out, /hello there/);
  claude.kill();
});

test('F-2: the waiter does not keep the session folder as its cwd', async () => {
  reset({ W3: session('W3') });
  const claude = startFakeClaude();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-orph-wt-'));
  const w = startWaiter('W3', claude.pid, { cwd: dir });
  assert.ok(await until(() => lockOf('W3') === w.pid && procWaiter.readWaitInfo('W3')));
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
  fs.writeFileSync(procWaiter.waitLockPath('W4'), String(process.pid));
  fs.writeFileSync(procWaiter.waitInfoPath('W4'), JSON.stringify({ pid: process.pid, owner: dead }));
  assert.equal(procWaiter.waitPid('W4'), 0);
  assert.equal(appSessions.markEnded('W4').ok, true);
  // Without wait.info (an older waiter) the lock pid alone still counts, as before.
  reset({ W5: session('W5', { last_seen: old }) });
  fs.mkdirSync(paths.inbox('W5'), { recursive: true });
  fs.writeFileSync(procWaiter.waitLockPath('W5'), String(process.pid));
  assert.equal(procWaiter.waitPid('W5'), process.pid);
});

test('F-3: the waiter records its owner as the session\'s claude_pid when none is known', async () => {
  reset({ W6: session('W6'), W7: session('W7', { claude_pid: 4242 }) });
  const claude = claudeWithWaiter('W6');
  assert.ok(await until(() => readJson(paths.sessions, {}).W6?.claude_pid === claude.pid, 15000), 'claude_pid not recorded');
  assert.equal(procWaiter.readWaitInfo('W6').owner, claude.pid);
  claude.kill();
  await exited(claude);
  const wp = procWaiter.readWaitInfo('W6').pid;
  // (On Windows node kills a non-detached child with its parent, so the lock may stay behind: waitPid ignores it.)
  assert.ok(await until(() => !procTable.alive(wp)), 'waiter of a fake claude did not exit');
  assert.equal(procWaiter.waitPid('W6'), 0);
  assert.equal(readJson(paths.sessions, {}).W7.claude_pid, 4242); // a known pid is never overwritten
});

// --- F-4: ending or forgetting a session stops its waiter ---

// Start node <file> <args> as an orphan, like a process whose Claude died: a launcher starts it detached and
// exits at once, so nothing (not even a Claude running these tests) is above it. Returns its pid.
const orphansStarted = new Set(); // every orphan this file started (the sweep may only ever kill these)
async function startOrphan(file, args = []) {
  const launcher = path.join(BOARD, 'launch.js');
  fs.writeFileSync(launcher, `const { spawn } = require('child_process');
const c = spawn(process.execPath, process.argv.slice(2), { stdio: 'ignore', detached: true });
c.unref();
console.log(c.pid);
`);
  const l = spawn(process.execPath, [launcher, file, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  l.stdout.on('data', (d) => (out += d));
  await exited(l);
  const pid = Number(out.trim());
  assert.ok(pid > 0, 'orphan did not start');
  orphansStarted.add(pid);
  started.push({ kill: () => { try { process.kill(pid); } catch {} } });
  return pid;
}

// A process that looks like a wait command for sid to the process table (an older-version waiter: no wait.info),
// orphaned. Optionally under an orphaned wrapper that runs the same command, like Claude's
// bash -c "... node bin/wait.js <sid>".
function fakeWaiterFiles() {
  const dir = path.join(BOARD, 'old', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wait-inbox.js');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  const wrap = path.join(BOARD, 'old', 'wrap.js');
  // The wrapper's own command line names "<dir>/bin/wait.js <sid>"; it starts the waiter detached (Windows node
  // would kill a non-detached child with it, which would hide what is being tested) and writes its pid to a file.
  fs.writeFileSync(wrap, `const fs = require('fs');
const { spawn } = require('child_process');
const c = spawn(process.execPath, [${JSON.stringify(file)}, process.argv[3]], { stdio: 'ignore', detached: true });
c.unref();
fs.writeFileSync(process.argv[4], String(c.pid));
setInterval(() => {}, 1000);
`);
  return { file, wrap };
}
async function startFakeWaiter(sid, { lock = true } = {}) {
  const { file } = fakeWaiterFiles();
  const pid = await startOrphan(file, [sid]);
  if (lock) {
    fs.mkdirSync(paths.inbox(sid), { recursive: true });
    fs.writeFileSync(procWaiter.waitLockPath(sid), String(pid));
  }
  return { pid };
}
async function startWrappedWaiter(sid) {
  const { wrap } = fakeWaiterFiles();
  const out = path.join(BOARD, `wrapped-${sid}.pid`);
  const wrapper = await startOrphan(wrap, [path.join(BOARD, 'bin', 'wait.js'), sid, out]);
  assert.ok(await until(() => fs.existsSync(out) && Number(fs.readFileSync(out, 'utf8')) > 0), 'wrapped waiter did not start');
  const pid = Number(fs.readFileSync(out, 'utf8'));
  orphansStarted.add(pid);
  started.push({ kill: () => { try { process.kill(pid); } catch {} } });
  fs.mkdirSync(paths.inbox(sid), { recursive: true });
  fs.writeFileSync(procWaiter.waitLockPath(sid), String(pid));
  return { wrapper: { pid: wrapper }, pid };
}

test('waitCommandSid: every plugin version and Claude\'s bash wrapper', () => {
  const sid = 'd0504315-19ba-41a2-b07f-656b621ac05f';
  assert.equal(procWaiter.waitCommandSid(`"C:\\Program Files\\nodejs\\node.exe" C:/Users/u/.ddashboard/bin/wait.js ${sid}`), sid);
  assert.equal(procWaiter.waitCommandSid(`"C:\\Program Files\\nodejs\\node.exe" C:/Users/u/.claude/plugins/cache/ddashboard/ddashboard/0.1.0/scripts/wait-inbox.js ${sid}`), sid);
  assert.equal(procWaiter.waitCommandSid(`bash -c "source /c/x/shell-snapshots/snapshot-bash-1.sh && { eval 'node \\"C:/Users/u/.ddashboard/bin/wait.js\\" ${sid}' < /dev/null; } && pwd -P"`), sid);
  assert.equal(procWaiter.waitCommandSid('/usr/bin/node /home/u/.ddashboard/bin/wait.js abc_1'), 'abc_1');
  assert.equal(procWaiter.waitCommandSid('node server.js'), '');
  assert.equal(procWaiter.waitCommandSid('node await.js x'), '');
});

test('stopWaiter: stops the waiter and its wrapper, removes the lock; never kills a pid that is not a waiter', async () => {
  reset({ X1: session('X1') });
  const { wrapper, pid } = await startWrappedWaiter('X1');
  const table = procTable.processTable();
  need(pid, wrapper.pid); // alive after the read, so in the table
  assert.deepEqual(procWaiter.waiterChain(pid, table), [pid, wrapper.pid]);
  const top = table.get(wrapper.pid);
  assert.equal(procWaiter.orphanWaiter(pid, table), true, `not an orphan: wrapper ${JSON.stringify(top)}, its parent ${JSON.stringify(table.get(top?.ppid))}`);
  const alive = procTable.alive(pid);
  const stopped = procWaiter.stopWaiter('X1');
  if (!stopped) need(pid); // not stopped by stopWaiter and gone anyway: someone else stopped it
  assert.equal(stopped, true, `not stopped (alive before: ${alive}, after: ${procTable.alive(pid)})`);
  assert.equal(procTable.alive(pid), false);
  assert.ok(await until(() => !procTable.alive(wrapper.pid)), 'wrapper shell left running');
  assert.equal(fs.existsSync(procWaiter.waitLockPath('X1')), false);
  // pid reuse: the lock names a live process that is not this session's wait command.
  reset({ X2: session('X2') });
  // Hosted by this test (a live parent that is not Claude): no sweep calls it an orphan, so it must stay alive.
  const other = track(spawn(process.execPath, [fakeWaiterFiles().file, 'SOMEONE-ELSE'], { stdio: 'ignore' }));
  const sleeper = startFakeClaude();
  await sleep(300);
  fs.mkdirSync(paths.inbox('X2'), { recursive: true });
  for (const p of [other, sleeper]) {
    fs.writeFileSync(procWaiter.waitLockPath('X2'), String(p.pid));
    assert.equal(procWaiter.stopWaiter('X2'), false);
    assert.equal(procTable.alive(p.pid), true);
  }
});

test('forgetSessions stops an orphan waiter and removes the inbox (was: waiter kept, inbox kept)', async () => {
  reset({ X3: session('X3', { state: 'ended', ended: new Date().toISOString() }) });
  const w = await startFakeWaiter('X3');
  await sleep(300);
  need(w.pid);
  assert.equal(procWaiter.waitPid('X3'), w.pid);
  assert.deepEqual(appSessions.forgetSessions(['X3']).forgotten, ['X3']);
  assert.ok(await until(() => !procTable.alive(w.pid)), 'waiter of a forgotten session still runs (bug-005)');
  assert.equal(fs.existsSync(paths.inbox('X3')), false);
});

test('markEnded: an orphan waiter (older version, no wait.info) does not block it, and is stopped', async () => {
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  reset({ X4: session('X4', { last_seen: old }) });
  const w = await startFakeWaiter('X4');
  await sleep(300);
  need(w.pid);
  assert.equal(procWaiter.waitPid('X4'), w.pid); // legacy rule: the lock pid alone says waiting
  const r = appSessions.markEnded('X4');
  assert.equal(r.ok, true, r.error);
  assert.ok(await until(() => !procTable.alive(w.pid)), 'orphan waiter left running');
  reset({ X5: session('X5', { last_seen: old }) });
  // A waiter under a live Claude still blocks it (the waiter must have a real Claude ancestor).
  const c2 = claudeWithWaiter('X5');
  assert.ok(await until(() => procWaiter.readWaitInfo('X5')?.owner === c2.pid, 15000));
  assert.equal(appSessions.markEnded('X5').code, 409);
  c2.kill();
});

test('SessionEnd hook stops the session\'s waiter', async () => {
  reset({ X6: session('X6') });
  const w = await startFakeWaiter('X6');
  await sleep(300);
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'session-end.js')], { input: JSON.stringify({ session_id: 'X6' }), env: process.env });
  assert.equal(r.status, 0);
  assert.equal(readJson(paths.sessions, {}).X6.state, 'ended');
  assert.ok(await until(() => !procTable.alive(w.pid)), 'waiter left running after SessionEnd');
});

test('a new waiter takes over from an orphan waiter instead of saying "Already waiting"', async () => {
  reset({ X7: session('X7') });
  const orphan = await startFakeWaiter('X7');
  await sleep(300);
  const claude = startFakeClaude();
  const w = startWaiter('X7', claude.pid);
  assert.ok(await until(() => lockOf('X7') === w.pid, 15000), `new waiter did not take over: ${w.out}`);
  assert.equal(procTable.alive(orphan.pid), false);
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
  assert.deepEqual(procWaiter.reapToolShells(claude.pid), []); // alive: never
  claude.kill();
  await exited(claude);
  assert.deepEqual(procWaiter.reapToolShells(claude.pid), [shell]);
  assert.equal(procTable.alive(shell), false);
  assert.equal(procTable.alive(tool), true); // not a Claude tool shell: left alone
});

// --- F-9: gone detection for every kind of session ---

async function withServer(fn) {
  const srv = await startServer({ track });
  try {
    await fn(srv.base);
  } finally { await srv.stop(); }
}
async function deadPid() {
  const p = startFakeClaude();
  await sleep(100);
  p.kill();
  await exited(p);
  return p.pid;
}

test('F-9: solo, lead and outside sessions whose Claude died are ended (gone) and can be forgotten', async () => {
  const dead = await deadPid();
  const live = startFakeClaude();
  await sleep(200);
  reset({
    S1: session('S1', { claude_pid: dead }), // solo
    L1: session('L1', { kind: 'lead', claude_pid: dead }),
    O1: session('O1', { claude_pid: dead, state: 'working' }), // died mid-turn
    A1: session('A1', { claude_pid: live.pid }),
    H1: session('H1', { kind: 'member', headless: true, pid: dead, claude_pid: dead }),
    N1: session('N1'), // no pid known: never guessed
  });
  await withServer(async (base) => {
    const st = await (await fetch(`${base}/api/state`)).json();
    const view = (sid) => st.sessions[sid]?.view;
    for (const sid of ['S1', 'L1', 'O1']) {
      assert.equal(view(sid), 'ended', `${sid} shown as ${view(sid)} (bug-005 RC-6)`);
      assert.equal(st.sessions[sid].end_reason, 'gone');
    }
    assert.equal(view('A1'), 'idle');
    assert.equal(view('N1'), 'idle');
    assert.notEqual(view('H1'), 'ended'); // headless: "finished", resumable
  });
  assert.deepEqual(appSessions.forgetSessions(['S1', 'L1', 'O1']).forgotten, ['S1', 'L1', 'O1']);
  live.kill();
});

test('F-9: a recorded pid now used by another program counts as gone only with a table newer than last_seen', () => {
  const table = new Map([[process.pid, { pid: process.pid, ppid: 1, name: 'node.exe', cmd: 'node server.js' }]]);
  const s = session('R1', { claude_pid: process.pid, last_seen: new Date(Date.now() - 60000).toISOString() });
  table.taken = Date.now();
  assert.equal(appSessions.sessionGone(s, null, table), true);
  table.taken = Date.now() - 120000; // read before the session was last seen: says nothing
  assert.equal(appSessions.sessionGone(s, null, table), false);
  assert.equal(appSessions.sessionGone(s), false); // no table: alive pid = alive
  table.taken = Date.now();
  table.set(process.pid, { pid: process.pid, ppid: 1, name: 'claude.exe', cmd: 'claude' });
  assert.equal(appSessions.sessionGone(s, null, table), false);
});

test('F-9: SessionStart records the Claude pid in solo mode too', async () => {
  reset({});
  const file = path.join(BOARD, 'claude-code', 'hook-runner.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `const { spawnSync } = require('child_process');
spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'scripts', 'hooks', 'session-start.js'))}], { input: JSON.stringify({ session_id: 'P1', cwd: ${JSON.stringify(CWD)} }), stdio: ['pipe', 'ignore', 'ignore'] });
setInterval(() => {}, 1000);
`);
  const claude = track(spawn(process.execPath, [file], { stdio: 'ignore' }));
  assert.ok(await until(() => readJson(paths.sessions, {}).P1?.claude_pid === claude.pid, 15000), `claude_pid not recorded: ${JSON.stringify(readJson(paths.sessions, {}).P1)}`);
  assert.equal(readJson(paths.projects, {})[KEY].mode, undefined); // solo
  claude.kill();
});

test('F-9: UserPromptSubmit records a missing pid once (0 when no Claude is found)', async () => {
  reset({ P2: session('P2') });
  const runner = path.join(BOARD, 'prompt-runner.js');
  fs.writeFileSync(runner, `require('child_process').spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'scripts', 'hooks', 'prompt-submit.js'))}], { input: JSON.stringify({ session_id: 'P2', cwd: ${JSON.stringify(CWD)}, prompt: 'hi' }), stdio: ['pipe', 'ignore', 'ignore'] });
`);
  await startOrphan(runner);
  assert.ok(await until(() => readJson(paths.sessions, {}).P2?.claude_pid !== undefined, 15000), 'nothing recorded');
  assert.equal(readJson(paths.sessions, {}).P2.claude_pid, 0); // no Claude above it
});

test('F-3: /api/state does not show "waiting" for a waiter whose owner is dead (server uses procWaiter.waitPid)', async () => {
  const dead = await deadPid();
  reset({ V1: session('V1'), V2: session('V2') });
  for (const sid of ['V1', 'V2']) fs.mkdirSync(paths.inbox(sid), { recursive: true });
  // Live pid in both locks (this test, not a wait command, so the sweep leaves it); V1's owner is dead.
  fs.writeFileSync(procWaiter.waitLockPath('V1'), String(process.pid));
  fs.writeFileSync(procWaiter.waitInfoPath('V1'), JSON.stringify({ pid: process.pid, owner: dead }));
  fs.writeFileSync(procWaiter.waitLockPath('V2'), String(process.pid));
  fs.writeFileSync(procWaiter.waitInfoPath('V2'), JSON.stringify({ pid: process.pid, owner: process.pid }));
  await withServer(async (base) => {
    const st = await (await fetch(`${base}/api/state`)).json();
    if (procTable.alive(dead)) throw new Swept(`dead owner pid ${dead} was reused`);
    assert.equal(st.sessions.V1.waiting, false);
    assert.equal(st.sessions.V1.view, 'idle');
    assert.equal(st.sessions.V2.view, 'waiting');
  });
});

// --- F-5 / F-6: orphan sweep, server cwd ---

test('orphanWaiter (table fixture): dead or reused parent, init parent, 0.1.0 path; never a live unknown host', () => {
  const W = (pid, ppid, cmd, extra = {}) => [pid, { pid, ppid, name: 'node.exe', cmd, start: 200, ...extra }];
  const old = '"C:\\Program Files\\nodejs\\node.exe" C:/u/.claude/plugins/cache/ddashboard/ddashboard/0.1.0/scripts/wait-inbox.js s1';
  const cur = 'node C:/u/.ddashboard/bin/wait.js s2';
  const bash = (pid, ppid, sid) => [pid, { pid, ppid, name: 'bash.exe', start: 150, cmd: `bash -c "{ eval 'node \\"C:/u/.ddashboard/bin/wait.js\\" ${sid}' < /dev/null; }"` }];
  // pids that are alive (this process) stand in for live processes; 4000000+ are dead.
  const live = process.pid;
  const t = new Map([
    W(4000001, 4000099, old), // 0.1.0 waiter, parent gone
    W(live, 4000098, cur), // parent gone... but checked through its own pid below
  ]);
  assert.equal(procWaiter.orphanWaiter(4000001, t), true);
  // A waiter under a live Claude: never.
  const t2 = new Map([
    W(live, 9, cur), [9, { pid: 9, ppid: 0, name: 'claude.exe', cmd: 'claude', start: 100 }],
  ]);
  assert.equal(procWaiter.orphanWaiter(live, t2), procTable.alive(9) ? false : true); // pid 9 alive only on some systems
  // Under a live program that is not Claude (unknown host): not provable, never killed.
  const t3 = new Map([W(live, process.ppid, cur), [process.ppid, { pid: process.ppid, ppid: 0, name: 'Code.exe', cmd: 'code', start: 100 }]]);
  assert.equal(procWaiter.orphanWaiter(live, t3), false);
  // Same, but that pid was started after the waiter: a reuse of the dead parent's pid.
  t3.get(process.ppid).start = 300;
  assert.equal(procWaiter.orphanWaiter(live, t3), true);
  // POSIX: re-parented to init.
  const t4 = new Map([W(live, 1, cur, { start: 0 }), [1, { pid: 1, ppid: 0, name: 'systemd', cmd: '/sbin/init' }]]);
  if (procTable.alive(1)) assert.equal(procWaiter.orphanWaiter(live, t4), true);
  // The bash wrappers count as part of the waiter: their parent decides.
  const t5 = new Map([W(live, process.ppid, cur), bash(process.ppid, 4000097, 's2')]);
  assert.equal(procWaiter.orphanWaiter(live, t5), true);
});

test('sweepWaiters: stops orphan waiters of any version, keeps live ones, removes stale locks', async () => {
  reset({ Y1: session('Y1'), Y2: session('Y2'), Y3: session('Y3'), Y4: session('Y4') });
  const orphan = await startFakeWaiter('Y1'); // like the 0.1.0 waiters seen live (old/scripts/wait-inbox.js)
  const { wrapper, pid: wrapped } = await startWrappedWaiter('Y2');
  const claude = claudeWithWaiter('Y3'); // a working session
  assert.ok(await until(() => procWaiter.readWaitInfo('Y3')?.owner === claude.pid, 15000));
  const y3 = procWaiter.readWaitInfo('Y3').pid;
  const { file } = fakeWaiterFiles();
  const hosted = track(spawn(process.execPath, [file, 'Y5'], { stdio: 'ignore' })); // live parent (this test): kept
  fs.mkdirSync(paths.inbox('Y4'), { recursive: true });
  const y4dead = await deadPid();
  fs.writeFileSync(procWaiter.waitLockPath('Y4'), String(y4dead)); // stale lock
  await sleep(300);
  const r = procWaiter.sweepWaiters(procTable.processTable());
  if (procTable.alive(y4dead)) throw new Swept(`stale lock pid ${y4dead} was reused`);
  const killed = r.killed.map((k) => k.pid);
  // Another server running its sweep at the same time (e.g. a parallel test run) may have stopped them first.
  for (const pid of [orphan.pid, wrapped]) assert.ok(killed.includes(pid) || !procTable.alive(pid), `not stopped: ${pid} ${JSON.stringify(r.killed)}`);
  // The sweep is scoped to this test's board (DDASH_BOARD_DIR): it may only stop orphans this file started.
  for (const k of r.killed) assert.ok(orphansStarted.has(k.pid), `sweep stopped a process this test did not start: ${JSON.stringify(k)}`);
  assert.ok(await until(() => !procTable.alive(wrapper.pid)), 'wrapper left running');
  assert.equal(procTable.alive(y3), true);
  assert.equal(procTable.alive(hosted.pid), true);
  assert.ok(r.locks >= 1);
  assert.equal(fs.existsSync(procWaiter.waitLockPath('Y4')), false);
  assert.equal(fs.existsSync(procWaiter.waitLockPath('Y3')), true);
  claude.kill();
});

test('sweepWaiters with DDASH_BOARD_DIR set leaves an orphan waiter outside that board alone', async () => {
  reset({});
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-orph-other-'));
  const file = path.join(other, 'bin', 'wait.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  const pid = await startOrphan(file, ['Z9']); // a real-looking orphan, but not under this board
  try {
    await sleep(300);
    const table = procTable.processTable();
    need(pid); // alive after the read, so in the table
    assert.equal(procWaiter.orphanWaiter(pid, table), true); // it is an orphan...
    assert.deepEqual(procWaiter.sweepWaiters(table).killed.filter((k) => k.pid === pid), []); // ...but out of scope
    need(pid); // gone although this sweep did not stop it: another server's sweep did
    assert.equal(procTable.alive(pid), true);
  } finally {
    try { process.kill(pid); } catch {}
    await until(() => !procTable.alive(pid));
    fs.rmSync(other, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('server: sweeps orphan waiters at start', async () => {
  reset({ Y6: session('Y6') });
  const orphan = await startFakeWaiter('Y6');
  await sleep(300);
  await withServer(async () => {
    assert.ok(await until(() => !procTable.alive(orphan.pid), 15000), 'server did not stop the orphan waiter');
  });
});

test('F-6: control.start runs the server outside the session folder', async () => {
  reset({});
  fs.rmSync(paths.serverPid, { force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-orph-start-'));
  // control.start waits for the server's pid file (written once it listens); a port taken between freePort and the
  // server's listen makes it fail, so try another free port.
  const runner = path.join(BOARD, 'start-runner.js');
  fs.writeFileSync(runner, `require(${JSON.stringify(path.join(ROOT, 'scripts', 'control.js'))}).start().then((m) => console.log(m));
`);
  let r;
  for (let i = 0; i < 3; i++) {
    const port = await freePort();
    r = require('child_process').spawnSync(process.execPath, [runner], { cwd: dir, env: { ...process.env, DDASH_PORT: String(port) }, encoding: 'utf8' });
    if (/started/i.test(r.stdout)) break;
  }
  assert.match(r.stdout, /started/i, r.stdout + r.stderr);
  const pid = readJson(paths.serverPid, {}).pid;
  started.push({ kill: () => { try { process.kill(pid); } catch {} } });
  try {
    // Windows refuses to remove a folder that is a running process's cwd.
    fs.rmSync(dir, { recursive: true });
    assert.equal(fs.existsSync(dir), false);
  } finally {
    try { process.kill(pid); } catch {}
    await until(() => !procTable.alive(pid));
  }
});

// --- run ---

(async () => {
  let failed = 0;
  for (const t of tests) {
    for (let i = 1; ; i++) {
      try {
        await t.fn();
        console.log(`ok   ${t.name}`);
      } catch (err) {
        if (err instanceof Swept && i < TRIES) { console.log(`again ${t.name} (${err.message})`); continue; }
        failed++;
        console.log(`FAIL ${t.name}\n${err.stack}`);
      }
      break;
    }
  }
  for (const p of started) { try { p.kill(); } catch {} }
  await sleep(200);
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
