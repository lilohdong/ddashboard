import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const URL_ = process.argv[2] || 'http://127.0.0.1:7357/';
const port = 9333;
const prof = mkdtempSync(join(tmpdir(), 'qa-chrome-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Page.enable');
await send('Page.navigate', { url: URL_ });
await sleep(2500);
// count renders of #cards
await ev(`window.__renders=0; new MutationObserver(()=>window.__renders++).observe(document.getElementById('cards'),{childList:true}); 1`);
const out = {};
// Test 1: programmatic selection survives a poll?
out.t1 = await ev(`(async()=>{
  const li=document.querySelector('#cards article li')||document.querySelector('#cards article .title');
  li.__mark=1; const r=document.createRange(); r.selectNodeContents(li); const s=getSelection(); s.removeAllRanges(); s.addRange(r);
  const before=s.toString().slice(0,40); const r0=window.__renders;
  await new Promise(r=>setTimeout(r,3500));
  return {before, after:getSelection().toString().slice(0,40), rangeCount:getSelection().rangeCount, sameNode: document.contains(li), renders: window.__renders-r0};
})()`);
// Test 2: real mouse drag held down across a poll
const box = await ev(`(()=>{const li=document.querySelector('#cards article li')||document.querySelector('#cards article .title'); li.scrollIntoView({block:'center'}); const b=li.getBoundingClientRect(); return {x:b.left+2,y:b.top+b.height/2,w:b.width};})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons:1, clickCount: 1 }); for (let k=1;k<=10;k++){ await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + k*20, y: box.y, button: 'left', buttons: 1 }); await sleep(30);} 
const mid = await ev(`getSelection().toString().slice(0,40)`);
const r0 = await ev('window.__renders');
await sleep(3500);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + Math.min(250, box.w - 2), y: box.y, button: 'left', buttons: 1 });
const afterHold = await ev(`getSelection().toString().slice(0,40)`);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + Math.min(250, box.w - 2), y: box.y, button: 'left', clickCount: 1 });
out.t2 = { selectedWhileDragging: mid, afterPollStillHeld: afterHold, renders: (await ev('window.__renders')) - r0 };
// Test 3: scroll positions — window, open details-body, aside
out.t3 = await ev(`(async()=>{
  window.scrollTo(0, 600); window.__dlen=0;
  const d=[...document.querySelectorAll('#cards details')].sort((a,b)=>b.textContent.length-a.textContent.length)[0]; let db=null;
  if(d){ d.open=true; d.dispatchEvent(new Event('toggle')); await new Promise(r=>setTimeout(r,50)); db=document.querySelector('#cards details[open] .details-body'); if(db) db.scrollTop=100; }
  const aside=document.querySelector('aside'); aside.scrollTop=200;
  const b={win:scrollY, details: db?db.scrollTop:null, detailsScrollable: db? db.scrollHeight>db.clientHeight:null, aside:aside.scrollTop};
  await new Promise(r=>setTimeout(r,3500));
  const db2=document.querySelector('#cards details[open] .details-body');
  return {before:b, after:{win:scrollY, details: db2?db2.scrollTop:null, aside:aside.scrollTop, detailsSameNode: db? document.contains(db):null}};
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close(); chrome.kill();
