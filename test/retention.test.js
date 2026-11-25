#!/usr/bin/env node
// store/retention.js (refactor step 13): done messages, logs (age and size cap), stray replies.jsonl lines,
// archive entries of missing cards. Run: node test/retention.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-retain-'));
const BOARD = path.join(TMP, 'board');
process.env.DDASH_BOARD_DIR = BOARD;

const { paths } = require('../scripts/core/paths');
const { writeJson, readJson, readJsonl } = require('../scripts/core/fsx');
const retention = require('../scripts/store/retention');
const migrate = require('../scripts/store/migrate');

const DAY = retention.DAY_MS;
const NOW = Date.now();
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const reset = () => {
  fs.rmSync(BOARD, { recursive: true, force: true });
  fs.mkdirSync(BOARD, { recursive: true });
  migrate.reset();
  for (const k of ['DDASH_RETAIN_DONE_DAYS', 'DDASH_RETAIN_LOG_DAYS', 'DDASH_RETAIN_LOG_MB']) delete process.env[k];
};
function file(f, text, ageDays = 0) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(f, t, t);
  return f;
}

test('retention: done/ messages older than 7 days go, newer ones and pending ones stay; an emptied done/ goes', () => {
  reset();
  const old = file(path.join(paths.done('A'), 'm1.json'), '{}', 8);
  const fresh = file(path.join(paths.done('A'), 'm2.json'), '{}', 1);
  const pending = file(path.join(paths.inbox('A'), 'm3.json'), '{}', 30);
  file(path.join(paths.done('B'), 'm4.json'), '{}', 9);
  assert.equal(retention.run(NOW).done, 2);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(pending), 'pending messages are never pruned');
  assert.equal(fs.existsSync(paths.done('B')), false);
  process.env.DDASH_RETAIN_DONE_DAYS = '0.5';
  assert.equal(retention.run(NOW).done, 1);
});

test('retention: logs older than 30 days go, then the oldest until under the cap; ddashboard.log stays', () => {
  reset();
  const app = file(paths.appLog, 'x'.repeat(10), 40);
  const old = file(paths.log('S1'), 'x', 31);
  const a = file(paths.log('S2'), 'x'.repeat(600 * 1024), 3);
  const b = file(paths.log('S3'), 'x'.repeat(600 * 1024), 2);
  assert.equal(retention.run(NOW).logs, 1);
  assert.ok(fs.existsSync(app) && fs.existsSync(a) && fs.existsSync(b));
  assert.equal(fs.existsSync(old), false);
  process.env.DDASH_RETAIN_LOG_MB = '1';
  assert.equal(retention.run(NOW).logs, 1);
  assert.equal(fs.existsSync(a), false, 'the oldest goes first');
  assert.ok(fs.existsSync(b) && fs.existsSync(app));
});

test('retention: stray replies.jsonl lines are folded into the monthly files once', () => {
  reset();
  migrate.run();
  fs.writeFileSync(paths.replies, JSON.stringify({ id: 'r1', ts: '2026-10-01T00:00:00.000Z', text: 'x' }) + '\n');
  assert.equal(retention.run(NOW).replies, 1);
  assert.equal(retention.run(NOW).replies, 0);
  assert.deepEqual(readJsonl(paths.repliesFor('2026-10')).map((r) => r.id), ['r1']);
});

test('retention: archive entries of cards in no card file go; with no readable card nothing goes', () => {
  reset();
  writeJson(paths.archived, { c1: { archived: true, ts: 'x' }, gone: { archived: false, ts: 'y' } });
  assert.equal(retention.run(NOW).archived, 0, 'no card file: keep everything');
  fs.mkdirSync(paths.cardsDir, { recursive: true });
  fs.writeFileSync(paths.cardsFor('2026-11'), JSON.stringify({ id: 'c1', ts: '2026-11-01T00:00:00.000Z' }) + '\n');
  assert.equal(retention.run(NOW).archived, 1);
  assert.deepEqual(Object.keys(readJson(paths.archived, {})), ['c1']);
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
