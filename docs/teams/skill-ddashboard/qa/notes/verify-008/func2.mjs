import { launch } from './cdp.mjs';
const c = await launch(9341); const { ev, sleep } = c; const R = {};
await c.send('Page.navigate', { url: 'http://127.0.0.1:7358/' }); await sleep(2500);
await ev(`window.__sp=[]; const of=window.fetch; window.fetch=(u,o)=>{ if(String(u).includes('/api/team/spawn')){ window.__sp.push(JSON.parse(o.body)); return Promise.resolve(new Response('{"ok":true}',{status:200})); } return of(u,o); }; 1`);
R.buttons = await ev(`[...document.querySelectorAll('[data-spawn-for]')].map(b=>b.dataset.spawnFor)`);
for (const id of ['sL|g1', 'sL|']) {
  await ev(`document.querySelector('[data-spawn-for="${id}"]').click(); 1`); await sleep(300);
  const k = id;
  R[k] = { open: await ev(`!!document.querySelector('form.spawn-form') && document.activeElement?.name==='role'`), group: await ev(`document.querySelector('form.spawn-form')?.dataset.group`) };
  await ev(`(()=>{const f=document.querySelector('form.spawn-form'); const set=(el,v)=>{el.value=v; el.dispatchEvent(new Event('input',{bubbles:true}));}; set(f.elements.role,'qa-x'); set(f.elements.model,'haiku'); set(f.elements.task,'tiny task'); f.elements.stay.checked=true; f.elements.stay.dispatchEvent(new Event('input',{bubbles:true})); 1})()`);
  await sleep(4500);
  R[k].draftKept = await ev(`(()=>{const f=document.querySelector('form.spawn-form'); return f&&[f.elements.role.value,f.elements.model.value,f.elements.task.value,f.elements.stay.checked].join('|')})()`);
  await ev(`document.querySelector('form.spawn-form').requestSubmit(); 1`); await sleep(800);
  R[k].closed = await ev(`!document.querySelector('form.spawn-form')`);
  R[k].draftReset = await ev(`(()=>{document.querySelector('[data-spawn-for="${id}"]').click(); const f=document.querySelector('form.spawn-form'); const r=[f.elements.role.value,f.elements.task.value].join('|'); document.querySelector('[data-spawn-cancel]').click(); return r})()`);
}
R.bodies = await ev(`JSON.stringify(window.__sp)`); R.errors = c.errs; console.log(JSON.stringify(R, null, 1)); c.close(); process.exit(0);
