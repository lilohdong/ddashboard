const fs=require('fs'),path=require('path');const f=path.join(process.env.DDASH_BOARD_DIR,'sessions.json');
const s=JSON.parse(fs.readFileSync(f));const b=s.L2;
s.DEAD1={...b,session_id:'DEAD1',name:'qa-dead',kind:'member',role:'qa-dead',lead:'L2',claude_pid:999999,state:'working',last_seen:new Date().toISOString()};
fs.writeFileSync(f,JSON.stringify(s));
