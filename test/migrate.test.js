#!/usr/bin/env node
// store/meta + store/migrate + store/replies (refactor step 13): schema migrations are idempotent, boards written
// by older versions (0.1.0, 0.2.0, pre-M-1b 0.3.0) load, and a whole-file rewrite by an older plugin keeps the
// fields it does not know. Run: node test/migrate.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-migrate-'));
const BOARD = path.join(TMP, 'board');
process.env.DDASH_BOARD_DIR = BOARD;

const { paths } = require('../scripts/core/paths');
const { readJson, writeJson, readJsonl } = require('../scripts/core/fsx');
const meta = require('../scripts/store/meta');
const migrate = require('../scripts/store/migrate');
const replies = require('../scripts/store/replies');
const sessionsStore = require('../scripts/store/sessions');
const projectsStore = require('../scripts/store/projects');
const { readProjects } = require('../scripts/app/teams');
const cards = require('../scripts/app/cards');
const { view } = require('../scripts/domain/session');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const reset = () => {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  migrate.reset();
  cards.reset();
};
const jsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};
// Every file under the board (relative path -> content), to compare before and after.
function snapshot(dir = BOARD, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'locks' && e.name !== 'logs') snapshot(p, out); } else out[path.relative(BOARD, p)] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

// --- Fixtures: boards as older versions left them ---

const REPLIES_020 = [
  { type: 'reply', id: 'r1', ts: '2026-09-30T23:00:00.000Z', session_id: 'S1', card_id: 'c1', card_title: 'one', text: 'ok' },
  { type: 'reply', id: 'r2', ts: '2026-10-02T08:00:00.000Z', session_id: 'S1', card_id: 'c2', card_title: 'two', text: 'go on' },
];

// 0.1.0: one cards.jsonl, sessions with ended flag only, projects with since/cwd/name, no replies dir, no meta.
function board010() {
  jsonl(paths.legacyCards, [
    { id: 'c0', ts: '2026-08-01T10:00:00.000Z', session_id: 'S0', session_name: 'old', project: 'proj', status: 'done', title: 'legacy card', summary: ['a'] },
  ]);
  writeJson(paths.sessions, {
    S0: { session_id: 'S0', name: 'old', cwd: TMP, branch: 'main', project: 'proj', last_seen: '2026-08-01T10:00:00.000Z', ended: '2026-08-01T11:00:00.000Z' },
  });
  writeJson(paths.projects, { [TMP.toLowerCase()]: { since: '2026-08-01T09:00:00.000Z', cwd: TMP, name: 'proj' } });
}

// 0.2.0: monthly cards, replies.jsonl, sessions with state, projects with mode solo and no teams, settings.
function board020() {
  jsonl(paths.cardsFor('2026-10-02'), [
    { id: 'c1', ts: '2026-09-30T22:00:00.000Z', session_id: 'S1', session_name: 'a', project: 'proj', project_key: 'k', status: 'review', title: 'one', summary: [] },
    { id: 'c2', ts: '2026-10-02T07:00:00.000Z', session_id: 'S1', session_name: 'a', project: 'proj', project_key: 'k', status: 'wip', title: 'two', summary: [] },
  ]);
  jsonl(paths.replies, REPLIES_020);
  writeJson(paths.sessions, {
    S1: { session_id: 'S1', name: 'a', cwd: TMP, branch: 'main', project: 'proj', project_key: 'k', state: 'idle', last_seen: '2026-10-02T08:00:00.000Z', rules_ver: 3 },
  });
  writeJson(paths.projects, { k: { since: '2026-09-01T00:00:00.000Z', cwd: TMP, name: 'proj', mode: 'solo', mode_ver: 2 } });
  writeJson(paths.settings, { lang: 'ko', ver: 1 });
}

// --- Schema migrations ---

test('meta: a board without meta.json has schema 1; the code wants schema 2', () => {
  reset();
  assert.equal(meta.schema(), 1);
  assert.equal(migrate.SCHEMA, 2);
  writeJson(paths.meta, { schema: 'x' });
  assert.equal(meta.schema(), 1, 'an unreadable schema counts as 1');
});

test('migrate: schema 2 copies replies.jsonl into replies/YYYY-MM.jsonl, keeps replies.jsonl, backs it up, records meta', () => {
  reset();
  board020();
  const before = fs.readFileSync(paths.replies, 'utf8');
  assert.deepEqual(migrate.run(), [2]);
  assert.equal(fs.readFileSync(paths.replies, 'utf8'), before, 'the 0.2.x file is left for older plugins');
  assert.equal(fs.readFileSync(`${paths.replies}.bak-s2`, 'utf8'), before);
  assert.deepEqual(readJsonl(paths.repliesFor('2026-09')).map((r) => r.id), ['r1']);
  assert.deepEqual(readJsonl(paths.repliesFor('2026-10')).map((r) => r.id), ['r2']);
  const m = readJson(paths.meta, {});
  assert.equal(m.schema, 2);
  assert.equal(m.migrated.length, 1);
  assert.equal(m.migrated[0].to, 2);
  assert.equal(m.migrated[0].by_version, require('../.claude-plugin/plugin.json').version);
});

test('migrate: idempotent (run twice, ensure, a lost meta.json, a fold after migration change nothing)', () => {
  reset();
  board020();
  migrate.run();
  const once = snapshot();
  assert.deepEqual(migrate.run(), []);
  migrate.reset();
  assert.deepEqual(migrate.ensure(), []);
  assert.equal(replies.fold(), 0);
  assert.deepEqual(snapshot(), once);
  // meta.json lost (or written by nobody): the migration runs again without duplicating a reply.
  fs.unlinkSync(paths.meta);
  migrate.reset();
  assert.deepEqual(migrate.ensure(), [2]);
  const again = snapshot();
  assert.equal(again['replies/2026-09.jsonl'], once['replies/2026-09.jsonl']);
  assert.equal(again['replies/2026-10.jsonl'], once['replies/2026-10.jsonl']);
});

test('migrate: a board with a newer schema than the code is left alone', () => {
  reset();
  board020();
  writeJson(paths.meta, { schema: 9, migrated: [], future: true });
  assert.deepEqual(migrate.run(), []);
  assert.equal(fs.existsSync(paths.repliesDir), false);
  assert.equal(readJson(paths.meta, {}).future, true);
});

test('replies: append migrates first, then writes the monthly file only', () => {
  reset();
  board020();
  replies.append({ type: 'reply', id: 'r3', ts: '2026-11-26T01:00:00.000Z', session_id: 'S1', text: 'new' });
  assert.equal(meta.schema(), 2);
  assert.equal(readJsonl(paths.replies).length, 2, 'replies.jsonl is not written any more');
  assert.deepEqual(readJsonl(paths.repliesFor('2026-11')).map((r) => r.id), ['r3']);
  assert.deepEqual(replies.recent().map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(replies.recent(2).map((r) => r.id), ['r2', 'r3']);
});

test('replies: an older server appending to replies.jsonl after the migration is read at once and folded once', () => {
  reset();
  board020();
  migrate.run();
  fs.appendFileSync(paths.replies, JSON.stringify({ type: 'reply', id: 'r9', ts: '2026-11-20T00:00:00.000Z', session_id: 'S1', text: 'old server' }) + '\n');
  assert.deepEqual(replies.recent().map((r) => r.id), ['r1', 'r2', 'r9']);
  assert.equal(replies.fold(), 1);
  assert.equal(replies.fold(), 0);
  assert.deepEqual(readJsonl(paths.repliesFor('2026-11')).map((r) => r.id), ['r9']);
  assert.deepEqual(replies.recent().map((r) => r.id), ['r1', 'r2', 'r9']);
});

test('replies: recent() before any migration reads replies.jsonl and writes nothing', () => {
  reset();
  board020();
  const before = snapshot();
  assert.deepEqual(replies.recent().map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(snapshot(), before);
});

// --- Old boards load ---

test('fixture 0.1.0: cards.jsonl, ended-flag sessions and projects without mode load', () => {
  reset();
  board010();
  const st = cards.state(300, { sessions: sessionsStore.read() });
  assert.equal(st.last_by_session.S0?.id, 'c0', 'the 0.1.0 card is read');
  assert.equal(st.archived_count, 1, 'older than DDASH_RECENT_DAYS');
  assert.equal(view(sessionsStore.get('S0')).view, 'ended');
  const p = readProjects()[TMP.toLowerCase()];
  assert.deepEqual(p.teams, {});
  assert.equal(p.name, 'proj');
  assert.deepEqual(replies.recent(), []);
  assert.deepEqual(migrate.run(), [2], 'no replies.jsonl: the migration still records schema 2');
  assert.equal(fs.existsSync(`${paths.replies}.bak-s2`), false);
});

test('fixture 0.2.0: monthly cards, replies, solo project and settings load; migration keeps every field', () => {
  reset();
  board020();
  const sessionsBefore = readJson(paths.sessions, {});
  migrate.run();
  const st = cards.state(300, { sessions: sessionsStore.read() });
  assert.equal(st.last_by_session.S1?.id, 'c2');
  assert.equal(st.archived_count, 2, 'older than DDASH_RECENT_DAYS');
  assert.deepEqual(replies.recent().map((r) => r.card_id), ['c1', 'c2']);
  const p = readProjects().k;
  assert.equal(p.mode, 'solo');
  assert.equal(p.mode_ver, 2);
  assert.deepEqual(p.teams, {});
  assert.deepEqual(readJson(paths.sessions, {}), sessionsBefore, 'sessions.json is not touched by the migration');
  assert.deepEqual(readJson(paths.settings, {}), { lang: 'ko', ver: 1 });
});

test('fixture pre-M-1b: a team-mode project with lead/lead_name/groups becomes one team (no group folders)', () => {
  reset();
  const cwd = path.join(TMP, 'nogit');
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(paths.sessions, { L1: { session_id: 'L1', cwd, state: 'idle', project_key: 'k' } });
  writeJson(paths.projects, {
    k: {
      since: 'x', cwd, name: 'proj', mode: 'team', mode_ver: 3, lead: 'L1', lead_name: 'Alpha Team',
      groups: { front: { created: 'y' }, 'bad name': {} }, handoff: { to: 'L2' },
    },
  });
  const p = readProjects().k;
  assert.deepEqual(Object.keys(p.teams), ['Alpha-Team']);
  const t = p.teams['Alpha-Team'];
  assert.equal(t.lead, 'L1');
  assert.deepEqual(Object.keys(t.groups), ['front']);
  assert.equal(t.groups.front.created, 'y');
  assert.deepEqual(t.handoff, { to: 'L2' });
  assert.equal(p.mode, 'team');
  assert.equal(p.mode_ver, 4);
  for (const k of ['lead', 'lead_name', 'groups', 'handoff']) assert.equal(p[k], undefined, k);
  assert.deepEqual(readJson(paths.projects, {}).k.teams, p.teams, 'saved on first read');
  // Idempotent: a second read changes nothing.
  const text = fs.readFileSync(paths.projects, 'utf8');
  readProjects();
  assert.equal(fs.readFileSync(paths.projects, 'utf8'), text);
});

// --- Old writers ---

// What 0.2.0 does: read the whole file, change the fields it knows with a spread, write the whole file.
const oldWrite = (file, fn) => { const all = readJson(file, {}); fn(all); fs.writeFileSync(file, JSON.stringify(all, null, 2)); };

test('old writer: a whole-file rewrite of sessions.json and projects.json keeps the fields it does not know', () => {
  reset();
  board020();
  migrate.run();
  sessionsStore.patch('S1', { v: 2, proc: { claude: { pid: 123, name: 'claude.exe', started: 'z' } }, state: 'working', kind: 'lead' });
  projectsStore.update((m) => { m.k.teams = { t1: { lead: 'S1', worktree: TMP, groups: { g: { dir: TMP } } } }; m.k.spawn = { runner_member: 'orca' }; });
  // 0.2.0 Stop hook and setProject:
  oldWrite(paths.sessions, (all) => { all.S1 = { ...all.S1, last_seen: '2026-11-26T00:00:00.000Z', state: 'idle' }; });
  oldWrite(paths.projects, (all) => { all.k = { ...(all.k || {}), since: '2026-11-26T00:00:00.000Z', cwd: TMP, name: 'proj' }; });
  const s = sessionsStore.get('S1');
  assert.equal(s.v, 2);
  assert.equal(s.proc.claude.pid, 123);
  assert.equal(s.kind, 'lead');
  assert.equal(s.state, 'idle');
  const p = readProjects().k;
  assert.equal(p.teams.t1.lead, 'S1');
  assert.equal(p.spawn.runner_member, 'orca');
  // meta.json is not a file old plugins know: it stays as written.
  assert.equal(meta.schema(), 2);
});

test('old writer: a 0.2.0 setProject of a new project (no teams) is migrated on the next read', () => {
  reset();
  board020();
  migrate.run();
  readProjects();
  oldWrite(paths.projects, (all) => { all.k2 = { since: 'now', cwd: TMP, name: 'other' }; });
  const p = readProjects();
  assert.deepEqual(p.k2.teams, {});
  assert.deepEqual(p.k.teams, {});
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
