// Team use cases on projects.json + sessions.json: read projects (projects without teams are migrated on read),
// add and remove teams (the dashboard switch), runners. The rules themselves are in domain/team.js.
const fs = require('fs');
const sessionsStore = require('../store/sessions');
const projectsStore = require('../store/projects');
const { deliver } = require('../store/inbox');
const migrate = require('../store/migrate');
const team = require('../domain/team');
const { RUNNER_VALUES, runnersOf, own, addTeamIn, removeTeamsIn } = team;
const { worktreeRoot, teamDir, ensureLeadRules, ensureGroupDir, moveDir } = require('./team-files');

// The file and git work of domain/team.js migrateProject (projects without teams; store/migrate.js runs it on read).
const migrateIo = {
  exists: (d) => fs.existsSync(d),
  worktreeRoot,
  teamDir,
  moveDir,
  ensureGroupDir,
  rmdir: (d) => { try { fs.rmdirSync(d); } catch { /* not empty */ } },
  notify: (lead, title) => {
    try { deliver(lead, { type: 'report', from: 'ddashboard', role: 'ddashboard', status: 'review', title }); } catch { /* best effort */ }
  },
};
const migrateProject = (p, sessions) => team.migrateProject(p, sessions, migrateIo);

// projects.json, with projects from before teams (0.2.x, pre-M-1b) migrated (saved once, on first read).
const readProjects = () => migrate.projects(migrateProject);

// Read projects.json, let fn change it, write it at once (keeps changes made since an earlier read). Returns fn's result.
function updateProjects(fn) {
  readProjects(); // migrate first
  return projectsStore.update(fn);
}

// Save a project's runners (either or both). Returns { ok, runner_lead, runner_member } or { ok: false, code, error }.
function setRunners(key, values = {}) {
  return updateProjects((projects) => {
    const p = own(projects, key);
    if (!p) return { ok: false, code: 404, error: 'project is not connected' };
    const keys = ['runner_lead', 'runner_member'].filter((k) => values[k] !== undefined);
    if (!keys.length) return { ok: false, code: 400, error: 'runner_lead or runner_member required' };
    for (const k of keys) if (!RUNNER_VALUES.includes(values[k])) return { ok: false, code: 400, error: `${k} must be one of ${RUNNER_VALUES.join(', ')}` };
    p.spawn = { ...(p.spawn || {}) };
    for (const k of keys) p.spawn[k] = values[k];
    return { ok: true, ...runnersOf(p) };
  });
}

// Add a team led by the given session (see domain/team addTeamIn); creates its lead-rules.md.
function addTeam(key, name, lead) {
  readProjects(); // migrate first
  // git outside the locks: the worktree of the lead's folder.
  const before = own(sessionsStore.read(), lead);
  const worktree = worktreeRoot(before?.cwd || projectsStore.get(key)?.cwd || process.cwd());
  const r = projectsStore.update((projects) => sessionsStore.update((sessions) => addTeamIn(projects, sessions, key, name, lead, worktree)));
  if (r.ok) ensureLeadRules({ worktree }, r.team);
  return r;
}

// Remove teams by name (every team when names is empty); see domain/team removeTeamsIn.
function removeTeams(key, names = []) {
  readProjects(); // migrate first
  return projectsStore.update((projects) => sessionsStore.update((sessions) => removeTeamsIn(projects, sessions, key, names)));
}

// Dashboard switch. team: add a team led by lead (named team or leadName). solo: remove the named team,
// or every team when none is named.
function setMode(key, mode, { lead, leadName, team } = {}) {
  if (mode === 'team') return addTeam(key, team || leadName, lead);
  return removeTeams(key, team ? [team] : []);
}

module.exports = { migrateProject, readProjects, updateProjects, setRunners, addTeam, removeTeams, setMode };
