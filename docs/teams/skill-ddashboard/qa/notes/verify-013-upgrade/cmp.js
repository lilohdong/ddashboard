const {T,req,fs}=require('./lib');
(async()=>{
 const old=JSON.parse(fs.readFileSync(T+'/snap-old-state.json'));const oldS=JSON.parse(fs.readFileSync(T+'/snap-old-search.json'));
 const st=(await req('GET','/api/state')).body;const s=(await req('GET','/api/search?archived=include&limit=500')).body;
 fs.writeFileSync(T+'/snap-new-state.json',JSON.stringify(st,null,1));fs.writeFileSync(T+'/snap-new-search.json',JSON.stringify(s,null,1));
 console.log('state keys new:',Object.keys(st).join(','));
 const res={};
 const oc=old.cards.map(c=>c.id),nc=(st.cards||[]).map(c=>c.id);
 res.cards_active_old=oc.length;res.cards_active_new=nc.length;res.active_same_set=JSON.stringify([...oc].sort())===JSON.stringify([...nc].sort());
 res.archived_old=old.archived_count;res.archived_new=st.archived_count;
 res.search_old=oldS.cards.length;res.search_new=s.cards.length;
 const om=new Map(oldS.cards.map(c=>[c.id,c]));let diffs=[];
 for(const c of s.cards){const o=om.get(c.id);if(!o){diffs.push('new-only '+c.id);continue}for(const k of Object.keys(o))if(JSON.stringify(o[k])!==JSON.stringify(c[k]))diffs.push(c.id+' '+k)}
 res.search_missing=[...om.keys()].filter(i=>!s.cards.some(c=>c.id===i));res.search_field_diffs=diffs.slice(0,10);
 const os=old.sessions,ns=st.sessions;res.sessions_old=Object.keys(os).length;res.sessions_new=Object.keys(ns).length;
 res.session_missing=Object.keys(os).filter(k=>!ns[k]);
 const sd=[];for(const k of Object.keys(os))for(const f of Object.keys(os[k])){if(['pending','waiting','view','last_seen'].includes(f))continue;if(JSON.stringify(os[k][f])!==JSON.stringify(ns[k]?.[f]))sd.push(k+'.'+f+': '+JSON.stringify(os[k][f])+' -> '+JSON.stringify(ns[k]?.[f]))}
 res.session_field_diffs=sd;
 res.pending_old=Object.fromEntries(Object.entries(os).filter(([,v])=>v.pending).map(([k,v])=>[k,v.pending]));res.pending_new=Object.fromEntries(Object.entries(ns).filter(([,v])=>v.pending).map(([k,v])=>[k,v.pending]));
 res.view_old=Object.fromEntries(Object.entries(os).map(([k,v])=>[k,v.view]));res.view_new=Object.fromEntries(Object.entries(ns).map(([k,v])=>[k,v.view]));
 res.replies_old=old.replies.length;res.replies_new=(st.replies||[]).length;res.replies_same=JSON.stringify(old.replies)===JSON.stringify(st.replies);
 res.last_by_session_same=JSON.stringify(old.last_by_session)===JSON.stringify(st.last_by_session);
 console.log(JSON.stringify(res,null,1));
})();
