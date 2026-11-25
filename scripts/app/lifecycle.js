// Session lifecycle use case: every write of state / ended / end_reason goes through domain/session.transition,
// and every entry to ended runs proc/supervisor.stop (outside the sessions lock).
// apply(sid, event, ctx): one locked read-modify-write of sessions.json, then the effects; ctx.stop: options for
//   supervisor.stop (table, closeTerminal, windowShell, kill/killClaude for tests), or false to skip it.
//   Returns transition's result plus stopped: supervisor.stop's result.
// applyIn(sessions, sid, event, ctx): the same inside an update already in progress (registerSession, markGone,
//   handoff); it returns the effects and the caller runs them with runEffects after the update.
// reapGone(isOpen, table): the server's liveness tick: every non-ended session the supervisor finds gone is ended
//   (reason gone) and stopped. Returns the ids.
const sessionsStore = require('../store/sessions');
const { transition, isEnded } = require('../domain/session');
const supervisor = require('../proc/supervisor');
const { processTable } = require('../proc/table');

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

// Run a transition's stop effect (best effort: a failure to stop a process never undoes the state change).
function runEffects(r, opts = {}) {
  if (!r?.ok || opts === false) return null;
  const e = r.effects.find((x) => x.type === 'stop');
  if (!e) return null;
  try { return supervisor.stop(r.s, e.reason, opts); } catch { return null; }
}

function apply(sid, event, ctx = {}) {
  const r = sessionsStore.update((sessions) => applyIn(sessions, sid, event, ctx));
  const stopped = runEffects(r, ctx.stop);
  return stopped ? { ...r, stopped } : r;
}

function reapGone(isOpen, table) {
  const ids = Object.values(sessionsStore.read()).filter((s) => !isEnded(s) && supervisor.gone(s, isOpen, table)).map((s) => s.session_id);
  const done = [];
  const ts = new Date().toISOString();
  if (ids.length && !table) table = processTable(); // one table for every stop below
  for (const sid of ids) {
    // Checked again under the lock: only a session that still is not ended changes.
    if (apply(sid, 'end', { reason: 'gone', seen: false, ts, stop: { table } }).ok) done.push(sid);
  }
  return done;
}

module.exports = { apply, applyIn, runEffects, reapGone };
