#!/usr/bin/env node
// QA bug-001: a member whose Orca terminal is closed and whose claude process is dead is still shown as alive.
// See docs/qa/bug-001-dead-member-idle.md. Run: node test/qa-dead-member.test.js
// Expected to FAIL until the bug is fixed (the "control" cases must pass both before and after the fix).
// Uses a temporary board dir, a fake orca command and fake pids; never touches ~/.ddashboard, never starts claude,
// never kills a process it did not start.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-qa-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-qa-proj-'));
process.env.DDASH_BOARD_DIR = BOARD; // must be set before lib is required
delete process.env.DDASH_NAME;

const ROOT = path.join(__dirname, '..');
const { startServer, freePort } = require('./helpers');
const corePaths = require(path.join(ROOT, 'plugin', 'scripts', 'core', 'paths.js'));
const coreFsx = require(path.join(ROOT, 'plugin', 'scripts', 'core', 'fsx.js'));
const procTable = require(path.join(ROOT, 'plugin', 'scripts', 'proc', 'table.js'));
const appSessions = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'sessions.js'));
const appProjects = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'projects.js'));
const team = require(path.join(ROOT, 'plugin', 'scripts', 'team.js'));
const { paths } = corePaths;
const { readJson, writeJson } = coreFsx;
const KEY = appProjects.projectKey(CWD);
const slash = (p) => String(p).replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake orca: `terminal show` answers writable per handle from a JSON map (FAKE_ORCA_TERMS) ---
function fakeOrca() {
  const file = path.join(BOARD, 'fake-orca.js');
  fs.writeFileSync(file, `const fs = require('fs');
const a = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
const terms = JSON.parse(fs.readFileSync(process.env.FAKE_ORCA_TERMS, 'utf8'));
const cmd = a.slice(0, 2).join(' ');
if (a[0] === 'status') out({ ok: true, result: { runtime: { reachable: true } } });
else if (cmd === 'terminal show') {
  const h = a[a.indexOf('--terminal') + 1];
  if (!(h in terms)) { out({ ok: false, error: { message: 'unknown terminal' } }); process.exit(1); }
  out({ ok: true, result: { terminal: { handle: h, connected: terms[h], writable: terms[h], orphaned: !terms[h] } } });
} else if (cmd === 'terminal send') out({ ok: true, result: { send: { accepted: true } } });
else if (cmd === 'terminal create') out({ ok: true, result: { terminal: { handle: 'term_new', paneKey: 'tab:leaf' } } });
else { out({ ok: false }); process.exit(1); }
`);
  return file;
}

// A process that looks like Claude Code to procTable.isClaudeProcess (node running a file under "claude-code").
function fakeClaudeFile() {
  const dir = path.join(BOARD, 'claude-code');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cli.js');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  return file;
}
const started = [];
function startFakeClaude() {
  const p = spawn(process.execPath, [fakeClaudeFile()], { stdio: 'ignore' });
  started.push(p);
  return p;
}
// Pid of a fake claude that has exited (a dead pid; reuse within the test run is practically impossible).
async function deadPid() {
  const p = startFakeClaude();
  const pid = p.pid;
  await new Promise((r) => { p.on('exit', r); p.kill(); });
  assert.equal(procTable.alive(pid), false, 'fixture: pid should be dead');
  return pid;
}

function member(sid, extra = {}) {
  const now = new Date().toISOString();
  return {
    session_id: sid, name: 'backend', cwd: CWD, project: 'proj', project_key: KEY, state: 'idle',
    started: now, last_seen: now, kind: 'member', role: sid, lead: 'L1', stay: false,
    headless: false, runner: 'orca', spawn: { permission_mode: 'acceptEdits', cwd: slash(CWD) }, ...extra,
  };
}

function setup(sessions, terms) {
  fs.rmSync(paths.sessions, { force: true });
  writeJson(paths.projects, { [KEY]: { since: new Date().toISOString(), cwd: CWD, name: 'proj', mode: 'team', mode_ver: 1, teams: { Alpha: { lead: 'L1', worktree: slash(CWD), groups: {} } } } });
  const now = new Date().toISOString();
  writeJson(paths.sessions, { L1: { session_id: 'L1', name: 'lead', cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: now, kind: 'lead' }, ...sessions });
  writeJson(paths.serverPid, { pid: process.pid });
  const termsFile = path.join(BOARD, 'terms.json');
  fs.writeFileSync(termsFile, JSON.stringify(terms));
  process.env.DDASH_ORCA = '';
  process.env.DDASH_ORCA_BIN = fakeOrca();
  process.env.FAKE_ORCA_TERMS = termsFile;
}

// State word printed by `team.js <lead> list` for a member (3rd column).
function listState(sid) {
  const r = team.main(['L1', 'list']);
  assert.equal(r.code, 0, r.out);
  const line = r.out.split('\n').find((l) => l.startsWith(sid));
  assert.ok(line, `member ${sid} not in list:\n${r.out}`);
  return line.split(/\s+/)[2];
}

async function withServer(fn) {
  const srv = await startServer();
  try {
    await fn(srv.base);
  } finally { await srv.stop(); }
}
const viewOf = async (base, sid) => {
  const j = await (await fetch(`${base}/api/state`)).json();
  const list = Array.isArray(j.sessions) ? j.sessions : Object.values(j.sessions);
  return list.find((s) => s.session_id === sid);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- the bug ---

test('QA-B001-1 list: closed Orca terminal + dead claude_pid, state idle -> must not be shown as idle', async () => {
  const pid = await deadPid();
  setup({ D1: member('D1', { claude_pid: pid, orca: { handle: 'term_closed' } }) }, { term_closed: false });
  const st = listState('D1');
  assert.notEqual(st, 'idle', `dead member listed as "${st}" (bug-001)`);
  assert.match(st, /ended|finished|dead|gone/);
});

test('QA-B001-2 list: died mid-turn (state working, terminal closed, pid dead) -> must not be shown as working', async () => {
  const pid = await deadPid();
  setup({ D2: member('D2', { state: 'working', claude_pid: pid, orca: { handle: 'term_closed' } }) }, { term_closed: false });
  const st = listState('D2');
  assert.notEqual(st, 'working', `dead member listed as "${st}" (bug-001)`);
});

test('QA-B001-3 dashboard /api/state: dead Orca member must not have view idle', async () => {
  const pid = await deadPid();
  setup({ D3: member('D3', { claude_pid: pid, orca: { handle: 'term_closed' } }) }, { term_closed: false });
  await withServer(async (base) => {
    const s = await viewOf(base, 'D3');
    assert.ok(s, 'D3 missing from /api/state');
    assert.notEqual(s.view, 'idle', `dashboard shows the dead member as "${s.view}" (unresponsive=${s.unresponsive}) (bug-001)`);
  });
});

test('QA-B001-4 dashboard: dead member stuck in working can be cleaned up (markEnded is not refused)', async () => {
  const pid = await deadPid();
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  setup({ D4: member('D4', { state: 'working', last_seen: old, claude_pid: pid, orca: { handle: 'term_closed' } }) }, { term_closed: false });
  const r = appSessions.markEnded('D4');
  assert.equal(r.ok, true, `markEnded refused a dead member: ${r.error} (bug-001)`);
});

// --- controls: must pass before and after the fix ---

test('QA-B001-C1 control: live claude + open terminal stays idle', async () => {
  const p = startFakeClaude();
  await sleep(200);
  setup({ A1: member('A1', { claude_pid: p.pid, orca: { handle: 'term_open' } }) }, { term_open: true });
  assert.equal(listState('A1'), 'idle');
});

test('QA-B001-C2 control: member without claude_pid or orca handle (old record) is not guessed dead by list', async () => {
  setup({ A2: member('A2', { runner: undefined }) }, {});
  assert.equal(listState('A2'), 'idle');
});

test('QA-B001-C3 control: a headless member whose pid exited is "finished" (existing behaviour)', async () => {
  const pid = await deadPid();
  setup({ H1: member('H1', { runner: 'headless', headless: true, pid }) }, {});
  assert.equal(listState('H1'), 'finished');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}\n  ${String(err.message).split('\n')[0]}`);
    }
  }
  for (const p of started) { try { p.kill(); } catch {} }
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
