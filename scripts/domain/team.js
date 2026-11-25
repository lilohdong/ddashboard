// Teams, roles and routing over plain objects (projects.json entries and session records). No I/O.
// projects.json[key].teams = { <name>: { lead, worktree, groups, created } }. A repo can have several teams. Each
// has one lead session; its members report only to that lead. A handoff changes only lead; name, worktree and
// groups stay. mode is 'team' while any team is left.
const { clearLeadContext } = require('./lead-context');
const { isEnded } = require('./session');

const DEFAULT_SPAWN = { permission_mode: 'auto', allowed_tools: ['Bash(git *)', 'Bash(node *)', 'Bash(npm *)'] };

// How new sessions start (plan M-1d): projects.json spawn.runner_lead (a new lead on handoff --spawn) and
// spawn.runner_member (members). headless | orca | window; default headless.
const RUNNER_VALUES = ['headless', 'orca', 'window'];
const runnersOf = (p) => Object.fromEntries(['runner_lead', 'runner_member'].map((k) => [k, RUNNER_VALUES.includes(p?.spawn?.[k]) ? p.spawn[k] : 'headless']));

const DEFAULT_TEAM_RULES = { peer_talk: false, qa_direct: false };

const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const GROUP_NAME_ERROR = 'group names use letters, digits, - and _ (up to 40)';
const GROUP_DEFAULTS = { keep_handoffs: 3, notes_days: 30 };
const badGroupName = (name) => !GROUP_NAME.test(String(name || '')) || String(name).startsWith('_');
const groupSettings = (g) => ({ ...GROUP_DEFAULTS, ...(g || {}) });

const teamsOf = (p) => (p && p.teams && typeof p.teams === 'object' ? p.teams : {});
// obj[key] only when it is obj's own entry, so names like "constructor" never hit Object.prototype.
const own = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);
// The key of obj equal to name ignoring case (folders on Windows/macOS ignore case), or undefined.
const sameName = (obj, name) => Object.keys(obj || {}).find((k) => k.toLowerCase() === String(name).toLowerCase());
const hasTeams = (p) => Object.keys(teamsOf(p)).length > 0;

// The team a session leads: { name, team } or null.
function teamOfLead(p, sid) {
  if (!sid) return null;
  for (const [name, team] of Object.entries(teamsOf(p))) if (team.lead === sid) return { name, team };
  return null;
}

// The team of a lead or member session: { name, team } or null.
function teamOfSession(s, p) {
  if (!s) return null;
  return teamOfLead(p, s.session_id) || (s.kind === 'member' && s.lead ? teamOfLead(p, s.lead) : null);
}

// A folder-safe team name from free text ('' if nothing usable is left).
const teamSlug = (name) => String(name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40);

function nextTeamName(p) {
  for (let i = 1; ; i++) if (!sameName(teamsOf(p), `team${i}`)) return `team${i}`;
}

// Members of a team (by its current lead).
const teamMembers = (sessions, key, team) => Object.values(sessions).filter((s) => s.project_key === key && s.kind === 'member' && s.lead === team.lead);

// Where a session stands in its project: solo | lead | member | outside (team mode, in no team).
// A member belongs to the team whose lead spawned it (s.lead); a member of a removed team is outside.
function teamRole(s, p) {
  if (!s || !p || !hasTeams(p)) return 'solo';
  if (teamOfLead(p, s.session_id)) return 'lead';
  if (s.kind === 'member' && s.lead && teamOfLead(p, s.lead)) return 'member';
  return 'outside';
}

// Where a session's card goes: the dashboard, or its lead's inbox. A member whose lead has
// ended (or is unknown) posts to the dashboard with a lead_missing flag.
function routeCard(sessions, projects, sid) {
  const s = sessions[sid];
  const role = teamRole(s, s && projects[s.project_key]);
  if (role !== 'member') return { to: 'board', role };
  const lead = sessions[s.lead];
  if (!lead || isEnded(lead)) return { to: 'board', role, lead_missing: true };
  return { to: 'lead', role, lead: s.lead };
}

function syncMode(p) {
  if (hasTeams(p)) p.mode = 'team';
  else if (p.mode) p.mode = 'solo';
}

// After a team change: mode follows the teams, mode_ver bumps (every session gets new instructions once).
function bumpMode(p) {
  syncMode(p);
  p.mode_ver = (Number(p.mode_ver) || 0) + 1;
  p.rules = { ...DEFAULT_TEAM_RULES, ...(p.rules || {}) };
}

// Add a team led by the given session (inside a projects + sessions update). Refuses a name in use and a session
// that already leads a team. No name: team1, team2, ... Other teams are not touched.
function addTeamIn(projects, sessions, key, name, lead, worktree) {
  const p = projects[key];
  if (!p) return { ok: false, error: 'project is not connected' };
  if (!own(sessions, lead)) return { ok: false, error: 'unknown lead session' };
  p.teams ||= {};
  const team = name ? teamSlug(name) : nextTeamName(p);
  if (!TEAM_NAME.test(team)) return { ok: false, error: 'team names use letters, digits, - and _ (up to 40)' };
  const taken = sameName(p.teams, team);
  if (taken) return { ok: false, code: 409, error: `team ${taken} exists in this project (names ignore case); pick another name` };
  const led = teamOfLead(p, lead);
  if (led) return { ok: false, code: 409, error: `this session already leads team ${led.name}` };
  p.teams[team] = { lead, worktree, groups: {}, created: new Date().toISOString() };
  bumpMode(p);
  sessions[lead].kind = 'lead';
  clearLeadContext(sessions[lead]);
  return { ok: true, team, mode: p.mode, mode_ver: p.mode_ver, lead };
}

// Remove teams by name (every team when names is empty). Their members are released (kind, lead and group
// cleared; former_lead kept), so they post to the dashboard and never rejoin a later team. Folders stay.
// The project is solo when no team is left.
function removeTeamsIn(projects, sessions, key, names) {
  const p = projects[key];
  if (!p) return { ok: false, error: 'project is not connected' };
  const list = names.length ? names : Object.keys(teamsOf(p));
  for (const n of list) if (!own(teamsOf(p), n)) return { ok: false, code: 404, error: `no team ${n}` };
  for (const n of list) {
    const leadSid = p.teams[n].lead;
    const lead = own(sessions, leadSid);
    if (lead?.kind === 'lead') delete lead.kind;
    clearLeadContext(lead);
    for (const m of teamMembers(sessions, key, p.teams[n])) {
      m.former_lead = leadSid;
      delete m.kind;
      delete m.lead;
      delete m.group;
    }
    delete p.teams[n];
  }
  bumpMode(p);
  return { ok: true, removed: list, mode: p.mode, mode_ver: p.mode_ver };
}

module.exports = {
  DEFAULT_SPAWN, RUNNER_VALUES, runnersOf, DEFAULT_TEAM_RULES, TEAM_NAME, GROUP_NAME, GROUP_NAME_ERROR, GROUP_DEFAULTS,
  badGroupName, groupSettings, isEnded, teamsOf, own, sameName, hasTeams, teamOfLead, teamOfSession, teamSlug,
  nextTeamName, teamMembers, teamRole, routeCard, syncMode, bumpMode, addTeamIn, removeTeamsIn,
};
