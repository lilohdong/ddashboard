// meta.json: the board's schema version, { schema: <int>, migrated: [{ to, by_version, ts }] } (docs/architecture.md
// §5.1). A missing or unreadable file means schema 1 (a 0.2.x board). Written only by store/migrate.js, under the
// 'meta' lock.
const path = require('path');
const { paths } = require('../core/paths');
const { readJson, writeJson } = require('../core/fsx');

const PLUGIN_JSON = path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
const pluginVersion = () => String(readJson(PLUGIN_JSON, {})?.version || '');

function read() {
  const m = readJson(paths.meta, null);
  const base = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  const schema = Number(base.schema);
  return {
    ...base,
    schema: Number.isInteger(schema) && schema >= 1 ? schema : 1,
    migrated: Array.isArray(base.migrated) ? base.migrated : [],
  };
}

const schema = () => read().schema;

// Record that the board now has schema `to` (unknown fields of meta.json are kept).
function record(to, ts = new Date().toISOString()) {
  const m = read();
  m.schema = to;
  m.migrated.push({ to, by_version: pluginVersion(), ts });
  writeJson(paths.meta, m);
  return m;
}

module.exports = { read, schema, record, pluginVersion };
