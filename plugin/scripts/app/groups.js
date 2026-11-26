// Groups (team mode): docs/teams/<team>/<group>/ in the team lead's worktree holds a group's memory:
// brief.md (injected into every new member before its task), handoff-NNN.md, notes/.
// Groups belong to one team: two teams may use the same group name, and one team's upkeep never
// touches another team's folders. Folder work is in app/team-files.js.
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const { gitOrNull: gitIn } = require('../core/git');
const sessionsStore = require('../store/sessions');
const projectsStore = require('../store/projects');
const { deliver } = require('../store/inbox');
const { GROUP_NAME_ERROR, GROUP_DEFAULTS, badGroupName, teamsOf, own, sameName, hasTeams, teamMembers } = require('../domain/team');
const { slash, worktreeRoot, teamDir, ensureGroupDir, moveDir } = require('./team-files');
const { readProjects } = require('./teams');

// The team's entry in a copy of projects (for checks and folder work outside the lock): { p, team } or { error }.
// Its worktree is filled in when missing (git), so teamIn can store it.
function teamFor(key, teamName) {
  const p = own(readProjects(), key);
  if (!p) return { error: 'project is not connected' };
  const team = own(teamsOf(p), teamName);
  if (!team) return { error: `no team ${teamName}` };
  team.groups ||= {};
  if (!team.worktree) team.worktree = worktreeRoot(sessionsStore.get(team.lead)?.cwd || p.cwd || process.cwd());
  return { p, team };
}

// The same team inside a projects update (the map being written), or null when it is gone meanwhile.
function teamIn(projects, key, teamName, worktree) {
  const team = own(teamsOf(own(projects, key)), teamName);
  if (!team) return null;
  team.groups ||= {};
  team.worktree ||= worktree;
  return team;
}
const TEAM_GONE = (teamName) => ({ ok: false, error: `no team ${teamName}` });

function groupsOf(key, teamName) {
  return teamsOf(readProjects()[key])[teamName]?.groups || {};
}

function createGroup(key, teamName, name) {
  if (badGroupName(name)) return { ok: false, error: GROUP_NAME_ERROR };
  const { team, error } = teamFor(key, teamName);
  if (error) return { ok: false, error };
  const taken = sameName(team.groups, name);
  if (taken) return { ok: false, error: `group ${taken} exists in team ${teamName} (names ignore case)` };
  const dir = slash(path.join(teamDir(team, teamName), name));
  ensureGroupDir(dir, name);
  return projectsStore.update((projects) => {
    const t = teamIn(projects, key, teamName, team.worktree);
    if (!t) return TEAM_GONE(teamName);
    const again = sameName(t.groups, name);
    if (again) return { ok: false, error: `group ${again} exists in team ${teamName} (names ignore case)` };
    t.groups[name] = { dir, created: new Date().toISOString(), ...GROUP_DEFAULTS };
    return { ok: true, dir };
  });
}

function renameGroup(key, teamName, name, next) {
  if (badGroupName(next)) return { ok: false, error: GROUP_NAME_ERROR };
  const { team, error } = teamFor(key, teamName);
  if (error) return { ok: false, error };
  const g = own(team.groups, name);
  if (!g) return { ok: false, error: `no group ${name} in team ${teamName}` };
  const taken = sameName(team.groups, next);
  if (taken) return { ok: false, error: `group ${taken} exists in team ${teamName} (names ignore case)` };
  const dir = slash(path.join(path.dirname(g.dir), next));
  if (fs.existsSync(dir)) return { ok: false, error: `folder exists: ${dir}` };
  let how = 'none';
  if (fs.existsSync(g.dir)) how = moveDir(g.dir, dir);
  projectsStore.update((projects) => {
    const t = teamIn(projects, key, teamName, team.worktree);
    if (!t) return;
    t.groups[next] = { ...(own(t.groups, name) || g), dir };
    delete t.groups[name];
  });
  sessionsStore.update((sessions) => {
    for (const s of teamMembers(sessions, key, team)) if (s.group === name) s.group = next;
  });
  return { ok: true, dir, moved: how };
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

// Remove a group: its members become unassigned; the folder moves to docs/teams/<team>/_archived/<name>-<date>/
// (purge: deleted instead).
function deleteGroup(key, teamName, name, { purge = false } = {}) {
  const { team, error } = teamFor(key, teamName);
  if (error) return { ok: false, error };
  const g = own(team.groups, name);
  if (!g) return { ok: false, error: `no group ${name} in team ${teamName}` };
  let folder = null;
  if (fs.existsSync(g.dir)) {
    if (purge) {
      fs.rmSync(g.dir, { recursive: true, force: true });
      folder = 'deleted';
    } else {
      const base = path.join(path.dirname(g.dir), '_archived', `${name}-${stamp()}`);
      let to = base;
      for (let i = 2; fs.existsSync(to); i++) to = `${base}-${i}`;
      moveDir(g.dir, to);
      folder = slash(to);
    }
  }
  projectsStore.update((projects) => {
    const t = teamIn(projects, key, teamName, team.worktree);
    if (t) delete t.groups[name];
  });
  sessionsStore.update((sessions) => {
    for (const s of teamMembers(sessions, key, team)) if (s.group === name) delete s.group;
  });
  return { ok: true, folder };
}

const BRIEF_STALE_COMMITS = config.get('DDASH_BRIEF_STALE_COMMITS');

// Brief staleness for a team project's groups. When a brief.md changes (new mtime), remember the git HEAD
// of its worktree; once HEAD is BRIEF_STALE_COMMITS or more commits past that, tell that team's lead once
// (until the brief changes again). Called from the Stop hook and team.js spawn. Returns the groups reported
// (as <team>/<group>).
function checkBriefs(key) {
  const p = own(readProjects(), key);
  if (!hasTeams(p)) return [];
  const changes = []; // [teamName, group name, fields (undefined deletes)]
  const told = [];
  for (const [teamName, team] of Object.entries(p.teams)) {
    for (const [name, g] of Object.entries(team.groups || {})) {
      let mtime;
      try { mtime = fs.statSync(path.join(g.dir, 'brief.md')).mtimeMs; } catch { continue; }
      const head = gitIn(['rev-parse', 'HEAD'], g.dir);
      if (!head) continue;
      if (g.brief_mtime !== mtime || !g.brief_head) {
        changes.push([teamName, name, { brief_mtime: mtime, brief_head: head, brief_stale_warned: undefined }]);
        continue;
      }
      if (g.brief_stale_warned || g.brief_head === head || !team.lead) continue;
      const n = Number(gitIn(['rev-list', '--count', `${g.brief_head}..HEAD`], g.dir));
      if (!(n >= BRIEF_STALE_COMMITS)) continue;
      deliver(team.lead, {
        type: 'report', from: name, role: 'ddashboard', status: 'review',
        title: `brief ${name} may be stale: ${n} commits since it was last updated (${slash(path.join(g.dir, 'brief.md'))})`,
      });
      changes.push([teamName, name, { brief_stale_warned: head }]);
      told.push(`${teamName}/${name}`);
    }
  }
  if (changes.length) setGroupFields(key, changes);
  return told;
}

// Set fields of groups in projects.json: changes = [[teamName, groupName, { field: value | undefined }]].
// Groups removed meanwhile are skipped.
function setGroupFields(key, changes) {
  projectsStore.update((projects) => {
    for (const [teamName, name, fields] of changes) {
      const g = own(own(teamsOf(own(projects, key)), teamName)?.groups, name);
      if (!g) continue;
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    }
  });
}

module.exports = { BRIEF_STALE_COMMITS, groupsOf, createGroup, renameGroup, deleteGroup, checkBriefs, setGroupFields };
