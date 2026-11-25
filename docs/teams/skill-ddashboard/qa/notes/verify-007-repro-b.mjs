import { spawn } from 'node:child_process';
import { mkdtempSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const B = process.argv[2];
const port = 9334, prof = mkdtempSync(join(tmpdir(), 'qa-chrome-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.enable'); await send('Page.navigate', { url: 'http://127.0.0.1:7361/' }); await sleep(2500);
const out = {};
// A: select text, post new card, wait 2 polls, check; then clear selection, wait, check
const f = join(B, 'cards', readdirSync(join(B, 'cards'))[0]);
await ev(`(()=>{const li=document.querySelector('#cards article li'); const r=document.createRange(); r.selectNodeContents(li); const s=getSelection(); s.removeAllRanges(); s.addRange(r); window.__sel=s.toString(); 1})()`);
const now = Date.now();
appendFileSync(f, JSON.stringify({ id: now + '-new', ts: new Date(now).toISOString(), session_id: 's-qa7', session_name: 'qa7', project: 'qa7proj', project_key: 'PK1', branch: 'x', diffstat: '', status: 'done', title: 'NEWCARD-POSTED', summary: ['fresh'] }) + '\n');
await sleep(7500);
const has = `!![...document.querySelectorAll('#cards article')].find(a=>a.textContent.includes('NEWCARD-POSTED'))`;
out.duringSelection = { selection: await ev(`getSelection().toString().slice(0,30)`), newCardShown: await ev(has) };
await ev(`getSelection().removeAllRanges(); 1`);
await sleep(3500);
out.afterClear = { newCardShown: await ev(has) };
// B: key tag click
out.keyTags = await ev(`[...document.querySelectorAll('#cards .badge.key')].map(b=>b.dataset.key+'|'+b.dataset.keyProject)`);
await ev(`document.querySelector('#cards .badge.key[data-key="fix"][data-key-project="PK1"]').click(); 1`);
await sleep(1500);
out.afterClick = await ev(`[...document.querySelectorAll('#cards article')].map(a=>(a.querySelector('.title')||a).textContent.trim().slice(0,40))`);
console.log(JSON.stringify(out, null, 2)); ws.close(); chrome.kill();
