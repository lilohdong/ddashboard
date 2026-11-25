#!/usr/bin/env node
// Layer rules of docs/architecture.md §3.2, checked from the require() calls (and web/ imports).
// Run: node test/layers.test.js
// The new layers (core, store, proc, runners, domain) are checked strictly: they start clean and must stay so.
// Rules that today's entry points still break (server.js and orca-launch.js require team.js, hooks require
// control.js) only warn until refactor step 13; set STRICT = true then.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STRICT = false;
const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const rel = (f) => path.relative(SCRIPTS, f).replace(/\\/g, '/');

const ENTRIES = new Set(['team.js', 'control.js', 'wait-inbox.js', 'orca-launch.js', 'server.js']);
const LEGACY = new Set(['lib.js', 'cards.js', 'usage.js', 'i18n.js']); // shrink away in later steps
const LEGACY_RUNNERS = new Set(['orca.js', 'terminal.js']); // become runners/* in step 9

// Layer of a module: { name, level }.
function layerOf(r) {
  const top = r.split('/')[0];
  if (r.startsWith('hooks/') || ENTRIES.has(r)) return { name: 'entry', level: 4 };
  if (top === 'app' || top === 'http') return { name: top, level: 3 };
  if (LEGACY.has(r)) return { name: 'legacy', level: 3 };
  if (top === 'domain') return { name: 'domain', level: 2 };
  if (top === 'runners' || LEGACY_RUNNERS.has(r)) return { name: 'runners', level: 1 };
  if (['core', 'store', 'proc'].includes(top)) return { name: top, level: 1 };
  if (top === 'web') return { name: 'web', level: 4 };
  return { name: 'other', level: 4 };
}

// Which level-1 groups a level-1 group may use.
const L1_ALLOWED = {
  core: ['core'],
  store: ['core', 'store'],
  proc: ['core', 'proc'],
  runners: ['core', 'proc', 'runners'],
};
const IO_MODULES = new Set(['fs', 'child_process', 'http', 'https', 'net', 'node:fs', 'node:child_process', 'node:http', 'node:net']);

function files(dir = SCRIPTS) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

// [{ from, to (scripts-relative, or a bare module name), line }]
function edges() {
  const out = [];
  for (const f of files()) {
    const text = fs.readFileSync(f, 'utf8');
    const re = /\brequire\(\s*(['"])([^'"]+)\1\s*\)|^\s*import\b[^'"]*?from\s*(['"])([^'"]+)\3|\bimport\(\s*(['"])([^'"]+)\5\s*\)/gm;
    for (const m of text.matchAll(re)) {
      const spec = m[2] || m[4] || m[6];
      const line = text.slice(0, m.index).split('\n').length;
      if (spec.startsWith('.')) {
        let to = path.resolve(path.dirname(f), spec);
        if (!/\.(c|m)?js$/.test(to)) to += '.js';
        out.push({ from: rel(f), to: rel(to), line });
      } else out.push({ from: rel(f), to: spec, line });
    }
  }
  return out;
}

function check() {
  const strict = [];
  const warn = [];
  for (const e of edges()) {
    const a = layerOf(e.from);
    const where = `${e.from}:${e.line} -> ${e.to}`;
    if (!e.to.includes('/') && !e.to.endsWith('.js')) {
      // A Node built-in or package.
      if (a.name === 'domain' && IO_MODULES.has(e.to)) strict.push(`${where}: domain/ does no I/O`);
      continue;
    }
    const b = layerOf(e.to);
    if (a.name === 'web') {
      if (b.name !== 'web') strict.push(`${where}: web/ talks to the server only through /api`);
      continue;
    }
    if (a.name === 'domain' && !(b.name === 'domain' || e.to === 'core/config.js')) strict.push(`${where}: domain/ may use only domain/ and core/config`);
    else if (a.level === 1 && b.level === 1 && !L1_ALLOWED[a.name].includes(b.name)) (LEGACY_RUNNERS.has(e.from) ? warn : strict).push(`${where}: ${a.name}/ may not use ${b.name}/`);
    else if (b.level > a.level) (a.level <= 2 && !LEGACY_RUNNERS.has(e.from) ? strict : warn).push(`${where}: ${a.name} (L${a.level}) may not use ${b.name} (L${b.level})`);
    if (a.name === 'entry' && b.name === 'entry') warn.push(`${where}: an entry point may not require another entry point`);
  }
  return { strict, warn };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('layers: core/store/proc/runners/domain/web follow the dependency rules', () => {
  const { strict } = check();
  assert.deepEqual(strict, []);
});

test(`layers: entry points and legacy modules (${STRICT ? 'strict' : 'warn only until step 13'})`, () => {
  const { warn } = check();
  for (const w of warn) console.log(`     WARN ${w}`);
  if (STRICT) assert.deepEqual(warn, []);
});

test('layers: the parser sees requires and imports (self-check)', () => {
  const all = edges();
  assert.ok(all.some((e) => e.from === 'store/record.js' && e.to === 'core/lock.js'));
  assert.ok(all.some((e) => e.from === 'web/main.mjs' && e.to.startsWith('web/')));
  assert.ok(all.some((e) => e.from === 'server.js' && e.to === 'lib.js'));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok   ${t.name}`); } catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err.stack || err}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
