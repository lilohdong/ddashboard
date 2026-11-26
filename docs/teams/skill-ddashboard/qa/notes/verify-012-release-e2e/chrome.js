// Headless Chrome (our own process, own profile dir) loads the board in light and dark, collects JS errors/console errors, saves screenshots.
const L = require('./lib'); const { fs, cp, sleep, rec, S } = L;
(async () => {
  const prof = fs.mkdtempSync(S.root + '/chrome-'); const port = 9333;
  const ch = cp.spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--window-size=1400,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  await sleep(3000);
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r)); let id = 0; const pend = new Map(); const errs = [];
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d.error); pend.delete(d.id); }
      if (d.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
      if (d.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(d.params.type)) errs.push('CONSOLE.' + d.params.type + ' ' + d.params.args.map((a) => a.value || a.description).join(' '));
      if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errs.push('LOG ' + d.params.entry.text + ' ' + (d.params.entry.url || '')); });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
    for (const scheme of ['light', 'dark']) {
      errs.length = 0; await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await send('Page.navigate', { url: `http://127.0.0.1:${L.PORT}/` }); await sleep(3000);
      const info = (await send('Runtime.evaluate', { expression: `JSON.stringify({title:document.title,bg:getComputedStyle(document.body).backgroundColor,fg:getComputedStyle(document.body).color,cards:document.querySelectorAll('.card,[class*=card]').length,len:document.body.innerText.length,text:document.body.innerText.slice(0,200)})`, returnByValue: true })).result.value;
      const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(L.HERE + `/board-${scheme}.png`, Buffer.from(shot.data, 'base64'));
      // click around: open a settings/language if present is out of scope; just wait a tick for polling errors
      await sleep(2500);
      rec(`CH ${scheme}: page loads, no JS exceptions / console errors`, errs.length === 0 && /"len":[1-9]/.test(info), JSON.stringify(errs) + ' ' + info);
    }
    ws.close();
  } finally { try { ch.kill(); } catch {} }
})().catch((e) => { console.error(e); process.exit(1); });
