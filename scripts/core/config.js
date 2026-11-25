// The only reader of process.env.DDASH_*: one table of every setting (name, default, parser, doc).
// Values are read on every get() (lazily), so tests can change the environment between cases. Modules that
// keep a value in a constant read it once at load, as before.
// docs/configuration.md is generated from this table: node scripts/core/config.js --doc > docs/configuration.md
const os = require('os');
const path = require('path');

// Parsers. An empty value always means the default.
//   num: a number >= 0 (0 is a value); invalid → default
//   pos: a number > 0; 0 or invalid → default
//   str: the trimmed text
//   path: a folder; a leading ~ means the home folder
//   off: a switch that is on unless set to 0/false/off/no
function parseNum(v, def) {
  v = String(v ?? '').trim();
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
const PARSERS = {
  num: parseNum,
  pos: (v, def) => { const n = parseNum(v, def); return n > 0 ? n : def; },
  str: (v, def) => String(v ?? '').trim() || def,
  path: (v, def) => (String(v ?? '').trim() || def).replace(/^~(?=$|[\\/])/, os.homedir()),
  off: (v) => !/^(0|false|off|no)$/i.test(String(v ?? '').trim()),
};

const TABLE = [
  // Board and server
  { name: 'DDASH_BOARD_DIR', type: 'path', def: path.join(os.homedir(), '.ddashboard'), doc: 'Board folder (sessions, cards, inbox, logs). Tests point it at a temp folder.' },
  { name: 'DDASH_PORT', type: 'pos', def: 7357, doc: 'Dashboard server port (127.0.0.1 only).' },
  { name: 'DDASH_RECENT_DAYS', type: 'num', def: 14, doc: 'Cards older than this many days count as archived.' },
  { name: 'DDASH_TICK_MS', type: 'pos', def: 10000, doc: 'Server liveness tick: sessions that died without SessionEnd are ended (ms).' },
  { name: 'DDASH_SWEEP_MS', type: 'pos', def: 60000, doc: 'Server sweep interval for orphan wait commands (ms).' },
  { name: 'DDASH_CONTEXT_WARN', type: 'pos', def: 150000, doc: 'Context size (tokens) at which the dashboard marks a session.' },
  { name: 'DDASH_STALE_MIN', type: 'pos', def: 60, doc: 'Minutes without activity after which an idle session without a waiter is unresponsive.' },
  // Retention (server, daily)
  { name: 'DDASH_RETAIN_DONE_DAYS', type: 'pos', def: 7, doc: 'Days a taken inbox message (inbox/<sid>/done/) is kept.' },
  { name: 'DDASH_RETAIN_LOG_DAYS', type: 'pos', def: 30, doc: 'Days a file in logs/ is kept after its last change.' },
  { name: 'DDASH_RETAIN_LOG_MB', type: 'pos', def: 50, doc: 'Size cap of logs/ (MB); the oldest files go first.' },
  // Sessions
  { name: 'DDASH_NAME', type: 'str', def: '', doc: 'Session name shown on the dashboard (default: the folder name, or the member role).' },
  // Wait command
  { name: 'DDASH_POLL_MS', type: 'pos', def: 1500, doc: 'Wait command inbox poll interval (ms).' },
  { name: 'DDASH_WAIT_CHECK_MS', type: 'pos', def: 60000, doc: 'Wait command owner identity re-check interval (ms, pid reuse).' },
  { name: 'DDASH_WAIT_OWNER', type: 'pos', def: 0, doc: 'Pid the wait command watches instead of its Claude ancestor (tests).' },
  // Team mode
  { name: 'DDASH_CLAUDE_BIN', type: 'str', def: 'claude', doc: 'The claude command for members (a .js file runs with node; tests).' },
  { name: 'DDASH_ORCA', type: 'off', def: true, doc: 'Set to 0 to turn the Orca runner off.' },
  { name: 'DDASH_ORCA_BIN', type: 'str', def: 'orca', doc: 'The orca command (a .js file runs with node; tests).' },
  { name: 'DDASH_WINDOW', type: 'off', def: true, doc: 'Set to 0 to turn the OS terminal window runner off.' },
  { name: 'DDASH_WINDOW_BIN', type: 'str', def: '', doc: 'Window launcher override (a .js file runs with node and gets <title> <cwd> <argv JSON>; tests).' },
  { name: 'DDASH_BRIEF_STALE_COMMITS', type: 'pos', def: 20, doc: 'Commits after which a group brief is reported as possibly stale.' },
  { name: 'DDASH_HANDOFF_MAX_TOKENS', type: 'num', def: 6000, doc: 'Largest lead handoff doc (estimated tokens); 0: no cap.' },
  // Lead context limit
  { name: 'DDASH_LEAD_WORK_BUDGET', type: 'num', def: 100000, doc: 'Tokens a lead may grow above its starting context before it is told to hand off.' },
  { name: 'DDASH_LEAD_CONTEXT_LIMIT', type: 'num', def: 0, doc: 'Absolute lead handoff point (tokens); 0: relative (start + work budget).' },
  { name: 'DDASH_CONTEXT_WINDOW', type: 'num', def: 0, doc: 'Model context window (tokens); 0: detect (200k, 1M for [1m] models).' },
];
const BY_NAME = new Map(TABLE.map((e) => [e.name, e]));

function entry(name) {
  const e = BY_NAME.get(name);
  if (!e) throw new Error(`unknown setting ${name} (add it to scripts/core/config.js)`);
  return e;
}

// The value of a setting, parsed; the default when unset, empty or invalid.
function get(name) {
  const e = entry(name);
  return PARSERS[e.type](process.env[name], e.def);
}

// True if the setting is set to a non-empty value.
const isSet = (name) => (entry(name), Boolean(String(process.env[name] ?? '').trim()));

// A number from any environment variable (empty or invalid: def; 0 is a value).
const envNum = (name, def) => parseNum(process.env[name], def);

function doc() {
  const fmt = (e) => (e.type === 'off' ? 'on' : e.name === 'DDASH_BOARD_DIR' ? '`~/.ddashboard`' : e.def === '' ? '—' : `\`${e.def}\``);
  return [
    '# Configuration',
    '',
    '<!-- Generated from scripts/core/config.js: node scripts/core/config.js --doc > docs/configuration.md -->',
    '',
    'Environment variables, read by `scripts/core/config.js` only. Dashboard choices (language) live in',
    '`settings.json`, per-project choices (runners, team rules) in `projects.json`. An empty value means the default.',
    '',
    '| Variable | Type | Default | Meaning |',
    '|---|---|---|---|',
    ...TABLE.map((e) => `| \`${e.name}\` | ${e.type} | ${fmt(e)} | ${e.doc} |`),
    '',
    'Types: num = number ≥ 0 (0 is a value), pos = number > 0 (0 means the default), str = text, path = folder',
    '(leading `~` = home), off = on unless `0`, `false`, `off` or `no`.',
    '',
  ].join('\n');
}

module.exports = { TABLE, get, isSet, envNum, parseNum, doc };

if (require.main === module && process.argv[2] === '--doc') process.stdout.write(doc());
