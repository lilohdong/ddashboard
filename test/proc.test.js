#!/usr/bin/env node
// proc/* tests (refactor step 3). Run: node test/proc.test.js
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DDASH_BOARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-proc-')); // never the real board

const table = require('../scripts/proc/table');
const { identityOf, same } = require('../scripts/proc/identity');
const kill = require('../scripts/proc/kill');
const lib = require('../scripts/lib');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const fake = (rows) => {
  const t = new Map(rows.map((r) => [r.pid, { start: 0, cmd: '', ...r }]));
  t.taken = Date.now();
  return t;
};

test('identity: same process → true; reused pid (other name or other start time) → false', () => {
  const before = fake([{ pid: 10, ppid: 1, name: 'claude.exe', start: 1000 }]);
  const id = identityOf(10, before);
  assert.deepEqual(id, { pid: 10, name: 'claude.exe', start: 1000 });
  assert.equal(same(id, before), true);
  assert.equal(same(id, fake([{ pid: 10, ppid: 1, name: 'CLAUDE', start: 1000 }])), true, 'name case and .exe ignored');
  assert.equal(same(id, fake([{ pid: 10, ppid: 1, name: 'claude.exe', start: 2000 }])), false, 'same name, started later: reused');
  assert.equal(same(id, fake([{ pid: 10, ppid: 1, name: 'notepad.exe', start: 1000 }])), false, 'other program');
  assert.equal(same(id, fake([])), false, 'gone');
  assert.equal(same({ pid: 10, name: 'claude.exe', start: 0 }, fake([{ pid: 10, ppid: 1, name: 'claude.exe', start: 5 }])), true, 'unknown start: name decides');
  assert.equal(same(null, before), false);
  assert.equal(identityOf(99, before), null);
});

test('identity: a real child process, then its pid after exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    const t1 = table.processTable();
    const id = identityOf(child.pid, t1);
    assert.ok(id && /node/i.test(id.name), `found ${JSON.stringify(id)}`);
    assert.ok(id.start > 0, 'start time known');
    assert.equal(same(id, table.processTable()), true);
  } finally { child.kill(); }
  await new Promise((r) => child.on('exit', r));
  // The pid is not running any more (or runs something else): never the same process.
  const t2 = table.processTable();
  const now = t2.get(child.pid);
  assert.equal(same({ pid: child.pid, name: 'node.exe', start: 1 }, t2), Boolean(now && /node/i.test(now.name) && now.start === 1));
});

test('async table has the same shape as the sync table (callback and promise forms)', async () => {
  const sync = table.processTable();
  const viaCb = await new Promise((resolve) => table.processTableAsync(resolve));
  const viaPromise = await table.processTableAsync();
  for (const t of [sync, viaCb, viaPromise]) {
    assert.ok(t instanceof Map && t.size > 0 && t.taken > 0);
    const me = t.get(process.pid);
    assert.ok(me, 'this process is listed');
    assert.deepEqual(Object.keys(me).sort(), ['cmd', 'name', 'pid', 'ppid', 'start']);
    assert.equal(me.ppid, process.ppid);
  }
  assert.equal(viaCb.get(process.pid).start, sync.get(process.pid).start);
  assert.equal(viaPromise.get(process.pid).name, sync.get(process.pid).name);
});

test('parseProcessList: Windows CIM lines and POSIX ps lines (with and without lstart)', () => {
  const win = table.parseProcessList('12\t4\tnode.exe\t133000000000000000\tnode C:\\x\\wait.js abc\r\n\r\nbad line\r\n', 5, 'win32');
  assert.deepEqual(win.get(12), { pid: 12, ppid: 4, name: 'node.exe', start: 133000000000000000, cmd: 'node C:\\x\\wait.js abc' });
  assert.equal(win.size, 1);
  assert.equal(win.taken, 5);
  const posix = table.parseProcessList([
    '  301     1 Thu Nov 26 07:03:19 2026 /usr/bin/node node /h/.ddashboard/bin/wait.js abc',
    '  302   301 Thu Nov  5 17:00:01 2026 bash bash -c x',
    '  303   1 sh',
  ].join('\n'), 7, 'linux');
  assert.equal(posix.get(301).name, 'node');
  assert.equal(posix.get(301).cmd, 'node /h/.ddashboard/bin/wait.js abc');
  assert.equal(posix.get(301).start, Date.parse('Thu Nov 26 07:03:19 2026'));
  assert.ok(posix.get(302).start > 0);
  assert.deepEqual(posix.get(303), { pid: 303, ppid: 1, name: 'sh', start: 0, cmd: '' });
});

test('findClaudePid / isClaudeProcess / descendants on a fake table', () => {
  const t = fake([
    { pid: 1, ppid: 0, name: 'init' },
    { pid: 5, ppid: 1, name: 'node.exe', cmd: 'node C:/npm/node_modules/@anthropic-ai/claude-code/cli.js' },
    { pid: 6, ppid: 5, name: 'bash.exe' },
    { pid: 7, ppid: 6, name: 'node.exe', cmd: 'node hook.js' },
    { pid: 8, ppid: 7, name: 'cmd.exe' },
  ]);
  assert.equal(table.findClaudePid(7, t), 5);
  assert.equal(table.findClaudePid(1, t), 0);
  assert.equal(table.isClaudeProcess({ name: 'claude.exe', cmd: '' }), true);
  assert.equal(table.isClaudeProcess({ name: 'node', cmd: 'node server.js' }), false);
  assert.deepEqual(kill.descendants(5, t), [6, 7, 8]);
});

test('killTree stops a real process tree; killClaude refuses a pid that is not Claude', async () => {
  const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'ignore' }); setTimeout(() => {}, 20000)`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const t = table.processTable();
  const kids = kill.descendants(parent.pid, t);
  assert.equal(kids.length, 1);
  assert.equal(kill.killClaude(parent.pid), false, 'node -e is not Claude');
  assert.equal(table.alive(parent.pid), true);
  assert.equal(kill.killTree(parent.pid, t), true);
  assert.equal(table.napUntil(() => !table.alive(kids[0]), 3000), true, 'child stopped too');
  assert.equal(kill.killTree(parent.pid, t), false, 'already gone');
});

test('lib re-exports the moved functions (callers unchanged)', () => {
  for (const [k, m] of [['processTable', table], ['processTableAsync', table], ['parseProcessList', table], ['isClaudeProcess', table], ['findClaudePid', table], ['alive', table], ['processName', table], ['napUntil', table], ['killTree', kill], ['killPid', kill], ['descendants', kill], ['killClaude', kill]]) {
    assert.equal(lib[k], m[k], k);
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
