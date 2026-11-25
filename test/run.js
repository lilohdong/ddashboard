#!/usr/bin/env node
// Runs every test/*.test.js in its own process, one after another (they share fixed ports and env tricks).
// Run: node test/run.js [filter]   — filter matches part of the file name.
// Exit code 1 when any file fails; prints the tail of a failing file's output.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tally = (out.match(/\d+\/\d+ passed/g) || []).pop() || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f} ${tally} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!ok) console.log(out.split('\n').filter((l) => !/^ok\s/.test(l)).slice(-40).join('\n'));
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exitCode = failed ? 1 : 0;
