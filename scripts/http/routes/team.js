// POST /api/team/end {session_id} -> stop a team member (same as `team.js <lead> end <sid>`).
// POST /api/team/spawn {lead, role, model?, stay?, task, group?, runner?} -> start a member for a live lead and tell
// the lead. Both start or stop processes: the use case runs off the request path (http/jobs.js).
const { readJson, paths, readProjects, safeId, isEnded, teamRole, deliver } = require('../../lib');
const { RUNNERS } = require('../../app/members');
const { fail } = require('../router');
const jobs = require('../jobs');

const refused = (err) => { throw fail(400, String(err?.message || err)); };

module.exports = [
  {
    method: 'POST', path: '/api/team/end', sameOrigin: true, body: true,
    handler: async ({ body: msg }) => {
      const sid = safeId(msg.session_id);
      const m = readJson(paths.sessions, {})[sid];
      if (!m || m.kind !== 'member' || !m.lead) throw fail(404, 'not a team member', 'not_member');
      const r = await jobs.run('endMember', m.lead, sid).catch(refused);
      return { ok: true, done: r.done, already: Boolean(r.already) };
    },
  },
  {
    method: 'POST', path: '/api/team/spawn', sameOrigin: true, body: true,
    handler: async ({ body: msg }) => {
      const sessions = readJson(paths.sessions, {});
      const projects = readProjects();
      const leadSid = safeId(msg.lead);
      const lead = sessions[leadSid];
      if (!lead) throw fail(404, 'unknown lead session', 'unknown_session');
      if (isEnded(lead) || teamRole(lead, projects[lead.project_key]) !== 'lead') throw fail(409, 'not a live team lead', 'not_lead');
      const role = String(msg.role || '').trim();
      const task = String(msg.task || '').trim();
      if (!role || !task) throw fail(400, 'role and task required');
      if (msg.runner !== undefined && msg.runner !== null && msg.runner !== '' && !RUNNERS.includes(msg.runner)) {
        throw fail(400, `runner must be one of ${RUNNERS.join(', ')}`, 'bad_runner');
      }
      const opts = { role, model: msg.model || undefined, stay: msg.stay === true, task: task.slice(0, 8000), group: msg.group || undefined, runner: RUNNERS.includes(msg.runner) ? msg.runner : undefined };
      const r = await jobs.run('spawnMember', leadSid, opts).catch(refused);
      const first = task.split(/\r?\n/)[0].slice(0, 200);
      deliver(leadSid, {
        type: 'report', from: r.sid, role: role.slice(0, 40), status: 'wip',
        title: `member ${role} ${r.sid.slice(0, 8)}${msg.group ? ` (group ${msg.group})` : ''} spawned by the user: ${first}`,
      });
      return { ok: true, session_id: r.sid, runner: r.runner, pid: r.pid, terminal: r.terminal, log: r.log, note: r.note || undefined };
    },
  },
];
