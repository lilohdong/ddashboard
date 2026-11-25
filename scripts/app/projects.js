// Projects connected to the dashboard (projects.json): the key and name of a folder's project, on/off.
const path = require('path');
const { git } = require('../core/git');
const projectsStore = require('../store/projects');
const { readProjects } = require('./teams');

// Worktrees of the same repository count as one project (keyed by the git common dir).
function projectKey(cwd) {
  const common = git('rev-parse --path-format=absolute --git-common-dir', cwd);
  return path.resolve(common || cwd).toLowerCase();
}

// Project name shown on the dashboard: the repository folder name (worktrees group under the original repo).
function projectName(cwd) {
  const common = git('rev-parse --path-format=absolute --git-common-dir', cwd);
  if (!common) return path.basename(cwd);
  const dir = path.resolve(common);
  return path.basename(dir) === '.git' ? path.basename(path.dirname(dir)) : path.basename(dir).replace(/\.git$/, '');
}

function projectActive(cwd) {
  return Boolean(readProjects()[projectKey(cwd)]);
}

// Turning a project on keeps its team settings (mode, teams, rules) from before. Returns how many are connected.
function setProject(cwd, on) {
  const key = projectKey(cwd);
  const name = on ? projectName(cwd) : '';
  readProjects(); // migrate first (outside our update)
  return projectsStore.update((projects) => {
    if (on) projects[key] = { ...(projects[key] || {}), since: new Date().toISOString(), cwd, name };
    else delete projects[key];
    return Object.keys(projects).length;
  });
}

module.exports = { projectKey, projectName, projectActive, setProject };
