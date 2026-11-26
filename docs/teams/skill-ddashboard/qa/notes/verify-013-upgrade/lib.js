const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process'),http=require('http');
const T='C:/Users/rhkdr/AppData/Local/Temp/qa013-vCt0';
const BOARD=T+'/board', PORT=7363, OLD=T+'/old', NEW=T+'/new';
const env=(extra={})=>({...process.env,DDASH_BOARD_DIR:BOARD,DDASH_PORT:String(PORT),DDASH_WINDOW:'0',DDASH_ORCA:'0',DDASH_NAME:'',...extra});
function hook(root,name,input,extra){const r=spawnSync(process.execPath,[root+'/scripts/hooks/'+name+'.js'],{input:JSON.stringify(input),env:env(extra),encoding:'utf8',timeout:30000});return {out:r.stdout,err:r.stderr,code:r.status};}
function req(method,p,body){return new Promise((res,rej)=>{const d=body?JSON.stringify(body):null;const r=http.request({host:'127.0.0.1',port:PORT,path:p,method,headers:d?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}},(x)=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res({code:x.statusCode,body:JSON.parse(b)})}catch{res({code:x.statusCode,body:b})}})});r.on('error',rej);if(d)r.write(d);r.end();});}
const card=(o)=>'text before\n```card\n'+JSON.stringify(o)+'\n```\n';
module.exports={T,BOARD,PORT,OLD,NEW,env,hook,req,card,fs,path,spawnSync};
