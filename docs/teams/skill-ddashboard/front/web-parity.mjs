// Track D parity check: renders scripts/dashboard.html (?old) and scripts/web/index.html against the same stub
// API in headless Chrome and compares side, cards, filters, mode bar, title, language. Needs Chrome; ports 7399/9335.
// Run: node docs/teams/skill-ddashboard/front/web-parity.mjs <repo>/scripts  (only useful while dashboard.html exists)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const S = process.argv[2];
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const sessions = {
  A: { session_id: 'A', name: 'alpha', project: 'proj', branch: 'main', cwd: '/p', view: 'working', last_seen: ago(1), usage: { input: 1200, output: 3400, cache_read: 2e6 }, last_context: 160000 },
  L: { session_id: 'L', name: 'lead', project: 'proj', view: 'idle', team: 'lead', team_name: 'T1', last_seen: ago(1), lead_handoff_at: 100000, last_context: 120000 },
  M1: { session_id: 'M1', name: 'm1', project: 'proj', view: 'working', team: 'member', lead: 'L', group: 'g1', role: 'front', last_seen: ago(1), pending: 2 },
  B: { session_id: 'B', name: 'beta', project: 'other', branch: 'dev', view: 'idle', last_seen: ago(500), unresponsive: true },
  E: { session_id: 'E', name: 'gone', project: 'proj', view: 'ended', last_seen: ago(500) },
};
const cards = [
  { id: 'c1', ts: ago(30), session_id: 'A', session_name: 'alpha', project: 'proj', project_key: 'PK', branch: 'main', status: 'done', title: 'First <b>', summary: ['s1'], key: 'fix', key_prev: 2, diffstat: '+1 -2' },
  { id: 'c2', ts: ago(20), session_id: 'B', session_name: 'beta', project: 'other', branch: 'dev', status: 'review', title: 'Look', review: ['check'], details: 'long\ntext' },
  { id: 'c3', ts: ago(10), session_id: 'E', session_name: 'gone', project: 'proj', branch: 'x', status: 'blocked', title: 'Old' },
  { id: 'c4', ts: ago(5), session_id: 'M1', session_name: 'm1', project: 'proj', branch: 'x', status: 'wip', title: 'Rep', via_lead: 'L' },
];
const state = { sessions, cards, replies: [{ card_id: 'c1', text: 'hi', ts: ago(2) }], last_by_session: { A: cards[0], B: cards[1], E: cards[2], M1: cards[3] }, archived_count: 2,
  teams: { proj: { key: 'PK', mode: 'team', runner_lead: 'orca', teams: { T1: { lead: 'L', groups: { g1: { dir: '/g1' } } } } } }, usage_today: { input: 5, output: 6, cache_read: 7 }, usage_total: { input: 1 }, settings: { lang: 'ko' } };
const types = { mjs: 'text/javascript', js: 'text/javascript', css: 'text/css', html: 'text/html' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/state') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state)); }
  if (u.pathname === '/api/search') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ cards: cards.filter((c) => c.key === u.searchParams.get('key')) })); }
  let f = u.pathname === '/' ? (u.searchParams.has('old') ? 'dashboard.html' : 'web/index.html') : u.pathname.slice(1);
  try { const b = readFileSync(join(S, f)); res.setHeader('content-type', types[f.split('.').pop()]); res.end(b); } catch { res.statusCode = 404; res.end(); }
}).listen(7399);
const port = 9335, prof = mkdtempSync(join(tmpdir(), 'qa-chrome-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const errs = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300)); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
const snap = `JSON.stringify({side:document.getElementById('side').innerHTML,cards:document.getElementById('cards').innerHTML,filters:document.getElementById('filters').innerHTML,mode:document.getElementById('mode').innerHTML,scope:document.getElementById('scope').textContent,rep:[document.getElementById('reports').hidden,document.getElementById('reports').textContent],lang:document.documentElement.lang,ph:document.getElementById('q').placeholder,bg:getComputedStyle(document.body).backgroundColor})`;
const out = {};
for (const which of ['old', 'new']) {
  await send('Page.navigate', { url: `http://127.0.0.1:7399/${which === 'old' ? '?old' : ''}` }); await sleep(2000);
  const a = await ev(snap);
  await ev(`document.querySelector('[data-kind="project"][data-id="proj"]').click(); 1`); await sleep(300);
  const b = await ev(snap);
  await ev(`document.querySelector('.badge.key').click(); 1`); await sleep(800);
  const c = await ev(snap);
  await ev(`localStorage.clear(); 1`);
  out[which] = [a, b, c];
}
for (let i = 0; i < 3; i++) { const q = JSON.parse(out.new[i]); console.log("sizes", i, q.side.length, q.cards.length, q.mode.slice(0,60), q.scope, q.lang);
  const o = JSON.parse(out.old[i]), n = JSON.parse(out.new[i]);
  for (const k of Object.keys(o)) console.log(i, k, JSON.stringify(o[k]) === JSON.stringify(n[k]) ? 'same' : 'DIFF\n old=' + JSON.stringify(o[k]).slice(0, 400) + '\n new=' + JSON.stringify(n[k]).slice(0, 400));
}
console.log('errors', errs);
ws.close(); chrome.kill(); srv.close(); process.exit(0);
