// Headless Chrome check of the dashboard on a migrated copy of the board, light and dark. usage: node ui.mjs <port> <outDir>
import { launch } from '../verify-008/cdp.mjs';
const port = process.argv[2], out = process.argv[3];
const c = await launch(9341);
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs=[];const ce=console.error;console.error=(...a)=>{window.__errs.push(a.join(' ').slice(0,200));ce(...a)};addEventListener('error',e=>window.__errs.push('error:'+e.message));addEventListener('unhandledrejection',e=>window.__errs.push('rej:'+e.reason));` });
await c.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await c.sleep(3000);
const res = {};
for (const scheme of ['light', 'dark']) {
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }); await c.sleep(500);
  res[scheme] = JSON.parse(await c.ev(`JSON.stringify({
    bg: getComputedStyle(document.body).backgroundColor,
    articles: document.querySelectorAll('#cards article').length,
    sessionsRendered: document.querySelectorAll('[data-sid], .session, #sessions > *').length,
    bodyTextLen: document.body.innerText.length,
    jsErrors: window.__errs
  })`));
  await c.shot(`${out}/ui-${scheme}.png`);
}
res.exceptions = c.errs;
console.log(JSON.stringify(res, null, 1));
c.close(); process.exit(0);
