#!/usr/bin/env node
// Front-end tests (scripts/web). Run: node test/web.test.js
// Imports the pure render modules with import() and renders fixtures; no browser, no server, no board dir.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { startServer, freePort } = require('./helpers');
const WEB = path.join(ROOT, 'plugin', 'scripts', 'web');
const i18n = require(path.join(ROOT, 'plugin', 'scripts', 'i18n.js'));
const imp = (name) => import(require('url').pathToFileURL(path.join(WEB, name)).href);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let M; // modules, loaded once
const t = (key, vars) => i18n.translate('en', key, vars);
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

function fixture() {
  const sessions = {
    A: { session_id: 'A', name: 'alpha', project: 'proj', branch: 'main', cwd: '/p', view: 'working', last_seen: ago(1) },
    B: { session_id: 'B', name: 'beta', project: 'proj', branch: 'dev', cwd: '/p', view: 'idle', last_seen: ago(5) },
    E: { session_id: 'E', name: 'gone', project: 'proj', branch: 'x', cwd: '/p', view: 'ended', last_seen: ago(500) },
  };
  const cards = [
    { id: 'c1', ts: ago(30), session_id: 'A', session_name: 'alpha', project: 'proj', project_key: 'PK', branch: 'main', status: 'done', title: 'First <b>', summary: ['s1'], key: 'fix', key_prev: 2 },
    { id: 'c2', ts: ago(20), session_id: 'B', session_name: 'beta', project: 'proj', project_key: 'PK', branch: 'dev', status: 'review', title: 'Look at this', review: ['check it'], details: 'long text' },
    { id: 'c3', ts: ago(10), session_id: 'E', session_name: 'gone', project: 'proj', project_key: 'PK', branch: 'x', status: 'blocked', title: 'Old blocker' },
  ];
  const state = { sessions, cards, replies: [], last_by_session: { A: cards[0], B: cards[1], E: cards[2] }, archived_count: 3 };
  const ui = M.state.initialUi();
  return { state, ui };
}

test('render modules are pure: no DOM or window access, no localStorage outside ui-state', () => {
  for (const f of ['format.mjs', 'select.mjs', 'render-side.mjs', 'render-cards.mjs', 'render-search.mjs', 'render-main.mjs']) {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(src, /\b(document|window|localStorage|getSelection)\s*[.(]|\bfetch\(/, f);
    assert.doesNotMatch(src, /^(let|var) /m, `${f}: no module-level mutable state`);
  }
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.mjs') && x !== 'ui-state.mjs')) {
    assert.doesNotMatch(fs.readFileSync(path.join(WEB, f), 'utf8'), /localStorage/, f);
  }
});

test('index.html: markup only, loads i18n.js before the module, style sheet linked', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline script');
  assert.doesNotMatch(html, /<style>/, 'no inline style');
  assert.ok(html.indexOf('src="/i18n.js"') < html.indexOf('src="/web/main.mjs"'));
  assert.match(html, /<script type="module" src="\/web\/main.mjs">/);
  assert.match(html, /<link rel="stylesheet" href="\/web\/style.css">/);
  for (const id of ['side', 'cards', 'filters', 'mode', 'scope', 'q', 'reports', 'lang', 'toggle']) assert.match(html, new RegExp(`id="${id}"`), id);
});

test('every module the page imports exists, and every i18n key the page uses exists', () => {
  const files = fs.readdirSync(WEB).filter((x) => x.endsWith('.mjs'));
  const src = files.map((f) => fs.readFileSync(path.join(WEB, f), 'utf8')).join('\n') + fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  for (const m of src.matchAll(/from '\.\/([\w-]+\.mjs)'/g)) assert.ok(files.includes(m[1]), `missing module ${m[1]}`);
  const used = new Set([
    ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/data-i18n-\w+="([\w.]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/runnerSel\('\w+', '([\w.]+)'\)/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size > 50, `found ${used.size} keys`);
  for (const k of used) assert.ok(k in i18n.DICT.en, `missing key ${k}`);
});

test('cards: escaped, urgent card answered after a reply, key tag carries the project, ended session is closed', () => {
  const { state, ui } = fixture();
  let v = M.main.renderMain(state, ui, t);
  assert.match(v.cards, /First &lt;b&gt;/);
  assert.doesNotMatch(v.cards, /First <b>/);
  // newest first
  assert.ok(v.cards.indexOf('Old blocker') < v.cards.indexOf('Look at this'));
  assert.ok(v.cards.indexOf('Look at this') < v.cards.indexOf('First'));
  // BUG-004: every card is an article with its id
  for (const id of ['c1', 'c2', 'c3']) assert.match(v.cards, new RegExp(`<article class="card" data-id="${id}">`));
  // key tag: exact key and project, with the history count
  assert.match(v.cards, /<button class="badge key" data-key="fix" data-key-project="PK" title="[^"]+">#fix · /);
  // live session: reply form; ended session: closed
  assert.match(v.cards, /<form data-sid="B" data-id="c2"/);
  assert.doesNotMatch(v.cards, /data-sid="E"/);
  assert.ok(v.cards.includes(`<div class="closed">${M.format.esc(t('card.closed'))}</div>`));
  // details and review
  assert.match(v.cards, /<details data-details="c2"><summary>/);
  ui.openDetails.add('c2');
  assert.match(M.main.renderMain(state, ui, t).cards, /<details data-details="c2" open>/);
  assert.match(v.cards, /<div class="review"><b>/);
  // filter counts: review 1, blocked 1, done 1
  assert.match(v.filters, /data-f="review">Needs review 1</);
  // a reply answers the review card: badge, and the filter no longer counts it
  state.replies.push({ card_id: 'c2', text: 'ok <go>', ts: ago(1) });
  v = M.main.renderMain(state, ui, t);
  assert.match(v.cards, /badge s-review answered/);
  assert.match(v.cards, /<b>You<\/b> ok &lt;go&gt;/);
  assert.match(v.filters, /data-f="review">Needs review 0</);
  assert.equal(state.cards[1].answered, undefined, 'render does not write to the server state');
  // reply draft survives a render
  ui.drafts.c2 = 'half typed';
  assert.match(M.main.renderMain(state, ui, t).cards, />half typed<\/textarea>/);
});

test('cards: member report via a lead is dimmed and closed; archived card offers restore', () => {
  const { state, ui } = fixture();
  state.sessions.L = { session_id: 'L', name: 'lead-1', project: 'proj', view: 'idle', last_seen: ago(1) };
  state.cards.push({ id: 'r1', ts: ago(1), session_id: 'A', session_name: 'alpha', branch: 'main', status: 'done', title: 'Report', via_lead: 'L', archived: true });
  const v = M.main.renderMain(state, ui, t);
  assert.match(v.cards, /<article class="card report" data-id="r1">/);
  assert.match(v.cards, new RegExp(t('card.reportTo', { name: 'lead-1' })));
  assert.match(v.cards, /data-unarchive="r1"/);
  assert.match(v.cards, /data-archive="c1"/);
});

test('sidebar: urgent count, ended hidden until shown, needs-you cleared by a reply or archive', () => {
  const { state, ui } = fixture();
  let html = M.side.renderSide(state, ui, t);
  // B's latest card needs review; E is ended so its blocker does not count
  assert.match(html, /data-kind="all"><span class="grow">All<\/span><span class="count">1<\/span>/);
  assert.match(html, /data-id="B"[\s\S]*?needs you/);
  assert.doesNotMatch(html, /data-id="E"/);
  assert.match(html, /data-toggle-ended>Show ended sessions \(1\)/);
  assert.match(html, /Archived \(3\)/);
  ui.showEnded = true;
  html = M.side.renderSide(state, ui, t);
  assert.match(html, /<span class="dot ended"><\/span>/);
  assert.match(html, /data-forget="E"/);
  ui.overrides.c2 = true; // archived optimistically
  assert.doesNotMatch(M.side.renderSide(state, ui, t), /<span class="count">/);
  delete ui.overrides.c2;
  state.replies.push({ card_id: 'c2', text: 'done', ts: ago(1) });
  assert.doesNotMatch(M.side.renderSide(state, ui, t), /<span class="count">/);
});

test('sidebar: team mode orders team > lead > groups > members, with "+ member" and group tools', () => {
  const { state, ui } = fixture();
  state.sessions.L = { session_id: 'L', name: 'lead', project: 'proj', view: 'idle', team: 'lead', team_name: 'T1', last_seen: ago(1) };
  state.sessions.M1 = { session_id: 'M1', name: 'm1', project: 'proj', view: 'working', team: 'member', lead: 'L', group: 'g1', role: 'front', last_seen: ago(1) };
  state.sessions.M2 = { session_id: 'M2', name: 'm2', project: 'proj', view: 'ended', team: 'member', lead: 'L', role: 'proc', last_seen: ago(1) };
  state.teams = { proj: { key: 'PK', mode: 'team', teams: { T1: { lead: 'L', groups: { g1: { dir: '/g1' } } } } } };
  const html = M.side.renderSide(state, ui, t);
  const pos = (re) => { const m = html.match(re); assert.ok(m, String(re)); return m.index; };
  const order = [/data-team-remove="T1"/, /data-id="L"/, /class="gname">g1/, /data-id="M1"/, /data-spawn-for="L\|g1"/, /gname unassigned/, /data-id="M2"/, /data-spawn-for="L\|"/, /data-group-add="proj"/, /data-id="A"/].map(pos);
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  assert.match(html, /<span class="tag" title="[^"]+">front<\/span>/);
  assert.match(html, /class="tag lead"[^>]*>lead · T1/);
  assert.match(html, /data-end-member="M1"/);
  assert.match(html, /<select class="mode-sel" data-mode-key="PK"/);
  // open "+ member" form keeps its draft; group delete confirmation
  ui.spawnFor = 'L|g1';
  ui.spawnDraft = { role: 'qa', model: '', stay: true, task: 'test <it>' };
  ui.groupDel = { project: 'proj', team: 'T1', name: 'g1' };
  const open = M.side.renderSide(state, ui, t);
  assert.match(open, /<form class="spawn-form depth2" data-spawn="L" data-group="g1">/);
  assert.match(open, /value="qa"/);
  assert.match(open, /name="stay" checked/);
  assert.match(open, />test &lt;it&gt;<\/textarea>/);
  assert.match(open, /data-group-del-ok/);
  // project scope shows the runner pickers in the mode bar
  ui.scope = { kind: 'project', id: 'proj' };
  state.teams.proj.runner_lead = 'orca';
  const v = M.main.renderMain(state, ui, t);
  assert.match(v.mode, /data-runner="runner_lead"[\s\S]*?<option value="orca" selected>/);
  assert.equal(v.reports.hidden, false);
});

test('scope: session and project filter the cards and set the title', () => {
  const { state, ui } = fixture();
  ui.scope = { kind: 'session', id: 'B' };
  let v = M.main.renderMain(state, ui, t);
  assert.equal(v.title, 'proj / beta');
  assert.match(v.cards, /data-id="c2"/);
  assert.doesNotMatch(v.cards, /data-id="c1"/);
  ui.filter = 'done';
  assert.match(M.main.renderMain(state, ui, t).cards, /class="empty"/);
  ui.scope = { kind: 'all' };
  v = M.main.renderMain(state, ui, t);
  assert.equal(v.title, 'All');
  assert.match(v.cards, /data-id="c1"/);
  assert.doesNotMatch(v.cards, /data-id="c2"/);
  assert.equal(v.reports.hidden, true);
});

test('search: loading, results, key history (exact, across sessions), archived view, unavailable', () => {
  const { state, ui } = fixture();
  ui.query = 'look';
  let v = M.main.renderMain(state, ui, t);
  assert.match(v.mode, new RegExp(t('search.searching')));
  assert.equal(v.cards, '', 'nothing while the first search loads');
  ui.results = [state.cards[1]];
  v = M.main.renderMain(state, ui, t);
  assert.match(v.mode, /data-clear-search/);
  assert.match(v.mode, new RegExp(t('search.results', { q: 'look', where: t('search.inAll'), n: 1 })));
  // key history: label "#fix", the exact key and project go to the server, scope is ignored
  ui.query = '';
  ui.keyFilter = { key: 'fix', project_key: 'PK' };
  ui.scope = { kind: 'session', id: 'B' };
  ui.results = [state.cards[0]];
  v = M.main.renderMain(state, ui, t);
  assert.match(v.mode, /#fix/);
  assert.match(v.cards, /data-id="c1"/);
  const p = M.select.searchParams(ui);
  assert.equal(p.get('key'), 'fix');
  assert.equal(p.get('project_key'), 'PK');
  assert.equal(p.get('archived'), 'include');
  // archived view shows only archived results (with optimistic overrides) and a back button
  ui.keyFilter = null;
  ui.scope = { kind: 'all' };
  ui.archivedView = true;
  ui.results = [{ ...state.cards[0], archived: true }, state.cards[1]];
  ui.overrides.c2 = true;
  v = M.main.renderMain(state, ui, t);
  assert.match(v.title, new RegExp(t('scope.archived', { scope: 'All' })));
  assert.match(v.mode, /data-archived/);
  assert.match(v.cards, /data-id="c1"/);
  assert.match(v.cards, /data-id="c2"/);
  assert.equal(M.select.searchParams(ui).get('archived'), 'only');
  ui.results = [];
  assert.match(M.main.renderMain(state, ui, t).cards, new RegExp(t('empty.noArchived')));
  ui.searchError = 'unavailable';
  assert.match(M.main.renderMain(state, ui, t).mode, new RegExp(t('search.unavailable')));
});

test('language: the same state renders in Korean', () => {
  const { state, ui } = fixture();
  ui.lang = 'ko';
  const ko = (key, vars) => i18n.translate('ko', key, vars);
  const v = M.main.renderMain(state, ui, ko);
  assert.match(v.cards, new RegExp(ko('card.send')));
  assert.notEqual(ko('card.send'), t('card.send'));
});

test('BUG-004: setHtml writes only changed HTML; poll guards and scroll keeping are in place', async () => {
  const dom = await imp('dom.mjs');
  let writes = 0;
  const el = { set innerHTML(v) { writes++; this._v = v; }, get innerHTML() { return this._v; } };
  assert.equal(dom.setHtml(el, '<b>a</b>'), true);
  assert.equal(dom.setHtml(el, '<b>a</b>'), false);
  assert.equal(dom.setHtml(el, '<b>b</b>'), true);
  assert.equal(writes, 2);
  const src = fs.readFileSync(path.join(WEB, 'dom.mjs'), 'utf8');
  assert.match(src, /scrolls\[el\.parentElement\.dataset\.details\] = el\.scrollTop/);
  assert.match(src, /article\[data-id\]/);
  const main = fs.readFileSync(path.join(WEB, 'main.mjs'), 'utf8');
  assert.match(main, /if \(busy\(\)\) \{ pendingLoad = true; return; \}/);
  assert.match(main, /addEventListener\('selectionchange', runPending\)/);
  // every polled region goes through setHtml / renderCards
  for (const id of ['side', 'filters', 'mode']) assert.match(main, new RegExp(`setHtml\\(\\$\\('${id}'\\)`), id);
  assert.match(main, /renderCards\(\$\('cards'\)/);
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.mjs'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(WEB, f), 'utf8'), /\$\('(side|filters|mode|cards)'\)\.innerHTML\s*=/, f);
  }
});

test('cardView: one place for the displayed status, answered and reply box', () => {
  const { state } = fixture();
  const cv = M.cards.cardView;
  assert.deepEqual(cv(state.cards[1], state), { status: 'review', answered: false, open: true, stopped: false, folded: [], foldedInto: '' });
  assert.deepEqual(cv({ ...state.cards[2], answered: true }, state), { status: 'blocked', answered: true, open: false, stopped: false, folded: [], foldedInto: '' });
  assert.equal(cv({ session_id: 'nobody', status: 'done' }, state).open, false);
});

// Moved from team.test.js (method C port): the key tag's i18n in all languages.
test('key tag: title and history count translated in every language', () => {
  const src = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'i18n.js'), 'utf8');
  assert.equal((src.match(/'card\.keyTitle'/g) || []).length, 3);
  assert.equal((src.match(/'card\.keyPrev'/g) || []).length, 3);
  assert.match(fs.readFileSync(path.join(WEB, 'select.mjs'), 'utf8'), /params\.set\('key', ui\.keyFilter\.key\)/);
});

test('server: serves the page, i18n.js, every web module and the style sheet with the right MIME; nothing else', async () => {
  const os = require('os');
  const board = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-web-'));
  const srv = await startServer({ env: { DDASH_BOARD_DIR: board, DDASH_ORCA: '0', DDASH_WINDOW: '0' } });
  const { base } = srv;
  try {
    const get = async (u) => { const r = await fetch(base + u); return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() }; };
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.equal(page.body, fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'));
    assert.match((await get('/i18n.js')).type, /^text\/javascript/);
    const css = await get('/web/style.css');
    assert.equal(css.status, 200);
    assert.match(css.type, /^text\/css/);
    for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.mjs'))) {
      const r = await get(`/web/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.type, /^text\/javascript/, f);
      assert.equal(r.body, fs.readFileSync(path.join(WEB, f), 'utf8'), f);
    }
    for (const u of ['/web/index.html', '/web/nope.mjs', '/web/', '/web/../server.js', '/web/%2e%2e%2fserver.js', '/web/..%5cserver.js', '/dashboard.html', '/server.js', '/lib.js', '/web/Main.mjs']) {
      const r = await get(u);
      assert.equal(r.status, 404, u);
      assert.doesNotMatch(r.body, /require\(/, u);
    }
  } finally { await srv.stop(); }
});

// verify-009 F2: each status badge has its own colour, distinct from the others, in light and dark.
test('style: every status badge has its own colour token in light and dark', async () => {
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const { STATUS_KEYS } = await imp('format.mjs');
  const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
  const light = css.slice(0, css.indexOf('prefers-color-scheme: dark'));
  for (const [name, part] of [['light', light], ['dark', dark]]) {
    const colours = STATUS_KEYS.map((k) => {
      const m = part.match(new RegExp(`--${k}: (#[0-9a-f]{6});`));
      assert.ok(m, `${name} --${k}`);
      return m[1];
    });
    assert.equal(new Set(colours).size, STATUS_KEYS.length, `${name}: ${colours}`);
  }
  for (const k of STATUS_KEYS) assert.ok(css.includes(`.s-${k} { color: var(--${k}); }`), k);
});

test('card meta: a session name equal to the project is shown once; same-name sessions get a short id', () => {
  const { cardWho } = M.format;
  const sessions = {
    'aaaaaaaa-1': { project: 'proj', name: 'proj' },
    'bbbbbbbb-2': { project: 'proj', name: 'proj' },
    'cccccccc-3': { project: 'proj', name: 'fix' },
  };
  assert.equal(cardWho('proj', 'proj', 'aaaaaaaa-1', sessions), 'proj · aaaaaaaa');
  assert.equal(cardWho('proj', 'fix', 'cccccccc-3', sessions), 'proj · fix');
  assert.equal(cardWho('proj', 'proj', 'aaaaaaaa-1', { 'aaaaaaaa-1': sessions['aaaaaaaa-1'] }), 'proj');
  const { state, ui } = fixture();
  state.sessions.A.name = 'proj';
  state.cards[0].session_name = 'proj';
  const v = M.main.renderMain(state, ui, t);
  assert.match(v.cards, /<div class="meta">proj · main · /);
  assert.doesNotMatch(v.cards, /proj · proj/);
});

(async () => {
  M = {
    state: await imp('ui-state.mjs'),
    format: await imp('format.mjs'),
    select: await imp('select.mjs'),
    side: await imp('render-side.mjs'),
    main: await imp('render-main.mjs'),
    cards: await imp('render-cards.mjs'),
  };
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n${err.stack}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
