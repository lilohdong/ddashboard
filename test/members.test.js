#!/usr/bin/env node
// app/members.js per runner (headless, orca, window) with fake claude / orca / window launchers, and the
// entry-point rule of step 9. Run: node test/members.test.js
// Uses a temporary board dir (DDASH_BOARD_DIR); never starts real claude, Orca terminals or windows.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-members-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-members-proj-')); // not a git repo: project key = the path
process.env.DDASH_BOARD_DIR = BOARD;
delete process.env.DDASH_NAME;
process.env.CLAUDE_CONFIG_DIR = BOARD;
process.env.DDASH_WINDOW = '0';
process.env.DDASH_ORCA = '0';

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const { paths } = require(path.join(SCRIPTS, 'core', 'paths.js'));
const { readJson, writeJson, readJsonl } = require(path.join(SCRIPTS, 'core', 'fsx.js'));
const members = require(path.join(SCRIPTS, 'app', 'members.js'));
const { projectKey } = require(path.join(SCRIPTS, 'app', 'projects.js'));

const KEY = projectKey(CWD);
const slash = (p) => String(p).replace(/\\/g, '/');
const sessions = () => readJson(paths.sessions, {});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function reset(extra = {}) {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  writeJson(paths.projects, { [KEY]: { since: new Date().toISOString(), cwd: CWD, name: 'proj', mode: 'team', mode_ver: 1, teams: { Alpha: { lead: 'L1', worktree: slash(CWD), groups: {} } } } });
  const base = { cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: new Date().toISOString() };
  writeJson(paths.sessions, { L1: { ...base, session_id: 'L1', name: 'L1', kind: 'lead' }, ...extra });
  writeJson(paths.serverPid, { pid: process.pid });
}

const member = (sid, fields = {}) => ({
  session_id: sid, name: 'qa', cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: new Date().toISOString(),
  kind: 'member', role: 'qa', lead: 'L1', spawn: { permission_mode: 'auto', allowed_tools: [], cwd: CWD }, ...fields,
});

async function waitFor(file) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

function fakeClaude() {
  const file = path.join(BOARD, 'fake-claude.js');
  fs.writeFileSync(file, `const fs = require('fs');
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }));
`);
  process.env.DDASH_CLAUDE_BIN = file;
  process.env.FAKE_OUT = path.join(BOARD, `claude-${Date.now()}-${Math.random()}.json`);
}

function fakeOrca({ up = true, writable = true } = {}) {
  const file = path.join(BOARD, 'fake-orca.js');
  fs.writeFileSync(file, `const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(a) + '\\n');
const out = (o) => console.log(JSON.stringify(o));
const cmd = a.slice(0, 2).join(' ');
if (a[0] === 'status') out({ ok: true, result: { runtime: { reachable: process.env.FAKE_ORCA_UP === '1' } } });
else if (cmd === 'terminal create') out({ ok: true, result: { terminal: { handle: 'term_fake', paneKey: 'p' } } });
else if (cmd === 'terminal show') out({ ok: true, result: { terminal: { handle: a[3], writable: process.env.FAKE_ORCA_WRITABLE === '1' } } });
else if (cmd === 'terminal send') out({ ok: true, result: { send: { accepted: true } } });
else if (cmd === 'terminal close') out({ ok: true, result: { closed: true } });
else { out({ ok: false }); process.exit(1); }
`);
  process.env.DDASH_ORCA = '';
  process.env.DDASH_ORCA_BIN = file;
  process.env.FAKE_ORCA_LOG = path.join(BOARD, 'orca.log');
  process.env.FAKE_ORCA_UP = up ? '1' : '0';
  process.env.FAKE_ORCA_WRITABLE = writable ? '1' : '0';
}
const orcaCalls = () => readJsonl(process.env.FAKE_ORCA_LOG).map((a) => a.slice(0, 2).join(' '));
const orcaOff = () => { process.env.DDASH_ORCA = '0'; };

function fakeWindow() {
  const file = path.join(BOARD, 'fake-window.js');
  fs.writeFileSync(file, `require('fs').writeFileSync(process.env.FAKE_WINDOW_OUT, JSON.stringify(process.argv.slice(2)));\n`);
  process.env.DDASH_WINDOW = '';
  process.env.DDASH_WINDOW_BIN = file;
  process.env.FAKE_WINDOW_OUT = path.join(BOARD, `window-${Date.now()}-${Math.random()}.json`);
}
const windowOff = () => { process.env.DDASH_WINDOW = '0'; delete process.env.DDASH_WINDOW_BIN; };

test('headless: spawn pre-registers the member and runs claude -p with the tag; a finished member is resumed on send', async () => {
  reset();
  fakeClaude();
  const r = members.spawnMember('L1', { role: 'qa', task: 'check it', runner: 'headless' });
  assert.equal(r.runner, 'headless');
  const s = sessions()[r.sid];
  assert.equal(s.kind, 'member');
  assert.equal(s.lead, 'L1');
  assert.equal(s.headless, true);
  const run = await waitFor(process.env.FAKE_OUT);
  assert.deepEqual(run.argv.slice(0, 3), ['-p', '--session-id', r.sid]);
  assert.match(run.input, /^\[ddash role=qa lead=L1 stay=0\] check it$/);

  // Finished (pid gone): send resumes it with --resume.
  writeJson(paths.sessions, { ...sessions(), [r.sid]: { ...sessions()[r.sid], pid: 0 } });
  fakeClaude();
  const sent = members.sendMember('L1', 'qa', 'again');
  assert.equal(sent.action, 'resumed');
  assert.equal(sent.runner, 'headless');
  const again = await waitFor(process.env.FAKE_OUT);
  assert.deepEqual(again.argv.slice(0, 3), ['-p', '--resume', r.sid]);
  assert.match(again.input, /^\[Lead instruction\]\nagain$/);
});

test('orca: spawn opens a terminal; send types into an idle one or queues for a working one; end closes it', () => {
  reset();
  fakeOrca();
  try {
    const r = members.spawnMember('L1', { role: 'fe', task: 'build', runner: 'orca' });
    assert.equal(r.terminal, 'term_fake');
    assert.equal(sessions()[r.sid].orca.handle, 'term_fake');
    assert.ok(orcaCalls().includes('terminal create'));

    writeJson(paths.sessions, { ...sessions(), [r.sid]: { ...sessions()[r.sid], state: 'idle' } }); // registered, idle at its prompt
    const typed = members.sendMember('L1', 'fe', 'next\nstep');
    assert.equal(typed.action, 'typed');
    assert.equal(typed.handle, 'term_fake');
    assert.ok(orcaCalls().includes('terminal send'));

    writeJson(paths.sessions, { ...sessions(), [r.sid]: { ...sessions()[r.sid], state: 'working' } });
    const queued = members.sendMember('L1', 'fe', 'later');
    assert.deepEqual([queued.action, queued.wake], ['queued', 'turn']);
    assert.equal(fs.readdirSync(paths.inbox(r.sid)).filter((f) => f.endsWith('.json')).length, 1);

    const end = members.endMember('L1', 'fe');
    assert.ok(!end.already);
    assert.ok(orcaCalls().includes('terminal close'));
    assert.equal(sessions()[r.sid].end_reason, 'stopped');
    assert.equal(members.endMember('L1', 'fe').already, true);
  } finally { orcaOff(); }
});

test('window: spawn opens a window through orca-launch; an ended window member is resumed in a new window', async () => {
  reset();
  fakeWindow();
  try {
    const r = members.spawnMember('L1', { role: 'be', task: 'api', runner: 'window' });
    assert.equal(r.runner, 'window');
    const [title, cwd, argvJson] = await waitFor(process.env.FAKE_WINDOW_OUT);
    assert.equal(title, 'be');
    assert.equal(cwd, CWD);
    const argv = JSON.parse(argvJson);
    assert.match(slash(argv[1]), /\/orca-launch\.js$/);
    const spec = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
    assert.deepEqual(spec.args.slice(0, 2), ['--session-id', r.sid]);

    writeJson(paths.sessions, { ...sessions(), [r.sid]: { ...sessions()[r.sid], state: 'ended', ended: new Date().toISOString(), end_reason: 'exit' } });
    process.env.FAKE_WINDOW_OUT = path.join(BOARD, 'window-resume.json');
    const sent = members.sendMember('L1', 'be', 'more');
    assert.deepEqual([sent.action, sent.runner], ['resumed', 'window']);
    const again = JSON.parse(JSON.parse(fs.readFileSync(process.env.FAKE_WINDOW_OUT, 'utf8'))[2]);
    assert.deepEqual(JSON.parse(fs.readFileSync(again[2], 'utf8')).args.slice(0, 2), ['--resume', r.sid]);
  } finally { windowOff(); }
});

test('runners: a forced runner that cannot run is refused; a configured one falls back to headless with a note', () => {
  reset();
  orcaOff();
  windowOff();
  assert.throws(() => members.pickRunner('orca'), /Orca is not running/);
  assert.throws(() => members.pickRunner('window'), /turned off/);
  const p = members.pickRunner(undefined, 'orca');
  assert.equal(p.how, 'headless');
  assert.match(p.note, /configured runner orca is not available/);
  assert.equal(members.configuredRunner({ spawn: { runner_member: 'window' } }, 'member'), 'window');
  assert.equal(members.configuredRunner({ spawn: { runner_member: 'tmux' } }, 'member'), 'headless');
});

test('list: a member whose Claude process is dead is marked ended (gone); others keep their state', () => {
  reset({ M1: member('M1', { claude_pid: 2147483646 }), M2: member('M2', { role: 'fe', headless: true }) });
  const rows = members.listMembers('L1');
  const by = Object.fromEntries(rows.map((r) => [r.s.session_id, r]));
  assert.equal(by.M1.state, 'ended');
  assert.equal(sessions().M1.end_reason, 'gone');
  assert.notEqual(by.M2.state, 'ended');
});

test('errors: unknown lead, a session that leads no team, an unknown member', () => {
  reset({ M1: member('M1') });
  assert.throws(() => members.spawnMember('nobody', { role: 'x', task: 'y' }), /unknown session nobody/);
  assert.throws(() => members.spawnMember('M1', { role: 'x', task: 'y' }), /not the lead of a team/);
  assert.throws(() => members.sendMember('L1', 'ghost', 'hi'), /no member "ghost"/);
  assert.throws(() => members.endMember('L1', 'ghost'), /no member "ghost"/);
});

test('entry points: team.js is a CLI over app/members; no entry point requires another', () => {
  const ENTRIES = ['team.js', 'control.js', 'wait-inbox.js', 'orca-launch.js', 'server.js'];
  const bad = [];
  for (const f of ENTRIES) {
    const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    for (const m of text.matchAll(/require\(\s*['"]\.\/([^'"]+?)(?:\.js)?['"]\s*\)/g)) {
      if (ENTRIES.includes(`${m[1]}.js`)) bad.push(`${f} -> ${m[1]}.js`);
    }
  }
  assert.deepEqual(bad, []);
  const team = fs.readFileSync(path.join(SCRIPTS, 'team.js'), 'utf8');
  assert.doesNotMatch(team, /require\(['"]\.\/lib['"]\)|require\(['"]child_process['"]\)|require\(['"]\.\/store\//);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n${err.stack}`); }
  }
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
