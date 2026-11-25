import { launch } from './cdp.mjs';
const [, , label] = process.argv;
const c = await launch();
await c.send('Page.navigate', { url: 'http://127.0.0.1:7358/' }); await c.sleep(2500);
for (const scheme of ['light', 'dark']) {
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }); await c.sleep(500);
  await c.shot(`${label}-${scheme}.png`);
  console.log(label, scheme, await c.ev(`getComputedStyle(document.body).backgroundColor+' '+document.title+' cards='+document.querySelectorAll('#cards article').length`));
}
console.log('errors', c.errs); c.close(); process.exit(0);
