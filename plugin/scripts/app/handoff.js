// Lead handoff: new lead `to` takes over from `from` (called from the new lead's first-prompt hook).
const sessionsStore = require('../store/sessions');
const inbox = require('../store/inbox');
const { own, teamOfLead } = require('../domain/team');
const { clearLeadContext } = require('../domain/lead-context');
const lifecycle = require('./lifecycle');
const { existingLeadRules } = require('./team-files');
const { readProjects, updateProjects } = require('./teams');

// Only the old lead's team changes: its lead and its members move; other teams are untouched. Moves the old lead's
// pending messages, marks the old lead ended (reason: handoff); the end's effects (supervisor) stop its wait command
// and Claude process. opts.kill / opts.killClaude for tests.
function performHandoff(from, to, doc, opts = {}) {
  const projects = readProjects();
  const r = sessionsStore.update((sessions) => handoffSessions(sessions, projects, from, to, doc));
  if (!r.ok) return r;
  const { key, t, old, members, ts, end } = r;
  // Re-read before writing: only this team's lead and handoff records change.
  updateProjects((all) => {
    const ft = teamOfLead(own(all, key), from);
    if (!ft) return;
    ft.team.lead = to;
    ft.team.last_handoff = { from, to, doc, ts };
    delete ft.team.handoff;
  });

  const moved = inbox.move(from, to);
  const stopped = lifecycle.runEffects(end, { kill: opts.kill, killClaude: opts.killClaude }) || {};
  const rules = existingLeadRules(t.team, t.name);
  return { ok: true, team: t.name, rules, members, moved, wait_killed: Boolean(stopped.waiter), claude_killed: Boolean(stopped.claude), claude_pid: old.claude_pid || 0 };
}

// The sessions part of a handoff (inside the sessions lock): checks, new lead, members, old lead ended.
function handoffSessions(sessions, projects, from, to, doc) {
  const old = sessions[from];
  const me = sessions[to];
  if (!old) return { ok: false, error: `unknown session ${from}` };
  if (!me) return { ok: false, error: `unknown session ${to}` };
  if (from === to) return { ok: false, error: 'a session cannot hand off to itself' };
  const key = old.project_key;
  const p = projects[key];
  if (!p) return { ok: false, error: 'the old lead\'s project is not connected' };
  if (me.project_key !== key) return { ok: false, error: 'the new lead is in a different project' };

  const t = teamOfLead(p, from);
  if (!t) return { ok: false, error: 'the old session leads no team' };
  const mine = teamOfLead(p, to);
  if (mine) return { ok: false, error: `the new lead already leads team ${mine.name}` };

  const ts = new Date().toISOString();

  me.kind = 'lead';
  clearLeadContext(me);
  me.handoff_from = from;
  if (doc) me.handoff_doc = doc;
  let members = 0;
  for (const s of Object.values(sessions)) {
    if (s.kind === 'member' && s.lead === from) { s.lead = to; members++; }
  }
  delete old.kind;
  const end = lifecycle.applyIn(sessions, from, 'end', { reason: 'handoff', replaced_by: to, ts });
  return { ok: true, key, t, old, members, ts, end };
}

module.exports = { performHandoff, handoffSessions };
