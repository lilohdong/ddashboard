// Headless Chrome check of folded + stopped cards, Stopped filter, light and dark. usage: node ui.mjs <outDir>
import { launch } from '../verify-008/cdp.mjs';
const out = process.argv[2];
const c = await launch(9339);
await c.send('Page.navigate', { url: 'http://127.0.0.1:7359/' }); await c.sleep(2500);
const res = {};
for (const scheme of ['light', 'dark']) {
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }); await c.sleep(400);
  await c.ev(`localStorage.setItem('ddash.filter','"all"'); document.querySelector('[data-f="all"]')?.click(); 1`); await c.sleep(300);
  // expand the folds of the S1 review card
  await c.ev(`document.querySelectorAll('details.folds').forEach(d => d.open = true); 1`); await c.sleep(200);
  res[scheme + '_all'] = JSON.parse(await c.ev(`JSON.stringify({
    bg: getComputedStyle(document.body).backgroundColor,
    filters: [...document.querySelectorAll('#filters button')].map(b => b.textContent.trim()),
    topCards: [...document.querySelectorAll('#cards article')].map(a => ({ title: (a.querySelector('.title, h3, h2, b')||a).textContent.trim().slice(0,40), badge: a.querySelector('.badge')?.textContent.trim(), badgeClass: a.querySelector('.badge')?.className, badgeColor: getComputedStyle(a.querySelector('.badge')).color, folds: a.querySelector('details.folds summary')?.textContent.trim() || null, foldItems: [...a.querySelectorAll('.fold')].map(f => f.textContent.trim().replace(/\\s+/g,' ').slice(0,50)), foldedBadge: !!a.querySelector('.badge.folded') }))
  })`));
  await c.shot(`${out}/ui-${scheme}-all.png`);
  await c.ev(`document.querySelector('[data-f="stopped"]').click(); 1`); await c.sleep(400);
  res[scheme + '_stopped'] = JSON.parse(await c.ev(`JSON.stringify({
    active: document.querySelector('#filters button.on')?.textContent.trim(),
    cards: [...document.querySelectorAll('#cards article')].map(a => ({ text: a.textContent.replace(/\\s+/g,' ').trim().slice(0,90), badge: a.querySelector('.badge')?.textContent.trim(), cls: a.querySelector('.badge')?.className, title: a.querySelector('.badge')?.title, color: getComputedStyle(a.querySelector('.badge')).color, bg: getComputedStyle(a.querySelector('.badge')).backgroundColor }))
  })`));
  await c.shot(`${out}/ui-${scheme}-stopped.png`);
}
res.errors = c.errs;
console.log(JSON.stringify(res, null, 1));
c.close(); process.exit(0);
