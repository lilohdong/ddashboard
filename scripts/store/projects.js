// projects.json: { projectKey: project }. Every write goes through update (lock + re-read).
// Lock order when both files change: projects, then sessions (never the other way round).
// app/teams.js readProjects adds the migration of projects without teams (store/migrate.js projects) on top of read().
const { paths } = require('../core/paths');
const { mapStore } = require('./record');

module.exports = mapStore(paths.projects, 'projects');
