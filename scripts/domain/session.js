// Session lifecycle (docs/architecture.md §4.1). Pure: no I/O, no clock unless ctx.ts is missing.
//
// Persisted phase: pending | working | idle | ended (ended carries end_reason: exit | gone | stopped | marked | handoff).
// A spawned member is "pending" until its first hook: kept on disk as state 'working' + pending: true, so readers
// of older plugin versions still see it as working.
//
// transition(s, event, ctx) -> { ok, patch, s, effects, code?, error? }
//   patch:   the fields to write (undefined = delete the field), for store.patch or Object.assign-and-delete
//   s:       the record after the patch (a copy)
//   effects: [{ type: 'stop', sid, reason }] on entry to ended; [{ type: 'prune', sid }] on forget
// An illegal event returns ok: false and an empty patch (callers ignore it, or report code/error).
//
// Events (ctx.ts: ISO time, default now):
//   spawn     ctx.fields: the new record's fields                       (none) -> pending
//   register  SessionStart / first prompt / /dashboard                  any -> working|idle (revives an ended
//                                                                       session, except a handoff, which stays ended)
//   prompt    a prompt was submitted / the waiter delivered messages    non-ended -> working
//   stop      Stop hook; ctx.busy: messages or a notice were handed over non-ended -> working (busy) | idle
//   resume    team send resumed an ended or finished member             any but ended(handoff) -> working
//   end       ctx.reason: exit|gone|stopped|marked|handoff               non-ended -> ended
//             marked needs ctx.gone, or idle && !ctx.waiting && ctx.stale (409 otherwise)
//             handoff (ctx.replaced_by) also applies to an ended lead (a dead lead is taken over), once
//             ctx.seen === false: last_seen is left as it was (gone, marked)
//   forget    ended -> (record deleted)                                 409 not_ended otherwise
// ctx.fields on any event but spawn: other fields written with the transition (undefined deletes), only when it
// is legal; lifecycle fields in it (state, ended, end_reason, replaced_by) are ignored.

const PHASES = ['pending', 'working', 'idle', 'ended'];
const END_REASONS = ['exit', 'gone', 'stopped', 'marked', 'handoff'];

const isEnded = (s) => Boolean(s && (s.ended || s.state === 'ended'));

function phase(s) {
  if (!s) return null;
  if (isEnded(s)) return 'ended';
  if (s.pending || s.state === 'pending') return 'pending';
  return s.state === 'working' ? 'working' : 'idle';
}

const LIFECYCLE_FIELDS = ['state', 'ended', 'end_reason', 'replaced_by'];
const now = (ctx) => ctx.ts || new Date().toISOString();

const refuse = (s, code, error) => ({ ok: false, patch: {}, s: s ? { ...s } : s, effects: [], code, error });

function result(s, patch, effects = []) {
  const next = { ...(s || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return { ok: true, patch, s: next, effects };
}

function transition(s, event, ctx = {}) {
  const r = step(s, event, ctx);
  if (!r.ok || event === 'spawn' || event === 'forget' || !ctx.fields) return r;
  const extra = Object.fromEntries(Object.entries(ctx.fields).filter(([k]) => !LIFECYCLE_FIELDS.includes(k)));
  return result(s, { ...extra, ...r.patch }, r.effects);
}

function step(s, event, ctx) {
  const ts = now(ctx);
  const p = phase(s);
  const sid = s?.session_id || ctx.fields?.session_id;

  if (event === 'spawn') {
    if (s) return refuse(s, 409, 'session exists');
    return result(null, { ...(ctx.fields || {}), state: 'working', pending: true, started: ts, last_seen: ts });
  }
  if (!s) return refuse(s, 404, 'unknown session');

  switch (event) {
    case 'register': {
      if (s.replaced_by) return result(s, { state: 'ended', last_seen: ts });
      const patch = { state: s.state === 'working' ? 'working' : 'idle', last_seen: ts, started: s.started || ts };
      if (p === 'ended') Object.assign(patch, { ended: undefined, end_reason: undefined });
      return result(s, patch);
    }
    case 'prompt':
      if (p === 'ended') return refuse(s, 409, 'session has ended');
      return result(s, { state: 'working', last_seen: ts });
    case 'stop':
      if (p === 'ended') return refuse(s, 409, 'session has ended');
      return result(s, { state: ctx.busy ? 'working' : 'idle', last_seen: ts });
    case 'resume':
      if (s.replaced_by || s.end_reason === 'handoff') return refuse(s, 409, 'session was replaced by a handoff');
      return result(s, { state: 'working', last_seen: ts, ended: undefined, end_reason: undefined });
    case 'end': {
      const reason = ctx.reason || 'exit';
      if (!END_REASONS.includes(reason)) return refuse(s, 400, `unknown end reason ${reason}`);
      if (p === 'ended' && (reason !== 'handoff' || s.replaced_by)) return refuse(s, 409, 'session has ended');
      if (reason === 'marked' && !ctx.gone && (s.state === 'working' || ctx.waiting || !ctx.stale)) {
        return refuse(s, 409, 'session is active (working, waiting or seen recently)');
      }
      const patch = { state: 'ended', ended: ts, end_reason: reason === 'marked' && ctx.gone ? 'gone' : reason };
      if (ctx.seen !== false) patch.last_seen = ts;
      if (reason === 'handoff' && ctx.replaced_by) patch.replaced_by = ctx.replaced_by;
      return result(s, patch, [{ type: 'stop', sid, reason: patch.end_reason }]);
    }
    case 'forget':
      if (p !== 'ended') return refuse(s, 409, 'session has not ended');
      return { ok: true, patch: {}, s: null, effects: [{ type: 'prune', sid }] };
    default:
      return refuse(s, 400, `unknown event ${event}`);
  }
}

// Displayed state, one function for the dashboard and `team list`.
// live: { waiting (wait command alive with a live owner), stale (not seen for STALE_MIN), pidAlive (headless run) }.
// Returns { phase, state, view, unresponsive, finished }:
//   view:  ended > working > waiting > idle (the dashboard's s.view; pending shows as working)
//   state: ended > finished > the persisted state ('working' | 'idle'), as `team list` prints it
function view(s, live = {}) {
  const ph = phase(s);
  const ended = ph === 'ended';
  const finished = !ended && Boolean(s.headless && s.pid && !live.pidAlive && !live.waiting);
  const v = ended ? 'ended' : s.state === 'working' ? 'working' : live.waiting ? 'waiting' : 'idle';
  return {
    phase: ph,
    view: v,
    unresponsive: v === 'idle' && Boolean(live.stale),
    finished,
    state: ended ? 'ended' : finished ? 'finished' : s.state || 'idle',
  };
}

module.exports = { PHASES, END_REASONS, isEnded, phase, transition, view };
