const {T,BOARD,OLD,env,hook,req,card,fs,spawnSync}=require('./lib');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const g=(cwd,...a)=>spawnSync('git',['-c','user.name=qa','-c','user.email=qa@example.invalid',...a],{cwd,encoding:'utf8'});
(async()=>{
 fs.mkdirSync(T+'/proj',{recursive:true});
 const projs={};
 for(const n of ['alpha','beta','gamma']){const d=T+'/proj/'+n;fs.mkdirSync(d,{recursive:true});g(d,'init','-q','-b','main');g(d,'commit','--allow-empty','-q','-m','init');projs[n]=d;}
 g(projs.alpha,'worktree','add','-q','-b','feat-x',T+'/proj/alpha-wt');projs.alphawt=T+'/proj/alpha-wt';
 const S=[ // [sid, proj, name, kind]
  ['s-alpha-solo','alpha','','solo'],['s-alpha-lead','alpha','lead-alpha','team'],['s-alpha-fe','alpha','fe','team'],['s-alpha-be','alpha','be','team'],
  ['s-alpha-wt','alphawt','','solo'],['s-beta-solo','beta','','solo'],['s-beta-ended','beta','','solo'],['s-gamma-solo','gamma','','solo'],['s-gamma-m','gamma','qa-x','team']];
 const log={};
 // connect each project via the slash command hook (starts server on first use)
 for(const p of ['alpha','beta','gamma']){const sid='s-'+p+'-solo';const r=hook(OLD,'prompt-submit',{session_id:sid,cwd:projs[p],prompt:'/ddashboard:dashboard'});log['connect-'+p]=r.out.split('\n')[0];}
 for(const [sid,p,name] of S){hook(OLD,'session-start',{session_id:sid,cwd:projs[p]},name?{DDASH_NAME:name}:{});hook(OLD,'prompt-submit',{session_id:sid,cwd:projs[p],prompt:'do work'});}
 const C=(sid,p,name,o)=>hook(OLD,'stop-card',{session_id:sid,cwd:projs[p],last_assistant_message:card(o)},name?{DDASH_NAME:name}:{});
 for(const [sid,p,name] of S){
  C(sid,p,name,{status:'done',title:`${sid} first`,summary:['a','b'],review:['check x'],details:'# details\nline1\nline2 한글 ✓'});
  await sleep(15);
  C(sid,p,name,{status:'wip',title:`${sid} wip plan`,summary:['working'],review:[]});
  await sleep(15);
  C(sid,p,name,{status:'wip',title:`${sid} wip plan v2`,summary:['revised'],review:[],replaces:'last'});
  await sleep(15);
 }
 C('s-alpha-solo','alpha','',{status:'blocked',title:'blocked card',summary:['need input'],review:['answer?']});
 C('s-beta-solo','beta','',{status:'review',title:'review card',summary:['please look'],review:['r1','r2']});
 await sleep(500);
 // replies: pending (no waiter) to live sessions
 const replies=[];
 for(const [sid,t] of [['s-alpha-solo','reply one'],['s-alpha-solo','reply two 한글'],['s-beta-solo','beta reply'],['s-gamma-m','member reply']]){replies.push((await req('POST','/api/reply',{session_id:sid,text:t})).code);}
 log.replies=replies;
 // one consumed by stop hook
 hook(OLD,'stop-card',{session_id:'s-alpha-solo',cwd:projs.alpha,last_assistant_message:'no card'});
 // end a session
 hook(OLD,'session-end',{session_id:'s-beta-ended',cwd:projs.beta});
 // archive some cards
 let st=(await req('GET','/api/state')).body;
 const ids=st.cards.map(c=>c.id);
 const arch=ids.filter((_,i)=>i%4===0);
 for(const id of arch)await req('POST','/api/archive',{card_id:id,archived:true});
 // unarchive one explicitly to test explicit entry
 await req('POST','/api/archive',{card_id:arch[0],archived:false});
 // hand-seeded legacy/old data (0.1.0 cards.jsonl + older monthly file)
 fs.writeFileSync(BOARD+'/cards.jsonl',[1,2].map(i=>JSON.stringify({id:'legacy-'+i,ts:'2026-01-0'+i+'T10:00:00.000Z',session_id:'s-old',session_name:'old',project:'alpha',status:'done',title:'legacy card '+i,summary:['x'],review:[]})).join('\n')+'\n');
 fs.mkdirSync(BOARD+'/cards',{recursive:true});
 fs.writeFileSync(BOARD+'/cards/2026-09.jsonl',JSON.stringify({id:'sep-1',ts:'2026-09-05T10:00:00.000Z',session_id:'s-old',session_name:'old',project:'alpha',status:'wip',title:'september wip',summary:['x'],review:[]})+'\n');
 await sleep(300);
 st=(await req('GET','/api/state')).body;
 fs.writeFileSync(T+'/snap-old-state.json',JSON.stringify(st,null,1));
 const all=(await req('GET','/api/search?archived=include&limit=500')).body;
 fs.writeFileSync(T+'/snap-old-search.json',JSON.stringify(all,null,1));
 console.log(JSON.stringify({log,sessions:Object.keys(st.sessions).length,cards:st.cards.length,all:all.cards.length,archived:st.archived_count,replies:st.replies.length,ports:fs.readFileSync(BOARD+'/server.pid','utf8')}));
})();
