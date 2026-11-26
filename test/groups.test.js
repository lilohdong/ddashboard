#!/usr/bin/env node
// Group and handoff tests (moved unchanged from team.test.js). Run: node test/groups.test.js
// Uses a temporary board dir (DDASH_BOARD_DIR); never touches ~/.ddashboard and never starts real claude.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-test-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-proj-')); // not a git repo: project key = the path
process.env.DDASH_BOARD_DIR = BOARD;
delete process.env.DDASH_NAME;
process.env.CLAUDE_CONFIG_DIR = BOARD; // no real Claude settings (model hints for the context window)
for (const k of ['ANTHROPIC_MODEL', 'DDASH_CONTEXT_WINDOW', 'DDASH_LEAD_WORK_BUDGET', 'DDASH_LEAD_CONTEXT_LIMIT', 'DDASH_HANDOFF_MAX_TOKENS']) delete process.env[k];
process.env.DDASH_WINDOW = '0'; // never open real terminal windows; the window tests use a fake launcher
process.env.DDASH_ORCA = '0'; // never open real Orca terminals; the Orca tests use a fake orca command

const ROOT = path.join(__dirname, '..');
const { startServer, freePort } = require('./helpers');
const corePaths = require(path.join(ROOT, 'plugin', 'scripts', 'core', 'paths.js'));
const coreFsx = require(path.join(ROOT, 'plugin', 'scripts', 'core', 'fsx.js'));
const domTeam = require(path.join(ROOT, 'plugin', 'scripts', 'domain', 'team.js'));
const domTags = require(path.join(ROOT, 'plugin', 'scripts', 'domain', 'tags.js'));
const domRules = require(path.join(ROOT, 'plugin', 'scripts', 'domain', 'rules.js'));
const storeInbox = require(path.join(ROOT, 'plugin', 'scripts', 'store', 'inbox.js'));
const storeCards = require(path.join(ROOT, 'plugin', 'scripts', 'store', 'cards.js'));
const appTeams = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'teams.js'));
const appHandoff = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'handoff.js'));
const appTeamFiles = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'team-files.js'));
const appRules = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'rules.js'));
const appProjects = require(path.join(ROOT, 'plugin', 'scripts', 'app', 'projects.js'));
const team = require(path.join(ROOT, 'plugin', 'scripts', 'team.js'));
const { paths } = corePaths;
const { readJson, writeJson } = coreFsx;

const KEY = appProjects.projectKey(CWD);
const slash = (p) => String(p).replace(/\\/g, '/');
const project = () => readJson(paths.projects, {})[KEY];
const teamConf = (name = 'Alpha') => project().teams[name];

// Point the lead (and its team's worktree) at another folder, e.g. a git repo.
function moveLead(dir, sid = 'L1', name = 'Alpha') {
  const s = readJson(paths.sessions, {});
  s[sid].cwd = dir;
  writeJson(paths.sessions, s);
  const all = readJson(paths.projects, {});
  all[KEY].teams[name].worktree = slash(dir);
  writeJson(paths.projects, all);
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- fixtures ---

function session(sid, extra = {}) {
  return { session_id: sid, name: sid, cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: new Date().toISOString(), text_ver: domRules.RULES_TEXT_VER, ...extra };
}

function reset({ mode = 'solo', lead, sessions = {} } = {}) {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  // A solo project looks like a 0.2.0 one (no mode fields); team mode was switched on once (one team, Alpha).
  const p = { since: new Date().toISOString(), cwd: CWD };
  if (mode === 'team') Object.assign(p, { name: 'proj', mode, mode_ver: 1, teams: {} });
  if (lead) p.teams.Alpha = { lead, worktree: slash(CWD), groups: {} };
  writeJson(paths.projects, { [KEY]: p });
  writeJson(paths.sessions, sessions);
  writeJson(paths.serverPid, { pid: process.pid }); // hooks treat the server as running
}

function teamFixture() {
  reset({
    mode: 'team', lead: 'L1',
    sessions: {
      L1: session('L1', { kind: 'lead' }),
      M1: session('M1', { kind: 'member', role: 'frontend', lead: 'L1', rules_ver: 1 }),
      O1: session('O1', { rules_ver: 1 }),
    },
  });
}

function runHook(name, input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'hooks', name)], {
    input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const inboxFiles = (sid) => { try { return fs.readdirSync(paths.inbox(sid)).filter((f) => f.endsWith('.json')); } catch { return []; } };
const inbox = (sid) => inboxFiles(sid).map((f) => readJson(path.join(paths.inbox(sid), f), null));
const allCards = () => storeCards.files().flatMap((f) => coreFsx.readJsonl(f));
const cardText = (c) => `done.\n\`\`\`card\n${JSON.stringify(c)}\n\`\`\``;

function fakeClaude() {
  const file = path.join(BOARD, 'fake-claude.js');
  fs.writeFileSync(file, `const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd(), nested: process.env.CLAUDECODE || '' }));
`);
  return file;
}

async function waitFor(file) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function withServer(fn) {
  const srv = await startServer();
  const { base } = srv;
  try {
    const post = async (url, body, headers = {}) => {
      const res = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await fn(post, base);
  } finally { await srv.stop(); }
}

// --- handoff ---

test('performHandoff: reassigns lead and members, moves inbox, stops the old lead', async () => {
  teamFixture();
  fs.rmSync(path.join(CWD, 'docs', 'teams', 'Alpha', 'lead-rules.md'), { force: true });
  const s0 = readJson(paths.sessions, {});
  s0.L2 = session('L2');
  s0.L1.claude_pid = 999999;
  writeJson(paths.sessions, s0);
  storeInbox.deliver('L1', { type: 'report', from: 'M1', title: 'pending report' });
  const waiter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  fs.writeFileSync(path.join(paths.inbox('L1'), 'wait.lock'), String(waiter.pid));
  const killed = [];
  try {
    const r = appHandoff.performHandoff('L1', 'L2', 'C:/doc.md', {
      kill: (pid) => { killed.push(pid); return true; },
      killClaude: (pid) => { killed.push(`claude:${pid}`); return true; },
    });
    const rules = slash(path.join(CWD, 'docs', 'teams', 'Alpha', 'lead-rules.md'));
    assert.deepEqual(r, { ok: true, team: 'Alpha', rules: '', members: 1, moved: 1, wait_killed: true, claude_killed: true, claude_pid: 999999 });
    assert.ok(!fs.existsSync(rules)); // a handoff never creates it
  } finally { waiter.kill(); }
  assert.deepEqual(killed, [waiter.pid, 'claude:999999']);
  const s = readJson(paths.sessions, {});
  assert.equal(teamConf().lead, 'L2');
  assert.equal(teamConf().last_handoff.from, 'L1');
  assert.equal(s.L2.kind, 'lead');
  assert.equal(s.M1.lead, 'L2');
  assert.equal(s.L1.state, 'ended');
  assert.equal(s.L1.end_reason, 'handoff');
  assert.equal(s.L1.replaced_by, 'L2');
  assert.equal(s.L1.kind, undefined);
  assert.equal(inboxFiles('L1').length, 0);
  assert.equal(inbox('L2')[0].title, 'pending report');
  assert.equal(appHandoff.performHandoff('L1', 'nobody', '').ok, false);
});

// --- groups ---

const groupDir = (name, t = 'Alpha') => path.join(CWD, 'docs', 'teams', t, name);

test('parseTag: group attribute', () => {
  assert.equal(domTags.parseTag('[ddash role=fe lead=L1 group=front] x').group, 'front');
  assert.equal(domTags.parseTag('[ddash role=fe lead=L1 group=../x] x').group, undefined);
});

test('groups: create, rename (plain), delete to _archived, purge', () => {
  teamFixture();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  assert.equal(team.main(['L1', 'group', 'create', 'front']).code, 0);
  assert.match(fs.readFileSync(path.join(groupDir('front'), 'brief.md'), 'utf8'), /## Key files/);
  assert.ok(fs.existsSync(path.join(groupDir('front'), 'notes')));
  assert.equal(team.main(['L1', 'group', 'create', 'front']).code, 1); // exists
  assert.equal(team.main(['L1', 'group', 'create', '../evil']).code, 1);
  assert.equal(team.main(['M1', 'group', 'create', 'x']).code, 1); // not the lead
  const s = readJson(paths.sessions, {});
  s.M1.group = 'front';
  writeJson(paths.sessions, s);
  assert.equal(team.main(['L1', 'group', 'rename', 'front', 'web']).code, 0);
  assert.ok(fs.existsSync(path.join(groupDir('web'), 'brief.md')));
  assert.ok(!fs.existsSync(groupDir('front')));
  assert.equal(readJson(paths.sessions, {}).M1.group, 'web');
  assert.equal(teamConf().groups.web.dir, slash(groupDir('web')));
  assert.match(team.main(['L1', 'group', 'list']).out, /^web .* members 1\/1/);
  assert.equal(team.main(['L1', 'group', 'delete', 'web']).code, 0);
  const archived = fs.readdirSync(path.join(CWD, 'docs', 'teams', 'Alpha', '_archived'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^web-\d{8}$/);
  assert.equal(readJson(paths.sessions, {}).M1.group, undefined);
  assert.deepEqual(teamConf().groups, {});
  team.main(['L1', 'group', 'create', 'tmp']);
  assert.equal(team.main(['L1', 'group', 'delete', 'tmp', '--purge']).code, 0);
  assert.ok(!fs.existsSync(groupDir('tmp')));
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('groups: rename uses git mv when the folder is tracked', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-repo-'));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    teamFixture();
    moveLead(repo);
    assert.equal(team.main(['L1', 'group', 'create', 'api']).code, 0);
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'groups');
    assert.match(team.main(['L1', 'group', 'rename', 'api', 'backend']).out, /git mv/);
    assert.match(git('status', '--porcelain').stdout, /^R {2}docs\/teams\/Alpha\/api\/brief\.md -> docs\/teams\/Alpha\/backend\/brief\.md/m);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('groups: the lead is told once when a brief falls behind HEAD', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-repo-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  const commit = (n) => { for (let i = 0; i < n; i++) git('commit', '-q', '--allow-empty', '-m', `c${i}`); };
  const env = { DDASH_BRIEF_STALE_COMMITS: '3' };
  const stop = () => runHook('stop-card.js', { session_id: 'M1', cwd: repo }, env);
  const notes = () => inbox('L1').filter((m) => /may be stale/.test(m.title || ''));
  try {
    git('init', '-q');
    commit(1);
    teamFixture();
    moveLead(repo);
    team.main(['L1', 'group', 'create', 'api']);
    stop(); // records the brief's HEAD
    const g = teamConf().groups.api;
    assert.equal(g.brief_head, git('rev-parse', 'HEAD').stdout.trim());
    commit(2);
    stop();
    assert.equal(notes().length, 0);
    commit(1);
    stop();
    stop();
    assert.equal(notes().length, 1);
    assert.match(notes()[0].title, /^brief api may be stale: 3 commits since it was last updated \(.*brief\.md\)$/);
    // Editing the brief resets it.
    const brief = path.join(repo, 'docs', 'teams', 'Alpha', 'api', 'brief.md');
    fs.appendFileSync(brief, '\nupdated');
    fs.utimesSync(brief, new Date(), new Date(Date.now() + 5000));
    stop();
    const g2 = teamConf().groups.api;
    assert.equal(g2.brief_stale_warned, undefined);
    assert.equal(g2.brief_head, git('rev-parse', 'HEAD').stdout.trim());
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('groups: prune keeps the newest handoffs and drops old notes only', () => {
  teamFixture();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  team.main(['L1', 'group', 'create', 'front']);
  const dir = groupDir('front');
  for (const n of [1, 2, 3, 4, 10]) fs.writeFileSync(path.join(dir, `handoff-${String(n).padStart(3, '0')}.md`), `h${n}`);
  fs.writeFileSync(path.join(dir, 'notes', 'old.md'), 'old');
  fs.writeFileSync(path.join(dir, 'notes', 'new.md'), 'new');
  const past = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(path.join(dir, 'notes', 'old.md'), past, past);
  fs.writeFileSync(path.join(CWD, 'docs', 'outside.md'), 'keep'); // outside the group folder
  fs.utimesSync(path.join(CWD, 'docs', 'outside.md'), past, past);
  // The Stop hook of a group member prunes.
  const s = readJson(paths.sessions, {});
  s.M1.group = 'front';
  writeJson(paths.sessions, s);
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: '' });
  assert.deepEqual(appTeamFiles.handoffs(dir), ['handoff-003.md', 'handoff-004.md', 'handoff-010.md']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')), ['new.md']);
  assert.ok(fs.existsSync(path.join(CWD, 'docs', 'outside.md')));
  assert.equal(appTeamFiles.latestHandoff(dir), path.join(dir, 'handoff-010.md').replace(/\\/g, '/'));
  assert.equal(team.main(['L1', 'group', 'prune', 'front']).out, 'Nothing to prune.');
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('groups: a spawned member gets the brief at SessionStart, before its task; long briefs are cut and reported', async () => {
  teamFixture();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  team.main(['L1', 'group', 'create', 'front']);
  const dir = groupDir('front');
  fs.writeFileSync(path.join(dir, 'brief.md'), '# front brief\nScope: the UI');
  fs.writeFileSync(path.join(dir, 'handoff-001.md'), 'h1');
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  process.env.FAKE_OUT = path.join(BOARD, 'g-spawn.json');
  assert.equal(team.main(['L1', 'spawn', '--role', 'fe', '--group', 'nope', 'x']).code, 1);
  const r = team.main(['L1', 'spawn', '--role', 'fe', '--group', 'front', 'build it']);
  assert.equal(r.code, 0, r.out);
  const got = await waitFor(process.env.FAKE_OUT);
  assert.equal(got.input, '[ddash role=fe lead=L1 stay=0 group=front] build it');
  const sid = got.argv[got.argv.indexOf('--session-id') + 1];
  assert.equal(readJson(paths.sessions, {})[sid].group, 'front');
  const start = runHook('session-start.js', { session_id: sid, cwd: CWD });
  assert.ok(start.startsWith('[ddashboard] Group "front" brief'), start);
  assert.ok(start.indexOf('Scope: the UI') < start.indexOf('You are a team member'));
  assert.match(start, /Latest handoff: .*handoff-001\.md/);
  assert.match(start, /next-handoff: it creates the next handoff-NNN\.md/);
  // The tag prompt then registers it without repeating anything.
  assert.equal(runHook('prompt-submit.js', { session_id: sid, cwd: CWD, prompt: got.input }), '');
  const s = readJson(paths.sessions, {})[sid];
  assert.equal(s.pending, undefined);
  assert.equal(s.group, 'front');
  // Two members of the group get the same prefix (the part before their own instructions).
  const ctx = appTeamFiles.groupContext('front', teamConf().groups.front);
  assert.ok(start.startsWith(ctx.text));
  // Too long: cut, and the lead is told once.
  fs.writeFileSync(path.join(dir, 'brief.md'), 'x'.repeat(appTeamFiles.BRIEF_MAX_CHARS + 50));
  const s2 = readJson(paths.sessions, {});
  s2.P1 = session('P1', { kind: 'member', role: 'fe', lead: 'L1', group: 'front', pending: true });
  s2.P2 = session('P2', { kind: 'member', role: 'fe', lead: 'L1', group: 'front', pending: true });
  writeJson(paths.sessions, s2);
  for (const f of inboxFiles('L1')) fs.unlinkSync(path.join(paths.inbox('L1'), f));
  assert.match(runHook('session-start.js', { session_id: 'P1', cwd: CWD }), /brief cut at 16000/);
  runHook('session-start.js', { session_id: 'P2', cwd: CWD });
  const notes = inbox('L1').filter((m) => /brief front needs trimming/.test(m.title));
  assert.equal(notes.length, 1);
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('server: /api/groups and spawn with a group', async () => {
  teamFixture();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  process.env.FAKE_OUT = path.join(BOARD, 'g-ui.json');
  await withServer(async (post, base) => {
    assert.equal((await post('/api/groups', { project: 'proj', action: 'create', name: 'qa' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/groups', { project: 'proj', action: 'create', name: 'qa' })).status, 200);
    assert.equal((await post('/api/groups', { project: 'proj', action: 'create', name: 'qa' })).status, 400);
    assert.equal((await post('/api/groups', { project: 'proj', action: 'rename', name: 'qa', new_name: 'test' })).status, 200);
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(Object.keys(st.teams.proj.teams.Alpha.groups), ['test']);
    assert.equal(st.sessions.L1.team_name, 'Alpha');
    assert.equal(st.sessions.M1.team_name, 'Alpha');
    const r = await post('/api/team/spawn', { lead: 'L1', role: 'qa', task: 'check', group: 'test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match((await waitFor(process.env.FAKE_OUT)).input, / group=test\] check$/);
    assert.match(inbox('L1').find((m) => m.from === r.body.session_id).title, /\(group test\) spawned by the user/);
    assert.equal((await post('/api/groups', { project: 'proj', action: 'delete', name: 'test', purge: true })).status, 200);
    assert.ok(!fs.existsSync(groupDir('test')));
    const s = readJson(paths.sessions, {});
    s.L1.state = 'ended';
    writeJson(paths.sessions, s);
    assert.equal((await post('/api/groups', { project: 'proj', action: 'create', name: 'z' })).status, 409);
  });
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

// --- several teams per repo (M-1b) ---

// Alpha (lead L1, member M1 frontend) and Beta (lead L2, member M2 backend); O1 is in no team.
function twoTeams() {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.L2 = session('L2', { rules_ver: 1 });
  s.M2 = session('M2', { kind: 'member', role: 'backend', lead: 'L2', rules_ver: 1 });
  writeJson(paths.sessions, s);
  assert.equal(appTeams.addTeam(KEY, 'Beta', 'L2').ok, true);
}

test('M-1b: two teams run side by side; members report only to their own lead', () => {
  twoTeams();
  const p = project();
  const s = readJson(paths.sessions, {});
  assert.equal(p.mode, 'team');
  assert.equal(domTeam.teamRole(s.L1, p), 'lead');
  assert.equal(domTeam.teamRole(s.L2, p), 'lead');
  assert.equal(domTeam.teamRole(s.M2, p), 'member');
  assert.equal(domTeam.teamRole(s.O1, p), 'outside');
  assert.match(appRules.rulesFor(s.L2, p), /lead of team "Beta"/);
  assert.match(appRules.rulesFor(s.O1, p), /teams: Alpha, Beta\)/);
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: cardText({ title: 'from M1' }) });
  runHook('stop-card.js', { session_id: 'M2', cwd: CWD, last_assistant_message: cardText({ title: 'from M2' }) });
  runHook('stop-card.js', { session_id: 'O1', cwd: CWD, last_assistant_message: cardText({ title: 'from O1' }) });
  assert.deepEqual(inbox('L1').map((m) => m.title), ['from M1']);
  assert.deepEqual(inbox('L2').map((m) => m.title), ['from M2']);
  const via = Object.fromEntries(allCards().map((c) => [c.title, c.via_lead]));
  assert.deepEqual(via, { 'from M1': 'L1', 'from M2': 'L2', 'from O1': undefined });
  // T list / send see only the lead's own members.
  const list = team.main(['L1', 'list']).out;
  assert.match(list, /^M1 /m);
  assert.doesNotMatch(list, /M2/);
  assert.equal(team.main(['L1', 'send', 'M2', 'hi']).code, 1);
  assert.equal(team.main(['L1', 'send', 'backend', 'hi']).code, 1);
  // "/ddashboard:dashboard team <name>" adds a team and refuses a name in use.
  assert.match(runHook('prompt-submit.js', { session_id: 'O1', cwd: CWD, prompt: '/ddashboard:dashboard team Beta' }), /No team was added: team Beta exists/);
  assert.equal(teamConf('Beta').lead, 'L2');
  const out = runHook('prompt-submit.js', { session_id: 'O1', cwd: CWD, prompt: '/ddashboard:dashboard team Gamma' });
  assert.match(out, /Team "Gamma" was added to this project; this session is its lead\. Other teams are unchanged/);
  assert.match(out, /lead of team "Gamma"/);
  assert.deepEqual(Object.keys(project().teams).sort(), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(teamConf('Alpha').lead, 'L1');
  assert.equal(readJson(paths.sessions, {}).M1.lead, 'L1');
});

test('M-1b: two teams can use the same group name; upkeep stays inside each team', () => {
  twoTeams();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  assert.equal(team.main(['L1', 'group', 'create', 'front']).code, 0);
  assert.equal(team.main(['L2', 'group', 'create', 'front']).code, 0);
  const a = groupDir('front', 'Alpha');
  const b = groupDir('front', 'Beta');
  assert.equal(teamConf('Alpha').groups.front.dir, slash(a));
  assert.equal(teamConf('Beta').groups.front.dir, slash(b));
  assert.ok(fs.existsSync(path.join(a, 'brief.md')) && fs.existsSync(path.join(b, 'brief.md')));
  const s = readJson(paths.sessions, {});
  s.M1.group = 'front';
  s.M2.group = 'front';
  writeJson(paths.sessions, s);
  fs.writeFileSync(path.join(b, 'brief.md'), 'Beta brief');
  assert.match(appRules.memberStart('M2'), /Beta brief/);
  for (const n of [1, 2, 3, 4, 5]) for (const d of [a, b]) fs.writeFileSync(path.join(d, `handoff-00${n}.md`), `h${n}`);
  // An Alpha member's Stop hook prunes only Alpha's folder.
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: '' });
  assert.equal(appTeamFiles.handoffs(a).length, 3);
  assert.equal(appTeamFiles.handoffs(b).length, 5);
  assert.match(team.main(['L2', 'group', 'list']).out, /^front .*Beta\/front +members 1\/1/);
  // Rename and delete --purge in Alpha leave Beta's group, folder and members alone.
  assert.equal(team.main(['L1', 'group', 'rename', 'front', 'web']).code, 0);
  const s2 = readJson(paths.sessions, {});
  assert.equal(s2.M1.group, 'web');
  assert.equal(s2.M2.group, 'front');
  assert.equal(team.main(['L1', 'group', 'delete', 'web', '--purge']).code, 0);
  assert.ok(!fs.existsSync(groupDir('web', 'Alpha')));
  assert.equal(appTeamFiles.handoffs(b).length, 5);
  assert.ok(teamConf('Beta').groups.front);
  assert.equal(readJson(paths.sessions, {}).M2.group, 'front');
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('M-1b: a handoff moves only its own team', () => {
  twoTeams();
  const s = readJson(paths.sessions, {});
  s.L3 = session('L3');
  writeJson(paths.sessions, s);
  const worktree = teamConf('Alpha').worktree;
  const r = appHandoff.performHandoff('L1', 'L3', '', { kill: () => true, killClaude: () => false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.team, 'Alpha');
  assert.equal(r.members, 1);
  const s2 = readJson(paths.sessions, {});
  assert.equal(teamConf('Alpha').lead, 'L3');
  assert.equal(teamConf('Alpha').worktree, worktree); // name, worktree and groups stay
  assert.equal(teamConf('Beta').lead, 'L2');
  assert.equal(s2.M1.lead, 'L3');
  assert.equal(s2.M2.lead, 'L2');
  assert.equal(s2.L2.kind, 'lead');
  assert.equal(s2.L2.replaced_by, undefined);
  // A session that leads a team cannot take over another one; a session that leads none cannot hand off.
  assert.match(appHandoff.performHandoff('L3', 'L2', '').error, /already leads team Beta/);
  assert.match(appHandoff.performHandoff('O1', 'M1', '').error, /leads no team/);
});

test('M-1b: removing a team leaves the others; the project is solo when no team is left', async () => {
  twoTeams();
  // "solo" from a lead removes only its team.
  const out = runHook('prompt-submit.js', { session_id: 'L1', cwd: CWD, prompt: '/ddashboard:dashboard solo' });
  assert.match(out, /Team "Alpha" was removed; this session posts its own cards\. Other teams are unchanged/);
  assert.deepEqual(Object.keys(project().teams), ['Beta']);
  assert.equal(project().mode, 'team');
  // Its former members post straight to the dashboard; Beta still reports to its lead.
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: cardText({ title: 'after' }) });
  assert.equal(allCards()[0].via_lead, undefined);
  assert.equal(inboxFiles('L1').length, 0);
  assert.equal(domTeam.teamRole(readJson(paths.sessions, {}).M1, project()), 'outside');
  // "solo" from a session that leads no team changes nothing.
  assert.match(runHook('prompt-submit.js', { session_id: 'O1', cwd: CWD, prompt: '/ddashboard:dashboard solo' }), /leads no team, so nothing changed/);
  assert.deepEqual(Object.keys(project().teams), ['Beta']);
  // (Turning the dashboard on above renamed the project after its folder, so the API is called with its key.)
  await withServer(async (post, base) => {
    assert.equal((await post('/api/mode', { project: KEY, mode: 'solo', team: 'Nope' })).status, 404);
    // The dashboard removes a team by name; the last one makes the project solo.
    assert.equal((await post('/api/mode', { project: KEY, mode: 'solo', team: 'Beta' })).status, 200);
    assert.equal(project().mode, 'solo');
    assert.deepEqual(project().teams, {});
    // It adds teams too, and refuses a name in use.
    assert.equal((await post('/api/mode', { project: KEY, mode: 'team', lead: 'L1', team: 'Alpha' })).status, 200);
    assert.equal((await post('/api/mode', { project: KEY, mode: 'team', lead: 'O1', team: 'Alpha' })).status, 409);
    assert.equal((await post('/api/mode', { project: KEY, mode: 'team', lead: 'L2', team: 'Beta' })).status, 200);
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(Object.keys(Object.values(st.teams)[0].teams).sort(), ['Alpha', 'Beta']);
    assert.equal(Object.values(st.teams)[0].teams.Beta.lead, 'L2');
    assert.equal(st.sessions.L2.team_name, 'Beta');
    // Members of a removed team were released: they do not rejoin when their lead starts a team again.
    assert.equal(st.sessions.M2.team, 'outside');
    assert.equal(st.sessions.M2.former_lead, 'L2');
    assert.equal(st.sessions.M2.lead, undefined);
    // With several teams, /api/groups needs the team.
    assert.equal((await post('/api/groups', { project: KEY, action: 'create', name: 'g' })).status, 400);
    assert.equal((await post('/api/groups', { project: KEY, team: 'Beta', action: 'create', name: 'g' })).status, 200);
    assert.ok(teamConf('Beta').groups.g);
    assert.equal(teamConf('Alpha').groups.g, undefined);
  });
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('M-1b: settings and group folders from before teams move on first read (git mv when tracked)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-repo-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q');
    const old = path.join(repo, 'docs', 'groups', 'front');
    fs.mkdirSync(path.join(old, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(old, 'brief.md'), 'old brief');
    fs.writeFileSync(path.join(old, 'handoff-001.md'), 'h1');
    git('add', '.');
    git('commit', '-qm', 'groups');
    reset({ sessions: { L1: session('L1', { kind: 'lead', cwd: repo }), M1: session('M1', { kind: 'member', lead: 'L1', group: 'front' }) } });
    writeJson(paths.projects, {
      [KEY]: {
        since: 'x', cwd: CWD, name: 'proj', mode: 'team', mode_ver: 3, lead: 'L1', lead_name: 'Alpha Team',
        groups: { front: { dir: slash(old), created: 'x', keep_handoffs: 5 } }, handoff: { from: 'L1', doc: 'd.md' },
      },
    });
    const p = appTeams.readProjects()[KEY];
    assert.deepEqual(Object.keys(p.teams), ['Alpha-Team']);
    const t = p.teams['Alpha-Team'];
    assert.equal(t.lead, 'L1');
    assert.equal(t.worktree.toLowerCase(), slash(repo).toLowerCase());
    assert.equal(t.groups.front.dir, slash(path.join(t.worktree, 'docs', 'teams', 'Alpha-Team', 'front')));
    assert.equal(t.groups.front.keep_handoffs, 5);
    assert.equal(t.handoff.from, 'L1');
    for (const k of ['lead', 'lead_name', 'groups', 'handoff']) assert.equal(p[k], undefined, k);
    assert.equal(p.mode, 'team');
    assert.equal(p.mode_ver, 4); // bumped: running sessions get the new instructions
    // Saved once; the folder moved with git mv and the empty docs/groups/ is gone.
    assert.ok(readJson(paths.projects, {})[KEY].teams['Alpha-Team']);
    assert.equal(fs.readFileSync(path.join(t.groups.front.dir, 'brief.md'), 'utf8'), 'old brief');
    assert.ok(!fs.existsSync(path.join(repo, 'docs', 'groups')));
    assert.match(git('status', '--porcelain').stdout, /^R {2}docs\/groups\/front\/brief\.md -> docs\/teams\/Alpha-Team\/front\/brief\.md/m);
    const s = readJson(paths.sessions, {});
    assert.equal(domTeam.teamRole(s.M1, p), 'member');
    assert.match(appRules.memberStart('M1'), /old brief/);
    // A second read changes nothing.
    const before = fs.readFileSync(paths.projects, 'utf8');
    appTeams.readProjects();
    assert.equal(fs.readFileSync(paths.projects, 'utf8'), before);
    // A solo project from 0.2.0 gets an empty team list and stays solo.
    writeJson(paths.projects, { [KEY]: { since: 'x', cwd: CWD } });
    const solo = appTeams.readProjects()[KEY];
    assert.deepEqual(solo.teams, {});
    assert.equal(solo.mode, undefined);
    assert.equal(domTeam.teamRole(s.L1, solo), 'solo');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('M-1b: handoff numbers never collide (exclusive create, next number on a clash)', async () => {
  const dir = path.join(BOARD, 'hf');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handoff-001.md'), 'h1');
  fs.writeFileSync(path.join(dir, 'handoff-002.md'), 'h2');
  assert.equal(path.basename(appTeamFiles.reserveHandoff(dir)), 'handoff-003.md');
  // Eight members finishing at once each get their own file.
  const code = `const { reserveHandoff } = require(${JSON.stringify(path.join(ROOT, 'plugin', 'scripts', 'app', 'team-files.js'))}); console.log(reserveHandoff(process.argv[1]));`;
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code, dir], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(out.trim()));
  });
  const got = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(new Set(got).size, 8, got.join('\n'));
  assert.ok(got.every((f) => /handoff-0(0[4-9]|1[01])\.md$/.test(f)), got.join('\n'));
  assert.equal(appTeamFiles.handoffs(dir).length, 11);
  // next-handoff: a member gets a file in its own group, a lead names one of its groups.
  teamFixture();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  team.main(['L1', 'group', 'create', 'front']);
  const s = readJson(paths.sessions, {});
  s.M1.group = 'front';
  writeJson(paths.sessions, s);
  const r = team.main(['M1', 'next-handoff']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, slash(path.join(groupDir('front'), 'handoff-001.md')));
  assert.match(fs.readFileSync(r.out, 'utf8'), /^# front handoff/);
  assert.match(team.main(['L1', 'next-handoff', 'front']).out, /handoff-002\.md$/);
  assert.equal(team.main(['L1', 'next-handoff']).code, 1);
  assert.equal(team.main(['O1', 'next-handoff']).code, 1);
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('M-1b review: team and group names ignore case; prototype names are plain names', () => {
  twoTeams();
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
  // 'alpha' would share docs/teams/alpha/ with 'Alpha' on a case-insensitive file system.
  assert.match(appTeams.addTeam(KEY, 'alpha', 'O1').error, /team Alpha exists in this project \(names ignore case\)/);
  assert.match(runHook('prompt-submit.js', { session_id: 'O1', cwd: CWD, prompt: '/ddashboard:dashboard team BETA' }), /No team was added: team Beta exists/);
  assert.equal(team.main(['L1', 'group', 'create', 'Front']).code, 0);
  assert.match(team.main(['L1', 'group', 'create', 'front']).out, /group Front exists in team Alpha \(names ignore case\)/);
  team.main(['L1', 'group', 'create', 'back']);
  assert.match(team.main(['L1', 'group', 'rename', 'back', 'FRONT']).out, /group Front exists/);
  // Names that are Object.prototype keys are not found unless they really exist.
  assert.equal(appTeams.removeTeams(KEY, ['constructor']).code, 404);
  assert.match(team.main(['L1', 'spawn', '--role', 'x', '--group', 'toString', 'task']).out, /no group toString in team Alpha/);
  assert.match(team.main(['L1', 'group', 'delete', 'constructor']).out, /no group constructor/);
  assert.equal(appTeams.addTeam(KEY, 'constructor', 'O1').ok, true);
  assert.equal(teamConf('constructor').lead, 'O1');
  assert.equal(team.main(['O1', 'group', 'create', 'hasOwnProperty']).code, 0);
  assert.ok(fs.existsSync(path.join(groupDir('hasOwnProperty', 'constructor'), 'brief.md')));
  const s = readJson(paths.sessions, {});
  s.M1.group = 'toString'; // a group that does not exist
  writeJson(paths.sessions, s);
  assert.doesNotMatch(appRules.rulesFor(s.M1, project()), /Group "toString" folder/);
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: '' }); // no crash
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('M-1b review: removing a team releases its members for good', () => {
  twoTeams();
  const s0 = readJson(paths.sessions, {});
  s0.M1.group = 'front';
  writeJson(paths.sessions, s0);
  const r = appTeams.removeTeams(KEY, ['Alpha']);
  assert.equal(r.ok, true);
  let s = readJson(paths.sessions, {});
  assert.equal(s.M1.kind, undefined);
  assert.equal(s.M1.lead, undefined);
  assert.equal(s.M1.group, undefined);
  assert.equal(s.M1.former_lead, 'L1');
  assert.equal(s.M2.lead, 'L2'); // the other team keeps its members
  // The same lead starts a new team: the released member stays outside.
  assert.equal(appTeams.addTeam(KEY, 'Delta', 'L1').ok, true);
  s = readJson(paths.sessions, {});
  assert.equal(domTeam.teamRole(s.M1, project()), 'outside');
  assert.equal(domTeam.routeCard(s, project(), 'M1').to, 'board');
});

test('M-1b review: migration bumps mode_ver, so running sessions get the new instructions once', () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.M1.rules_ver = 3;
  s.M1.group = 'front';
  writeJson(paths.sessions, s);
  writeJson(paths.projects, {
    [KEY]: { since: 'x', cwd: CWD, name: 'proj', mode: 'team', mode_ver: 3, lead: 'L1', lead_name: 'Alpha', groups: { front: { dir: slash(path.join(CWD, 'docs', 'groups', 'front')) } } },
  });
  const update = appRules.pendingRules('M1');
  assert.match(update, /mode changed \(now team\)/);
  assert.match(update, /docs\/teams\/Alpha\/front/);
  assert.match(update, /next-handoff/);
  assert.equal(appRules.pendingRules('M1'), '');
  assert.equal(project().mode_ver, 4);
  fs.rmSync(path.join(CWD, 'docs'), { recursive: true, force: true });
});

test('M-1b review: migration moves group folders inside the worktree that holds them', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-repo-'));
  const wt = `${repo}-wt`;
  const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  try {
    git(repo, 'init', '-q');
    for (const g of ['front', 'back']) {
      fs.mkdirSync(path.join(repo, 'docs', 'groups', g), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'groups', g, 'brief.md'), `${g} brief`);
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'groups');
    assert.equal(git(repo, 'worktree', 'add', '-q', wt).status, 0);
    // The lead now sits in the second worktree; front's folder is in the first, back's in the second.
    reset({ sessions: { L1: session('L1', { kind: 'lead', cwd: wt }) } });
    writeJson(paths.projects, {
      [KEY]: {
        since: 'x', cwd: CWD, name: 'proj', mode: 'team', mode_ver: 1, lead: 'L1', lead_name: 'Alpha',
        groups: {
          front: { dir: slash(path.join(repo, 'docs', 'groups', 'front')) },
          back: { dir: slash(path.join(wt, 'docs', 'groups', 'back')) },
        },
      },
    });
    const t = appTeams.readProjects()[KEY].teams.Alpha;
    // The team's worktree is the one holding docs/groups/, not the lead's current one.
    assert.equal(t.worktree.toLowerCase(), slash(repo).toLowerCase());
    assert.equal(t.groups.front.dir, slash(path.join(t.worktree, 'docs', 'teams', 'Alpha', 'front')));
    assert.match(git(repo, 'status', '--porcelain').stdout, /^R {2}docs\/groups\/front\/brief\.md -> docs\/teams\/Alpha\/front\/brief\.md/m);
    // The folder in the other worktree is not moved (no deletions left in its index), and the lead is told.
    assert.equal(t.groups.back.dir.toLowerCase(), slash(path.join(wt, 'docs', 'groups', 'back')).toLowerCase());
    assert.equal(git(wt, 'status', '--porcelain').stdout.trim(), '');
    assert.match(inbox('L1')[0].title, /group folders not moved to docs\/teams\/Alpha\/.*back/);
  } finally {
    git(repo, 'worktree', 'remove', '--force', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

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
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
