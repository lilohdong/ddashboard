#!/usr/bin/env node
// Team mode tests. Run: node test/team.test.js
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
process.env.DDASH_ORCA = '0'; // never open real Orca terminals; the Orca tests use a fake orca command

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'scripts', 'lib.js'));
const team = require(path.join(ROOT, 'scripts', 'team.js'));
const { paths, readJson, writeJson } = lib;

const KEY = lib.projectKey(CWD);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- fixtures ---

function session(sid, extra = {}) {
  return { session_id: sid, name: sid, cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: new Date().toISOString(), ...extra };
}

function reset({ mode = 'solo', lead, sessions = {} } = {}) {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  // A solo project looks like a 0.2.0 one (no mode fields); team mode was switched on once.
  const p = { since: new Date().toISOString(), cwd: CWD };
  if (mode === 'team') Object.assign(p, { name: 'proj', mode, mode_ver: 1 });
  if (lead) Object.assign(p, { lead, lead_name: 'Alpha' });
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
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', name)], {
    input: JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const inboxFiles = (sid) => { try { return fs.readdirSync(paths.inbox(sid)).filter((f) => f.endsWith('.json')); } catch { return []; } };
const inbox = (sid) => inboxFiles(sid).map((f) => readJson(path.join(paths.inbox(sid), f), null));
const allCards = () => lib.cardFiles().flatMap((f) => lib.readJsonl(f));
const cardText = (c) => `done.\n\`\`\`card\n${JSON.stringify(c)}\n\`\`\``;

// --- tag parsing ---

test('parseTag: member tag', () => {
  assert.deepEqual(lib.parseTag('[ddash role=frontend lead=abc-123 stay=1] build the page'),
    { type: 'member', role: 'frontend', lead: 'abc-123', stay: true, rest: 'build the page' });
  const t = lib.parseTag('  [ddash role="QA lead" lead=x stay=0]\nTest it');
  assert.equal(t.role, 'QA lead');
  assert.equal(t.stay, false);
  assert.equal(t.rest, 'Test it');
  assert.equal(lib.parseTag('[ddash lead=x] go').role, 'member');
});

test('parseTag: handoff tag', () => {
  assert.deepEqual(lib.parseTag('[ddash lead-handoff from=old-1 doc="C:/a b/h.md"] take over'),
    { type: 'handoff', from: 'old-1', doc: 'C:/a b/h.md', rest: 'take over' });
});

test('parseTag: no tag or incomplete tag', () => {
  assert.equal(lib.parseTag('hello [ddash role=x lead=y]'), null);
  assert.equal(lib.parseTag('[ddash role=x]'), null); // no lead
  assert.equal(lib.parseTag('[ddash lead-handoff doc=x]'), null); // no from
  assert.equal(lib.parseTag(''), null);
});

test('wakeReason knows the message headers', () => {
  assert.equal(lib.wakeReason('[Dashboard reply]\n- x'), 'reply');
  assert.equal(lib.wakeReason('[Team report]\n- x'), 'report');
  assert.equal(lib.wakeReason('[Lead instruction]\nx'), 'order');
  assert.equal(lib.wakeReason('[ddash role=a lead=b] task'), 'order');
  assert.equal(lib.wakeReason('hi'), 'human');
});

// --- routing ---

test('routeCard: solo mode posts to the board', () => {
  const sessions = { M1: session('M1', { kind: 'member', lead: 'L1' }), L1: session('L1') };
  const r = lib.routeCard(sessions, { [KEY]: { mode: 'solo' } }, 'M1');
  assert.deepEqual(r, { to: 'board', role: 'solo' });
});

test('routeCard: team mode sends member cards to the lead', () => {
  const sessions = { M1: session('M1', { kind: 'member', lead: 'L1' }), L1: session('L1'), O1: session('O1') };
  const projects = { [KEY]: { mode: 'team', lead: 'L1' } };
  assert.deepEqual(lib.routeCard(sessions, projects, 'M1'), { to: 'lead', role: 'member', lead: 'L1' });
  assert.deepEqual(lib.routeCard(sessions, projects, 'L1'), { to: 'board', role: 'lead' });
  assert.deepEqual(lib.routeCard(sessions, projects, 'O1'), { to: 'board', role: 'outside' });
});

test('routeCard: lead missing falls back to the board', () => {
  const projects = { [KEY]: { mode: 'team', lead: 'L1' } };
  const ended = { M1: session('M1', { kind: 'member', lead: 'L1' }), L1: session('L1', { state: 'ended', ended: 'x' }) };
  assert.deepEqual(lib.routeCard(ended, projects, 'M1'), { to: 'board', role: 'member', lead_missing: true });
  const gone = { M1: session('M1', { kind: 'member', lead: 'L9' }) };
  assert.equal(lib.routeCard(gone, projects, 'M1').lead_missing, true);
});

// --- message formatting ---

test('formatMessages: dashboard replies keep the 0.2.0 format', () => {
  const out = lib.formatMessages([{ text: 'do it', card_title: 'Plan' }, { type: 'reply', text: 'thanks' }]);
  assert.equal(out, '[Dashboard reply]\n- [card: Plan] do it\n- thanks');
});

test('formatMessages: reports and instructions get their own headers', () => {
  const report = lib.reportMessage(
    { id: 'c1', status: 'review', title: 'Login page', summary: ['added form'], review: ['check styles'], details: 'x'.repeat(400) },
    { session_id: 'abcdef123456', role: 'frontend' },
  );
  assert.equal(report.details_ref, 'c1');
  assert.equal(report.details, undefined);
  const out = lib.formatMessages([{ type: 'order', text: 'fix the bug' }, report, { text: 'hi' }]);
  assert.equal(out, [
    '[Dashboard reply]\n- hi',
    '[Team report]\n- frontend (abcdef12) review: Login page\n  added form\n  check: check styles\n  details: long, read with: team.js show c1',
    '[Lead instruction]\n- fix the bug',
  ].join('\n\n'));
  const short = lib.reportMessage({ id: 'c2', status: 'done', title: 't', details: 'short' }, { session_id: 's' });
  assert.equal(short.details, 'short');
  assert.equal(lib.messagesReason([report]), 'report');
  assert.equal(lib.messagesReason([report, { text: 'x' }]), 'reply');
});

// --- rules ---

test('rules: solo text unchanged, team texts per role, re-injected once on mode change', () => {
  teamFixture();
  const sessions = readJson(paths.sessions, {});
  const p = readJson(paths.projects, {})[KEY];
  assert.equal(lib.rulesFor(sessions.O1, { mode: 'solo' }), lib.rulesText('O1'));
  assert.match(lib.rulesFor(sessions.L1, p), /team lead "Alpha"/);
  assert.match(lib.rulesFor(sessions.L1, p), /bin\/team\.js" L1/);
  assert.match(lib.rulesFor(sessions.M1, p), /Role: frontend/);
  assert.match(lib.rulesFor(sessions.M1, p), /Don't start a wait command/);
  assert.match(lib.rulesFor({ ...sessions.M1, stay: true }, p), /bin\/wait\.js" M1/);
  assert.match(lib.rulesFor(sessions.O1, p), /outside the team/);
  assert.equal(lib.pendingRules('M1'), ''); // rules_ver === mode_ver
  lib.setMode(KEY, 'solo');
  assert.match(lib.pendingRules('M1'), /mode changed \(now solo\)/);
  assert.equal(lib.pendingRules('M1'), '');
});

test('rules: every role restarts the wait command in the same response; member reports stay short', () => {
  teamFixture();
  const sessions = readJson(paths.sessions, {});
  const p = { ...readJson(paths.projects, {})[KEY], groups: { front: { dir: 'C:/x/docs/groups/front' } } };
  const same = /same response, as parallel tool calls/;
  assert.match(lib.rulesFor(sessions.O1, { mode: 'solo' }), same);
  assert.match(lib.rulesFor(sessions.L1, p), same);
  assert.match(lib.rulesFor(sessions.O1, p), same);
  assert.match(lib.rulesFor({ ...sessions.M1, stay: true }, p), same);
  assert.match(lib.rulesFor(sessions.M1, p), /summary of at most 3 lines: put the evidence in a file/);
  assert.match(lib.rulesFor({ ...sessions.M1, group: 'front' }, p), /evidence in C:\/x\/docs\/groups\/front\/notes\/ and give the path/);
});

test('setMode: team with a new lead moves the members, solo clears the lead', () => {
  teamFixture();
  const r = lib.setMode(KEY, 'team', { lead: 'O1', leadName: 'Beta' });
  assert.equal(r.ok, true);
  const s = readJson(paths.sessions, {});
  const p = readJson(paths.projects, {})[KEY];
  assert.equal(p.lead, 'O1');
  assert.equal(p.lead_name, 'Beta');
  assert.equal(p.mode_ver, 2);
  assert.equal(s.O1.kind, 'lead');
  assert.equal(s.L1.kind, undefined);
  assert.equal(s.M1.lead, 'O1');
  lib.setMode(KEY, 'solo');
  const p2 = readJson(paths.projects, {})[KEY];
  assert.equal(p2.mode, 'solo');
  assert.equal(p2.lead, undefined);
  assert.equal(lib.setMode(KEY, 'team', { lead: 'nobody' }).ok, false);
});

// --- handoff ---

test('performHandoff: reassigns lead and members, moves inbox, stops the old lead', async () => {
  teamFixture();
  const s0 = readJson(paths.sessions, {});
  s0.L2 = session('L2');
  s0.L1.claude_pid = 999999;
  writeJson(paths.sessions, s0);
  lib.deliver('L1', { type: 'report', from: 'M1', title: 'pending report' });
  const waiter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  fs.writeFileSync(path.join(paths.inbox('L1'), 'wait.lock'), String(waiter.pid));
  const killed = [];
  try {
    const r = lib.performHandoff('L1', 'L2', 'C:/doc.md', {
      kill: (pid) => { killed.push(pid); return true; },
      killClaude: (pid) => { killed.push(`claude:${pid}`); return true; },
    });
    assert.deepEqual(r, { ok: true, members: 1, moved: 1, wait_killed: true, claude_killed: true, claude_pid: 999999 });
  } finally { waiter.kill(); }
  assert.deepEqual(killed, [waiter.pid, 'claude:999999']);
  const s = readJson(paths.sessions, {});
  const p = readJson(paths.projects, {})[KEY];
  assert.equal(p.lead, 'L2');
  assert.equal(p.lead_name, 'Alpha');
  assert.equal(s.L2.kind, 'lead');
  assert.equal(s.M1.lead, 'L2');
  assert.equal(s.L1.state, 'ended');
  assert.equal(s.L1.end_reason, 'handoff');
  assert.equal(s.L1.replaced_by, 'L2');
  assert.equal(s.L1.kind, undefined);
  assert.equal(inboxFiles('L1').length, 0);
  assert.equal(inbox('L2')[0].title, 'pending report');
  assert.equal(lib.performHandoff('L1', 'nobody', '').ok, false);
});

// --- hooks end to end ---

test('Stop hook: member card goes to the lead inbox (via_lead), not the board', () => {
  teamFixture();
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: cardText({ status: 'done', title: 'API ready', summary: ['ok'] }) });
  const [card] = allCards();
  assert.equal(card.via_lead, 'L1');
  const [msg] = inbox('L1');
  assert.equal(msg.type, 'report');
  assert.equal(msg.title, 'API ready');
  assert.equal(msg.role, 'frontend');
  // The lead's next stop hands the report over under its header.
  const out = JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, last_assistant_message: 'no card' }));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^\[Team report\]\n- frontend \(M1\) done: API ready/);
  assert.equal(readJson(paths.sessions, {}).L1.reply_handed, 'report');
});

test('Stop hook: lead missing posts to the board with lead_missing', () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.L1.state = 'ended';
  writeJson(paths.sessions, s);
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: cardText({ status: 'blocked', title: 'Stuck' }) });
  const [card] = allCards();
  assert.equal(card.lead_missing, true);
  assert.equal(card.via_lead, undefined);
  assert.equal(inboxFiles('L1').length, 0);
});

test('Stop hook: solo mode stores the card and hands replies over as before', () => {
  reset({ sessions: { S1: session('S1') } });
  lib.deliver('S1', { text: 'next step', card_title: 'Plan' });
  const out = JSON.parse(runHook('stop-card.js', { session_id: 'S1', cwd: CWD, last_assistant_message: cardText({ title: 'Plan' }) }));
  assert.deepEqual(out, { decision: 'block', reason: '[Dashboard reply]\n- [card: Plan] next step' });
  const [card] = allCards();
  assert.equal(card.via_lead, undefined);
  assert.equal(card.lead_missing, undefined);
});

test('Stop hook: a replaced lead is told to stop once', () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  Object.assign(s.L1, { replaced_by: 'L2', state: 'ended' });
  writeJson(paths.sessions, s);
  const first = JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, last_assistant_message: cardText({ title: 'x' }) }));
  assert.match(first.reason, /replaced as team lead by L2/);
  assert.equal(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, last_assistant_message: '' }), '');
  assert.equal(allCards().length, 0);
});

test('Stop hook: a lead over the context limit is told once to hand off', () => {
  teamFixture();
  const transcript = path.join(BOARD, 't.jsonl');
  const rows = [
    { type: 'user', uuid: 'u1', message: { content: 'go' } },
    { type: 'assistant', message: { id: 'a1', usage: { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
  ];
  fs.writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const env = { DDASH_LEAD_CONTEXT_LIMIT: '400' };
  const out = JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript }, env));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /context \(510 tokens\) is over the team lead limit \(400\).*bin\/team\.js" L1 handoff <doc-path>/);
  assert.equal(readJson(paths.sessions, {}).L1.context_handoff_told, true);
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'a2', usage: { input_tokens: 20, cache_read_input_tokens: 600 } } }) + '\n');
  assert.equal(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript }, env), ''); // once
  // Members and solo sessions are never told.
  assert.equal(runHook('stop-card.js', { session_id: 'O1', cwd: CWD, transcript_path: transcript }, env), '');
});

test('UserPromptSubmit: member tag registers the member; replaced lead prompts are blocked', () => {
  teamFixture();
  const out = runHook('prompt-submit.js', { session_id: 'N1', cwd: CWD, prompt: '[ddash role=qa lead=L1 stay=1] test it' });
  assert.match(out, /You are a team member\. Role: qa/);
  const s = readJson(paths.sessions, {});
  assert.equal(s.N1.kind, 'member');
  assert.equal(s.N1.lead, 'L1');
  assert.equal(s.N1.stay, true);
  assert.equal(s.N1.state, 'working');
  // Untagged first prompt in team mode: outside the team.
  assert.match(runHook('prompt-submit.js', { session_id: 'X1', cwd: CWD, prompt: 'hello' }), /outside the team/);
  // Already registered, mode unchanged: nothing printed.
  assert.equal(runHook('prompt-submit.js', { session_id: 'N1', cwd: CWD, prompt: 'more' }), '');
  const s2 = readJson(paths.sessions, {});
  s2.N1.replaced_by = 'Z';
  writeJson(paths.sessions, s2);
  assert.equal(JSON.parse(runHook('prompt-submit.js', { session_id: 'N1', cwd: CWD, prompt: 'go' })).decision, 'block');
});

test('UserPromptSubmit: handoff tag takes over the team', () => {
  teamFixture(); // L1 has no claude_pid, so nothing real is killed
  const out = runHook('prompt-submit.js', { session_id: 'L2', cwd: CWD, prompt: '[ddash lead-handoff from=L1 doc=h.md] take over' });
  assert.match(out, /took over as team lead from L1/);
  assert.match(out, /team lead "Alpha"/);
  const s = readJson(paths.sessions, {});
  assert.equal(readJson(paths.projects, {})[KEY].lead, 'L2');
  assert.equal(s.M1.lead, 'L2');
  assert.equal(s.L1.replaced_by, 'L2');
});

test('SessionStart: team mode defers new sessions to the first prompt', () => {
  teamFixture();
  assert.equal(runHook('session-start.js', { session_id: 'NEW', cwd: CWD }), '');
  assert.equal(readJson(paths.sessions, {}).NEW, undefined);
  reset({ sessions: {} });
  assert.equal(runHook('session-start.js', { session_id: 'NEW', cwd: CWD }), lib.rulesText('NEW'));
});

// --- team.js ---

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

test('team.js spawn: headless claude -p with the tag, default permissions, recorded options', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  process.env.FAKE_OUT = path.join(BOARD, 'spawn.json');
  process.env.CLAUDECODE = '1';
  const r = team.main(['L1', 'spawn', '--role', 'backend', '--model', 'sonnet', 'build the API']);
  assert.equal(r.code, 0, r.out);
  const got = await waitFor(process.env.FAKE_OUT);
  const sid = got.argv[got.argv.indexOf('--session-id') + 1];
  assert.equal(got.argv[0], '-p');
  assert.deepEqual(got.argv.slice(got.argv.indexOf('--model'), got.argv.indexOf('--model') + 2), ['--model', 'sonnet']);
  assert.ok(got.argv.includes('auto'));
  assert.deepEqual(got.argv.slice(-3), ['Bash(git *)', 'Bash(node *)', 'Bash(npm *)']);
  assert.equal(got.input, `[ddash role=backend lead=L1 stay=0] build the API`);
  assert.equal(got.nested, '');
  const s = readJson(paths.sessions, {})[sid];
  assert.equal(s.kind, 'member');
  assert.equal(s.pending, true);
  assert.equal(s.spawn.model, 'sonnet');
  assert.ok(fs.existsSync(paths.log(sid)));
});

test('team.js send: inbox when waiting, resume when a headless member has finished', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  const s = readJson(paths.sessions, {});
  s.H1 = session('H1', { kind: 'member', role: 'qa', lead: 'L1', headless: true, pid: 999999, spawn: { permission_mode: 'acceptEdits', allowed_tools: ['Bash(git *)'], cwd: CWD } });
  writeJson(paths.sessions, s);
  // M1 waits: the instruction goes to its inbox.
  fs.mkdirSync(paths.inbox('M1'), { recursive: true });
  fs.writeFileSync(path.join(paths.inbox('M1'), 'wait.lock'), String(process.pid));
  assert.equal(team.main(['L1', 'send', 'frontend', 'use the new API']).code, 0);
  const [order] = inbox('M1');
  assert.equal(order.type, 'order');
  assert.equal(order.text, 'use the new API');
  // H1 has finished (dead pid): resumed with the same options.
  process.env.FAKE_OUT = path.join(BOARD, 'resume.json');
  const r = team.main(['L1', 'send', 'qa', 'run the tests again']);
  assert.match(r.out, /Resumed qa/);
  const got = await waitFor(process.env.FAKE_OUT);
  assert.deepEqual(got.argv.slice(0, 3), ['-p', '--resume', 'H1']);
  assert.equal(got.input, '[Lead instruction]\nrun the tests again');
  assert.equal(team.main(['L1', 'send', 'nobody', 'x']).code, 1);
  assert.match(team.main(['L1', 'list']).out, /M1 {2}frontend .*\(waiting\)/);
});

test('team.js show and handoff', () => {
  teamFixture();
  runHook('stop-card.js', { session_id: 'M1', cwd: CWD, last_assistant_message: cardText({ title: 'Long', details: 'D'.repeat(500) }) });
  const [card] = allCards();
  assert.match(team.main(['L1', 'show', card.id]).out, /D{500}/);
  const doc = path.join(BOARD, 'handoff.md');
  fs.writeFileSync(doc, '# handoff');
  const r = team.main(['L1', 'handoff', doc]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[ddash lead-handoff from=L1 doc=.*handoff\.md\]/);
  assert.equal(readJson(paths.projects, {})[KEY].handoff.from, 'L1');
  assert.equal(team.main(['M1', 'handoff', doc]).code, 1); // not the lead
});

// --- Orca (visible members). A fake orca logs its calls; FAKE_ORCA_UP / _WRITABLE / _FAIL steer its replies. ---

function fakeOrca() {
  const file = path.join(BOARD, 'fake-orca.js');
  fs.writeFileSync(file, `const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(a) + '\\n');
const out = (o) => console.log(JSON.stringify(o));
const cmd = a.slice(0, 2).join(' ');
if (a[0] === 'status') out({ ok: true, result: { runtime: { reachable: process.env.FAKE_ORCA_UP === '1' } } });
else if (cmd === 'terminal create') {
  if (process.env.FAKE_ORCA_FAIL === '1') { out({ ok: false, error: { message: 'no worktree' } }); process.exit(1); }
  out({ ok: true, result: { terminal: { handle: 'term_fake', paneKey: 'tab:leaf' } } });
} else if (cmd === 'terminal show') out({ ok: true, result: { terminal: { handle: a[3], writable: process.env.FAKE_ORCA_WRITABLE === '1' } } });
else if (cmd === 'terminal send') out({ ok: true, result: { send: { accepted: true } } });
else { out({ ok: false }); process.exit(1); }
`);
  return file;
}

function orcaEnv({ up = true, writable = true, fail = false } = {}) {
  process.env.DDASH_ORCA = '';
  process.env.DDASH_ORCA_BIN = fakeOrca();
  process.env.FAKE_ORCA_LOG = path.join(BOARD, 'orca.log');
  process.env.FAKE_ORCA_UP = up ? '1' : '0';
  process.env.FAKE_ORCA_WRITABLE = writable ? '1' : '0';
  process.env.FAKE_ORCA_FAIL = fail ? '1' : '0';
  try { fs.unlinkSync(process.env.FAKE_ORCA_LOG); } catch {}
}
const orcaCalls = () => lib.readJsonl(process.env.FAKE_ORCA_LOG);
const orcaOff = () => { process.env.DDASH_ORCA = '0'; };
const flagOf = (argv, name) => argv[argv.indexOf(name) + 1];

test('team.js spawn: visible in Orca when it runs, with the same pre-registration', () => {
  teamFixture();
  orcaEnv();
  try {
    const r = team.main(['L1', 'spawn', '--role', 'fe', '--model', 'sonnet', 'build\nthe page']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /in a visible Orca terminal \(term_fake\)/);
    const create = orcaCalls().find((c) => c[0] === 'terminal' && c[1] === 'create');
    assert.equal(flagOf(create, '--worktree'), `path:${CWD.replace(/\\/g, '/')}`);
    assert.equal(flagOf(create, '--title'), 'fe');
    const command = flagOf(create, '--command');
    const m = command.match(/^node "(.+\/orca-launch\.js)" "(.+\.json)"$/);
    assert.ok(m, command);
    const spec = JSON.parse(fs.readFileSync(m[2], 'utf8'));
    const sid = flagOf(spec.args, '--session-id');
    assert.equal(flagOf(spec.args, '--model'), 'sonnet');
    assert.ok(spec.args.includes('auto'));
    assert.ok(!spec.args.includes('-p'));
    assert.equal(fs.readFileSync(spec.prompt_file, 'utf8'), '[ddash role=fe lead=L1 stay=0] build\nthe page');
    const s = readJson(paths.sessions, {})[sid];
    assert.equal(s.runner, 'orca');
    assert.equal(s.headless, false);
    assert.equal(s.pending, true);
    assert.equal(s.orca.handle, 'term_fake');
    assert.match(team.main(['L1', 'list']).out, / orca/);
  } finally { orcaOff(); }
});

test('team.js spawn: --headless forces claude -p, --orca needs Orca, a failed terminal falls back to headless', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  try {
    orcaEnv();
    process.env.FAKE_OUT = path.join(BOARD, 'h.json');
    const r = team.main(['L1', 'spawn', '--headless', '--role', 'be', 'api']);
    assert.match(r.out, /headless \(pid/);
    assert.equal((await waitFor(process.env.FAKE_OUT)).argv[0], '-p');
    assert.ok(!orcaCalls().some((c) => c[1] === 'create'));

    orcaEnv({ up: false });
    const before = Object.keys(readJson(paths.sessions, {})).length;
    const r2 = team.main(['L1', 'spawn', '--orca', '--role', 'be', 'api']);
    assert.equal(r2.code, 1);
    assert.match(r2.out, /Orca is not running/);
    assert.equal(Object.keys(readJson(paths.sessions, {})).length, before);

    orcaEnv({ fail: true });
    assert.equal(team.main(['L1', 'spawn', '--orca', '--role', 'be', 'api']).code, 1);
    assert.equal(Object.keys(readJson(paths.sessions, {})).length, before);
    process.env.FAKE_OUT = path.join(BOARD, 'h2.json');
    const r3 = team.main(['L1', 'spawn', '--role', 'be', 'api']);
    assert.match(r3.out, /could not open a terminal \(.*no worktree\); started headless/);
    const got = await waitFor(process.env.FAKE_OUT);
    assert.equal(readJson(paths.sessions, {})[flagOf(got.argv, '--session-id')].runner, 'headless');
  } finally { orcaOff(); }
});

test('team.js send to an Orca member: inbox, typed into its terminal, or resumed', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  const s = readJson(paths.sessions, {});
  s.V1 = session('V1', { kind: 'member', role: 'ui', lead: 'L1', runner: 'orca', headless: false, orca: { handle: 'term_v1' }, spawn: { permission_mode: 'acceptEdits', cwd: CWD } });
  writeJson(paths.sessions, s);
  const set = (fields) => { const all = readJson(paths.sessions, {}); Object.assign(all.V1, fields); writeJson(paths.sessions, all); };
  try {
    // Idle at its prompt: typed into the terminal as one line.
    orcaEnv();
    assert.match(team.main(['L1', 'send', 'ui', 'fix the\nheader']).out, /Typed into ui's Orca terminal/);
    const sent = orcaCalls().find((c) => c[1] === 'send');
    assert.equal(flagOf(sent, '--terminal'), 'term_v1');
    assert.equal(flagOf(sent, '--text'), '[Lead instruction] fix the header');
    assert.ok(sent.includes('--enter'));
    assert.equal(readJson(paths.sessions, {}).V1.state, 'working');
    // Mid-turn: into the inbox.
    assert.match(team.main(['L1', 'send', 'ui', 'also the footer']).out, /Queued for ui/);
    assert.equal(inbox('V1')[0].text, 'also the footer');
    // Terminal closed: resumed in a new Orca terminal.
    orcaEnv({ writable: false });
    set({ state: 'idle' });
    assert.match(team.main(['L1', 'send', 'ui', 'next']).out, /Resumed ui .*new Orca terminal/);
    const spec = JSON.parse(fs.readFileSync(flagOf(orcaCalls().find((c) => c[1] === 'create'), '--command').match(/"([^"]+\.json)"$/)[1], 'utf8'));
    assert.deepEqual(spec.args.slice(0, 2), ['--resume', 'V1']);
    assert.equal(fs.readFileSync(spec.prompt_file, 'utf8'), '[Lead instruction]\nnext');
    // Ended and Orca down: headless resume.
    orcaEnv({ up: false });
    set({ state: 'ended', ended: 'x' });
    process.env.FAKE_OUT = path.join(BOARD, 'v-resume.json');
    assert.match(team.main(['L1', 'send', 'ui', 'last']).out, /headless: Orca is not available/);
    assert.deepEqual((await waitFor(process.env.FAKE_OUT)).argv.slice(0, 3), ['-p', '--resume', 'V1']);
    const v = readJson(paths.sessions, {}).V1;
    assert.equal(v.runner, 'headless');
    assert.equal(v.ended, undefined);
  } finally { orcaOff(); }
});

test('orca-launch: starts claude with the prompt first, then the options', () => {
  const out = path.join(BOARD, 'launch.json');
  const promptFile = path.join(BOARD, 'p.txt');
  fs.writeFileSync(promptFile, '[ddash role=fe lead=L1 stay=0] two\nlines');
  const specFile = path.join(BOARD, 'spec.json');
  fs.writeFileSync(specFile, JSON.stringify({ args: ['--session-id', 'S1', '--allowedTools', 'Bash(git *)'], prompt_file: promptFile, cwd: CWD }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orca-launch.js'), specFile], {
    input: '', encoding: 'utf8', env: { ...process.env, DDASH_CLAUDE_BIN: fakeClaude(), FAKE_OUT: out, CLAUDECODE: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(got.argv, ['[ddash role=fe lead=L1 stay=0] two\nlines', '--session-id', 'S1', '--allowedTools', 'Bash(git *)']);
  assert.equal(got.nested, '');
});

// --- sidebar housekeeping and dashboard spawn (through the server) ---

test('forgetSessions / markEnded', () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.E1 = session('E1', { state: 'ended', ended: 'x' });
  s.OLD = session('OLD', { last_seen: new Date(Date.now() - 2 * 3600e3).toISOString() });
  writeJson(paths.sessions, s);
  fs.mkdirSync(paths.done('E1'), { recursive: true });
  assert.deepEqual(lib.forgetSessions(['E1', 'M1']), { forgotten: ['E1'], refused: ['M1'] });
  assert.equal(fs.existsSync(paths.inbox('E1')), false);
  assert.equal(lib.markEnded('M1').code, 409); // seen recently
  assert.equal(lib.markEnded('OLD').ok, true);
  assert.equal(readJson(paths.sessions, {}).OLD.end_reason, 'marked');
});

async function withServer(fn) {
  const port = 7400 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'server.js')], { env: { ...process.env, DDASH_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const post = async (url, body, headers = {}) => {
      const res = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await fn(post, base);
  } finally { srv.kill(); }
}

test('server: forget, mark ended, spawn from the dashboard', async () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.E1 = session('E1', { state: 'ended', ended: 'x' });
  s.E2 = session('E2', { state: 'ended', ended: 'x' });
  s.OLD = session('OLD', { last_seen: new Date(Date.now() - 2 * 3600e3).toISOString() });
  writeJson(paths.sessions, s);
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  process.env.FAKE_OUT = path.join(BOARD, 'ui-spawn.json');
  await withServer(async (post, base) => {
    assert.equal((await post('/api/sessions/forget', { session_id: 'E1' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/sessions/forget', { session_id: 'M1' })).status, 409);
    assert.equal((await post('/api/sessions/forget', { session_id: 'E1' })).body.forgotten, 1);
    assert.equal((await post('/api/sessions/forget', { project: 'proj', ended: true })).body.forgotten, 1);
    assert.equal((await post('/api/sessions/end', { session_id: 'M1' })).status, 409);
    assert.equal((await post('/api/sessions/end', { session_id: 'OLD' })).status, 200);
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.stale_min, 60);
    assert.deepEqual(Object.keys(st.sessions).sort(), ['L1', 'M1', 'O1', 'OLD']);

    assert.equal((await post('/api/team/spawn', { lead: 'O1', role: 'qa', task: 'x' })).status, 409); // not the lead
    assert.equal((await post('/api/team/spawn', { lead: 'L1', role: 'qa', task: 'x' }, { Origin: 'http://evil.example' })).status, 403);
    const r = await post('/api/team/spawn', { lead: 'L1', role: 'qa', model: 'haiku', stay: true, task: 'Test the login\nmore lines' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.runner, 'headless'); // DDASH_ORCA=0
    const got = await waitFor(process.env.FAKE_OUT);
    assert.equal(got.input, '[ddash role=qa lead=L1 stay=1] Test the login\nmore lines');
    assert.ok(got.argv.includes('haiku'));
    const note = inbox('L1').find((m) => m.from === r.body.session_id);
    assert.equal(note.type, 'report');
    assert.equal(note.title, `member qa ${r.body.session_id.slice(0, 8)} spawned by the user: Test the login`);
    const s2 = readJson(paths.sessions, {});
    s2.L1.state = 'ended';
    writeJson(paths.sessions, s2);
    assert.equal((await post('/api/team/spawn', { lead: 'L1', role: 'qa', task: 'x' })).status, 409); // lead ended
  });
});

test('server: unresponsive marker and lead context limit in /api/state', async () => {
  teamFixture();
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  const s = readJson(paths.sessions, {});
  s.Q1 = session('Q1', { last_seen: old });
  s.Q2 = session('Q2', { last_seen: old });
  s.Q3 = session('Q3', { last_seen: old, state: 'working' });
  s.Q4 = session('Q4', { last_seen: old, state: 'ended', ended: old });
  writeJson(paths.sessions, s);
  fs.mkdirSync(paths.inbox('Q2'), { recursive: true });
  fs.writeFileSync(path.join(paths.inbox('Q2'), 'wait.lock'), String(process.pid)); // live waiter
  await withServer(async (_post, base) => {
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.lead_context_limit, 150000);
    const un = Object.values(st.sessions).filter((x) => x.unresponsive).map((x) => x.session_id);
    assert.deepEqual(un, ['Q1']);
  });
});

// --- groups ---

const groupDir = (name) => path.join(CWD, 'docs', 'groups', name);

test('parseTag: group attribute', () => {
  assert.equal(lib.parseTag('[ddash role=fe lead=L1 group=front] x').group, 'front');
  assert.equal(lib.parseTag('[ddash role=fe lead=L1 group=../x] x').group, undefined);
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
  assert.equal(readJson(paths.projects, {})[KEY].groups.web.dir, groupDir('web').replace(/\\/g, '/'));
  assert.match(team.main(['L1', 'group', 'list']).out, /^web .* members 1\/1/);
  assert.equal(team.main(['L1', 'group', 'delete', 'web']).code, 0);
  const archived = fs.readdirSync(path.join(CWD, 'docs', 'groups', '_archived'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^web-\d{8}$/);
  assert.equal(readJson(paths.sessions, {}).M1.group, undefined);
  assert.deepEqual(readJson(paths.projects, {})[KEY].groups, {});
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
    const s = readJson(paths.sessions, {});
    s.L1.cwd = repo;
    writeJson(paths.sessions, s);
    assert.equal(team.main(['L1', 'group', 'create', 'api']).code, 0);
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'groups');
    assert.match(team.main(['L1', 'group', 'rename', 'api', 'backend']).out, /git mv/);
    assert.match(git('status', '--porcelain').stdout, /^R {2}docs\/groups\/api\/brief\.md -> docs\/groups\/backend\/brief\.md/m);
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
    const s = readJson(paths.sessions, {});
    s.L1.cwd = repo;
    writeJson(paths.sessions, s);
    team.main(['L1', 'group', 'create', 'api']);
    stop(); // records the brief's HEAD
    const g = readJson(paths.projects, {})[KEY].groups.api;
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
    const brief = path.join(repo, 'docs', 'groups', 'api', 'brief.md');
    fs.appendFileSync(brief, '\nupdated');
    fs.utimesSync(brief, new Date(), new Date(Date.now() + 5000));
    stop();
    const g2 = readJson(paths.projects, {})[KEY].groups.api;
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
  assert.deepEqual(lib.handoffs(dir), ['handoff-003.md', 'handoff-004.md', 'handoff-010.md']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')), ['new.md']);
  assert.ok(fs.existsSync(path.join(CWD, 'docs', 'outside.md')));
  assert.equal(lib.latestHandoff(dir), path.join(dir, 'handoff-010.md').replace(/\\/g, '/'));
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
  assert.match(start, /write the next handoff-NNN\.md/);
  // The tag prompt then registers it without repeating anything.
  assert.equal(runHook('prompt-submit.js', { session_id: sid, cwd: CWD, prompt: got.input }), '');
  const s = readJson(paths.sessions, {})[sid];
  assert.equal(s.pending, undefined);
  assert.equal(s.group, 'front');
  // Two members of the group get the same prefix (the part before their own instructions).
  const ctx = lib.groupContext('front', readJson(paths.projects, {})[KEY].groups.front);
  assert.ok(start.startsWith(ctx.text));
  // Too long: cut, and the lead is told once.
  fs.writeFileSync(path.join(dir, 'brief.md'), 'x'.repeat(lib.BRIEF_MAX_CHARS + 50));
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
    assert.deepEqual(Object.keys(st.teams.proj.groups), ['test']);
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

// --- language (settings.json, card language, dashboard dictionary) ---

const i18n = require(path.join(ROOT, 'scripts', 'i18n.js'));

test('i18n: every key in every language, and every key the page uses exists', () => {
  const keys = Object.keys(i18n.DICT.en);
  for (const lang of Object.keys(i18n.LANGS)) {
    assert.deepEqual(Object.keys(i18n.DICT[lang]).sort(), keys.slice().sort(), `keys of ${lang}`);
    for (const k of keys) {
      const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      assert.equal(vars(i18n.DICT[lang][k]), vars(i18n.DICT.en[k]), `placeholders of ${lang} ${k}`);
    }
  }
  const html = fs.readFileSync(path.join(ROOT, 'scripts', 'dashboard.html'), 'utf8');
  const used = new Set([
    ...[...html.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n-\w+="([\w.]+)"/g)].map((m) => m[1]),
    ...['review', 'blocked', 'wip', 'done'].map((k) => `status.${k}`),
    ...['working', 'waiting', 'idle', 'ended'].map((k) => `view.${k}`),
  ]);
  for (const k of used) assert.ok(k in i18n.DICT.en, `missing key ${k}`);
  assert.equal(i18n.translate('ko', 'ago.m', { n: 3 }), '3분 전');
  assert.equal(i18n.translate('zh-CN', 'nope.key'), 'nope.key');
  assert.equal(i18n.translate('ko', 'card.send'), '보내기');
  assert.equal(i18n.pickLang(null, 'ko-KR'), 'ko');
  assert.equal(i18n.pickLang(null, 'zh-TW'), 'zh-CN');
  assert.equal(i18n.pickLang('en', 'ko-KR'), 'en');
  assert.equal(i18n.pickLang(null, 'fr'), 'en');
});

test('card language: rules unchanged without a setting, named language with one, re-injected once on change', () => {
  teamFixture();
  const sessions = readJson(paths.sessions, {});
  const p = readJson(paths.projects, {})[KEY];
  assert.match(lib.rulesText('S'), /written in the user's language/);
  assert.doesNotMatch(lib.rulesFor(sessions.M1, p), /written in/);
  assert.equal(lib.pendingRules('O1'), '');
  assert.equal(lib.saveSettings({ lang: 'fr' }).ok, false);
  lib.saveSettings({ lang: 'ko' });
  assert.match(lib.rulesText('S'), /written in Korean\)/);
  assert.match(lib.rulesFor(sessions.L1, p), /written in Korean\)/);
  assert.match(lib.rulesFor(sessions.O1, p), /written in Korean\)/);
  assert.match(lib.rulesFor(sessions.M1, p), /short summary lines, written in Korean\)/);
  assert.match(lib.pendingRules('O1'), /card language changed \(now Korean\)/);
  assert.equal(lib.pendingRules('O1'), '');
  lib.saveSettings({ lang: 'zh-CN' });
  assert.match(lib.pendingRules('O1'), /Simplified Chinese/);
  lib.saveSettings({ lang: null });
  assert.match(lib.rulesText('S'), /written in the user's language/);
});

test('server: settings API', async () => {
  teamFixture();
  await withServer(async (post, base) => {
    assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), { lang: null });
    assert.equal((await post('/api/settings', { lang: 'ko' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/settings', { lang: 'xx' })).status, 400);
    assert.deepEqual((await post('/api/settings', { lang: 'zh-CN' })).body, { ok: true, lang: 'zh-CN' });
    assert.equal((await (await fetch(`${base}/api/state`)).json()).settings.lang, 'zh-CN');
    assert.equal(readJson(paths.settings, {}).lang, 'zh-CN');
    const js = await fetch(`${base}/i18n.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.match(await js.text(), /DDASH_I18N/);
  });
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
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
