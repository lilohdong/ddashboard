#!/usr/bin/env node
// Card parsing and lifecycle (docs/architecture.md §4.2, refactor step 6). Run: node test/cards.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-cards-'));
const BOARD = path.join(TMP, 'board');
process.env.DDASH_BOARD_DIR = BOARD;

const { parseCard, lifecycle } = require('../plugin/scripts/domain/card');
const store = require('../plugin/scripts/store/cards');
const cards = require('../plugin/scripts/app/cards');
const sessionsStore = require('../plugin/scripts/store/sessions');
const { writeJson } = require('../plugin/scripts/core/fsx');
const { paths } = require('../plugin/scripts/core/paths');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const reset = () => {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  cards.reset();
};

let clock = Date.now() - 60 * 60000;
const nextTs = () => new Date((clock += 1000)).toISOString();
const card = (id, sid, status, extra = {}) => ({ id, ts: nextTs(), session_id: sid, project_key: 'PK', project: 'p', status, title: id, ...extra });
const post = (...cs) => { for (const c of cs) store.append(c); return cs; };
const live = { state: 'idle' };
const ended = { state: 'ended', ended: new Date().toISOString(), end_reason: 'exit' };
const setSessions = (m) => writeJson(paths.sessions, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { session_id: k, ...v }])));
const top = () => cards.state().cards;
const ids = (list) => list.map((c) => c.id);
const find = (id) => cards.search('', 'include', 500).find((c) => c.id === id);

// --- parseCard (fixtures moved from the Stop hook) ---

test('parseCard: none, minimal, defaults and limits', () => {
  assert.equal(parseCard('no card here'), null);
  assert.deepEqual(parseCard('```card\n{"status":"wip","title":"T"}\n```'), { status: 'wip', title: 'T', summary: [], review: [] });
  const c = parseCard('```card\n{"summary":["a","b","c","d"],"review":["1","2","3","4","5","6"]}\n```');
  assert.equal(c.status, 'done');
  assert.equal(c.title, '(untitled)');
  assert.equal(c.summary.length, 3);
  assert.equal(c.review.length, 5);
  assert.equal(parseCard(`\`\`\`card\n${JSON.stringify({ title: 'x'.repeat(300), details: 'd'.repeat(5000) })}\n\`\`\``).title.length, 200);
  assert.equal(parseCard(`\`\`\`card\n${JSON.stringify({ details: 'd'.repeat(5000) })}\n\`\`\``).details.length, 4000);
  assert.equal(parseCard('```card\n{"details":"   "}\n```').details, undefined);
});

test('parseCard: the last block wins; raw newlines in strings; ``` inside details', () => {
  assert.equal(parseCard('```card\n{"title":"one"}\n```\ntext\n```card\n{"title":"two"}\n```').title, 'two');
  assert.equal(parseCard('```card\n{"title":"T","details":"line1\nline2\tx"}\n```').details, 'line1\nline2\tx');
  const text = '```card\n{"title":"T","details":"see\\n```js\\ncode()\\n```\\nend"}\n```';
  assert.equal(parseCard(text).details, 'see\n```js\ncode()\n```\nend');
});

test('parseCard: key normalised or dropped, replaces only "last", invalid JSON kept as text', () => {
  assert.equal(parseCard('```card\n{"key":"Login Fix"}\n```').key, 'login-fix');
  assert.equal(parseCard('```card\n{"key":"bad/key!"}\n```').key, undefined);
  assert.equal(parseCard('```card\n{"replaces":"last"}\n```').replaces, 'last');
  assert.equal(parseCard('```card\n{"replaces":"abc"}\n```').replaces, undefined);
  assert.deepEqual(parseCard('```card\nnot json\nline 2\n```'), { status: 'done', title: 'not json', summary: ['line 2'], review: [] });
});

// --- lifecycle (pure) ---

test('lifecycle: wip -> done folds; wip -> wip -> review chain collapses to the top card', () => {
  const [a, b] = [card('a', 'S', 'wip'), card('b', 'S', 'done')];
  let l = lifecycle([a, b], { S: live });
  assert.deepEqual(l.get('a'), { outcome: 'done', folded_into: 'b' });
  assert.deepEqual(l.get('b'), { outcome: 'done' });
  const [w1, w2, r] = [card('w1', 'S', 'wip'), card('w2', 'S', 'wip'), card('r', 'S', 'review')];
  l = lifecycle([w1, w2, r], { S: live });
  assert.deepEqual(l.get('w1'), { outcome: 'review', folded_into: 'r' });
  assert.deepEqual(l.get('w2'), { outcome: 'review', folded_into: 'r' });
  // Only wip cards fold, and only within their session.
  const [d1, x, d2] = [card('d1', 'S', 'done'), card('x', 'T', 'wip'), card('d2', 'S', 'done')];
  l = lifecycle([d1, x, d2], { S: live, T: live });
  assert.equal(l.get('d1').folded_into, undefined);
  assert.deepEqual(l.get('x'), { outcome: 'wip' });
});

test('lifecycle: ended or forgotten session -> its open wip cards are stopped; resume folds them again', () => {
  const cs = [card('w1', 'S', 'wip'), card('w2', 'S', 'wip')];
  let l = lifecycle(cs, { S: ended });
  assert.deepEqual(l.get('w2'), { outcome: 'stopped', stopped: true });
  assert.deepEqual(l.get('w1'), { outcome: 'stopped', folded_into: 'w2', stopped: true });
  assert.equal(lifecycle(cs, {}).get('w2').outcome, 'stopped', 'forgotten counts as ended');
  assert.deepEqual(lifecycle(cs, { S: live }).get('w2'), { outcome: 'wip' }, 'resumed: open again');
  l = lifecycle([...cs, card('d', 'S', 'done')], { S: live });
  assert.deepEqual(l.get('w2'), { outcome: 'done', folded_into: 'd' });
  // An ended session's done card is not stopped.
  assert.deepEqual(lifecycle([card('z', 'S', 'done')], { S: ended }).get('z'), { outcome: 'done' });
});

// --- app/cards: index, /api/state and /api/search views ---

test('state: folded cards render under the newer card (oldest first), not top-level; outcome everywhere', () => {
  reset();
  setSessions({ S: live });
  post(card('w1', 'S', 'wip'), card('w2', 'S', 'wip'), card('r', 'S', 'review'));
  const st = cards.state();
  assert.deepEqual(ids(st.cards), ['r']);
  assert.deepEqual(ids(st.cards[0].folded), ['w1', 'w2']);
  assert.ok(st.cards[0].folded.every((c) => c.outcome === 'review' && c.folded_into === 'r'));
  assert.equal(st.archived_count, 0, 'folded cards are not archived');
  assert.equal(st.last_by_session.S.outcome, 'review');
  const s = find('w1');
  assert.equal(s.folded_into, 'r', 'search still finds folded cards');
  assert.equal(s.archived, false);
});

test('state: stopped wip of an ended session; resumed session folds it under its next card', () => {
  reset();
  setSessions({ S: ended });
  post(card('w', 'S', 'wip'));
  let c = top()[0];
  assert.equal(c.outcome, 'stopped');
  assert.equal(c.stopped, true);
  setSessions({ S: live });
  assert.equal(top()[0].outcome, 'wip');
  assert.equal(top()[0].stopped, undefined);
  post(card('d', 'S', 'done'));
  c = top();
  assert.deepEqual(ids(c), ['d']);
  assert.deepEqual(ids(c[0].folded), ['w']);
});

test('state: a key replacement beats stopped (handoff to a new lead)', () => {
  reset();
  setSessions({ OLD: ended, NEW: live });
  post(card('k1', 'OLD', 'wip', { key: 'task' }), card('k2', 'NEW', 'wip', { key: 'task' }));
  assert.deepEqual(ids(top()), ['k2']);
  const k1 = find('k1');
  assert.equal(k1.replaced, true);
  assert.equal(k1.stopped, undefined);
  assert.equal(k1.archived, true);
  assert.equal(top()[0].key_prev, 1);
});

test('state: explicit archive / unarchive wins over every rule', () => {
  reset();
  setSessions({ S: ended, T: live });
  post(card('stop', 'S', 'wip'), card('old', 'T', 'done', { key: 'k' }), card('new', 'T', 'done', { key: 'k' }));
  assert.deepEqual(ids(top()), ['stop', 'new']);
  cards.setArchived('stop', true);
  cards.setArchived('old', false);
  assert.deepEqual(ids(top()), ['old', 'new']);
  assert.equal(cards.state().archived_count, 1);
  // A folded card follows its top card, unless the user chose otherwise.
  post(card('w', 'T', 'wip'), card('top', 'T', 'done'));
  assert.equal(find('w').archived, false);
  cards.setArchived('top', true);
  assert.equal(find('w').archived, true);
  cards.setArchived('w', false);
  assert.equal(find('w').archived, false);
  assert.ok(!ids(top()).includes('w'), 'unarchived folded card stays folded');
});

test('state: member reports fold among their own cards and stay hidden unless reports=1', () => {
  reset();
  setSessions({ L: live, M: live });
  post(card('m1', 'M', 'wip', { via_lead: 'L' }), card('m2', 'M', 'done', { via_lead: 'L' }));
  assert.deepEqual(ids(top()), []);
  const st = cards.state(300, { reports: true });
  assert.deepEqual(ids(st.cards), ['m2']);
  assert.deepEqual(ids(st.cards[0].folded), ['m1']);
});

test('nothing is written to card files; the index picks up appended cards and rebuilds after truncation', () => {
  reset();
  setSessions({ S: ended });
  post(card('w', 'S', 'wip'));
  const file = store.files().find((f) => fs.existsSync(f) && f !== paths.legacyCards);
  const before = fs.readFileSync(file, 'utf8');
  cards.state();
  cards.search('');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!/outcome|folded_into|stopped/.test(before));
  fs.writeFileSync(file, '');
  assert.deepEqual(ids(top()), []);
  post(card('n', 'S', 'done'));
  assert.deepEqual(ids(top()), ['n']);
  assert.equal(sessionsStore.get('S').state, 'ended');
});

// --- dashboard (scripts/web): cardView, folded / stopped rendering, urgency by outcome ---

const WEB = path.join(ROOT, 'plugin', 'scripts', 'web');
const imp = (name) => import(require('url').pathToFileURL(path.join(WEB, name)).href);
const i18n = require('../plugin/scripts/i18n.js');
const tr = (key, vars) => i18n.translate('en', key, vars);
const webFixture = (W) => {
  const sessions = { S: { session_id: 'S', name: 's', project: 'p', view: 'idle' }, E: { session_id: 'E', name: 'e', project: 'p', view: 'ended' } };
  const w1 = { ...card('w1', 'S', 'wip'), outcome: 'review', folded_into: 'r', summary: ['step one'] };
  const r = { ...card('r', 'S', 'review'), outcome: 'review', folded: [w1] };
  const st = { ...card('st', 'E', 'wip'), outcome: 'stopped', stopped: true };
  const state = { sessions, cards: [st, r], replies: [], last_by_session: { S: r, E: st }, archived_count: 0 };
  return { state, ui: W.state.initialUi(), w1, r, st };
};
const loadWeb = async () => ({
  cards: await imp('render-cards.mjs'), main: await imp('render-main.mjs'), select: await imp('select.mjs'), state: await imp('ui-state.mjs'),
});

test('web: a top card shows its folded cards collapsed; expanded when its id is in ui.openFolds', async () => {
  const W = await loadWeb();
  const { state, ui, r } = webFixture(W);
  let html = W.cards.cardsHtml([r], '', state, ui, tr);
  assert.match(html, /<details class="folds" data-folds="r"><summary>1 earlier progress cards<\/summary>/);
  assert.match(html, /step one/);
  ui.openFolds.add('r');
  html = W.cards.cardsHtml([r], '', state, ui, tr);
  assert.match(html, /data-folds="r" open>/);
});

test('web: stopped card has the Stopped badge and filter bucket; a folded search hit shows its outcome', async () => {
  const W = await loadWeb();
  const { state, ui, st, w1 } = webFixture(W);
  assert.equal(W.cards.cardView(st, state).status, 'stopped');
  assert.match(W.cards.cardsHtml([st], '', state, ui, tr), /class="badge s-stopped" title="Still in progress when its session ended">Stopped</);
  const v = W.main.renderMain(state, ui, tr);
  assert.match(v.filters, /data-f="stopped">Stopped 1</);
  assert.match(v.filters, /data-f="wip">In progress 0</);
  const hit = W.cards.cardsHtml([w1], '', state, ui, tr);
  assert.match(hit, /badge s-review/);
  assert.match(hit, /badge folded/);
});

test('web: urgency and answered use the outcome', async () => {
  const W = await loadWeb();
  const { state, ui, r } = webFixture(W);
  assert.deepEqual(W.select.urgentBySession(state, ui), { S: 1 });
  // A wip card folded into a review card is not urgent by itself.
  state.last_by_session.S = { ...r, status: 'wip', outcome: 'done' };
  assert.deepEqual(W.select.urgentBySession(state, ui), {});
  state.last_by_session.S = { id: 'x', status: 'wip', outcome: 'review' };
  assert.deepEqual(W.select.urgentBySession(state, ui), { S: 1 });
  state.replies = [{ card_id: 'x', text: 'ok', ts: nextTs() }];
  assert.deepEqual(W.select.urgentBySession(state, ui), {});
  assert.equal(W.select.answered({ id: 'x', status: 'wip', outcome: 'review' }, new Set(['x'])), true);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
