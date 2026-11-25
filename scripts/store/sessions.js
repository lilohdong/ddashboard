// sessions.json: { sid: session }. Every write goes through update/patch/patchDiff (lock + re-read), so
// concurrent hooks, waiters, team.js and the server never overwrite each other's fields.
// Lock order when both files change: projects, then sessions.
const { paths } = require('../core/paths');
const { mapStore } = require('./record');

module.exports = mapStore(paths.sessions, 'sessions');
