// Shared by routes: a project given by its key in projects.json, or by its name as shown on the dashboard.
const { own } = require('../../lib');
const { teams } = require('../../app/server-state');

const projectKeyOf = (projects, sessions, name) => (own(projects, name) ? name : own(teams(projects, sessions), name)?.key);

module.exports = { projectKeyOf };
