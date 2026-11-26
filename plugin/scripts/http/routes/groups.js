// POST /api/groups {project, team?, action: create|rename|delete, name, new_name?, purge?} -> manage a team's groups
// (same as `team.js <lead> group ...`; needs a live lead). Deleting with purge ends members: off the request path.
const { paths } = require('../../core/paths');
const { readJson } = require('../../core/fsx');
const { teamsOf, own, isEnded } = require('../../domain/team');
const { readProjects } = require('../../app/teams');
const { fail } = require('../router');
const jobs = require('../jobs');
const { projectKeyOf } = require('./project');

const NEEDS_LEAD = 'groups need team mode with a live lead';

module.exports = [
  {
    method: 'POST', path: '/api/groups', sameOrigin: true, body: true,
    handler: async ({ body: msg }) => {
      const projects = readProjects();
      const sessions = readJson(paths.sessions, {});
      const key = projectKeyOf(projects, sessions, String(msg.project || ''));
      if (!key || !projects[key]) throw fail(404, 'unknown project', 'unknown_project');
      const list = teamsOf(projects[key]);
      const names = Object.keys(list);
      const tn = msg.team ? String(msg.team) : names.length === 1 ? names[0] : '';
      if (!names.length) throw fail(409, NEEDS_LEAD, 'no_lead');
      if (!own(list, tn)) throw tn ? fail(404, `no team ${tn}`, 'unknown_team') : fail(400, 'team required: this project has several teams');
      const lead = sessions[list[tn].lead];
      if (!lead || isEnded(lead)) throw fail(409, NEEDS_LEAD, 'no_lead');
      if (!['create', 'rename', 'delete'].includes(msg.action)) throw fail(400, 'action must be create, rename or delete');
      const args = { name: String(msg.name || ''), newName: String(msg.new_name || ''), purge: msg.purge === true };
      return jobs.run('groupAction', list[tn].lead, msg.action, args).catch((err) => { throw fail(400, String(err?.message || err)); });
    },
  },
];
