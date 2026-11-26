const fs=require('fs');const p=require('path');
fs.writeFileSync(p.join(process.env.FAKE_DIR,'call-'+process.pid+'.json'),JSON.stringify({argv:process.argv.slice(2),input:fs.readFileSync(0,'utf8')}));
setTimeout(()=>{},120000);