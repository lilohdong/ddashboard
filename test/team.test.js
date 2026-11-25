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
process.env.CLAUDE_CONFIG_DIR = BOARD; // no real Claude settings (model hints for the context window)
for (const k of ['ANTHROPIC_MODEL', 'DDASH_CONTEXT_WINDOW', 'DDASH_LEAD_WORK_BUDGET', 'DDASH_LEAD_CONTEXT_LIMIT', 'DDASH_HANDOFF_MAX_TOKENS']) delete process.env[k];
process.env.DDASH_WINDOW = '0'; // never open real terminal windows; the window tests use a fake launcher
process.env.DDASH_ORCA = '0'; // never open real Orca terminals; the Orca tests use a fake orca command

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'scripts', 'lib.js'));
const team = require(path.join(ROOT, 'scripts', 'team.js'));
const { paths, readJson, writeJson } = lib;

const KEY = lib.projectKey(CWD);
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
  return { session_id: sid, name: sid, cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: new Date().toISOString(), text_ver: lib.RULES_TEXT_VER, ...extra };
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
  const projects = { [KEY]: { mode: 'team', teams: { Alpha: { lead: 'L1' } } } };
  assert.deepEqual(lib.routeCard(sessions, projects, 'M1'), { to: 'lead', role: 'member', lead: 'L1' });
  assert.deepEqual(lib.routeCard(sessions, projects, 'L1'), { to: 'board', role: 'lead' });
  assert.deepEqual(lib.routeCard(sessions, projects, 'O1'), { to: 'board', role: 'outside' });
});

test('routeCard: lead missing falls back to the board', () => {
  const projects = { [KEY]: { mode: 'team', teams: { Alpha: { lead: 'L1' } } } };
  const ended = { M1: session('M1', { kind: 'member', lead: 'L1' }), L1: session('L1', { state: 'ended', ended: 'x' }) };
  assert.deepEqual(lib.routeCard(ended, projects, 'M1'), { to: 'board', role: 'member', lead_missing: true });
  const gone = { M1: session('M1', { kind: 'member', lead: 'L1' }) }; // lead session forgotten
  assert.equal(lib.routeCard(gone, projects, 'M1').lead_missing, true);
  // A member whose lead leads no team (its team was removed) is outside: straight to the board.
  const stray = { M1: session('M1', { kind: 'member', lead: 'L9' }) };
  assert.deepEqual(lib.routeCard(stray, projects, 'M1'), { to: 'board', role: 'outside' });
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
  assert.match(lib.rulesFor(sessions.L1, p), /lead of team "Alpha"/);
  assert.match(lib.rulesFor(sessions.L1, p), /docs\/teams\/Alpha\/<g>\//);
  assert.match(lib.rulesFor(sessions.L1, p), /bin\/team\.js" L1/);
  assert.match(lib.rulesFor(sessions.M1, p), /Role: frontend/);
  assert.match(lib.rulesFor(sessions.M1, p), /Don't start a wait command/);
  assert.match(lib.rulesFor({ ...sessions.M1, stay: true }, p), /bin\/wait\.js" M1/);
  assert.match(lib.rulesFor(sessions.O1, p), /teams: Alpha\). You are outside every team/);
  assert.equal(lib.pendingRules('M1'), ''); // rules_ver === mode_ver
  lib.setMode(KEY, 'solo');
  assert.match(lib.pendingRules('M1'), /mode changed \(now solo\)/);
  assert.equal(lib.pendingRules('M1'), '');
});

test('rules: every role restarts the wait command in the same response; member reports stay short', () => {
  teamFixture();
  const sessions = readJson(paths.sessions, {});
  const p0 = readJson(paths.projects, {})[KEY];
  const p = { ...p0, teams: { Alpha: { ...p0.teams.Alpha, groups: { front: { dir: 'C:/x/docs/teams/Alpha/front' } } } } };
  const same = /same response, as parallel tool calls/;
  assert.match(lib.rulesFor(sessions.O1, { mode: 'solo' }), same);
  assert.match(lib.rulesFor(sessions.L1, p), same);
  assert.match(lib.rulesFor(sessions.O1, p), same);
  assert.match(lib.rulesFor({ ...sessions.M1, stay: true }, p), same);
  assert.match(lib.rulesFor(sessions.M1, p), /summary of at most 3 lines: put the evidence in a file/);
  assert.match(lib.rulesFor({ ...sessions.M1, group: 'front' }, p), /evidence in C:\/x\/docs\/teams\/Alpha\/front\/notes\/ and give the path/);
  assert.match(lib.rulesFor({ ...sessions.M1, group: 'front' }, p), /bin\/team\.js" M1 next-handoff: it creates the next handoff-NNN\.md/);
});

test('setMode: team adds a team next to the others (no replacing), solo removes teams', () => {
  teamFixture();
  const r = lib.setMode(KEY, 'team', { lead: 'O1', team: 'Beta' });
  assert.equal(r.ok, true, r.error);
  const s = readJson(paths.sessions, {});
  const p = project();
  assert.deepEqual(Object.keys(p.teams).sort(), ['Alpha', 'Beta']);
  assert.equal(p.teams.Alpha.lead, 'L1');
  assert.equal(p.teams.Beta.lead, 'O1');
  assert.equal(p.teams.Beta.worktree, slash(CWD));
  assert.equal(p.mode_ver, 2);
  assert.equal(s.O1.kind, 'lead');
  assert.equal(s.L1.kind, 'lead');
  assert.equal(s.M1.lead, 'L1'); // members stay with their own lead
  // A name in use and a session that already leads a team are refused; free text becomes a folder-safe name.
  assert.match(lib.addTeam(KEY, 'Alpha', 'M1').error, /team Alpha exists/);
  assert.match(lib.addTeam(KEY, 'Gamma', 'O1').error, /already leads team Beta/);
  assert.equal(lib.addTeam(KEY, 'my team!', 'M1').team, 'my-team');
  assert.equal(lib.removeTeams(KEY, ['my-team']).ok, true);
  assert.equal(lib.setMode(KEY, 'team', { lead: 'nobody' }).ok, false);
  lib.setMode(KEY, 'solo');
  const p2 = project();
  assert.equal(p2.mode, 'solo');
  assert.deepEqual(p2.teams, {});
  assert.equal(readJson(paths.sessions, {}).L1.kind, undefined);
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

// A transcript with one turn per context size (each turn: a human prompt, then one assistant message).
function contextTurns(file, sizes, model = 'claude-test') {
  const rows = sizes.flatMap((c, i) => [
    { type: 'user', uuid: `u${i}`, message: { content: 'go' } },
    { type: 'assistant', message: { id: `a${i}`, model, usage: { input_tokens: 10, cache_read_input_tokens: c - 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
  ]);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('M-1c: Stop hook tells the lead once, after its context grew by the work budget', () => {
  teamFixture();
  const transcript = path.join(BOARD, 't.jsonl');
  const env = { DDASH_LEAD_WORK_BUDGET: '300' };
  const stop = (sid, sizes) => { contextTurns(transcript, sizes); return runHook('stop-card.js', { session_id: sid, cwd: CWD, transcript_path: transcript }, env); };
  assert.equal(stop('L1', [510]), ''); // baseline: first context in the transcript
  assert.equal(readJson(paths.sessions, {}).L1.lead_baseline, 510);
  assert.equal(readJson(paths.sessions, {}).L1.lead_handoff_at, 810);
  assert.equal(readJson(paths.sessions, {}).L1.context_window, 200000);
  assert.equal(stop('L1', [510, 800]), ''); // grew 290 < 300
  const out = JSON.parse(stop('L1', [510, 800, 820]));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /context \(820 tokens\) has grown by 310 since you started as team lead \(start 510, handoff at 810\)/);
  assert.match(out.reason, /NEW handoff doc \(under 6000 tokens\).*Do not copy or point to older handoff docs.*bin\/team\.js" L1 handoff <doc-path>/);
  assert.equal(readJson(paths.sessions, {}).L1.context_handoff_told, true);
  assert.equal(stop('L1', [510, 800, 820, 900]), ''); // once
  // Members and solo sessions are never told and get no baseline.
  assert.equal(stop('O1', [5000]), '');
  assert.equal(stop('M1', [5000]), '');
  assert.equal(readJson(paths.sessions, {}).M1.lead_baseline, undefined);
});

test('M-1c: a lead already running at upgrade takes its baseline from the transcript head', () => {
  teamFixture();
  const transcript = path.join(BOARD, 't.jsonl');
  contextTurns(transcript, [40000, 90000, 150000]);
  const out = JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript }));
  assert.match(out.reason, /context \(150000 tokens\) has grown by 110000 .*\(start 40000, handoff at 140000\)/);
});

test('M-1c: unknown baseline uses the absolute cap (80% of the window)', () => {
  teamFixture();
  const p = project();
  const s = { session_id: 'L1', kind: 'lead', last_context: 150000, cwd: CWD };
  assert.equal(lib.leadContextNotice(s, p, { transcript: path.join(BOARD, 'missing.jsonl') }), '');
  assert.equal(s.lead_baseline, 0);
  assert.equal(s.lead_baseline_unknown, true);
  assert.equal(s.lead_handoff_at, 160000);
  s.last_context = 161000;
  assert.match(lib.leadContextNotice(s, p, {}), /context \(161000 tokens\) is past the team lead handoff point \(160000, 80% of the 200000-token context window\)/);
});

test('M-1c: the handoff point is cut to 80% of the window; a lead starting above it is told at once', () => {
  teamFixture();
  const transcript = path.join(BOARD, 't.jsonl');
  contextTurns(transcript, [170000]);
  assert.match(JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript })).reason, /start 170000, handoff at 160000/);
  // DDASH_LEAD_CONTEXT_LIMIT is an absolute point, still cut to 80%.
  teamFixture();
  contextTurns(transcript, [510, 700]);
  assert.match(JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript }, { DDASH_LEAD_CONTEXT_LIMIT: '600' })).reason, /handoff at 600/);
  // A work budget of 0 is a value (not the default): told on the first turn.
  teamFixture();
  contextTurns(transcript, [510]);
  assert.match(JSON.parse(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript }, { DDASH_LEAD_WORK_BUDGET: '0' })).reason, /handoff at 510/);
});

test('M-1c: context window from the model ([1m]), kept after a compact', () => {
  teamFixture();
  const transcript = path.join(BOARD, 't.jsonl');
  // SessionStart records the model; [1m] means a 1M window (start 150k is not a large start there).
  lib.rememberModel('L1', 'claude-opus-5-5[1m]');
  contextTurns(transcript, [150000, 240000]);
  assert.equal(runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript }), '');
  let L1 = readJson(paths.sessions, {}).L1;
  assert.equal(L1.context_window, 1000000);
  assert.equal(L1.lead_handoff_at, 250000);
  // Without any model hint the stored window is kept (never back to 200k).
  writeJson(paths.models, {});
  contextTurns(transcript, [150000, 60000]); // compacted
  runHook('stop-card.js', { session_id: 'L1', cwd: CWD, transcript_path: transcript });
  L1 = readJson(paths.sessions, {}).L1;
  assert.equal(L1.context_window, 1000000);
  // Pure rules.
  assert.equal(lib.contextWindow({}), 200000);
  assert.equal(lib.contextWindow({ models: ['opus[1m]'] }), 1000000);
  assert.equal(lib.contextWindow({ stored: 1000000 }), 1000000);
  assert.equal(lib.contextWindow({ seen: 250000 }), 1000000);
});

test('M-1c: leadLimit and large start use the given window', () => {
  assert.deepEqual(lib.leadLimit(40000, 200000), { baseline: 40000, window: 200000, at: 140000, budget: 100000, big: false });
  assert.equal(lib.leadLimit(90000, 200000).at, 160000); // 80% of 200k
  assert.equal(lib.leadLimit(150000, 200000).big, true); // over half of 200k
  assert.equal(lib.leadLimit(150000, 1000000).big, false); // not of 1M
  assert.equal(lib.leadLimit(150000, 1000000).at, 250000);
  assert.equal(lib.leadLimit(0, 200000).at, 160000); // unknown start: absolute cap
});

test('M-1c: envNum keeps 0, ignores empty and invalid values', () => {
  process.env.DDASH_TEST_NUM = '0';
  assert.equal(lib.envNum('DDASH_TEST_NUM', 5), 0);
  process.env.DDASH_TEST_NUM = '';
  assert.equal(lib.envNum('DDASH_TEST_NUM', 5), 5);
  process.env.DDASH_TEST_NUM = 'abc';
  assert.equal(lib.envNum('DDASH_TEST_NUM', 5), 5);
  delete process.env.DDASH_TEST_NUM;
  assert.equal(lib.envNum('DDASH_TEST_NUM', 5), 5);
});

test('M-1c: adding or removing a team clears the lead context state', () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  Object.assign(s.O1, { lead_baseline: 90000, lead_handoff_at: 160000, context_handoff_told: true, lead_baseline_unknown: true });
  writeJson(paths.sessions, s);
  assert.equal(lib.addTeam(KEY, 'Beta', 'O1').ok, true);
  const fields = (sid) => ['lead_baseline', 'lead_handoff_at', 'context_handoff_told', 'lead_baseline_unknown'].map((k) => readJson(paths.sessions, {})[sid][k]);
  assert.deepEqual(fields('O1'), [undefined, undefined, undefined, undefined]);
  const s2 = readJson(paths.sessions, {});
  Object.assign(s2.O1, { lead_baseline: 1, lead_handoff_at: 2, context_handoff_told: true });
  writeJson(paths.sessions, s2);
  assert.equal(lib.removeTeams(KEY, ['Beta']).ok, true);
  assert.deepEqual(fields('O1'), [undefined, undefined, undefined, undefined]);
});

test('M-1c: estimateTokens counts Korean and other non-ASCII text high', () => {
  assert.equal(lib.estimateTokens('abcdefg'), 2);
  assert.equal(lib.estimateTokens('가나다라'), 6);
  assert.equal(lib.estimateTokens(''), 0);
  assert.ok(lib.estimateTokens('한'.repeat(4001)) > 6000);
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
  assert.match(runHook('prompt-submit.js', { session_id: 'X1', cwd: CWD, prompt: 'hello' }), /outside every team/);
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
  assert.match(out, /took over as lead of team "Alpha" from L1/);
  assert.match(out, /lead of team "Alpha"/);
  const s = readJson(paths.sessions, {});
  assert.equal(teamConf().lead, 'L2');
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
  fs.mkdirSync(path.join(CWD, 'docs', 'teams', 'Alpha'), { recursive: true });
  fs.writeFileSync(path.join(CWD, 'docs', 'teams', 'Alpha', 'lead-rules.md'), '# rules');
  const r = team.main(['L1', 'handoff', doc]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[ddash lead-handoff from=L1 doc=.*handoff\.md\]/);
  assert.equal(teamConf().handoff.from, 'L1');
  assert.match(r.out, /members of team Alpha move to it/);
  assert.equal(team.main(['M1', 'handoff', doc]).code, 1); // not the lead
});

test('M-1c: team.js handoff refuses a doc over 6000 tokens; names lead-rules.md only when it exists', () => {
  teamFixture();
  const doc = path.join(BOARD, 'handoff.md');
  fs.writeFileSync(doc, '# 인수인계\n' + '상태 '.repeat(2000)); // ~6000 chars, 4000 of them Korean: over the limit
  const r = team.main(['L1', 'handoff', doc]);
  assert.equal(r.code, 1);
  assert.match(r.out, /handoff doc is too long: about \d+ tokens \(limit 6000\)\. Shorten it/);
  assert.equal(teamConf().handoff, undefined);
  fs.writeFileSync(doc, '# handoff\n' + 'state '.repeat(2000)); // 12000 ASCII chars: fine
  const rules = slash(path.join(CWD, 'docs', 'teams', 'Alpha', 'lead-rules.md'));
  fs.rmSync(rules, { force: true });
  // No lead-rules.md: not created by the handoff, left out of the prompt, a warning on stderr.
  const warned = [];
  const write = process.stderr.write;
  process.stderr.write = (t) => { warned.push(String(t)); return true; };
  let ok;
  try { ok = team.main(['L1', 'handoff', doc]); } finally { process.stderr.write = write; }
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.out.includes('Read only this handoff doc (not older handoff docs)'), ok.out);
  assert.match(warned.join(''), /lead-rules\.md does not exist/);
  assert.ok(!fs.existsSync(rules));
  // With the file: the new lead is told to read it.
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, '# rules');
  const ok2 = team.main(['L1', 'handoff', doc]);
  assert.ok(ok2.out.includes(`Read only this handoff doc and the team rules ${rules} (not older handoff docs)`), ok2.out);
});

test('M-1c: a new team gets a lead-rules.md template; an existing one is kept', () => {
  teamFixture();
  const file = path.join(CWD, 'docs', 'teams', 'Beta', 'lead-rules.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'mine');
  assert.equal(lib.addTeam(KEY, 'Beta', 'O1').ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
  assert.equal(lib.addTeam(KEY, 'Gamma', 'M1').ok, true);
  assert.match(fs.readFileSync(path.join(CWD, 'docs', 'teams', 'Gamma', 'lead-rules.md'), 'utf8'), /lead rules/);
});

// --- Orca (visible members). A fake orca logs its calls; FAKE_ORCA_UP / _WRITABLE / _FAIL steer its replies. ---

function fakeOrca() {
  const file = path.join(BOARD, 'fake-orca.js');
  fs.writeFileSync(file, `const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(a) + '\\n');
if (process.env.FAKE_ORCA_SLOW_MS) { const end = Date.now() + Number(process.env.FAKE_ORCA_SLOW_MS); while (Date.now() < end); }
const out = (o) => console.log(JSON.stringify(o));
const cmd = a.slice(0, 2).join(' ');
if (a[0] === 'status') out({ ok: true, result: { runtime: { reachable: process.env.FAKE_ORCA_UP === '1' } } });
else if (cmd === 'terminal create') {
  if (process.env.FAKE_ORCA_FAIL === '1') { out({ ok: false, error: { message: 'no worktree' } }); process.exit(1); }
  out({ ok: true, result: { terminal: { handle: 'term_fake', paneKey: 'tab:leaf' } } });
} else if (cmd === 'terminal show') out({ ok: true, result: { terminal: { handle: a[3], writable: process.env.FAKE_ORCA_WRITABLE === '1' } } });
else if (cmd === 'terminal send') out({ ok: true, result: { send: { accepted: true } } });
else if (cmd === 'terminal close') out({ ok: true, result: { closed: true } });
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
  lib.setRunners(KEY, { runner_member: 'orca' });
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
  lib.setRunners(KEY, { runner_member: 'orca' });
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

test('M-1c: team.js handoff --spawn: visible Orca terminal when Orca runs, --headless/--orca like spawn', async () => {
  teamFixture();
  lib.setRunners(KEY, { runner_lead: 'orca' });
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  const doc = path.join(BOARD, 'handoff.md');
  fs.writeFileSync(doc, '# handoff');
  fs.mkdirSync(path.join(CWD, 'docs', 'teams', 'Alpha'), { recursive: true });
  fs.writeFileSync(path.join(CWD, 'docs', 'teams', 'Alpha', 'lead-rules.md'), '# rules');
  try {
    // Orca up: interactive claude (no -p) with --session-id in a terminal titled 'lead <team>'.
    orcaEnv();
    const r = team.main(['L1', 'handoff', doc, '--spawn', '--model', 'opus']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Started the new lead in a visible Orca terminal \(term_fake\)/);
    const create = orcaCalls().find((c) => c[0] === 'terminal' && c[1] === 'create');
    assert.equal(flagOf(create, '--title'), 'lead Alpha');
    assert.equal(flagOf(create, '--worktree'), `path:${slash(CWD)}`);
    const spec = JSON.parse(fs.readFileSync(flagOf(create, '--command').match(/"([^"]+\.json)"$/)[1], 'utf8'));
    assert.ok(!spec.args.includes('-p'));
    assert.ok(flagOf(spec.args, '--session-id'));
    assert.equal(flagOf(spec.args, '--model'), 'opus');
    assert.match(fs.readFileSync(spec.prompt_file, 'utf8'), /^\[ddash lead-handoff from=L1 doc=.*handoff\.md\] Read only this handoff doc/);

    // --headless forces claude -p even with Orca up (and implies --spawn).
    orcaEnv();
    process.env.FAKE_OUT = path.join(BOARD, 'lead-h.json');
    const h = team.main(['L1', 'handoff', doc, '--headless']);
    assert.match(h.out, /Started the new lead headless/);
    const got = await waitFor(process.env.FAKE_OUT);
    assert.equal(got.argv[0], '-p');
    assert.match(got.input, /^\[ddash lead-handoff from=L1/);
    assert.ok(!orcaCalls().some((c) => c[1] === 'create'));

    // --orca with Orca down is refused before anything changes; both flags are refused.
    orcaEnv({ up: false });
    const conf = readJson(paths.projects, {});
    delete conf[KEY].teams.Alpha.handoff;
    writeJson(paths.projects, conf);
    const o = team.main(['L1', 'handoff', doc, '--orca']);
    assert.equal(o.code, 1);
    assert.match(o.out, /Orca is not running/);
    assert.equal(teamConf().handoff, undefined);
    assert.match(team.main(['L1', 'handoff', doc, '--orca', '--headless']).out, /use only one of --headless, --orca, --window/);

    // Orca down, runner_lead orca: headless with a note. A failed terminal falls back to headless with a note.
    process.env.FAKE_OUT = path.join(BOARD, 'lead-h2.json');
    assert.match(team.main(['L1', 'handoff', doc, '--spawn']).out, /^The configured runner orca is not available \(Orca is not running.*\); started headless instead\.\nStarted the new lead headless/);
    assert.equal((await waitFor(process.env.FAKE_OUT)).argv[0], '-p');
    orcaEnv({ fail: true });
    process.env.FAKE_OUT = path.join(BOARD, 'lead-h3.json');
    assert.match(team.main(['L1', 'handoff', doc, '--spawn']).out, /could not open a terminal \(.*no worktree\); started headless instead\.\nStarted the new lead headless/);
    await waitFor(process.env.FAKE_OUT);
  } finally { orcaOff(); }
});

// --- M-1d: runner settings (headless | orca | window) ---

// A fake window launcher: records <title> <cwd> <command> to FAKE_WINDOW_OUT.
function windowEnv(on = true) {
  const file = path.join(BOARD, 'fake-window.js');
  fs.writeFileSync(file, `require('fs').writeFileSync(process.env.FAKE_WINDOW_OUT, JSON.stringify(process.argv.slice(2)));\n`);
  process.env.DDASH_WINDOW = on ? '' : '0';
  process.env.DDASH_WINDOW_BIN = file;
  process.env.FAKE_WINDOW_OUT = path.join(BOARD, `window-${Date.now()}-${Math.random()}.json`);
}
const windowOff = () => { process.env.DDASH_WINDOW = '0'; delete process.env.DDASH_WINDOW_BIN; };
const windowSpec = async () => {
  const [title, cwd, argvJson] = await waitFor(process.env.FAKE_WINDOW_OUT);
  const argv = JSON.parse(argvJson);
  const spec = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
  return { title, cwd, argv, spec };
};

test('M-1d: runners default to headless even when Orca runs', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  assert.deepEqual(lib.runnersOf(project()), { runner_lead: 'headless', runner_member: 'headless' });
  try {
    orcaEnv();
    process.env.FAKE_OUT = path.join(BOARD, 'd1.json');
    assert.match(team.main(['L1', 'spawn', '--role', 'be', 'api']).out, /headless \(pid/);
    assert.equal((await waitFor(process.env.FAKE_OUT)).argv[0], '-p');
    const doc = path.join(BOARD, 'handoff.md');
    fs.writeFileSync(doc, '# handoff');
    process.env.FAKE_OUT = path.join(BOARD, 'd2.json');
    const r = team.main(['L1', 'handoff', doc, '--spawn']);
    assert.match(r.out, /^Started the new lead headless/);
    await waitFor(process.env.FAKE_OUT);
    assert.ok(!orcaCalls().some((c) => c[1] === 'create'));
    assert.match(team.main(['L1', 'handoff', doc]).out, /--spawn with this project's runner_lead: headless/);
  } finally { orcaOff(); }
});

test('M-1d: runner window opens a terminal window (members, leads, resume)', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  assert.equal(lib.setRunners(KEY, { runner_lead: 'window', runner_member: 'window' }).ok, true);
  try {
    windowEnv();
    const r = team.main(['L1', 'spawn', '--role', 'fe', 'build']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /in a new terminal window/);
    const w = await windowSpec();
    assert.equal(w.title, 'fe');
    assert.equal(slash(w.cwd), slash(CWD));
    assert.equal(w.argv[0], process.execPath);
    assert.match(slash(w.argv[1]), /\/orca-launch\.js$/);
    assert.match(slash(w.argv[2]), /\.window-\d+\.json$/);
    assert.ok(!w.spec.args.includes('-p'));
    const sid = flagOf(w.spec.args, '--session-id');
    const s = readJson(paths.sessions, {})[sid];
    assert.equal(s.runner, 'window');
    assert.equal(s.headless, false);
    assert.match(team.main(['L1', 'list']).out, / window/);
    // An ended window member is resumed in a new window.
    const all = readJson(paths.sessions, {});
    Object.assign(all[sid], { state: 'ended', ended: 'x' });
    writeJson(paths.sessions, all);
    windowEnv();
    assert.match(team.main(['L1', 'send', sid, 'next']).out, /Resumed fe .*in a new terminal window/);
    const w2 = await windowSpec();
    assert.deepEqual(w2.spec.args.slice(0, 2), ['--resume', sid]);
    assert.equal(fs.readFileSync(w2.spec.prompt_file, 'utf8'), '[Lead instruction]\nnext');
    assert.equal(readJson(paths.sessions, {})[sid].ended, undefined);
    // A new lead on handoff --spawn.
    windowEnv();
    const doc = path.join(BOARD, 'handoff.md');
    fs.writeFileSync(doc, '# handoff');
    assert.match(team.main(['L1', 'handoff', doc, '--spawn']).out, /^Started the new lead in a new terminal window/);
    const w3 = await windowSpec();
    assert.equal(w3.title, 'lead Alpha');
    assert.match(fs.readFileSync(w3.spec.prompt_file, 'utf8'), /^\[ddash lead-handoff from=L1/);
  } finally { windowOff(); }
});

test('M-1d: an unavailable configured runner falls back to headless with a note; flags override and are strict', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  lib.setRunners(KEY, { runner_member: 'window', runner_lead: 'orca' });
  try {
    windowOff(); // DDASH_WINDOW=0
    process.env.FAKE_OUT = path.join(BOARD, 'f1.json');
    const r = team.main(['L1', 'spawn', '--role', 'be', 'api']);
    assert.match(r.out, /^The configured runner window is not available \(terminal windows are turned off.*\); started headless instead\.\nSpawned be: .* headless/);
    await waitFor(process.env.FAKE_OUT);
    // Orca down: the lead runner falls back too.
    orcaEnv({ up: false });
    const doc = path.join(BOARD, 'handoff.md');
    fs.writeFileSync(doc, '# handoff');
    process.env.FAKE_OUT = path.join(BOARD, 'f2.json');
    assert.match(team.main(['L1', 'handoff', doc, '--spawn']).out, /^The configured runner orca is not available \(Orca is not running.*\); started headless instead\.\nStarted the new lead headless/);
    await waitFor(process.env.FAKE_OUT);
    // Flags win over the setting: --headless runs headless without a note; --window is refused when no window can open.
    process.env.FAKE_OUT = path.join(BOARD, 'f3.json');
    assert.match(team.main(['L1', 'spawn', '--headless', '--role', 'be', 'api']).out, /^Spawned be: .* headless/);
    await waitFor(process.env.FAKE_OUT);
    const before = Object.keys(readJson(paths.sessions, {})).length;
    const w = team.main(['L1', 'spawn', '--window', '--role', 'be', 'api']);
    assert.equal(w.code, 1);
    assert.match(w.out, /terminal windows are turned off .*Use --headless, or leave out --window/);
    assert.equal(Object.keys(readJson(paths.sessions, {})).length, before);
    assert.match(team.main(['L1', 'spawn', '--window', '--orca', '--role', 'be', 'api']).out, /use only one of --headless, --orca, --window/);
    // --window works when a window can open, whatever the setting.
    windowEnv();
    lib.setRunners(KEY, { runner_member: 'orca' });
    assert.match(team.main(['L1', 'spawn', '--window', '--role', 'qa', 'test']).out, /in a new terminal window/);
    await windowSpec();
  } finally { orcaOff(); windowOff(); }
});

test('M-1d: setRunners validates; /api/settings with a project saves runners, /api/state shows them', async () => {
  teamFixture();
  assert.match(lib.setRunners(KEY, { runner_lead: 'tmux' }).error, /runner_lead must be one of headless, orca, window/);
  assert.match(lib.setRunners(KEY, {}).error, /required/);
  assert.equal(lib.setRunners('nope', { runner_lead: 'orca' }).code, 404);
  await withServer(async (post, base) => {
    const r = await post('/api/settings', { project: KEY, runner_member: 'orca' }, { Origin: base });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, runner_lead: 'headless', runner_member: 'orca' });
    assert.equal((await post('/api/settings', { project: KEY, runner_lead: 'bad' }, { Origin: base })).status, 400);
    const st = await (await fetch(`${base}/api/state`)).json();
    const tp = Object.values(st.teams).find((x) => x.key === KEY);
    assert.equal(tp.runner_member, 'orca');
    assert.equal(tp.runner_lead, 'headless');
  });
  assert.equal(project().spawn.runner_member, 'orca');
});

test('M-1d review: window launcher never puts paths on a shell command line (&, %, ^, quotes)', () => {
  const save = process.env.DDASH_WINDOW_BIN;
  delete process.env.DDASH_WINDOW_BIN;
  const term = require(path.join(ROOT, 'scripts', 'terminal.js'));
  const cwd = 'C:/a&b/100%PATH%^x';
  const argv = ['C:/node js/node.exe', 'C:/x&y/orca-launch.js', 'C:/logs/50%/s.json'];
  try {
    const w = term.launcher({ title: 'lead "A" & del', cwd, argv, name: 'sid.window-1', platform: 'win32' });
    assert.equal(w.verbatim, true);
    assert.deepEqual(w.args, ['/d', '/c', 'start "lead A  del" cmd /k .\\sid.window-1.cmd']);
    assert.equal(w.script.name, 'sid.window-1.cmd');
    const lines = w.script.content.split('\r\n');
    assert.equal(lines[2], 'cd /d "C:/a&b/100%%PATH%%^x"');
    assert.equal(lines[3], '"C:/node js/node.exe" "C:/x&y/orca-launch.js" "C:/logs/50%%/s.json"');
    assert.match(lines[4], /^if errorlevel 1 \(.*This window stays open\.\) else exit$/);
    const mac = term.launcher({ title: 't', cwd: "/a'b&c", argv: ['/n', '/l "x".js'], platform: 'darwin' });
    assert.equal(mac.args[1], 'tell application "Terminal" to do script "cd \'/a\'\\\\\'\'b&c\' && \'/n\' \'/l \\"x\\".js\'"');
    const lin = term.launcher({ title: 't', cwd: '/a&b', argv: ['/n'], platform: 'linux' });
    assert.equal(lin.sync, false);
    assert.match(lin.args[5], /^cd '\/a&b' && '\/n' \|\| \{ .*read x; \}$/);
  } finally { if (save !== undefined) process.env.DDASH_WINDOW_BIN = save; }
});

test('M-1d review: openWindow refuses a missing folder and a failing launcher (so spawn falls back to headless)', async () => {
  const term = require(path.join(ROOT, 'scripts', 'terminal.js'));
  teamFixture(); // resets the board: before the fake launchers are written
  windowEnv();
  try {
    assert.throws(() => term.openWindow({ title: 't', cwd: path.join(CWD, 'nope'), argv: ['x'], dir: BOARD }), /folder does not exist/);
    const bad = path.join(BOARD, 'bad-window.js');
    fs.writeFileSync(bad, 'process.exit(3);\n');
    process.env.DDASH_WINDOW_BIN = bad;
    assert.throws(() => term.openWindow({ title: 't', cwd: CWD, argv: ['x'], dir: BOARD }), /failed \(exit 3\)/);
    // A configured window runner whose launch fails: headless with a note.
    lib.setRunners(KEY, { runner_member: 'window' });
    process.env.DDASH_CLAUDE_BIN = fakeClaude();
    process.env.FAKE_OUT = path.join(BOARD, 'wf.json');
    assert.match(team.main(['L1', 'spawn', '--role', 'be', 'api']).out, /^The terminal window could not open a terminal \(.*failed \(exit 3\)\); started headless instead\./);
    await waitFor(process.env.FAKE_OUT);
  } finally { windowOff(); }
});

test('M-1d review: window members: dead Claude process -> ended and resumed on send; idle -> honest queue text', async () => {
  teamFixture();
  process.env.DDASH_CLAUDE_BIN = fakeClaude();
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('exit', r));
  const s = readJson(paths.sessions, {});
  s.W1 = session('W1', { kind: 'member', role: 'ui', lead: 'L1', runner: 'window', headless: false, claude_pid: process.pid, spawn: { cwd: CWD } });
  s.W2 = session('W2', { kind: 'member', role: 'db', lead: 'L1', runner: 'window', headless: false, claude_pid: dead.pid, spawn: { cwd: CWD } });
  writeJson(paths.sessions, s);
  try {
    assert.match(team.main(['L1', 'send', 'ui', 'hi']).out, /idle in its terminal window and reads it only on its next turn.*type something there yourself/);
    assert.match(team.main(['L1', 'list']).out, /W2 {2}db {2}ended/);
    windowEnv();
    const w2 = readJson(paths.sessions, {});
    delete w2.W2.ended; w2.W2.state = 'idle'; // not yet noticed by list
    writeJson(paths.sessions, w2);
    assert.match(team.main(['L1', 'send', 'db', 'next']).out, /Resumed db .*in a new terminal window/);
    assert.deepEqual((await windowSpec()).spec.args.slice(0, 2), ['--resume', 'W2']);
  } finally { windowOff(); }
});

test('M-1d review: claude runs without cmd.exe when possible; through it, the prompt moves to its file', () => {
  const dir = path.join(BOARD, 'npm-bin');
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@node "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*');
  const save = process.env.DDASH_CLAUDE_BIN;
  try {
    process.env.DDASH_CLAUDE_BIN = path.join(dir, 'claude.cmd');
    const cmd = team.claudeCommand();
    if (process.platform === 'win32') assert.deepEqual(cmd, { file: process.execPath, pre: [cli], shell: false });
    // Through a shell, special characters never reach the command line.
    const viaShell = { file: 'claude.cmd', pre: [], shell: true };
    const args = team.interactiveArgs(viaShell, '[ddash role=fe lead=L1 stay=0] use %PATH% & echo\nline 2', ['--model', 'x'], 'C:/logs/p.txt');
    assert.equal(args[0], '[ddash role=fe lead=L1 stay=0] Your first message is in C:/logs/p.txt (moved there because the Windows shell would change it). Read that file first and follow it.');
    assert.deepEqual(args.slice(1), ['--model', 'x']);
    assert.deepEqual(team.interactiveArgs({ pre: ['cli.js'], shell: false }, 'a %B% c', []), ['cli.js', 'a %B% c']);
  } finally { if (save === undefined) delete process.env.DDASH_CLAUDE_BIN; else process.env.DDASH_CLAUDE_BIN = save; }
});

test('M-1d review: handoff keeps project settings changed while it ran; /api/team/spawn refuses unknown runners', async () => {
  teamFixture();
  const doc = path.join(BOARD, 'handoff.md');
  fs.writeFileSync(doc, '# handoff');
  const orig = lib.recordClaudePid;
  lib.recordClaudePid = (...a) => { lib.setRunners(KEY, { runner_member: 'orca' }); return orig(...a); }; // a dashboard change mid-handoff
  try { assert.equal(team.main(['L1', 'handoff', doc]).code, 0); } finally { lib.recordClaudePid = orig; }
  assert.equal(project().spawn.runner_member, 'orca');
  assert.equal(teamConf().handoff.from, 'L1');
  await withServer(async (post) => {
    const r = await post('/api/team/spawn', { lead: 'L1', role: 'qa', task: 'x', runner: 'tmux' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /runner must be one of headless, orca, window/);
  });
});

test('BUG-001: team.js end closes an Orca member terminal, stops a headless run, marks both ended', async () => {
  teamFixture();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const s = readJson(paths.sessions, {});
  s.V1 = session('V1', { kind: 'member', role: 'ui', lead: 'L1', runner: 'orca', headless: false, orca: { handle: 'term_v1' } });
  s.H1 = session('H1', { kind: 'member', role: 'api', lead: 'L1', runner: 'headless', headless: true, pid: sleeper.pid, state: 'working' });
  writeJson(paths.sessions, s);
  try {
    orcaEnv();
    const r = team.main(['L1', 'end', 'ui']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^Ended ui \(V1\): closed its Orca terminal \(term_v1\)/);
    const close = orcaCalls().find((c) => c[0] === 'terminal' && c[1] === 'close');
    assert.equal(flagOf(close, '--terminal'), 'term_v1');
    const exited = new Promise((res) => sleeper.on('exit', res));
    assert.match(team.main(['L1', 'end', 'H1']).out, /stopped the headless run and its tool processes \(pid \d+\)/);
    await exited;
    const after = readJson(paths.sessions, {});
    for (const id of ['V1', 'H1']) {
      assert.equal(after[id].state, 'ended');
      assert.equal(after[id].end_reason, 'stopped');
    }
    assert.match(team.main(['L1', 'end', 'nobody']).out, /no member "nobody"/);
    assert.match(team.main(['L1', 'list']).out, /V1 {2}ui {2}ended/);
  } finally { orcaOff(); sleeper.kill(); }
});

test('BUG-001: POST /api/team/end stops a member; non-members are refused', async () => {
  teamFixture();
  await withServer(async (post) => {
    assert.equal((await post('/api/team/end', { session_id: 'O1' })).status, 404);
    const r = await post('/api/team/end', { session_id: 'M1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
  });
  assert.equal(readJson(paths.sessions, {}).M1.end_reason, 'stopped');
});

test('BUG-001: the server checks Orca terminals in the background (a slow orca never blocks /api/state)', async () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.V9 = session('V9', { kind: 'member', role: 'ui', lead: 'L1', runner: 'orca', headless: false, orca: { handle: 'term_gone' } });
  writeJson(paths.sessions, s);
  orcaEnv({ writable: false });
  process.env.FAKE_ORCA_SLOW_MS = '1500';
  try {
    await withServer(async (_post, base) => {
      const t0 = Date.now();
      const first = (await (await fetch(`${base}/api/state`)).json()).sessions.V9;
      assert.ok(Date.now() - t0 < 1000, `/api/state took ${Date.now() - t0} ms`);
      assert.equal(first.view, 'idle'); // not known yet: never guessed gone
      let view = first.view;
      for (let i = 0; i < 40 && view !== 'ended'; i++) {
        await new Promise((r) => setTimeout(r, 150));
        view = (await (await fetch(`${base}/api/state`)).json()).sessions.V9.view;
      }
      assert.equal(view, 'ended');
    });
    assert.equal(readJson(paths.sessions, {}).V9.end_reason, 'gone');
  } finally { delete process.env.FAKE_ORCA_SLOW_MS; orcaOff(); }
});

// A fake "shell": a node process that starts a child node (the "program") and prints the child's pid.
function processPair() {
  const parent = spawn(process.execPath, ['-e', "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => {}, 60000);"]);
  return new Promise((res) => parent.stdout.once('data', (d) => res({ parent, child: Number(String(d).trim()) })));
}

test('BUG-003: killTree stops a process and the processes it started', async () => {
  const { parent, child } = await processPair();
  assert.equal(lib.alive(child), true);
  assert.equal(lib.killTree(parent.pid), true);
  for (let i = 0; i < 40 && lib.alive(child); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(lib.alive(child), false, 'child left running');
  assert.equal(lib.killTree(parent.pid), false); // already gone
});

test('BUG-003: end closes a window member\'s shell with everything in it; an ended member keeps its end time', async () => {
  teamFixture();
  const { parent, child } = await processPair();
  const s = readJson(paths.sessions, {});
  s.W7 = session('W7', { kind: 'member', role: 'win', lead: 'L1', runner: 'window', headless: false, window_shell_pid: parent.pid, window_launch_pid: child });
  s.E7 = session('E7', { kind: 'member', role: 'old', lead: 'L1', state: 'ended', ended: '2026-01-01T00:00:00.000Z', end_reason: 'gone' });
  writeJson(paths.sessions, s);
  try {
    assert.match(team.main(['L1', 'end', 'win']).out, new RegExp(`closed its terminal window \\(pid ${parent.pid}\\)`));
    for (let i = 0; i < 40 && lib.alive(child); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(lib.alive(parent.pid), false);
    assert.equal(lib.alive(child), false);
    assert.equal(readJson(paths.sessions, {}).W7.end_reason, 'stopped');
    orcaEnv();
    const all = readJson(paths.sessions, {});
    Object.assign(all.E7, { runner: 'orca', orca: { handle: 'term_old' }, claude_pid: process.pid, headless: true, pid: process.pid });
    writeJson(paths.sessions, all);
    assert.equal(team.main(['L1', 'end', 'old']).out, 'old (E7) is already ended (2026-01-01T00:00:00.000Z); nothing was stopped.');
    assert.ok(!orcaCalls().some((c) => c[1] === 'close')); // no terminal closed
    assert.equal(lib.alive(process.pid), true); // no pid killed (the recorded pids are this test process)
    const e = readJson(paths.sessions, {}).E7;
    assert.equal(e.ended, '2026-01-01T00:00:00.000Z');
    assert.equal(e.end_reason, 'gone');
  } finally { orcaOff(); parent.kill(); try { process.kill(child); } catch {} }
});

test('BUG-003: orca-launch records the window shell and its own pid on the session', () => {
  teamFixture();
  const s = readJson(paths.sessions, {});
  s.W8 = session('W8', { kind: 'member', role: 'w8', lead: 'L1', runner: 'window' });
  writeJson(paths.sessions, s);
  const prompt = path.join(BOARD, 'w8.prompt.txt');
  fs.writeFileSync(prompt, 'hello');
  const spec = path.join(BOARD, 'w8.json');
  fs.writeFileSync(spec, JSON.stringify({ args: [], prompt_file: prompt, cwd: CWD, sid: 'W8', kind: 'window' }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orca-launch.js'), spec], {
    input: '', encoding: 'utf8', env: { ...process.env, DDASH_CLAUDE_BIN: fakeClaude(), FAKE_OUT: path.join(BOARD, 'w8-out.json') },
  });
  assert.equal(r.status, 0, r.stderr);
  const w = readJson(paths.sessions, {}).W8;
  assert.equal(w.window_shell_pid, process.pid);
  assert.ok(w.window_launch_pid > 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(BOARD, 'w8-out.json'), 'utf8')).argv[0], 'hello');
});

test('BUG-002: the window script runs with NoDefaultCurrentDirectoryInExePath set, in a folder with & and %', () => {
  if (process.platform !== 'win32') return;
  const term = require(path.join(ROOT, 'scripts', 'terminal.js'));
  const save = process.env.DDASH_WINDOW_BIN;
  delete process.env.DDASH_WINDOW_BIN;
  try {
    const dir = path.join(BOARD, 'a&b 100%PATH%x');
    fs.mkdirSync(dir, { recursive: true });
    const prog = path.join(BOARD, 'cwd-out.js');
    const out = path.join(BOARD, 'cwd-out.txt');
    fs.writeFileSync(prog, "require('fs').writeFileSync(process.argv[2], process.cwd());\n");
    const l = term.launcher({ title: 't', cwd: dir, argv: [process.execPath, prog, out], name: 'b2.window-1', platform: 'win32' });
    const logs = path.join(BOARD, 'win-logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, l.script.name), l.script.content);
    // What the window's cmd runs, without the window: cmd /k .\<script> -> here cmd /c .\<script>.
    const run = l.args[2].replace(/^start "[^"]*" cmd \/k /, '');
    assert.equal(run, '.\\b2.window-1.cmd');
    const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', run], { cwd: logs, env, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), dir);
    // A bare name is not found with that variable set (the cause of BUG-002).
    const bare = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', l.script.name], { cwd: logs, env, windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.notEqual(bare.status, 0);
  } finally { if (save !== undefined) process.env.DDASH_WINDOW_BIN = save; }
});

test('BUG-001: memberGone never guesses: live wait command, no pid, unknown terminal state', () => {
  const base = { session_id: 'G1', kind: 'member', runner: 'orca', orca: { handle: 'h' }, state: 'idle' };
  assert.equal(lib.memberGone(base), false); // no pid, terminal not checked
  assert.equal(lib.memberGone(base, () => null), false); // Orca cannot tell
  assert.equal(lib.memberGone(base, () => false), true); // terminal closed
  assert.equal(lib.memberGone({ ...base, claude_pid: process.pid }, () => false), false); // the pid decides when known
  assert.equal(lib.memberGone({ ...base, headless: true, claude_pid: 999999 }), false); // headless: "finished" rule
  assert.equal(lib.memberGone({ ...base, state: 'ended' }, () => false), false);
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

test('server: unresponsive marker and lead handoff point in /api/state', async () => {
  teamFixture();
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  const s = readJson(paths.sessions, {});
  s.Q1 = session('Q1', { last_seen: old });
  s.Q2 = session('Q2', { last_seen: old });
  s.Q3 = session('Q3', { last_seen: old, state: 'working' });
  s.Q4 = session('Q4', { last_seen: old, state: 'ended', ended: old });
  s.L1.lead_baseline = 120000;
  s.L1.context_window = 200000;
  writeJson(paths.sessions, s);
  fs.mkdirSync(paths.inbox('Q2'), { recursive: true });
  fs.writeFileSync(path.join(paths.inbox('Q2'), 'wait.lock'), String(process.pid)); // live waiter
  await withServer(async (_post, base) => {
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.lead_context_limit, undefined);
    assert.equal(st.sessions.L1.lead_handoff_at, 160000); // 80% of 200k
    assert.equal(st.sessions.L1.baseline_big, true); // started over half the window
    assert.equal(st.sessions.L1.context_window, 200000);
    const un = Object.values(st.sessions).filter((x) => x.unresponsive).map((x) => x.session_id);
    assert.deepEqual(un, ['Q1']);
  });
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
  // The keys the page uses are checked in test/web.test.js.
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

// --- card keys ---

const cardsIndex = () => { const c = require(path.join(ROOT, 'scripts', 'cards.js')); c.reset(); return c; };
const post = (sid, c) => runHook('stop-card.js', { session_id: sid, cwd: CWD, last_assistant_message: cardText(c) });

test('key: valid keys are stored with project_key; invalid keys are dropped, the card is kept', () => {
  reset({ sessions: { S1: session('S1') } });
  post('S1', { title: 'a', key: 'login-fix_2' });
  for (const key of ['x'.repeat(61), '', '   ', 42, 'ünï', 'a/b']) post('S1', { title: `bad ${JSON.stringify(key)}`, key });
  const all = allCards();
  assert.equal(all.length, 7);
  assert.equal(all[0].key, 'login-fix_2');
  assert.equal(all[0].project_key, KEY);
  assert.ok(all.slice(1).every((c) => c.key === undefined && c.project_key === KEY));
  post('S1', { title: 'x'.repeat(5), key: 'k'.repeat(60) });
  assert.equal(allCards().at(-1).key, 'k'.repeat(60));
});

test('key: a newer card with the same key replaces earlier ones from any session, only in the same project', () => {
  reset({ sessions: { S1: session('S1'), S2: session('S2') } });
  lib.appendCard({ id: 'other-1', ts: new Date(Date.now() - 1000).toISOString(), session_id: 'X', project_key: 'other-project', key: 'login-fix', title: 'other project' });
  post('S1', { title: 'v1', key: 'login-fix' });
  post('S1', { title: 'unrelated' });
  post('S2', { title: 'v2', key: 'login-fix' });
  post('S1', { title: 'v3', key: 'login-fix' });
  const cards = cardsIndex();
  const st = cards.state();
  const titles = st.cards.map((c) => c.title);
  assert.deepEqual(titles, ['other project', 'unrelated', 'v3']);
  assert.equal(st.cards.find((c) => c.title === 'v3').key_prev, 2);
  assert.equal(st.cards.find((c) => c.title === 'other project').key_prev, undefined);
  assert.equal(st.archived_count, 2);
  // The whole history is one search away (the dashboard's key tag runs this search).
  const hist = cards.search('login-fix', 'include').filter((c) => c.project_key === KEY);
  assert.deepEqual(hist.map((c) => [c.title, c.archived]), [['v3', false], ['v2', true], ['v1', true]]);
  // Unarchive of a replaced card still wins, like with "replaces".
  const v1 = hist.find((c) => c.title === 'v1');
  cards.setArchived(v1.id, false);
  assert.ok(cards.state().cards.some((c) => c.id === v1.id));
});

test('key: "replaces":"last" and key on one card both apply', () => {
  reset({ sessions: { S1: session('S1'), S2: session('S2') } });
  post('S2', { title: 'keyed', key: 'task' });
  post('S1', { title: 'draft plan' });
  post('S1', { title: 'final', key: 'task', replaces: 'last' });
  assert.deepEqual(cardsIndex().state().cards.map((c) => c.title), ['final']);
});

test('key: member cards drop the key (reports, not board cards); a new lead after handoff replaces the old lead\'s card', () => {
  teamFixture();
  post('M1', { title: 'member', key: 'login-fix' });
  assert.equal(allCards()[0].via_lead, 'L1');
  assert.equal(allCards()[0].key, undefined);
  post('L1', { title: 'old lead', key: 'login-fix' });
  post('O1', { title: 'outside', key: 'login-fix' }); // a session outside every team posts to the board too
  const s0 = readJson(paths.sessions, {});
  s0.L2 = session('L2');
  writeJson(paths.sessions, s0);
  assert.equal(lib.performHandoff('L1', 'L2', 'C:/doc.md', { kill: () => true, killClaude: () => true }).ok, true);
  post('L2', { title: 'new lead', key: 'login-fix' });
  const st = cardsIndex().state(300, { reports: true });
  assert.deepEqual(st.cards.map((c) => c.title), ['member', 'new lead']);
  assert.equal(st.cards[1].key_prev, 2);
  // A member whose lead is gone posts to the board, still without a key.
  const s = readJson(paths.sessions, {});
  s.L2.state = 'ended';
  writeJson(paths.sessions, s);
  post('M1', { title: 'orphan', key: 'login-fix' });
  const orphan = allCards().at(-1);
  assert.equal(orphan.lead_missing, true);
  assert.equal(orphan.key, undefined);
});

test('key: the card instructions explain keys in every card language, for solo and lead sessions, not members', () => {
  teamFixture();
  const sessions = readJson(paths.sessions, {});
  const p = readJson(paths.projects, {})[KEY];
  const line = /add "key":"task-name" \(a-z, 0-9, -, _; max 60\): a newer card with the same key in this project replaces the older ones/;
  for (const lang of ['en', 'ko', 'zh-CN']) {
    assert.equal(lib.saveSettings({ lang }).ok, true);
    assert.match(lib.rulesFor(sessions.O1, { mode: 'solo' }), line);
    assert.match(lib.rulesFor(sessions.O1, p), line);
    assert.match(lib.rulesFor(sessions.L1, p), line);
    assert.doesNotMatch(lib.rulesFor(sessions.M1, p), /"key"/);
  }
  lib.saveSettings({ lang: '' });
  const i18n = require(path.join(ROOT, 'scripts', 'i18n.js'));
  for (const lang of ['en', 'ko', 'zh-CN']) {
    assert.ok(i18n.DICT[lang]['card.keyTitle'], lang);
    assert.match(i18n.DICT[lang]['card.keyPrev'], /\{n\}/, lang);
  }
});

test('key: uppercase and spaces are normalized (lowercase, spaces to -) instead of dropped', () => {
  reset({ sessions: { S1: session('S1') } });
  post('S1', { title: 'v1', key: 'Login Fix' });
  post('S1', { title: 'v2', key: ' login-FIX ' });
  assert.deepEqual(allCards().map((c) => c.key), ['login-fix', 'login-fix']);
  assert.deepEqual(cardsIndex().state().cards.map((c) => c.title), ['v2']);
});

// Ported from method C: a manual unarchive beats key replacement; the unarchived old card counts only older cards.
test('key: a manual unarchive of a replaced card wins, and its "earlier" count only counts older cards', () => {
  reset({ sessions: { S1: session('S1') } });
  post('S1', { title: 'v1', key: 'task' });
  post('S1', { title: 'v2', key: 'task' });
  post('S1', { title: 'v3', key: 'task' });
  const v2 = allCards().find((c) => c.title === 'v2');
  const cards = cardsIndex();
  assert.deepEqual(cards.state().cards.map((c) => c.title), ['v3']);
  cards.setArchived(v2.id, false);
  const st = cards.state();
  assert.deepEqual(st.cards.map((c) => [c.title, c.key_prev]), [['v2', 1], ['v3', 2]]);
});

// Ported from method C.
test('key: the same key in another project is untouched (sessions in two projects)', () => {
  reset({ sessions: { S1: session('S1'), S2: session('S2', { project_key: 'other-project' }) } });
  post('S1', { title: 'mine', key: 'task' });
  post('S2', { title: 'theirs', key: 'task' });
  assert.deepEqual(cardsIndex().state().cards.map((c) => c.title).sort(), ['mine', 'theirs']);
  post('S2', { title: 'theirs2', key: 'task' });
  assert.deepEqual(cardsIndex().state().cards.map((c) => c.title).sort(), ['mine', 'theirs2']);
});

test('key: history search matches the exact key and project, not substrings or other projects', () => {
  reset({ sessions: { S1: session('S1'), S2: session('S2', { project_key: 'other-project' }) } });
  post('S1', { title: 'v1', key: 'login-fix' });
  post('S1', { title: 'v2 fix the login', key: 'login-fix' });
  post('S1', { title: 'short', key: 'fix' });
  post('S1', { title: 'mentions fix in title' });
  post('S2', { title: 'other project', key: 'login-fix' });
  const cards = cardsIndex();
  const titles = (key, pk) => cards.search('', 'include', 100, { key, project_key: pk }).map((c) => c.title);
  assert.deepEqual(titles('login-fix', KEY), ['v2 fix the login', 'v1']);
  assert.deepEqual(titles('fix', KEY), ['short']);
  assert.deepEqual(titles('login-fix', 'other-project'), ['other project']);
  assert.equal(cards.search('fix').length, 5); // plain text search is unchanged
});

test('server: /api/search with key and project_key returns one task history', async () => {
  reset({ sessions: { S1: session('S1'), S2: session('S2', { project_key: 'other-project' }) } });
  post('S1', { title: 'v1', key: 'login-fix' });
  post('S1', { title: 'short', key: 'fix' });
  post('S2', { title: 'other', key: 'login-fix' });
  await withServer(async (_post, base) => {
    const r = await (await fetch(`${base}/api/search?key=fix&project_key=${encodeURIComponent(KEY)}`)).json();
    assert.deepEqual(r.cards.map((c) => c.title), ['short']);
  });
});

test('rules: a running session gets the instructions again once when the instruction text changes', () => {
  reset({ sessions: { S1: session('S1', { text_ver: 0 }) } });
  const update = lib.pendingRules('S1');
  assert.match(update, /instructions were updated/);
  assert.match(update, /"key":"task-name"/);
  assert.equal(lib.pendingRules('S1'), '');
  assert.equal(readJson(paths.sessions, {}).S1.text_ver, lib.RULES_TEXT_VER);
});

// The dashboard page tests (key tag, BUG-004 polling) live in test/web.test.js.

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
