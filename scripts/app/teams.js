// Team use cases on projects.json + sessions.json: read projects (with the pre-M-1b migration), add and remove
// teams (the dashboard switch), runners. The rules themselves are in domain/team.js.
const fs = require('fs');
const path = require('path');
const sessionsStore = require('../store/sessions');
const projectsStore = require('../store/projects');
const { deliver } = require('../store/inbox');
const {
  RUNNER_VALUES, runnersOf, GROUP_NAME, own, sameName, teamSlug, syncMode, addTeamIn, removeTeamsIn,
} = require('../domain/team');
const { slash, worktreeRoot, teamDir, ensureLeadRules, ensureGroupDir, moveDir } = require('./team-files');

// 0.3.0 settings before M-1b kept one lead per project (lead, lead_name, groups). They become one team named
// after lead_name, and docs/groups/<g>/ moves to docs/teams/<team>/<g>/ (git mv when tracked) inside the
// worktree that holds docs/groups/ (which becomes the team's worktree, even if the lead has moved since).
// A group folder in another worktree is not moved: it keeps its path and the lead is told once.
// Bumps mode_ver so running sessions get the new instructions. Returns true if p changed.
function migrateProject(p, sessions) {
  if (!p || typeof p !== 'object' || (p.teams && typeof p.teams === 'object')) return false;
  p.teams = {};
  if (p.mode === 'team' && p.lead) {
    const name = teamSlug(p.lead_name) || 'team1';
    const groups = Object.entries(p.groups && typeof p.groups === 'object' ? p.groups : {}).filter(([g]) => GROUP_NAME.test(g));
    const existing = groups.map(([, g]) => g?.dir).filter((d) => d && fs.existsSync(d));
    const base = existing[0] || own(sessions, p.lead)?.cwd || p.cwd;
    const team = { lead: p.lead, worktree: worktreeRoot(base), groups: {} };
    if (p.handoff) team.handoff = p.handoff;
    if (p.last_handoff) team.last_handoff = p.last_handoff;
    const oldRoots = new Set();
    const skipped = [];
    for (const [g, conf] of groups) {
      if (sameName(team.groups, g)) continue;
      let dir = slash(path.join(teamDir(team, name), g));
      try {
        if (conf?.dir && fs.existsSync(conf.dir) && !fs.existsSync(dir)) {
          if (worktreeRoot(conf.dir).toLowerCase() !== team.worktree.toLowerCase()) {
            dir = slash(conf.dir); // another worktree: a move would leave deletions in its index
            skipped.push(`${g} (${dir})`);
          } else {
            moveDir(conf.dir, dir);
            oldRoots.add(path.dirname(conf.dir));
          }
        }
        ensureGroupDir(dir, g);
      } catch (err) {
        dir = slash(conf?.dir || dir);
        skipped.push(`${g} (${err.message})`);
      }
      team.groups[g] = { ...conf, dir };
    }
    // Drop the old docs/groups/ folder if nothing is left in it.
    for (const d of oldRoots) try { fs.rmdirSync(d); } catch { /* not empty */ }
    p.teams[name] = team;
    p.mode_ver = (Number(p.mode_ver) || 0) + 1;
    if (skipped.length) {
      try {
        deliver(p.lead, {
          type: 'report', from: 'ddashboard', role: 'ddashboard', status: 'review',
          title: `group folders not moved to docs/teams/${name}/ (move them by hand in their worktree): ${skipped.join(', ')}`,
        });
      } catch { /* best effort */ }
    }
  }
  for (const k of ['lead', 'lead_name', 'groups', 'handoff', 'last_handoff']) delete p[k];
  syncMode(p);
  return true;
}

// projects.json, with settings from before M-1b moved to teams (saved once, on first read).
// Inside a sessions update the migration is applied in memory only (lock order: projects before sessions); the
// next read outside it saves it.
const needsMigration = (projects) => Object.values(projects).some((p) => p && typeof p === 'object' && !p.teams);
function migrateAll(projects) {
  const sessions = sessionsStore.read();
  for (const p of Object.values(projects)) {
    if (p && typeof p === 'object' && !p.teams) migrateProject(p, sessions);
  }
  return projects;
}
function readProjects() {
  const projects = projectsStore.read();
  if (!needsMigration(projects)) return projects;
  if (projectsStore.inUpdate() || sessionsStore.inUpdate()) return migrateAll(projects);
  return projectsStore.update(migrateAll);
}

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
