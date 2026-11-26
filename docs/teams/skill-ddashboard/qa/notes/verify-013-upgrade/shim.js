const {T,BOARD,OLD,NEW,env,hook,req,card,fs,spawnSync}=require('./lib');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const P=T+'/proj/alpha';const shim=BOARD+'/bin/wait.js';
const run=(sid)=>spawnSync(process.execPath,[shim,sid],{env:env({DDASH_POLL_MS:'100'}),encoding:'utf8',timeout:15000});
(async()=>{
 const R={};
 R.shim_before=fs.readFileSync(shim,'utf8').split('\n')[2];
 // A: shim untouched -> 0.2.0 target still present
 await req('POST','/api/reply',{session_id:'s-alpha-be',text:'shim A reply'});
 let r=run('s-alpha-be');R.A_old_target_present={code:r.status,out:r.stdout.trim()};
 // old hooks on the migrated board (old plugin still in an old session)
 hook(OLD,'stop-card',{session_id:'s-alpha-be',cwd:P,last_assistant_message:card({status:'done',title:'card from OLD hook on migrated board',summary:['x'],review:[]})},{DDASH_NAME:'be'});
 const st=(await req('GET','/api/state')).body;
 R.old_hook_card_visible=st.cards.some(c=>c.title==='card from OLD hook on migrated board');
 // B: old plugin dir gone (in-place/cached update removed it)
 fs.renameSync(T+'/old',T+'/old-gone');
 r=run('s-alpha-be');R.B_target_gone={code:r.status,out:r.stdout.trim()};
 // new session-start hook refreshes the shim
 const h=hook(NEW,'session-start',{session_id:'s-alpha-be',cwd:P},{DDASH_NAME:'be'});
 R.new_session_start_out_head=h.out.split('\n').slice(0,2).join(' | ');R.new_start_err=h.err;
 R.shim_after=fs.readFileSync(shim,'utf8').split('\n')[2];
 R.bin_files=fs.readdirSync(BOARD+'/bin');
 await req('POST','/api/reply',{session_id:'s-alpha-be',text:'shim B reply'});
 r=run('s-alpha-be');R.B_refreshed={code:r.status,out:r.stdout.trim()};
 // refreshed shim sees wait lock + server view 'waiting'? start long waiter owned by fake claude not needed; just check state view
 const st2=(await req('GET','/api/state')).body;R.view_be=st2.sessions['s-alpha-be'].view;
 // new hooks end-to-end on migrated board
 hook(NEW,'stop-card',{session_id:'s-alpha-be',cwd:P,last_assistant_message:card({status:'wip',title:'card from NEW hook',summary:['y'],review:[]})},{DDASH_NAME:'be'});
 await req('POST','/api/reply',{session_id:'s-alpha-be',text:'post-upgrade reply'});
 const st3=(await req('GET','/api/state')).body;
 R.new_card_visible=st3.cards.some(c=>c.title==='card from NEW hook');R.replies_after=st3.replies.length;R.pending_be=st3.sessions['s-alpha-be'].pending;
 fs.renameSync(T+'/old-gone',T+'/old');
 console.log(JSON.stringify(R,null,1));
})();
