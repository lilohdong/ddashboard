#!/usr/bin/env node
// domain/rules: injected texts and version stamping (refactor step 7). Run: node test/rules.test.js
// The snapshot hash below covers every rules text a session is given. When it fails because you changed a text
// on purpose: bump RULES_TEXT_VER in scripts/domain/rules.js (running sessions then get the new text once) and
// put the new hash and version here.
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.DDASH_HANDOFF_MAX_TOKENS = '8000'; // fixed for the snapshot
const rules = require('../scripts/domain/rules');

const SNAPSHOT = { ver: 2, hash: 'b8a7430f4e2ce5b9' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const C = { url: 'http://127.0.0.1:7357', waitBin: '/b/wait.js', teamBin: '/b/team.js' };
function allRulesTexts() {
  const out = [];
  for (const lang of [undefined, 'en', 'ko', 'zh-CN']) {
    const c = { ...C, lang };
    out.push(rules.rulesFor('S', {}, { role: 'solo' }, c));
    out.push(rules.rulesFor('L', {}, { role: 'lead', team: 'Alpha' }, c));
    out.push(rules.rulesFor('L', {}, { role: 'lead' }, c));
    out.push(rules.rulesFor('O', {}, { role: 'outside', teams: ['Beta', 'Alpha'] }, c));
    for (const stay of [false, true]) {
      out.push(rules.rulesFor('M', { role: 'qa', stay }, { role: 'member' }, c));
      out.push(rules.rulesFor('M', { role: 'qa', group: 'front', stay }, { role: 'member', group: { dir: '/w/docs/teams/Alpha/front' } }, c));
    }
  }
  return out;
}
const hashOf = (texts) => crypto.createHash('sha256').update(texts.join('\n\u0000\n')).digest('hex').slice(0, 16);

test('rules text snapshot: a changed text needs a RULES_TEXT_VER bump', () => {
  const hash = hashOf(allRulesTexts());
  if (SNAPSHOT.ver === rules.RULES_TEXT_VER) {
    assert.equal(hash, SNAPSHOT.hash, `rules texts changed (hash ${hash}): bump RULES_TEXT_VER in scripts/domain/rules.js, then set SNAPSHOT to { ver: <new>, hash: '${hash}' } in test/rules.test.js`);
  } else {
    assert.fail(`RULES_TEXT_VER is ${rules.RULES_TEXT_VER}: set SNAPSHOT to { ver: ${rules.RULES_TEXT_VER}, hash: '${hash}' } in test/rules.test.js`);
  }
});

test('texts: roles, paths, card language', () => {
  const c = { ...C, lang: 'ko' };
  assert.match(rules.soloText('S', c), /dashboard \(http:\/\/127\.0\.0\.1:7357\)\. Session ID: S/);
  assert.match(rules.soloText('S', c), /node "\/b\/wait\.js" S/);
  assert.match(rules.soloText('S', c), /written in Korean\)/);
  assert.match(rules.soloText('S', C), /written in the user's language\)/);
  assert.match(rules.leadText('L', 'Alpha', C), /lead of team "Alpha".*\n.*T = node "\/b\/team\.js" L/);
  assert.match(rules.leadText('L', 'Alpha', C), /under 8000 tokens/);
  assert.match(rules.outsideText('O', ['b', 'a'], C), /teams: a, b\)/);
  assert.doesNotMatch(rules.memberText('M', { role: 'qa' }, null, C), /written in/);
  assert.match(rules.memberText('M', { role: 'qa' }, null, c), /short summary lines, written in Korean\)/);
  assert.match(rules.memberText('M', { role: 'qa', stay: true }, null, C), /node "\/b\/wait\.js" M/);
});

test('texts: the command paths are read only by the texts that use them', () => {
  let reads = 0;
  const c = { url: C.url, get waitBin() { reads++; return '/w'; }, get teamBin() { throw new Error('team bin read'); } };
  rules.soloText('S', c);
  rules.memberText('M', { stay: true }, null, c);
  assert.equal(reads, 2);
});

test('stamp / needsUpdate: mode first, then language, then text version', () => {
  const v = { mode: 3, lang: 2 };
  const s = rules.stamp(v);
  assert.deepEqual(s, { rules_ver: 3, lang_ver: 2, text_ver: rules.RULES_TEXT_VER });
  assert.equal(rules.needsUpdate(s, v), '');
  assert.equal(rules.needsUpdate({ ...s, rules_ver: 1, lang_ver: 0 }, v), 'mode');
  assert.equal(rules.needsUpdate({ ...s, lang_ver: 0, text_ver: 0 }, v), 'lang');
  assert.equal(rules.needsUpdate({ ...s, text_ver: 0 }, v), 'text');
  assert.equal(rules.needsUpdate({}, {}), rules.RULES_TEXT_VER ? 'text' : '');
  assert.equal(rules.needsUpdate(null, v), '');
  assert.match(rules.updateText('mode', { mode: 'team' }, 'R'), /^\[ddashboard\] The project's dashboard mode changed \(now team\)\. Updated instructions:\nR$/);
  assert.match(rules.updateText('lang', { lang: 'zh-CN' }, 'R'), /card language changed \(now Simplified Chinese\)/);
  assert.match(rules.updateText('text', {}, 'R'), /instructions were updated/);
});

test('rules texts and version stamping live only in domain/rules.js', () => {
  const SCRIPTS = path.join(__dirname, '..', 'scripts');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(SCRIPTS).filter((x) => /\.(c|m)?js$/.test(x) && !x.endsWith(path.join('domain', 'rules.js')))) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SCRIPTS, f);
    assert.doesNotMatch(src, /\btext_ver\s*[:=]/, `${rel} writes text_ver`);
    assert.doesNotMatch(src, /\b(rules_ver|lang_ver)\s*[:=]/, `${rel} writes rules_ver/lang_ver`);
    assert.doesNotMatch(src, /The user follows your progress on a dashboard|You are a team member\. Role/, `${rel} holds a rules text`);
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
