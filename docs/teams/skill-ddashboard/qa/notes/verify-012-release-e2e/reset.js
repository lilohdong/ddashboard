// Stop the server this QA started (pid file in OUR board) and empty the board, for a fresh run.
const L = require('./lib'); const { S, fs } = L;
try { const p = L.readJ(S.board + '/server.pid', null); if (p && p.pid) process.kill(p.pid); } catch {}
setTimeout(() => {
  for (const f of fs.readdirSync(S.board)) fs.rmSync(S.board + '/' + f, { recursive: true, force: true });
  for (const f of fs.readdirSync(S.tx)) fs.rmSync(S.tx + '/' + f);
  fs.writeFileSync(L.HERE + '/evidence.txt', '');
  console.log('reset');
}, 1500);
