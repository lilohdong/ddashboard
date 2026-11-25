// Session use cases on sessions.json: register, state writes from hooks, the Claude pid, forget, mark gone or
// ended. Every state change goes through app/lifecycle.js (domain/session.js state machine).
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const { paths } = require('../core/paths');
const { git } = require('../core/git');
const sessionsStore = require('../store/sessions');
const { processTable, findClaudePid } = require('../proc/table');
const { waitPid, orphanWaiter, needsProcesses, stopSessionProcesses } = require('../proc/waiter');
const supervisor = require('../proc/supervisor');
const { isEnded, isStale, transition } = require('../domain/session');
const { own } = require('../domain/team');
const lifecycle = require('./lifecycle');
const { projectKey, projectName } = require('./projects');

function registerSession(sid, cwd) {
  // git first, outside the lock.
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  const project = projectName(cwd);
  const key = projectKey(cwd);
  sessionsStore.update((sessions) => {
    sessions[sid] = {
      ...(sessions[sid] || {}),
      session_id: sid,
      name: config.get('DDASH_NAME') || sessions[sid]?.name || path.basename(cwd),
      cwd,
      branch,
      project,
      project_key: key,
    };
    // working stays working, anything else is idle; an ended session is revived, except a lead replaced by a
    // handoff, which stays ended even if the session is resumed.
    lifecycle.applyIn(sessions, sid, 'register');
  });
}

// Old entry for state writes (kept for callers and tests): working -> prompt, idle -> stop, ended -> end (exit).
// Only touches registered sessions; an ended session keeps its state. Returns true when the record exists.
function setState(sid, state) {
  const r = state === 'ended' ? lifecycle.apply(sid, 'end', { reason: 'exit' })
    : lifecycle.apply(sid, state === 'working' ? 'prompt' : 'stop', { busy: false });
  return r.ok || r.code !== 404;
}

const isRegistered = (sid) => Boolean(sessionsStore.get(sid));

// Save the session's Claude Code pid (best effort). Returns the pid or 0.
function recordClaudePid(sid, startPid = process.ppid) {
  const pid = findClaudePid(startPid);
  if (!pid) return 0;
  return sessionsStore.patch(sid, { claude_pid: pid }) ? pid : 0;
}

// Remove a session's inbox dir if nothing is left in it (no pending messages, no live waiter).
function removeEmptyInbox(sid) {
  const dir = paths.inbox(sid);
  if (waitPid(sid)) return;
  try { fs.unlinkSync(path.join(dir, 'wait.lock')); } catch { /* none */ }
  try { fs.rmdirSync(paths.done(sid)); } catch { /* not empty */ }
  try { fs.rmdirSync(dir); } catch { /* not empty */ }
}

// Drop ended sessions from sessions.json (cards and usage stay). Returns { forgotten, refused }:
// sessions that are not ended are refused.
function forgetSessions(ids) {
  const forgotten = [];
  const refused = [];
  sessionsStore.update((sessions) => {
    for (const id of ids) {
      const s = own(sessions, id);
      if (!s) continue;
      if (!lifecycle.applyIn(sessions, id, 'forget').ok) { refused.push(id); continue; }
      forgotten.push(s);
    }
  });
  // Nothing of a forgotten session may keep running (bug-005): its waiter, a dead Claude's tool shells.
  let table = null;
  for (const s of forgotten) {
    if (needsProcesses(s)) try { stopSessionProcesses(s, (table = table || processTable())); } catch { /* best effort */ }
    removeEmptyInbox(s.session_id);
  }
  return { forgotten: forgotten.map((s) => s.session_id), refused };
}

// True when the session's Claude process (or run, window, terminal) is known to be gone (proc/supervisor.js).
const sessionGone = supervisor.gone;

// Mark these sessions ended (end_reason 'gone') in sessions.json and stop what they left running. Returns the ids changed.
function markGone(sids, table) {
  if (!sids.length) return [];
  const ts = new Date().toISOString();
  const ended = [];
  sessionsStore.update((sessions) => {
    for (const sid of sids) {
      const r = own(sessions, sid) && lifecycle.applyIn(sessions, sid, 'end', { reason: 'gone', ts, seen: false });
      if (r?.ok) ended.push([sid, r]);
    }
  });
  for (const [, r] of ended) lifecycle.runEffects(r, { table: table || undefined });
  return ended.map(([sid]) => sid);
}

function markEnded(sid) {
  const s = sessionsStore.get(sid);
  if (!s) return { ok: false, code: 404, error: 'unknown session' };
  if (isEnded(s)) return { ok: true };
  // A session whose Claude process is dead may be marked ended even while it still says "working".
  const gone = sessionGone(s);
  // A wait command with no live Claude above it (bug-005, e.g. one from an older plugin version) is not activity.
  let table = null;
  const wp = waitPid(sid);
  const waiting = wp && !orphanWaiter(wp, (table = processTable()));
  const ctx = { reason: 'marked', gone, waiting: Boolean(waiting), stale: isStale(s), seen: false, ts: new Date().toISOString() };
  const check = transition(s, 'end', ctx);
  if (!check.ok) return { ok: false, code: check.code, error: check.error };
  const r = lifecycle.apply(sid, 'end', { ...ctx, stop: { table: table || undefined } });
  if (!r.ok && !isEnded(sessionsStore.get(sid))) return { ok: false, code: r.code, error: r.error };
  return { ok: true };
}

module.exports = {
  registerSession, setState, isRegistered, recordClaudePid, removeEmptyInbox, forgetSessions, sessionGone, markGone,
  markEnded,
};
