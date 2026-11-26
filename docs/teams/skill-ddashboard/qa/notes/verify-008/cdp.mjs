import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function launch(port = 9338) {
  const prof = mkdtempSync(join(tmpdir(), 'qa-chrome-'));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map(); const errs = []; let dialogs = []; let dialogAnswer = { accept: true, promptText: undefined };
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push({ type: m.params.type, msg: m.params.message }); send('Page.handleJavaScriptDialog', { accept: dialogAnswer.accept, promptText: dialogAnswer.promptText ?? m.params.defaultPrompt }); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result; return r?.result?.value; };
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable');
  return { send, ev, shot, sleep, errs, dialogs, setDialog: (a) => { dialogAnswer = a; }, close: () => { ws.close(); chrome.kill(); } };
}
