#!/usr/bin/env node
// core/* tests (refactor step 1). Run: node test/core.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-core-'));
process.env.DDASH_BOARD_DIR = path.join(TMP, 'board');

const config = require('../plugin/scripts/core/config');
const fsx = require('../plugin/scripts/core/fsx');
const { git, gitOrNull } = require('../plugin/scripts/core/git');
const { newId } = require('../plugin/scripts/core/ids');
const { log, bestEffort } = require('../plugin/scripts/core/log');
const { paths, BOARD_DIR, safeId } = require('../plugin/scripts/core/paths');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Every source file of the plugin, for the config coverage check.
function sources(dir = path.join(ROOT, 'plugin', 'scripts')) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}
const NOT_ENV = new Set(['DDASH_I18N']); // the page global set by i18n.js

test('config: the table covers every DDASH_* name used in the code', () => {
  const known = new Set(config.TABLE.map((e) => e.name));
  const missing = [];
  for (const f of sources()) {
    for (const name of fs.readFileSync(f, 'utf8').match(/DDASH_[A-Z0-9_]+/g) || []) {
      if (!known.has(name) && !NOT_ENV.has(name)) missing.push(`${name} (${path.relative(ROOT, f)})`);
    }
  }
  assert.deepEqual(missing, []);
});

test('config: only core/config reads process.env.DDASH_*', () => {
  const own = path.join(ROOT, 'plugin', 'scripts', 'core', 'config.js');
  const readers = sources().filter((f) => f !== own && /process\.env\.DDASH_|process\.env\[['"]DDASH_/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(readers.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')), []);
});

test('config: docs/configuration.md is generated from the table', () => {
  const file = path.join(ROOT, 'docs', 'configuration.md');
  assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), config.doc());
});

test('config: parsers (lazy reads, defaults, 0 handling, switches, ~ paths)', () => {
  const set = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  const saved = ['DDASH_STALE_MIN', 'DDASH_LEAD_CONTEXT_LIMIT', 'DDASH_ORCA', 'DDASH_CLAUDE_BIN'].map((k) => [k, process.env[k]]);
  try {
    set('DDASH_STALE_MIN', undefined); assert.equal(config.get('DDASH_STALE_MIN'), 60);
    set('DDASH_STALE_MIN', '5'); assert.equal(config.get('DDASH_STALE_MIN'), 5);
    set('DDASH_STALE_MIN', '0'); assert.equal(config.get('DDASH_STALE_MIN'), 60, 'pos: 0 means the default');
    set('DDASH_STALE_MIN', 'x'); assert.equal(config.get('DDASH_STALE_MIN'), 60);
    set('DDASH_LEAD_CONTEXT_LIMIT', '0'); assert.equal(config.get('DDASH_LEAD_CONTEXT_LIMIT'), 0, 'num: 0 is a value');
    set('DDASH_LEAD_CONTEXT_LIMIT', ' '); assert.equal(config.get('DDASH_LEAD_CONTEXT_LIMIT'), 0);
    set('DDASH_LEAD_CONTEXT_LIMIT', '-3'); assert.equal(config.get('DDASH_LEAD_CONTEXT_LIMIT'), 0);
    set('DDASH_ORCA', undefined); assert.equal(config.get('DDASH_ORCA'), true);
    for (const v of ['0', 'false', 'OFF', 'no']) { set('DDASH_ORCA', v); assert.equal(config.get('DDASH_ORCA'), false, v); }
    set('DDASH_ORCA', '1'); assert.equal(config.get('DDASH_ORCA'), true);
    set('DDASH_CLAUDE_BIN', ''); assert.equal(config.get('DDASH_CLAUDE_BIN'), 'claude');
    assert.equal(config.isSet('DDASH_BOARD_DIR'), true);
    assert.throws(() => config.get('DDASH_NOPE'), /unknown setting/);
    assert.equal(config.envNum('DDASH_ANY_OTHER', 7), 7);
  } finally { for (const [k, v] of saved) set(k, v); }
  const p = config.TABLE.find((e) => e.name === 'DDASH_BOARD_DIR');
  const saved2 = process.env.DDASH_BOARD_DIR;
  process.env.DDASH_BOARD_DIR = '~/x';
  try { assert.equal(config.get('DDASH_BOARD_DIR'), `${os.homedir()}/x`); } finally { process.env.DDASH_BOARD_DIR = saved2; }
  assert.ok(p);
});

test('paths: board paths follow DDASH_BOARD_DIR read at load; safeId strips path characters', () => {
  assert.equal(BOARD_DIR, path.join(TMP, 'board'));
  assert.equal(paths.sessions, path.join(TMP, 'board', 'sessions.json'));
  assert.equal(paths.cardsFor('2026-11-26T00:00:00Z'), path.join(TMP, 'board', 'cards', '2026-11.jsonl'));
  assert.equal(safeId('../a b/c'), 'abc');
  assert.equal(safeId(''), 'unknown');
});

test('fsx: atomicWrite retries a rename that fails with EPERM/EBUSY, then succeeds', () => {
  const file = path.join(TMP, 'retry.json');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (a, b) => {
    calls++;
    if (calls <= 3) { const e = new Error('busy'); e.code = calls === 2 ? 'EBUSY' : 'EPERM'; throw e; }
    return real(a, b);
  };
  try { fsx.writeJson(file, { a: 1 }); } finally { fs.renameSync = real; }
  assert.equal(calls, 4);
  assert.deepEqual(fsx.readJson(file), { a: 1 });
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp')), []);
});

test('fsx: atomicWrite gives up after 10 tries, removes its tmp file, keeps the old content', () => {
  const file = path.join(TMP, 'stuck.json');
  fsx.writeJson(file, { old: true });
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls++; const e = new Error('locked'); e.code = 'EACCES'; throw e; };
  try { assert.throws(() => fsx.writeJson(file, { new: true }), /locked/); } finally { fs.renameSync = real; }
  assert.equal(calls, 10);
  assert.deepEqual(fsx.readJson(file), { old: true });
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp')), []);
});

test('fsx: other rename errors are not retried', () => {
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls++; const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  try { assert.throws(() => fsx.writeJson(path.join(TMP, 'x.json'), {})); } finally { fs.renameSync = real; }
  assert.equal(calls, 1);
});

test('fsx: jsonl append/read (malformed lines skipped, limit), readTail', () => {
  const file = path.join(TMP, 'a', 'b.jsonl');
  fsx.appendJsonl(file, { n: 1 });
  fs.appendFileSync(file, '{bad\n');
  fsx.appendJsonl(file, { n: 2 });
  assert.deepEqual(fsx.readJsonl(file), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(fsx.readJsonl(file, 1), [{ n: 2 }]);
  assert.deepEqual(fsx.readJsonl(path.join(TMP, 'none.jsonl')), []);
  assert.equal(fsx.readTail(file, 9).toString(), '{"n":2}\n'.slice(-9).padStart(9, '\n'));
  assert.equal(fsx.readTail(path.join(TMP, 'none'), 10), null);
  assert.equal(fsx.readJson(path.join(TMP, 'none.json'), 'fb'), 'fb');
});

test('git: string or array args; failure is "" (git) or null (gitOrNull)', () => {
  assert.match(git('rev-parse --is-inside-work-tree', ROOT), /^true$/);
  assert.match(git(['rev-parse', '--is-inside-work-tree'], ROOT), /^true$/);
  assert.equal(git('rev-parse --show-toplevel', TMP), '');
  assert.equal(gitOrNull('no-such-command-xyz', ROOT), null);
});

test('ids: newId is unique and time-ordered in shape', () => {
  const ids = new Set(Array.from({ length: 200 }, newId));
  assert.equal(ids.size, 200);
  assert.match(newId(), /^\d{13}-[a-z0-9]{1,5}$/);
});

test('log: appends one line per entry with label and stack; bestEffort logs and returns the fallback', () => {
  log('test', 'hello\nworld');
  const r = bestEffort('optional', () => { throw new Error('boom'); }, 42);
  assert.equal(r, 42);
  assert.equal(bestEffort('fine', () => 7), 7);
  const text = fs.readFileSync(paths.appLog, 'utf8');
  assert.match(text, /\] test: hello\n {4}world\n/);
  assert.match(text, /optional: Error: boom/);
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
