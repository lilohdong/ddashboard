// Board migrations (docs/architecture.md §5.1).
// 1) Schema migrations: an ordered list { to, files(), run() }. Each run() is idempotent; they run under the 'meta'
//    lock at server start (run()) and lazily from the store (ensure()) when meta.json says the board is older than
//    the code. Before a migration its files are copied to <file>.bak-s<to> (once). A board newer than the code is
//    left alone.
// 2) Shape migrations that run on read, whatever the schema says, because an older plugin in an old session may
//    write the old shape again: projects without teams (0.2.x, and pre-M-1b 0.3.0 settings; the transform is
//    domain/team.js migrateProject, its file work app/teams.js).
// 3) Legacy read paths: the 0.1.0 cards.jsonl (read-only, never written again).
// Compatibility rule: add fields or files only; never rename/remove fields a released version reads, never change
// a file's top-level shape.
const fs = require('fs');
const { paths } = require('../core/paths');
const { withLock } = require('../core/lock');
const { log } = require('../core/log');
const meta = require('./meta');
const sessionsStore = require('./sessions');
const projectsStore = require('./projects');

// Schema 1: 0.2.x (no meta.json). Modules are required inside run() (store/replies.js requires this module).
const MIGRATIONS = [
  // 2: replies.jsonl -> replies/YYYY-MM.jsonl (copied; replies.jsonl stays for older plugins).
  { to: 2, files: () => [paths.replies], run: () => require('./replies').fold() },
];
const SCHEMA = MIGRATIONS[MIGRATIONS.length - 1].to;

function backup(file, to) {
  const bak = `${file}.bak-s${to}`;
  try {
    if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  } catch (err) { log('migrate backup', err); }
}

// Run every migration the board has not had yet. Returns the schemas migrated to.
function run() {
  return withLock('meta', () => {
    const done = [];
    for (const m of MIGRATIONS) {
      if (meta.schema() >= m.to) continue;
      for (const f of m.files ? m.files() : []) backup(f, m.to);
      m.run();
      meta.record(m.to);
      done.push(m.to);
      log('migrate', `board schema ${m.to}`);
    }
    return done;
  });
}

// run() once per process, only when meta.json says it is needed (a cheap read otherwise).
let current = false;
function ensure() {
  if (current) return [];
  const done = meta.schema() >= SCHEMA ? [] : run();
  current = true;
  return done;
}
const reset = () => { current = false; }; // tests

// --- Projects without teams (read path) ---

// Same test as domain/team.js needsTeams (the store may not require domain/).
const needsTeams = (p) => Boolean(p) && typeof p === 'object' && !(p.teams && typeof p.teams === 'object');
const needsMigration = (projects) => Object.values(projects).some(needsTeams);

// projects.json with every project migrated by migrateOne(p, sessions) (saved once, on the first read that needs
// it). Inside a projects or sessions update the migration is applied in memory only (lock order: projects before
// sessions); the next read outside it saves it.
function projects(migrateOne) {
  const all = projectsStore.read();
  if (!needsMigration(all)) return all;
  const migrateAll = (m) => {
    const sessions = sessionsStore.read();
    for (const p of Object.values(m)) if (needsTeams(p)) migrateOne(p, sessions);
    return m;
  };
  if (projectsStore.inUpdate() || sessionsStore.inUpdate()) return migrateAll(all);
  return projectsStore.update(migrateAll);
}

// --- Legacy read paths ---

// The 0.1.0 card log, read before the monthly files (store/cards.js).
const legacyCardFiles = () => [paths.legacyCards];

module.exports = { run, ensure, reset, SCHEMA, MIGRATIONS, needsTeams, projects, legacyCardFiles };
