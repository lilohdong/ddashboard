// Session lifecycle use case: every write of state / ended / end_reason goes through domain/session.transition.
// apply(sid, event, ctx): one locked read-modify-write of sessions.json. applyIn(sessions, sid, event, ctx): the same
// inside an update already in progress (registerSession, markGone, handoff). Both return transition's result.
// Effects (stop on entry to ended, prune on forget) are returned to the caller; proc/supervisor applies them (step 5).
const sessionsStore = require('../store/sessions');
const { transition } = require('../domain/session');

function applyIn(sessions, sid, event, ctx = {}) {
  const s = Object.hasOwn(sessions, sid) ? sessions[sid] : undefined;
  const r = transition(s, event, ctx);
  if (!r.ok) return r;
  if (event === 'forget') delete sessions[sid];
  else if (event === 'spawn') sessions[sid] = r.s;
  else {
    for (const [k, v] of Object.entries(r.patch)) {
      if (v === undefined) delete s[k];
      else s[k] = v;
    }
  }
  return r;
}

function apply(sid, event, ctx = {}) {
  return sessionsStore.update((sessions) => applyIn(sessions, sid, event, ctx));
}

module.exports = { apply, applyIn };
