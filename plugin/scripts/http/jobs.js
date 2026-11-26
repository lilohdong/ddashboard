// Process work off the request path (docs/architecture.md §3.2): use cases that spawn or kill processes, or read
// the process table, run in a worker thread, so their synchronous child_process calls (orca CLI, process table,
// window launchers) never block the server's event loop (/api/state keeps answering during a spawn).
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'job-worker.js');

// run('spawnMember', leadSid, opts) -> Promise of the use case's return value; rejects with its error message.
function run(name, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new Worker(WORKER, { workerData: { name, args } });
    w.once('message', (m) => {
      settled = true;
      if (m.ok) resolve(m.value);
      else reject(new Error(m.error));
    });
    w.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    w.once('exit', (code) => { if (!settled) { settled = true; reject(new Error(`job ${name} stopped (exit ${code})`)); } });
  });
}

module.exports = { run };
