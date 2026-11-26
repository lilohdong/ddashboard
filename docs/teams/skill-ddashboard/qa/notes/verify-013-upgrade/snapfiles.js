const {BOARD,fs}=require('./lib');const crypto=require('crypto');
const out={};(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;if(e.isDirectory())w(p);else out[p.slice(BOARD.length+1)]=crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0,10)+' '+fs.statSync(p).size}})(BOARD);
console.log(JSON.stringify(out,null,1));
