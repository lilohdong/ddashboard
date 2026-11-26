const fs=require('fs'),http=require('http');const B=process.argv[2];
const get=(p)=>new Promise(r=>http.get('http://127.0.0.1:7361'+p,x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r(JSON.parse(d)))}));
const L=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
(async()=>{
 const orig=(d)=>{const M=d+'/';return M};
 const ids=new Set([...fs.readdirSync(B+'/orig/cards').flatMap(f=>L(B+'/orig/cards/'+f)),...L(B+'/orig/cards.jsonl')].map(c=>c.id));
 const rep=new Set(L(B+'/orig/replies.jsonl').map(r=>r.id));
 const sess=Object.keys(JSON.parse(fs.readFileSync(B+'/orig/sessions.json','utf8')));
 const proj=Object.keys(JSON.parse(fs.readFileSync(B+'/orig/projects.json','utf8')));
 const s=await get('/api/state?reports=1');
 const all=await get('/api/search?limit=500');
 const sIds=new Set(all.cards.map(c=>c.id));
 const stCards=new Set([...s.cards.flatMap(c=>[c.id,...(c.folded||[]).map(f=>f.id)])]);
 const stRep=new Set(s.replies.map(r=>r.id));
 const arch=await get('/api/search?archived=only&limit=500');
 const cnt=(a,b)=>[a.size,b.size,[...a].filter(x=>!b.has(x)).length,[...b].filter(x=>!a.has(x)).length];
 console.log(JSON.stringify({
  cards_orig:ids.size, search_all:all.cards.length, search_missing_or_extra:cnt(ids,sIds).slice(2),
  state_active_ids:stCards.size, search_archived:arch.cards.length, state_archived_count:s.archived_count, active_plus_archived:stCards.size+s.archived_count,
  replies_orig:rep.size, state_replies:s.replies.length, rep_diff:cnt(rep,stRep).slice(2),
  sessions_orig:sess.length, state_sessions:Object.keys(s.sessions).length, sess_missing:sess.filter(x=>!(x in s.sessions)).length,
  projects_orig:proj.length, state_teams:Object.keys(s.teams).length, proj_in_state: proj.filter(p=>p in s.teams||Object.values(s.teams).some(t=>t.project_key===p)).length}));
})();
