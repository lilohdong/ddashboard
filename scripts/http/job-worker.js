// Worker thread body for http/jobs.js: runs one named use case and posts { ok, value } or { ok: false, error }.
const { parentPort, workerData } = require('worker_threads');

const JOBS = {
  spawnMember: (...a) => require('../app/members').spawnMember(...a),
  endMember: (...a) => require('../app/members').endMember(...a),
  groupAction: (...a) => require('../app/members').groupAction(...a),
  markEnded: (...a) => require('../lib').markEnded(...a),
};

(async () => {
  const { name, args } = workerData;
  try {
    if (!JOBS[name]) throw new Error(`unknown job ${name}`);
    const value = await JOBS[name](...args);
    parentPort.postMessage({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.message || err) });
  }
})();
