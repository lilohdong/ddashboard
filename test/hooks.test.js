#!/usr/bin/env node
// app/hooks (refactor step 10): the use cases in-process with fixture transcripts (no hook child process), runHook's
// error contract, thin hook files. Run: node test/hooks.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-hooks-'));
const BOARD = path.join(TMP, 'board');
process.env.DDASH_BOARD_DIR = BOARD;
process.env.DDASH_ORCA = '0';

const hooks = require('../scripts/app/hooks');
const sessions = require('../scripts/store/sessions');
const { writeJson } = require('../scripts/core/fsx');
const { paths } = require('../scripts/core/paths');
const storeInbox = require('../scripts/store/inbox');
const appProjects = require('../scripts/app/projects');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const NOW = () => new Date().toISOString();
const session = (sid, more = {}) => ({ session_id: sid, name: sid, cwd: TMP, project: 'proj', project_key: 'k', state: 'working', started: NOW(), last_seen: NOW(), ...more });
function reset(map = {}) {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  writeJson(paths.sessions, map);
}
const allCards = () => {
  const dir = path.join(BOARD, 'cards');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const cardText = (c) => `Done.\n\n\`\`\`card\n${JSON.stringify({ status: 'done', summary: ['a'], ...c })}\n\`\`\`\n`;

// A transcript of one turn: a human prompt, then assistant messages (text, usage).
function transcript(name, texts, { context = 1000 } = {}) {
  const file = path.join(TMP, `${name}.jsonl`);
  const rows = [{ type: 'user', uuid: 'u1', message: { content: 'go' } }, ...texts.map((text, i) => ({
    type: 'assistant', message: { id: `${name}-a${i}`, model: 'claude-test', usage: { input_tokens: 10, cache_read_input_tokens: context - 10, output_tokens: 5 }, content: [{ type: 'text', text }] },
  }))];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('onStop: the card from the transcript is stored, usage recorded, the session goes idle, nothing printed', async () => {
  reset({ S1: session('S1') });
  const t = transcript('t1', ['working on it', cardText({ title: 'Fixed login' })]);
  const r = await hooks.onStop({ session_id: 'S1', cwd: TMP, transcript_path: t });
  assert.deepEqual(r, { stdout: '' });
  const cards = allCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Fixed login');
  assert.equal(cards[0].session_id, 'S1');
  const s = sessions.get('S1');
  assert.equal(s.state, 'idle');
  assert.equal(s.last_title, 'Fixed login');
  assert.equal(s.usage.turns, 1);
  assert.equal(s.last_context, 1000);
  // The same turn again (no new card): no second card, usage not counted twice.
  await hooks.onStop({ session_id: 'S1', cwd: TMP, transcript_path: t });
  assert.equal(allCards().length, 1);
  assert.equal(sessions.get('S1').usage.turns, 1);
});

test('onStop: waiting inbox messages are handed over (block) and the session stays working', async () => {
  reset({ S2: session('S2') });
  storeInbox.deliver('S2', { text: 'please also update the docs' });
  const r = await hooks.onStop({ session_id: 'S2', cwd: TMP, transcript_path: transcript('t2', ['ok']) });
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /\[Dashboard reply\]\n- please also update the docs/);
  assert.equal(sessions.get('S2').state, 'working');
});

test('onStop: a session ended meanwhile stays ended; an unknown session is ignored', async () => {
  reset({ S3: session('S3', { state: 'ended', ended: NOW(), end_reason: 'stopped' }) });
  await hooks.onStop({ session_id: 'S3', cwd: TMP, last_assistant_message: cardText({ title: 'late card' }) });
  assert.equal(sessions.get('S3').state, 'ended');
  assert.equal(sessions.get('S3').end_reason, 'stopped');
  assert.equal(allCards().length, 1); // the card itself is kept
  assert.deepEqual(await hooks.onStop({ session_id: 'NOPE', cwd: TMP, last_assistant_message: cardText({}) }), { stdout: '' });
  assert.equal(allCards().length, 1);
});

test('onStop: a lead replaced by a handoff is told once to stop and posts nothing', async () => {
  reset({ L1: session('L1', { state: 'ended', ended: NOW(), end_reason: 'handoff', replaced_by: 'L2' }) });
  const first = JSON.parse((await hooks.onStop({ session_id: 'L1', cwd: TMP, last_assistant_message: cardText({ title: 'x' }) })).stdout);
  assert.match(first.reason, /replaced as team lead by L2/);
  assert.equal((await hooks.onStop({ session_id: 'L1', cwd: TMP, last_assistant_message: '' })).stdout, '');
  assert.equal(allCards().length, 0);
});

test('onSessionEnd: ended with reason exit, prints nothing; onSessionStart prints nothing without a server', async () => {
  reset({ E1: session('E1') });
  assert.deepEqual(await hooks.onSessionEnd({ session_id: 'E1' }), { stdout: '' });
  assert.equal(sessions.get('E1').state, 'ended');
  assert.equal(sessions.get('E1').end_reason, 'exit');
  assert.deepEqual(await hooks.onSessionStart({ session_id: 'E1', cwd: TMP }), { stdout: '' });
});

test('runHook: a failing use case exits 0, prints nothing and logs one line with the hook name and session id', () => {
  reset();
  const script = `require(${JSON.stringify(path.join(ROOT, 'scripts', 'app', 'hooks.js'))}).runHook('stop-card', () => { throw new Error('boom in hook'); });`;
  const r = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify({ session_id: 'ERR1' }), encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  const logText = fs.readFileSync(paths.appLog, 'utf8');
  assert.match(logText, /hook stop-card: ERR1: Error: boom in hook/);
});

test('runHook: a real hook file with garbage input exits 0 and prints nothing', () => {
  reset();
  for (const f of ['session-start', 'prompt-submit', 'stop-card', 'session-end']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', `${f}.js`)], { input: '{not json', encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(r.stdout, '', f);
  }
});

// verify-009 F1: in an active project with the server up, a garbled hook call must not register a session.
test('runHook: empty, non-JSON or session-less stdin registers nothing, prints nothing, logs, exits 0', () => {
  reset();
  writeJson(paths.serverPid, { pid: process.pid, port: 1 }); // "server running": this test process is alive
  appProjects.setProject(TMP, true);
  assert.ok(appProjects.projectActive(TMP));
  const bad = ['', '   \n', '{not json', 'null', '[]', '123', JSON.stringify({ cwd: TMP }), JSON.stringify({ session_id: 123, cwd: TMP }), JSON.stringify({ session_id: '  ', cwd: TMP })];
  for (const f of ['session-start', 'prompt-submit', 'stop-card', 'session-end']) {
    for (const input of bad) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', `${f}.js`)], { input, cwd: TMP, encoding: 'utf8', env: process.env });
      assert.equal(r.status, 0, `${f} ${input}: ${r.stderr}`);
      assert.equal(r.stdout, '', `${f} ${input}`);
      assert.equal(r.stderr, '', `${f} ${input}`);
    }
  }
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(paths.sessions, "utf8"))), []);
  const lines = fs.readFileSync(paths.appLog, 'utf8').split('\n').filter((l) => / ignored: /.test(l));
  assert.equal(lines.length, 4 * bad.length);
  assert.match(lines.join('\n'), /hook session-start: ignored: empty stdin/);
  assert.match(lines.join('\n'), /hook stop-card: ignored: stdin is not JSON/);
  assert.match(lines.join('\n'), /hook prompt-submit: ignored: stdin is not a JSON object/);
  assert.match(lines.join('\n'), /hook session-end: ignored: no session_id/);
  // control: the same setup with a real session id registers it
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'session-start.js')], { input: JSON.stringify({ session_id: 'REAL1', cwd: TMP }), cwd: TMP, encoding: 'utf8', env: process.env });
  assert.equal(ok.status, 0);
  assert.ok(sessions.get('REAL1'), 'a real hook call still registers');
  assert.ok(ok.stdout.length > 0, 'and prints its instructions');
});

test('parseHookInput: only a JSON object with a string session_id is a hook call', () => {
  const p = hooks.parseHookInput;
  assert.deepEqual(p('{"session_id":"S1","cwd":"x"}'), { input: { session_id: 'S1', cwd: 'x' } });
  assert.equal(p('').error, 'empty stdin');
  assert.equal(p(undefined).error, 'empty stdin');
  assert.equal(p('{').error, 'stdin is not JSON');
  assert.equal(p('null').error, 'stdin is not a JSON object');
  assert.equal(p('["S1"]').error, 'stdin is not a JSON object');
  assert.equal(p('{"session_id":7}').error, 'no session_id');
  assert.equal(p('{}').error, 'no session_id');
});

test('hook files are thin (at most 15 lines, one runHook call)', () => {
  const dir = path.join(ROOT, 'scripts', 'hooks');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(text.trimEnd().split('\n').length <= 15, `${f} has more than 15 lines`);
    assert.match(text, /runHook\(/, f);
  }
});

test('onPrompt: only "/ddashboard:dashboard" activates; a bare "/dashboard off" (another plugin) is ignored', async () => {
  reset({});
  const other = path.join(TMP, 'other-proj');
  fs.mkdirSync(other, { recursive: true });
  appProjects.setProject(other, true); // keeps a project connected, so "off" never stops a server
  appProjects.setProject(TMP, true);
  assert.equal((await hooks.onPrompt({ session_id: 'A1', cwd: TMP, prompt: '/dashboard off' })).stdout, '');
  assert.equal(appProjects.projectActive(TMP), true);
  const r = await hooks.onPrompt({ session_id: 'A1', cwd: TMP, prompt: '/ddashboard:dashboard off' });
  assert.match(r.stdout, /Disconnected this project/);
  assert.equal(appProjects.projectActive(TMP), false);
  appProjects.setProject(other, false);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* busy on Windows */ }
  process.exitCode = failed ? 1 : 0;
})();
