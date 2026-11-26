const fs=require('fs');const f=require('path').join(process.env.DDASH_BOARD_DIR,'sessions.json');
const s=JSON.parse(fs.readFileSync(f));s.L1.claude_pid=+process.argv[2];fs.writeFileSync(f,JSON.stringify(s));
const r=require(process.argv[3]+'/scripts/app/handoff.js').performHandoff('L1','L2',process.argv[4]);
console.log(JSON.stringify(r));
const t=JSON.parse(fs.readFileSync(f));for(const k in t)console.log(k.slice(0,8),t[k].kind,t[k].role||'',t[k].lead||'',t[k].state,t[k].end_reason||'');
