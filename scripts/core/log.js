// The plugin's own log (BOARD_DIR/logs/ddashboard.log): one line per entry, never throws.
// Size-capped: over MAX_BYTES the file moves to ddashboard.log.1 (one old file kept).
const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');

const MAX_BYTES = 2 * 1024 * 1024;

function log(label, detail) {
  try {
    const file = paths.appLog;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
    const text = detail instanceof Error ? (detail.stack || detail.message) : typeof detail === 'string' ? detail : JSON.stringify(detail ?? '');
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${label}: ${String(text).replace(/\r?\n/g, '\n    ')}\n`);
  } catch { /* logging must never fail the caller */ }
}

// Run optional work: on error, log it and return fallback instead of throwing.
function bestEffort(label, fn, fallback) {
  try { return fn(); } catch (err) { log(label, err); return fallback; }
}

module.exports = { log, bestEffort, MAX_BYTES };
