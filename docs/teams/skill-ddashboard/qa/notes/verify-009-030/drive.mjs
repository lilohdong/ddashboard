// QA driver for verify-009-030. usage: node drive.mjs <extractDir> <tmpRoot> <phase: A|B>
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const [X, T, phase] = process.argv.slice(2);
const BOARD = T + '/board', FIX = T + '/fixrepo', PORT = 7359;
mkdirSync(FIX, { recursive: true });
process.env.DDASH_BOARD_DIR = BOARD; process.env.DDASH_PORT = String(PORT); process.env.DDASH_ORCA = '0';
const req = createRequire(X + '/scripts/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {}; const rec = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); };
const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...o });
if (!existsSync(FIX + '/.git')) { sh('git', ['init', '-q', '-b', 'main'], { cwd: FIX }); writeFileSync(FIX + '/a.txt', 'x'); sh('git', ['add', '.'], { cwd: FIX }); sh('git', ['-c', 'user.name=qa', '-c', 'user.email=q@q', 'commit', '-qm', 'init'], { cwd: FIX }); }
const env = { ...process.env, DDASH_TICK_MS: phase === 'A' ? '600000' : '700', DDASH_SWEEP_MS: '600000' };
const srv = spawn('node', [X + '/scripts/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
writeFileSync(T + '/server.pid', String(srv.pid));
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/state`); break; } catch { await sleep(200); } }
const lib = req('./lib'); lib.setProject(FIX, true);
const sessionsStore = req('./store/sessions');
const api = async (p, body) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify(body) } : {}); return r.json(); };
const hook = (name, input, raw) => sh('node', [`${X}/scripts/hooks/${name}.js`], { input: raw ?? JSON.stringify(input), env: process.env, cwd: FIX });
const cardText = (c) => 'done.\n```card\n' + JSON.stringify(c) + '\n```';
const post = (sid, c) => hook('stop-card', { session_id: sid, cwd: FIX, last_assistant_message: cardText(c) });
const start = (sid) => hook('session-start', { session_id: sid, cwd: FIX, source: 'startup' });
const byTitle = async () => { const m = {}; for (const c of (await api('/api/search?limit=500&archived=include')).cards) m[c.title] = c; return m; };

if (phase === 'A') {
  for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) start(s);
  rec('registered', Object.keys(sessionsStore.read()));
  // (1) fold
  post('s1', { status: 'wip', title: 'S1 wip a' }); await sleep(30);
  post('s1', { status: 'wip', title: 'S1 wip b' }); await sleep(30);
  post('s1', { status: 'review', title: 'S1 review', review: ['x'] });
  // (2) ended, no newer card
  post('s2', { status: 'wip', title: 'S2 wip only' });
  hook('session-end', { session_id: 's2', reason: 'other' });
  post('s3', { status: 'wip', title: 'S3 wip forgotten' }); hook('session-end', { session_id: 's3', reason: 'other' });
  post('s4', { status: 'wip', title: 'S4 wip, resumed' }); hook('session-end', { session_id: 's4', reason: 'other' });
  let m = await byTitle();
  const view = (t) => m[t] && { outcome: m[t].outcome, folded_into: m[t].folded_into, stopped: m[t].stopped, replaced: m[t].replaced, archived: m[t].archived };
  const rid = m['S1 review']?.id;
  rec('1_fold', { a: view('S1 wip a'), b: view('S1 wip b'), review_id: rid, top: view('S1 review') });
  rec('2_stopped', { s2: view('S2 wip only'), s3: view('S3 wip forgotten') });
  rec('forget_s3', await api('/api/sessions/forget', { session_id: 's3' }));
  m = await byTitle(); rec('2_forgotten_still_stopped', view('S3 wip forgotten'));
  start('s4'); post('s4', { status: 'done', title: 'S4 done after resume' });
  m = await byTitle(); rec('2_resume_folds', { old: view('S4 wip, resumed'), new_id: m['S4 done after resume']?.id });
  const st = await api('/api/state');
  const top = st.cards.find((c) => c.title === 'S1 review');
  rec('state_top_folded', { n: top?.folded?.length, titles: top?.folded?.map((f) => f.title) });
  rec('state_active_has_folded_toplevel', st.cards.filter((c) => /S1 wip/.test(c.title)).length);
  // (3) key replacement beats stopped; archive
  post('s5', { status: 'wip', title: 'K old wip', key: 'kx' }); hook('session-end', { session_id: 's5', reason: 'other' });
  m = await byTitle(); rec('3_before_replace', view('K old wip'));
  post('s6', { status: 'wip', title: 'K newer other session', key: 'kx' });
  m = await byTitle(); rec('3_after_replace', { old: view('K old wip'), neu: view('K newer other session') });
  const sid2id = m['S2 wip only'].id;
  rec('3_archive', await api('/api/archive', { card_id: sid2id, archived: true }));
  m = await byTitle(); const stA = await api('/api/state'); rec('3_archived_view', { archived: m['S2 wip only'].archived, inActive: stA.cards.some((c) => c.id === sid2id), count: stA.archived_count });
  await api('/api/archive', { card_id: sid2id, archived: false });
  m = await byTitle(); rec('3_unarchive', { archived: m['S2 wip only'].archived, outcome: m['S2 wip only'].outcome });
  // (5) mtime
  sessionsStore.update((s) => { s.dead1 = { session_id: 'dead1', name: 'dead1', kind: 'member', state: 'idle', claude_pid: 999999, project: 'fixrepo', project_key: lib.projectKey(FIX), cwd: FIX, last_seen: new Date().toISOString(), started: new Date().toISOString() }; });
  const sf = BOARD + '/sessions.json';
  const m0 = statSync(sf).mtimeMs, h0 = readFileSync(sf, 'utf8');
  for (let i = 0; i < 6; i++) { await api('/api/state'); await api('/api/state?reports=1'); await sleep(100); }
  const m1 = statSync(sf).mtimeMs;
  const dead = sessionsStore.read().dead1;
  rec('5_mtime', { same: m0 === m1, m0, m1, content_same: h0 === readFileSync(sf, 'utf8'), dead_state_after_gets: dead.state });
  const st2 = await api('/api/state'); rec('5_view_of_dead', st2.sessions.dead1 && { view: st2.sessions.dead1.view, state: st2.sessions.dead1.state });
  // (7) bad hook input
  const bad = [];
  for (const h of ['session-start', 'prompt-submit', 'stop-card', 'session-end']) {
    for (const [lab, raw] of [['notjson', 'not json{'], ['empty', ''], ['null', 'null'], ['array', '[1,2]'], ['badsid', JSON.stringify({ session_id: '../../etc/x', cwd: 5, transcript_path: {} })], ['numsid', JSON.stringify({ session_id: 123, cwd: null, last_assistant_message: 7, transcript_path: 'Z:/none.jsonl' })]]) {
      const r = hook(h, null, raw); bad.push({ h, lab, code: r.status, stdout: r.stdout.length, stderr: r.stderr.length });
    }
  }
  rec('7_bad', { allExit0: bad.every((b) => b.code === 0), n: bad.length, rows: bad.filter((b) => b.stdout || b.stderr) });
  const logf = BOARD + '/logs/ddashboard.log'; const lg = existsSync(logf) ? readFileSync(logf, 'utf8') : '';
  rec('7_log', { exists: existsSync(logf), hookLines: lg.split('\n').filter((l) => /hook (session-start|prompt-submit|stop-card|session-end)/.test(l)).length, sample: lg.split('\n').filter((l) => /hook /.test(l)).slice(0, 3) });
  rec('dashboard_ready', true);
  writeFileSync(T + '/phaseA-out.json', JSON.stringify(out, null, 1));
  if (process.env.KEEP) { writeFileSync(T + '/keep', '1'); await sleep(Number(process.env.KEEP)); }
} else {
  // (6) fake member whose process dies
  const lp = spawn('node', ['-e', 'setTimeout(()=>{},600000)'], { stdio: 'ignore' });
  const key = lib.projectKey(FIX), now = new Date().toISOString();
  sessionsStore.update((s) => { s.mem1 = { session_id: 'mem1', name: 'mem1', kind: 'member', lead: 'leadX', group: 'qa', role: 'qa', state: 'idle', claude_pid: lp.pid, project: 'fixrepo', project_key: key, cwd: FIX, last_seen: now, started: now }; });
  sessionsStore.update((s) => { s.mem0 = { session_id: 'mem0', name: 'mem0', kind: 'member', lead: 'leadX', state: 'idle', project: 'fixrepo', project_key: key, cwd: FIX, last_seen: now, started: now }; });
  await sleep(200);
  const before = sessionsStore.read().mem1; rec('6_before', { state: before.state });
  const tKill = Date.now(); sh('taskkill', ['/PID', String(lp.pid), '/F']);
  let seen = null; for (let i = 0; i < 60; i++) { const s = sessionsStore.read().mem1; if (s.state === 'ended') { seen = Date.now() - tKill; break; } await sleep(50); }
  const s1 = sessionsStore.read().mem1, s0 = sessionsStore.read().mem0;
  rec('6_gone', { ms_to_ended: seen, tick_ms: 700, state: s1.state, end_reason: s1.end_reason, control_state: s0.state, control_reason: s0.end_reason });
  const st = await api('/api/state'); rec('6_view', { mem1: st.sessions.mem1?.view, mem0: st.sessions.mem0?.view });
  rec('6_server_log', srvLog.split('\n').filter((l) => /gone|liveness/.test(l)));
  writeFileSync(T + '/phaseB-out.json', JSON.stringify(out, null, 1));
}
if (!(phase === 'A' && process.env.KEEP)) { sh('taskkill', ['/PID', String(srv.pid), '/T', '/F']); }
process.exit(0);
