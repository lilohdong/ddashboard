#!/usr/bin/env node
// http/router.js and http/routes/* (refactor step 11). Run: node test/router.test.js
// The route table (every route, same-origin on every POST), the router's error replies ({error, code}), and a slow
// fake orca that must not block GET /api/state while POST /api/team/spawn waits for it.
// Uses a temporary board dir (DDASH_BOARD_DIR); never starts real claude or Orca terminals.
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BOARD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-router-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-router-proj-')); // not a git repo: project key = the path
process.env.DDASH_BOARD_DIR = BOARD;
delete process.env.DDASH_NAME;
process.env.CLAUDE_CONFIG_DIR = BOARD;
process.env.DDASH_WINDOW = '0';
process.env.DDASH_ORCA = '0';

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const { paths } = require(path.join(SCRIPTS, 'core', 'paths.js'));
const { readJson, writeJson } = require(path.join(SCRIPTS, 'core', 'fsx.js'));
const { projectKey } = require(path.join(SCRIPTS, 'app', 'projects.js'));
const { createRouter, fail } = require(path.join(SCRIPTS, 'http', 'router.js'));
const routes = require(path.join(SCRIPTS, 'http', 'routes'));

const KEY = projectKey(CWD);
const slash = (p) => String(p).replace(/\\/g, '/');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Every API route the dashboard uses. A new route must be added here (and so to this test).
const API = [
  'GET /api/settings', 'POST /api/settings', 'GET /api/state', 'GET /api/search', 'POST /api/archive', 'POST /api/mode',
  'POST /api/sessions/forget', 'POST /api/sessions/end', 'POST /api/team/end', 'POST /api/team/spawn', 'POST /api/groups',
  'POST /api/reply',
];
const POSTS = API.filter((r) => r.startsWith('POST ')).map((r) => r.slice(5));
const GETS = API.filter((r) => r.startsWith('GET ')).map((r) => r.slice(4));

function reset() {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  writeJson(paths.projects, { [KEY]: { since: new Date().toISOString(), cwd: CWD, name: 'proj', mode: 'team', mode_ver: 1, teams: { Alpha: { lead: 'L1', worktree: slash(CWD), groups: {} } } } });
  const base = { cwd: CWD, project: 'proj', project_key: KEY, state: 'idle', last_seen: new Date().toISOString() };
  writeJson(paths.sessions, { L1: { ...base, session_id: 'L1', name: 'L1', kind: 'lead' } });
}

// A fake orca: `status` is reachable, `terminal create` waits FAKE_ORCA_DELAY ms (blocking, as the real CLI may).
function slowOrca(delay) {
  const file = path.join(BOARD, 'fake-orca.js');
  fs.writeFileSync(file, `const a = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o));
const cmd = a.slice(0, 2).join(' ');
if (cmd === 'terminal create') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_ORCA_DELAY));
if (a[0] === 'status') out({ ok: true, result: { runtime: { reachable: true } } });
else if (cmd === 'terminal create') out({ ok: true, result: { terminal: { handle: 'term_slow', paneKey: 'p' } } });
else if (cmd === 'terminal show') out({ ok: true, result: { terminal: { handle: a[3], writable: true } } });
else { out({ ok: false }); process.exit(1); }
`);
  return { DDASH_ORCA: '', DDASH_ORCA_BIN: file, FAKE_ORCA_DELAY: String(delay) };
}

async function withServer(env, fn) {
  const port = 7900 + Math.floor(Math.random() * 500);
  const srv = spawn(process.execPath, [path.join(SCRIPTS, 'server.js')], { env: { ...process.env, ...env, DDASH_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/api/state`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const post = async (url, body, headers = {}) => {
      const res = await fetch(base + url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await fn(post, base);
  } finally { srv.kill(); }
}

// An in-process server over a given route table.
async function withRoutes(table, fn) {
  const srv = http.createServer(createRouter(table));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('table: every API route is in the table once; every POST checks the origin and reads a JSON body', () => {
  const named = routes.filter((r) => typeof r.path === 'string').map((r) => `${r.method} ${r.path}`);
  assert.deepEqual([...named].sort(), [...API].sort());
  for (const r of routes) {
    assert.ok(['GET', 'POST'].includes(r.method), `${r.method} ${r.path}`);
    assert.equal(typeof r.handler, 'function');
    if (r.method === 'POST') {
      assert.equal(r.sameOrigin, true, `POST ${r.path} must check the origin`);
      assert.equal(r.body, true, `POST ${r.path} reads a body`);
    } else assert.equal(r.body, false);
  }
  // The only non-string path is the static whitelist (GET).
  const dyn = routes.filter((r) => typeof r.path !== 'string');
  assert.equal(dyn.length, 1);
  assert.equal(dyn[0].method, 'GET');
  assert.ok(dyn[0].path('/web/main.mjs'));
  assert.equal(dyn[0].path('/web/../lib.js'), null);
});

test('server: every POST route refuses another origin (403 forbidden) before reading its body', async () => {
  reset();
  const before = fs.readFileSync(paths.sessions, 'utf8');
  await withServer({}, async (post, base) => {
    for (const url of POSTS) {
      const r = await post(url, { session_id: 'L1', lead: 'L1', role: 'qa', task: 'x', project: KEY, mode: 'solo', text: 'hi', lang: 'ko' }, { Origin: 'http://evil.example' });
      assert.equal(r.status, 403, url);
      assert.deepEqual(r.body, { error: 'forbidden', code: 'forbidden' }, url);
    }
    for (const url of GETS) assert.equal((await fetch(base + url)).status, 200, url);
    // Same-origin requests pass the check (and reach the handler: a bad body is the handler's 400, not 403).
    for (const url of POSTS) {
      const r = await post(url, 'not json', { Origin: base });
      assert.equal(r.status, 400, url);
      assert.equal(r.body.code, 'bad_json', url);
    }
  });
  assert.equal(fs.readFileSync(paths.sessions, 'utf8'), before); // nothing was written
});

test('server: errors are {error, code}; unknown paths 404; a body over 64 KB is refused', async () => {
  reset();
  await withServer({}, async (post, base) => {
    const nf = await fetch(`${base}/api/nope`);
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: 'not found', code: 'not_found' });
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST', body: '{}' })).status, 404); // GET-only path
    assert.equal((await fetch(`${base}/web/../lib.js`)).status, 404);
    assert.deepEqual((await post('/api/reply', { session_id: 'nobody', text: 'x' })).body, { error: 'unknown session', code: 'unknown_session' });
    assert.deepEqual((await post('/api/reply', { session_id: 'L1', text: ' ' })).body, { error: 'empty', code: 'empty' });
    assert.deepEqual((await post('/api/mode', { project: 'nope', mode: 'solo' })).body, { error: 'unknown project', code: 'unknown_project' });
    assert.deepEqual((await post('/api/team/end', { session_id: 'L1' })).body, { error: 'not a team member', code: 'not_member' });
    assert.equal((await post('/api/sessions/end', { session_id: 'nobody' })).body.code, 'unknown_session'); // through the job worker
    assert.equal((await post('/api/archive', { card_id: 'x', archived: 1 })).body.code, 'bad_request');
    for (const url of POSTS) { // an array body (verify-011 F3) never reaches a handler
      const r = await post(url, '[1]');
      assert.equal(r.status, 400, url);
      assert.equal(r.body.code, 'bad_json', url);
    }
    const big = await post('/api/reply', JSON.stringify({ session_id: 'L1', text: 'x'.repeat(70 * 1024) }));
    assert.equal(big.status, 413);
    assert.equal(big.body.code, 'too_large');
    // The server still answers after the refused body.
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  });
});

test('router: fail() sets status and code; an unexpected throw is 500 internal; async handlers are awaited', async () => {
  const table = [
    { method: 'GET', path: '/a', sameOrigin: false, body: false, handler: () => { throw fail(409, 'busy', 'session_active'); } },
    { method: 'GET', path: '/b', sameOrigin: false, body: false, handler: () => { throw new Error('boom'); } },
    { method: 'GET', path: '/c', sameOrigin: false, body: false, handler: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: 1 }; } },
    { method: 'POST', path: '/d', sameOrigin: true, body: true, handler: ({ body }) => body },
  ];
  await withRoutes(table, async (base) => {
    let r = await fetch(`${base}/a`);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'busy', code: 'session_active' });
    r = await fetch(`${base}/b`);
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'boom', code: 'internal' });
    assert.deepEqual(await (await fetch(`${base}/c`)).json(), { ok: 1 });
    r = await fetch(`${base}/d`, { method: 'POST', headers: { Origin: 'http://localhost:1' }, body: '{"x":1}' });
    assert.deepEqual(await r.json(), { x: 1 });
    // verify-011 F3: valid JSON that is not an object is 400 bad_json before the handler runs.
    for (const body of ['[1]', '[]', '[{"x":1}]', 'null', '1', '"x"', 'true']) {
      r = await fetch(`${base}/d`, { method: 'POST', body });
      assert.equal(r.status, 400, body);
      assert.deepEqual(await r.json(), { error: 'body must be a JSON object', code: 'bad_json' }, body);
    }
  });
});

// verify-011 F1: no Origin header is accepted on purpose (CLI and hooks send none; browsers always send one).
test('router: a POST without an Origin header is accepted; a foreign or "null" Origin is 403', async () => {
  const table = [{ method: 'POST', path: '/p', sameOrigin: true, body: true, handler: () => ({ ok: true }) }];
  await withRoutes(table, async (base) => {
    const post = (headers) => new Promise((resolve, reject) => {
      // http.request, not fetch: it adds no headers of its own, so "no Origin" is certain.
      const req = http.request(`${base}/p`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.deepEqual(await post({}), { status: 200, body: { ok: true } });
    for (const origin of ['http://127.0.0.1:7357', 'http://localhost', 'http://localhost:7357']) assert.equal((await post({ Origin: origin })).status, 200, origin);
    for (const origin of ['http://evil.example', 'null', 'https://127.0.0.1:7357', 'http://127.0.0.1.evil.example', 'file://']) {
      assert.deepEqual(await post({ Origin: origin }), { status: 403, body: { error: 'forbidden', code: 'forbidden' } }, origin);
    }
  });
});

// verify-011 F2: POST /api/settings is a patch; an empty body or no known key is 400 and keeps lang.
test('server: POST /api/settings with {} or no known key is 400 bad_request and keeps the language', async () => {
  reset();
  writeJson(paths.settings, { lang: 'ko', ver: 5 });
  await withServer({}, async (post, base) => {
    for (const body of [{}, { foo: 1 }, { langg: 'en' }]) {
      const r = await post('/api/settings', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'bad_request', JSON.stringify(body));
      assert.equal(typeof r.body.error, 'string');
    }
    assert.deepEqual(readJson(paths.settings, {}), { lang: 'ko', ver: 5 }, 'nothing changed');
    assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), { lang: 'ko' });
    // A project body changes only the runner it carries, never the language.
    let r = await post('/api/settings', { project: KEY, runner_member: 'window' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await post('/api/settings', { project: KEY });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad_request');
    assert.equal(readJson(paths.settings, {}).lang, 'ko');
    // The given key changes; null clears it (as the dashboard's language picker may send).
    assert.deepEqual((await post('/api/settings', { lang: 'en' })).body, { ok: true, lang: 'en' });
    assert.deepEqual(readJson(paths.settings, {}), { lang: 'en', ver: 6 });
    assert.equal((await post('/api/settings', { lang: 'xx' })).body.code, 'bad_lang');
    assert.deepEqual((await post('/api/settings', { lang: null })).body, { ok: true, lang: null });
    assert.equal(readJson(paths.settings, {}).lang, undefined);
  });
});

test('server: a slow orca does not block /api/state while /api/team/spawn waits for it', async () => {
  reset();
  const DELAY = 2500;
  await withServer(slowOrca(DELAY), async (post, base) => {
    let pending = true;
    const t0 = Date.now();
    const spawned = post('/api/team/spawn', { lead: 'L1', role: 'fe', task: 'build', runner: 'orca' }).finally(() => { pending = false; });
    await new Promise((r) => setTimeout(r, 300)); // the spawn is inside orca terminal create by now
    let during = 0;
    while (pending && Date.now() - t0 < DELAY - 300) {
      const s0 = Date.now();
      const st = await fetch(`${base}/api/state`);
      assert.equal(st.status, 200);
      await st.json();
      const ms = Date.now() - s0;
      assert.ok(ms < 800, `/api/state took ${ms} ms during a spawn`);
      if (pending) during++;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(during >= 3, `only ${during} /api/state answers while the spawn was pending`);
    const r = await spawned;
    assert.ok(Date.now() - t0 >= DELAY - 100, 'the spawn waited for orca');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.runner, 'orca');
    assert.equal(readJson(paths.sessions, {})[r.body.session_id].orca.handle, 'term_slow');
    // The lead was told (as before the router).
    const inbox = fs.readdirSync(paths.inbox('L1')).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(paths.inbox('L1'), f), {}));
    assert.ok(inbox.some((m) => m.type === 'report' && m.from === r.body.session_id && /spawned by the user: build/.test(m.title)));
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  try { fs.rmSync(BOARD, { recursive: true, force: true }); fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  process.exitCode = failed ? 1 : 0;
})();
