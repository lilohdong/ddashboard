#!/usr/bin/env node
// domain/session (refactor step 4): table-driven transitions, illegal events, view() parity with the old
// server / `team list` formulas, and app/lifecycle on a real board. Run: node test/session.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ddash-session-'));
process.env.DDASH_BOARD_DIR = path.join(TMP, 'board');

const { transition, view, phase, isEnded } = require('../plugin/scripts/domain/session');
const lifecycle = require('../plugin/scripts/app/lifecycle');
const sessions = require('../plugin/scripts/store/sessions');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const TS = '2026-11-26T10:00:00.000Z';
const OLD = '2026-11-20T10:00:00.000Z';

const rec = (fields = {}) => ({ session_id: 'S', state: 'idle', started: OLD, last_seen: OLD, ...fields });
const ENDED = (reason, more = {}) => rec({ state: 'ended', ended: OLD, end_reason: reason, ...more });

// [name, record, event, ctx, expected: { ok, phase?, fields?, effects?, code? }]
const TABLE = [
  ['spawn creates a pending record', undefined, 'spawn', { fields: { session_id: 'S', kind: 'member' } },
    { ok: true, phase: 'pending', fields: { state: 'working', pending: true, started: TS, last_seen: TS, kind: 'member' } }],
  ['spawn over an existing record is refused', rec(), 'spawn', {}, { ok: false, code: 409 }],
  ['register: idle stays idle', rec(), 'register', {}, { ok: true, phase: 'idle', fields: { last_seen: TS } }],
  ['register: working stays working', rec({ state: 'working' }), 'register', {}, { ok: true, phase: 'working' }],
  ['register: pending (state working) stays pending', rec({ state: 'working', pending: true }), 'register', {}, { ok: true, phase: 'pending' }],
  ['register revives an ended session (resume)', ENDED('exit'), 'register', {},
    { ok: true, phase: 'idle', fields: { ended: undefined, end_reason: undefined } }],
  ['register keeps a handed-off lead ended', ENDED('handoff', { replaced_by: 'N' }), 'register', {},
    { ok: true, phase: 'ended', fields: { state: 'ended', ended: OLD, end_reason: 'handoff' } }],
  ['prompt: idle -> working', rec(), 'prompt', {}, { ok: true, phase: 'working', fields: { last_seen: TS } }],
  ['prompt: pending -> working (still pending until setMember)', rec({ state: 'working', pending: true }), 'prompt', {}, { ok: true }],
  ['prompt on ended is ignored', ENDED('stopped'), 'prompt', {}, { ok: false, code: 409 }],
  ['prompt on a handed-off lead is ignored', ENDED('handoff', { replaced_by: 'N' }), 'prompt', {}, { ok: false }],
  ['stop: working -> idle', rec({ state: 'working' }), 'stop', {}, { ok: true, phase: 'idle' }],
  ['stop busy: stays working', rec({ state: 'working' }), 'stop', { busy: true }, { ok: true, phase: 'working' }],
  ['stop on ended keeps it ended', ENDED('stopped'), 'stop', {}, { ok: false }],
  ['resume: ended(stopped) -> working', ENDED('stopped'), 'resume', {}, { ok: true, phase: 'working', fields: { ended: undefined, end_reason: undefined } }],
  ['resume: finished headless (idle) -> working', rec({ headless: true, pid: 5 }), 'resume', { fields: { pid: 6 } }, { ok: true, phase: 'working', fields: { pid: 6 } }],
  ['resume of a handed-off lead is refused', ENDED('handoff', { replaced_by: 'N' }), 'resume', {}, { ok: false, code: 409 }],
  ['end exit', rec({ state: 'working' }), 'end', { reason: 'exit' },
    { ok: true, phase: 'ended', fields: { ended: TS, end_reason: 'exit', last_seen: TS }, effects: [{ type: 'stop', sid: 'S', reason: 'exit' }] }],
  ['end gone leaves last_seen', rec(), 'end', { reason: 'gone', seen: false }, { ok: true, phase: 'ended', fields: { end_reason: 'gone', last_seen: OLD } }],
  ['end stopped', rec({ state: 'working' }), 'end', { reason: 'stopped' }, { ok: true, fields: { end_reason: 'stopped' } }],
  ['end on ended is ignored (first reason kept)', ENDED('gone'), 'end', { reason: 'exit' }, { ok: false, code: 409 }],
  ['end with an unknown reason', rec(), 'end', { reason: 'nap' }, { ok: false, code: 400 }],
  ['mark ended: idle, stale, not waiting', rec(), 'end', { reason: 'marked', stale: true }, { ok: true, fields: { end_reason: 'marked' } }],
  ['mark ended: refused while working', rec({ state: 'working' }), 'end', { reason: 'marked', stale: true }, { ok: false, code: 409 }],
  ['mark ended: refused while waiting', rec(), 'end', { reason: 'marked', stale: true, waiting: true }, { ok: false, code: 409 }],
  ['mark ended: refused when seen recently', rec(), 'end', { reason: 'marked', stale: false }, { ok: false, code: 409 }],
  ['mark ended: gone wins over working, reason gone', rec({ state: 'working' }), 'end', { reason: 'marked', gone: true }, { ok: true, fields: { end_reason: 'gone' } }],
  ['handoff ends a live lead', rec({ state: 'working' }), 'end', { reason: 'handoff', replaced_by: 'N' },
    { ok: true, phase: 'ended', fields: { end_reason: 'handoff', replaced_by: 'N' } }],
  ['handoff takes over a dead (gone) lead', ENDED('gone'), 'end', { reason: 'handoff', replaced_by: 'N' },
    { ok: true, fields: { end_reason: 'handoff', replaced_by: 'N', ended: TS } }],
  ['a second handoff of the same lead is refused', ENDED('handoff', { replaced_by: 'N' }), 'end', { reason: 'handoff', replaced_by: 'M' }, { ok: false }],
  ['forget an ended session', ENDED('exit'), 'forget', {}, { ok: true, effects: [{ type: 'prune', sid: 'S' }] }],
  ['forget a live session is refused', rec(), 'forget', {}, { ok: false, code: 409 }],
  ['an unknown session', undefined, 'prompt', {}, { ok: false, code: 404 }],
  ['an unknown event', rec(), 'nap', {}, { ok: false, code: 400 }],
  ['fields ride along, lifecycle fields in them are ignored', rec(), 'prompt', { fields: { pid: 9, state: 'idle', ended: TS } },
    { ok: true, phase: 'working', fields: { pid: 9, state: 'working', ended: undefined } }],
];

for (const [name, s, event, ctx, exp] of TABLE) {
  test(`transition: ${name}`, () => {
    const before = s && JSON.stringify(s);
    const r = transition(s, event, { ts: TS, ...ctx });
    assert.equal(r.ok, exp.ok, r.error);
    if (s) assert.equal(JSON.stringify(s), before, 'the input record is not changed');
    if (!exp.ok) {
      assert.deepEqual(r.patch, {});
      assert.deepEqual(r.effects, []);
      if (exp.code) assert.equal(r.code, exp.code);
      return;
    }
    if (exp.phase) assert.equal(phase(r.s), exp.phase);
    for (const [k, v] of Object.entries(exp.fields || {})) assert.deepEqual(r.s?.[k], v, k);
    if (exp.effects) assert.deepEqual(r.effects, exp.effects);
    else if (event === 'end') assert.deepEqual(r.effects, [{ type: 'stop', sid: 'S', reason: r.s.end_reason }], 'entering ended stops the session');
    else assert.deepEqual(r.effects, []);
  });
}

// The formulas server.js and team.js used before step 4.
const oldServerView = (s, waiting) => (s.ended || s.state === 'ended' ? 'ended' : s.state === 'working' ? 'working' : waiting ? 'waiting' : 'idle');
const oldListState = (s, waiting, pidAlive) => (isEnded(s) ? 'ended' : s.headless && s.pid && !pidAlive && !waiting ? 'finished' : s.state || 'idle');

test('view(): parity with the old dashboard view and team list state', () => {
  const records = [
    rec(), rec({ state: 'working' }), rec({ state: 'working', pending: true }), ENDED('exit'), rec({ state: 'ended' }),
    rec({ ended: OLD }), rec({ state: undefined }), rec({ headless: true, pid: 7 }), rec({ headless: true, pid: 7, state: 'working' }),
    rec({ headless: true }), ENDED('stopped', { headless: true, pid: 7 }),
  ];
  let n = 0;
  for (const s of records) {
    for (const waiting of [false, true]) {
      for (const stale of [false, true]) {
        for (const pidAlive of [false, true]) {
          const v = view(s, { waiting, stale, pidAlive });
          assert.equal(v.view, oldServerView(s, waiting), JSON.stringify(s));
          assert.equal(v.unresponsive, v.view === 'idle' && stale);
          assert.equal(v.state, oldListState(s, waiting, pidAlive), JSON.stringify(s));
          n++;
        }
      }
    }
  }
  assert.equal(n, records.length * 8);
});

test('lifecycle.apply: writes through the store, refusals write nothing', () => {
  fs.rmSync(process.env.DDASH_BOARD_DIR, { recursive: true, force: true });
  assert.equal(lifecycle.apply('A', 'spawn', { fields: { session_id: 'A', role: 'dev' } }).ok, true);
  assert.equal(sessions.get('A').pending, true);
  assert.equal(lifecycle.apply('A', 'end', { reason: 'stopped' }).ok, true);
  const mtime = fs.statSync(sessions.file).mtimeMs;
  const r = lifecycle.apply('A', 'prompt');
  assert.equal(r.ok, false);
  assert.equal(fs.statSync(sessions.file).mtimeMs, mtime);
  assert.equal(sessions.get('A').end_reason, 'stopped');
  assert.equal(lifecycle.apply('A', 'resume', { fields: { pid: 3 } }).ok, true);
  assert.deepEqual([sessions.get('A').state, sessions.get('A').ended, sessions.get('A').pid], ['working', undefined, 3]);
  assert.equal(lifecycle.apply('A', 'forget').ok, false);
  lifecycle.apply('A', 'end', {});
  assert.equal(lifecycle.apply('A', 'forget').ok, true);
  assert.equal(sessions.get('A'), undefined);
});

test('every state write in scripts/ goes through domain/session (no direct state/ended/end_reason assignment)', () => {
  const SCRIPTS = path.join(__dirname, '..', 'plugin', 'scripts');
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'web') walk(p); continue; }
      if (!e.name.endsWith('.js') || p.endsWith(path.join('domain', 'session.js'))) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        if (/\bstate:\s*'(ended|working|idle|pending)'|\.state\s*=[^=]|\bend_reason:\s*'|\bend_reason\s*=[^=]/.test(line)) bad.push(`${path.relative(SCRIPTS, p)}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(SCRIPTS);
  // Display copies in team.js (cmdList / cmdSend after markGone) are not writes.
  const allowed = [/^team\.js:.*Object\.assign\(s, \{ state: 'ended'/, /^team\.js:.*m\.state = 'ended'/];
  assert.deepEqual(bad.filter((b) => !allowed.some((a) => a.test(b.replace(/\\/g, '/')))), []);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
})();
