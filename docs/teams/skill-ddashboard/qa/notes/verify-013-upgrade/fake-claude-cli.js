// fake live "claude" parent for the control waiter
const {spawn}=require('child_process');const fs=require('fs');
const [,,board,out]=process.argv;
const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)',board+'/bin/wait.js','s-ctl-live'],{stdio:'ignore'});
fs.mkdirSync(board+'/inbox/s-ctl-live',{recursive:true});fs.writeFileSync(board+'/inbox/s-ctl-live/wait.lock',String(c.pid));
fs.writeFileSync(out,JSON.stringify({claude:process.pid,waiter:c.pid}));
setInterval(()=>{},1000);
