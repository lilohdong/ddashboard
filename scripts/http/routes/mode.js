// POST /api/mode {project, mode: team, lead, team?} adds a team led by that session;
// {project, mode: solo, team?} removes that team (no team: every team).
const { paths, safeId } = require('../../core/paths');
const { readJson } = require('../../core/fsx');
const { readProjects, setMode } = require('../../app/teams');
const { fail } = require('../router');
const { projectKeyOf } = require('./project');

module.exports = [
  {
    method: 'POST', path: '/api/mode', sameOrigin: true, body: true,
    handler: ({ body: msg }) => {
      const projects = readProjects();
      const sessions = readJson(paths.sessions, {});
      const key = projectKeyOf(projects, sessions, String(msg.project || ''));
      if (!key || !projects[key]) throw fail(404, 'unknown project', 'unknown_project');
      if (msg.mode !== 'team' && msg.mode !== 'solo') throw fail(400, 'mode must be solo or team');
      let lead;
      if (msg.mode === 'team') {
        lead = safeId(msg.lead);
        const s = sessions[lead];
        if (!s || s.project_key !== key) throw fail(400, 'lead must be a session of this project');
        if (s.ended || s.state === 'ended') throw fail(409, 'lead session has ended', 'session_ended');
      }
      const team = msg.team ? String(msg.team) : msg.lead_name ? String(msg.lead_name) : undefined;
      const r = setMode(key, msg.mode, { lead, team });
      if (!r.ok) throw fail(r.code || 400, r.error);
      return r;
    },
  },
];
