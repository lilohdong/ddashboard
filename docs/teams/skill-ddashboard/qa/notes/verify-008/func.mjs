import { launch } from './cdp.mjs';
import { readFileSync, existsSync } from 'node:fs';
const B = process.argv[2];
const c = await launch(9340); const { ev, sleep } = c; const R = {};
const pj = () => JSON.parse(readFileSync(B + '/projects.json', 'utf8'));
const api = (p) => ev(`fetch('${p}').then(r=>r.json())`);
await c.send('Page.navigate', { url: 'http://127.0.0.1:7358/' }); await sleep(2500);
// stub spawn POST to capture body (a real spawn would launch claude)
await ev(`window.__sp=[]; const of=window.fetch; window.fetch=(u,o)=>{ if(String(u).includes('/api/team/spawn')){ window.__sp.push(JSON.parse(o.body)); return Promise.resolve(new Response('{"ok":true}',{status:200})); } return of(u,o); }; 1`);
// 1 +member form (lead-level)
await ev(`document.querySelector('[data-spawn-for="sL"]').click(); 1`); await sleep(300);
R.formOpen = await ev(`!!document.querySelector('form.spawn-form') && document.activeElement?.name==='role'`);
await ev(`(()=>{const f=document.querySelector('form.spawn-form'); const set=(el,v)=>{el.value=v; el.dispatchEvent(new Event('input',{bubbles:true}));}; set(f.elements.role,'qa-x'); set(f.elements.model,'haiku'); set(f.elements.task,'tiny task'); f.elements.stay.checked=true; f.elements.stay.dispatchEvent(new Event('input',{bubbles:true})); 1})()`);
await sleep(4500); // across polls
R.draftKept = await ev(`(()=>{const f=document.querySelector('form.spawn-form'); return f&&[f.elements.role.value,f.elements.model.value,f.elements.task.value,f.elements.stay.checked].join('|')})()`);
await ev(`document.querySelector('form.spawn-form').requestSubmit(); 1`); await sleep(800);
R.spawnBody = await ev(`JSON.stringify(window.__sp)`); R.formClosed = await ev(`!document.querySelector('form.spawn-form')`);
// cancel path + group-level spawn
await ev(`document.querySelector('[data-spawn-for]').click(); 1`); await sleep(200);
R.cancel = await ev(`(()=>{document.querySelector('[data-spawn-cancel]').click(); return 1})()`); await sleep(200);
R.cancelClosed = await ev(`!document.querySelector('form.spawn-form')`);
// 2 group delete g2 (purge checked) 
R.groupsBefore = Object.keys(pj().PK2.teams.T1.groups);
await ev(`document.querySelector('[data-group-del="g2"]').click(); 1`); await sleep(300);
R.delPanel = await ev(`!!document.querySelector('.group-del [data-group-del-ok]')`);
await ev(`document.querySelector('[data-group-del-cancel]').click(); 1`); await sleep(300);
R.delCancelKept = Object.keys(pj().PK2.teams.T1.groups).join(',') + ' panelGone=' + await ev(`!document.querySelector('.group-del')`);
await ev(`document.querySelector('[data-group-del="g2"]').click(); 1`); await sleep(300);
await ev(`document.querySelector('.group-del [data-group-del-ok]').click(); 1`); await sleep(1500);
R.groupsAfter = Object.keys(pj().PK2.teams.T1.groups); R.g2Gone = await ev(`!document.querySelector('[data-group-del="g2"]')`);
R.g2Folder = existsSync(B + '/../wt/docs/teams/T1/g2');
// group add via prompt
c.setDialog({ accept: true, promptText: 'g3' });
await ev(`document.querySelector('[data-group-add]').click(); 1`); await sleep(1500);
R.groupsAdd = Object.keys(pj().PK2.teams.T1.groups);
// 3 runner select (project scope)
await ev(`document.querySelector('[data-kind="project"][data-id="soloproj"]').click(); 1`); await sleep(400);
R.runnerSelects = await ev(`[...document.querySelectorAll('select[data-runner]')].map(s=>s.dataset.runner+'='+s.value)`);
await ev(`(()=>{const s=document.querySelector('select[data-runner="runner_member"]'); s.value='orca'; s.dispatchEvent(new Event('change',{bubbles:true})); 1})()`); await sleep(1500);
R.runnerSaved = await ev(`fetch('/api/state').then(r=>r.json()).then(s=>s.teams.soloproj.runner_member+'/'+s.teams.soloproj.runner_lead)`);
R.runnerSelAfter = await ev(`document.querySelector('select[data-runner="runner_member"]').value`);
await ev(`(()=>{const s=document.querySelector('select[data-runner="runner_member"]'); s.value='headless'; s.dispatchEvent(new Event('change',{bubbles:true})); 1})()`); await sleep(1200);
// mode select: solo -> team led by sB
c.setDialog({ accept: true, promptText: 'teamB' });
R.modeOpts = await ev(`[...document.querySelector('select[data-mode-key="PK1"]').options].map(o=>o.value)`);
await ev(`(()=>{const s=document.querySelector('select[data-mode-key="PK1"]'); s.value='team:sB'; s.dispatchEvent(new Event('change',{bubbles:true})); 1})()`); await sleep(1500);
R.teamAdded = JSON.stringify(Object.keys(pj().PK1.teams || {})); R.teamLead = pj().PK1.teams?.teamB?.lead;
R.modeNow = await ev(`document.querySelector('select[data-mode-key="PK1"]').selectedOptions[0].textContent`);
// back to solo
await ev(`(()=>{const s=document.querySelector('select[data-mode-key="PK1"]'); s.value='solo'; s.dispatchEvent(new Event('change',{bubbles:true})); 1})()`); await sleep(1500);
R.soloBack = JSON.stringify(pj().PK1.teams || {}); R.dialogs = c.dialogs;
// 4 archive / restore
await ev(`document.querySelector('[data-kind="all"]').click(); 1`); await sleep(300);
const cnt = `document.querySelectorAll('#cards article').length`;
R.cardsBefore = await ev(cnt);
const id = await ev(`document.querySelector('[data-archive]').dataset.archive`);
await ev(`document.querySelector('[data-archive="${id}"]').click(); 1`); await sleep(1200);
R.afterArchive = { cards: await ev(cnt), archivedApi: (await api('/api/search?archived=only')).cards.map((x) => x.id), badge: await ev(`document.querySelector('[data-archived]')?.textContent`) };
await ev(`document.querySelector('[data-archived]').click(); 1`); await sleep(1500);
R.archivedView = await ev(`[...document.querySelectorAll('#cards article')].map(a=>a.querySelector('[data-unarchive]')?.dataset.unarchive)`);
await ev(`document.querySelector('[data-unarchive="${id}"]').click(); 1`); await sleep(1500);
await ev(`document.querySelector('[data-archived]')?.click(); 1`); await sleep(1500);
R.afterRestore = { cards: await ev(cnt), archivedApi: (await api('/api/search?archived=only')).cards.length };
R.errors = c.errs; console.log(JSON.stringify(R, null, 1)); c.close(); process.exit(0);
