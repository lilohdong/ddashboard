// spawns detached children and exits (so the children's parent is dead = orphan)
const {spawn}=require('child_process');const fs=require('fs');
const [,,board,out]=process.argv;const pids={};
const o1=spawn(process.execPath,[board+'/bin/wait.js','s-alpha-fe'],{detached:true,stdio:'ignore',env:{...process.env,DDASH_BOARD_DIR:board,DDASH_POLL_MS:'200'}});o1.unref();pids.real020=o1.pid;
const o2=spawn(process.execPath,['-e','setInterval(()=>{},1000)',board+'/bin/wait.js','s-orphan-fake'],{detached:true,stdio:'ignore'});o2.unref();pids.fake=o2.pid;
fs.mkdirSync(board+'/inbox/s-orphan-fake',{recursive:true});fs.writeFileSync(board+'/inbox/s-orphan-fake/wait.lock',String(o2.pid));
fs.writeFileSync(out,JSON.stringify(pids));setTimeout(()=>process.exit(0),300);
