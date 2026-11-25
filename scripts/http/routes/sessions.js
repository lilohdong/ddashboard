// POST /api/sessions/forget {session_id} | {project, ended: true} -> drop ended sessions from the sidebar.
// POST /api/sessions/end {session_id} -> mark an idle, stale session (or one whose Claude is dead) as ended.
const { paths, safeId } = require('../../core/paths');
const { readJson } = require('../../core/fsx');
const { isEnded } = require('../../domain/session');
const { readProjects } = require('../../app/teams');
const { forgetSessions } = require('../../app/sessions');
const { fail } = require('../router');
const jobs = require('../jobs');
const { projectKeyOf } = require('./project');

const END_CODES = { 404: 'unknown_session', 409: 'session_active' };

module.exports = [
  {
    method: 'POST', path: '/api/sessions/forget', sameOrigin: true, body: true,
    handler: ({ body: msg }) => {
      const sessions = readJson(paths.sessions, {});
      let ids;
      if (msg.session_id) {
        const sid = safeId(msg.session_id);
        if (!sessions[sid]) throw fail(404, 'unknown session', 'unknown_session');
        if (!isEnded(sessions[sid])) throw fail(409, 'session has not ended', 'session_active');
        ids = [sid];
      } else if (msg.project && msg.ended === true) {
        const name = String(msg.project);
        const key = projectKeyOf(readProjects(), sessions, name);
        ids = Object.values(sessions).filter((s) => isEnded(s) && (key ? s.project_key === key : s.project === name)).map((s) => s.session_id);
      } else throw fail(400, 'session_id, or project with ended: true, required');
      const r = forgetSessions(ids);
      if (msg.session_id && r.refused.length) throw fail(409, 'session has not ended', 'session_active');
      return { ok: true, forgotten: r.forgotten.length };
    },
  },
  {
    // Reads the process table and may stop processes: off the request path (http/jobs.js).
    method: 'POST', path: '/api/sessions/end', sameOrigin: true, body: true,
    handler: async ({ body: msg }) => {
      const r = await jobs.run('markEnded', safeId(msg.session_id));
      if (!r.ok) throw fail(r.code, r.error, END_CODES[r.code]);
      return { ok: true };
    },
  },
];
