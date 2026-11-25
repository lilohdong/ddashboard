// GET /api/state: sessions (with their displayed view, team place, pending messages), teams, replies, recent cards
// and usage. Read-only: it writes no board file (gone sessions are ended by the server's liveness tick).
const fs = require('fs');
const path = require('path');
const { paths } = require('../core/paths');
const { readJson } = require('../core/fsx');
const { waitPid } = require('../proc/waiter');
const { teamRole, routeCard, teamOfSession, teamsOf, runnersOf } = require('../domain/team');
const { isStale, STALE_MIN } = require('../domain/session');
const { leadLimit } = require('../domain/lead-context');
const { readSettings } = require('./settings');
const { readProjects } = require('./teams');
const cards = require('./cards');
const replies = require('../store/replies');
const usage = require('./usage');
const config = require('../core/config');
const { view } = require('../domain/session');


const CONTEXT_WARN = config.get('DDASH_CONTEXT_WARN');

// A live wait command whose owner (when known) is alive: see proc/waiter.waitPid.
const waiting = (sid) => Boolean(waitPid(sid));

function pendingCount(sid) {
  try { return fs.readdirSync(paths.inbox(sid)).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

// Mode and teams per connected project, keyed by the project name the dashboard groups sessions by.
function teams(projects, sessions) {
  const nameOf = {};
  for (const s of Object.values(sessions)) if (s.project_key && s.project) nameOf[s.project_key] ||= s.project;
  const out = {};
  for (const [key, p] of Object.entries(projects)) {
    const name = p.name || nameOf[key] || path.basename(p.cwd || key);
    const list = {};
    for (const [tn, t] of Object.entries(teamsOf(p))) {
      const groups = Object.fromEntries(Object.entries(t.groups || {}).map(([n, g]) => [n, { dir: g.dir, created: g.created }]));
      list[tn] = { lead: t.lead || null, worktree: t.worktree || null, groups };
    }
    out[name] = { key, mode: Object.keys(list).length ? 'team' : 'solo', mode_ver: Number(p.mode_ver) || 0, teams: list, ...runnersOf(p) };
  }
  return out;
}

function build({ reports = false } = {}) {
  const sessions = readJson(paths.sessions, {});
  const projects = readProjects();
  for (const s of Object.values(sessions)) {
    s.pending = pendingCount(s.session_id);
    s.waiting = waiting(s.session_id);
    s.project = s.project || s.name;
    // Displayed state: ended > working > listening (wait command alive) > idle.
    // Unresponsive: idle, no live wait command, not seen for stale_min minutes.
    const v = view(s, { waiting: s.waiting, stale: isStale(s) });
    s.view = v.view;
    s.unresponsive = v.unresponsive;
    // Place in the team: solo | lead | member | outside (team mode, untagged)
    s.team = teamRole(s, projects[s.project_key]);
    const own = s.team === 'lead' || s.team === 'member' ? teamOfSession(s, projects[s.project_key]) : null;
    if (own) s.team_name = own.name;
    if (s.team === 'lead' && s.lead_baseline !== undefined) {
      const lim = leadLimit(s.lead_baseline, s.context_window); // the stored window: never back to 200k after a compact
      Object.assign(s, { lead_handoff_at: lim.at, context_window: lim.window, baseline_big: lim.big });
    }
    if (s.team === 'member' && routeCard(sessions, projects, s.session_id).lead_missing) s.lead_missing = true;
  }
  const { cards: recent, last_by_session, archived_count } = cards.state(300, { reports });
  const { usage_total, usage_today } = usage.state(Object.keys(sessions));
  return {
    teams: teams(projects, sessions),
    sessions,
    replies: replies.recent(1000),
    cards: recent,
    last_by_session,
    archived_count,
    usage_total,
    usage_today,
    context_warn: CONTEXT_WARN,
    stale_min: STALE_MIN,
    settings: { lang: readSettings().lang || null },
  };
}

module.exports = { build, teams, pendingCount };
