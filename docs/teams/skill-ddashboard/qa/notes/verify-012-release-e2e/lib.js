// Shared helpers for verify-012. State (temp dir) lives in state.json next to these scripts.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const HERE = __dirname, STATE = path.join(HERE, 'state.json'), PORT = Number(process.env.QA_PORT || 7364);
const S = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(S, null, 1));
const env = () => ({ ...process.env, DDASH_PORT: String(PORT), DDASH_BOARD_DIR: S.board, CLAUDE_CONFIG_DIR: S.cfg, DDASH_ORCA: '0', DDASH_WINDOW: '0',
  DDASH_CLAUDE_BIN: S.fake, FAKE_DIR: S.fakeDir, DDASH_POLL_MS: '300', DDASH_TICK_MS: '2000' });
const slash = (p) => String(p).split(String.fromCharCode(92)).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const logf = path.join(HERE, 'evidence.txt');
function rec(id, ok, detail = '') { const line = `${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 400) : ''}`; console.log(line); fs.appendFileSync(logf, line + '\n'); return ok; }
function note(s) { console.log(s); fs.appendFileSync(logf, s + '\n'); }
function hook(name, input, extra = {}) {
  const r = cp.spawnSync(process.execPath, [path.join(S.src, 'scripts', 'hooks', name + '.js')], { input: JSON.stringify(input), env: { ...env(), ...extra }, encoding: 'utf8', cwd: S.proj, timeout: 30000 });
  const o = { out: r.stdout, err: r.stderr, code: r.status }; if (!process.env.QA_NOGUARD) sanitize(); return o;
}
async function api(method, p, body, origin) {
  const h = { 'content-type': 'application/json' }; if (origin) h.origin = origin;
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
const state = async (reports) => (await api('GET', '/api/state' + (reports ? '?reports=1' : ''))).body;
function team(lead, ...args) {
  const r = cp.spawnSync(process.execPath, [path.join(S.board, 'bin', 'team.js'), lead, ...args], { env: env(), encoding: 'utf8', timeout: 30000 });
  const o = { out: (r.stdout || '') + (r.stderr || ''), code: r.status }; sanitize(); return o;
}
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// a transcript fixture: one human prompt then an assistant turn with the text and usage
function transcript(file, prompt, text, usage, id) {
  const rows = [
    { type: 'user', message: { role: 'user', content: prompt }, uuid: 'u' + id },
    { type: 'assistant', message: { id: 'msg_' + id, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage }, uuid: 'a' + id },
  ];
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const cardText = (c) => 'Done.\n```card\n' + JSON.stringify(c) + '\n```';
// --- safety: hooks run from inside the real Claude session record that Claude as the session's claude_pid (they walk up the process tree).
// Any session whose claude_pid is one of OUR ancestors is re-pinned to a dummy node process WE spawn, so end/handoff/kill can never reach the real Claude.
function ancestors() {
  if (L_anc) return L_anc; const set = new Set(); let p = process.pid;
  for (let i = 0; i < 20 && p; i++) { set.add(p); const r = cp.spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${p}").ParentProcessId`], { encoding: 'utf8' }); const n = Number(String(r.stdout).trim()); if (!n || n === p) break; p = n; }
  return (L_anc = set);
}
let L_anc = null; const own = [];
function spawnDummy() { const c = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},3600000)', 'claude-code-qa-dummy'], { detached: true, stdio: 'ignore' }); c.unref(); own.push(c.pid); S.own = own; save(); return c.pid; }
function sanitize() {
  if (!S.board || !S.src) return; const anc = ancestors(); const raw = readJ(S.board + '/sessions.json', {}); const bad = Object.entries(raw).filter(([, v]) => v && anc.has(Number(v.claude_pid))).map(([k]) => k);
  for (const sid of bad) { const d = spawnDummy(); note(`GUARD ${sid}: claude_pid was our own Claude (ancestor ${raw[sid].claude_pid}); re-pinned to dummy ${d}`);
    cp.spawnSync(process.execPath, ['-e', `require(process.argv[1]+'/scripts/store/sessions.js').update(s=>{if(s[process.argv[2]])s[process.argv[2]].claude_pid=Number(process.argv[3])})`, S.src, sid, String(d)], { env: env() }); }
  return bad;
}
module.exports = { ancestors, spawnDummy, sanitize, own, S, save, env, slash, sleep, rec, note, hook, api, state, team, readJ, transcript, cardText, PORT, HERE, fs, path, cp, os };
// Point a session's claude_pid at our dummy process (hooks resolve the REAL claude.exe above this shell; never let a test touch it)
function pinPid(sid) {
  const code = `const st=require(process.argv[1]+'/scripts/store/sessions.js');st.update(s=>{if(s[process.argv[2]])s[process.argv[2]].claude_pid=Number(process.argv[3])})`;
  return cp.spawnSync(process.execPath, ['-e', code, S.src, sid, String(S.dummy)], { env: env(), encoding: 'utf8' });
}
module.exports.pinPid = pinPid;
