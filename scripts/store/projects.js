// projects.json: { projectKey: project }. Every write goes through update (lock + re-read).
// Lock order when both files change: projects, then sessions (never the other way round).
// lib.readProjects adds the pre-M-1b migration on top of read().
const { paths } = require('../core/paths');
const { mapStore } = require('./record');

module.exports = mapStore(paths.projects, 'projects');
