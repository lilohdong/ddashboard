// models.json: { sid: { model, ts } } from the SessionStart hook (also for sessions not registered yet), the newest
// 300 kept. Used only to spot 1M-context models.
const { paths } = require('../core/paths');
const { mapStore } = require('./record');

const store = mapStore(paths.models, 'models');
const KEEP = 300;

function remember(sid, model) {
  if (!sid || !model) return;
  store.update((all) => {
    all[sid] = { model: String(model), ts: new Date().toISOString() };
    const old = Object.entries(all).sort((a, b) => String(b[1]?.ts).localeCompare(String(a[1]?.ts))).slice(KEEP);
    for (const [k] of old) delete all[k];
  });
}

const known = (sid) => store.get(sid)?.model || '';

module.exports = { ...store, remember, known };
