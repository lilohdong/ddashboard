// GET /api/settings; POST /api/settings {lang} (dashboard and card language) or {project, runner_lead?, runner_member?}.
const { paths } = require('../../core/paths');
const { readJson } = require('../../core/fsx');
const { readSettings, saveSettings } = require('../../app/settings');
const { readProjects, setRunners } = require('../../app/teams');
const { fail } = require('../router');
const { projectKeyOf } = require('./project');

module.exports = [
  { method: 'GET', path: '/api/settings', sameOrigin: false, body: false, handler: () => ({ lang: readSettings().lang || null }) },
  {
    method: 'POST', path: '/api/settings', sameOrigin: true, body: true,
    handler: ({ body: msg }) => {
      if (msg.project !== undefined) {
        const key = projectKeyOf(readProjects(), readJson(paths.sessions, {}), String(msg.project));
        const r = setRunners(key, { runner_lead: msg.runner_lead, runner_member: msg.runner_member });
        if (!r.ok) throw fail(r.code || 400, r.error);
        return r;
      }
      const r = saveSettings({ lang: msg.lang || null });
      if (!r.ok) throw fail(400, r.error, 'bad_lang');
      return { ok: true, lang: r.settings.lang || null };
    },
  },
];
