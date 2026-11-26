// Token usage log: usage/YYYY-MM.jsonl, one line per turn (written by the Stop hook, indexed by app/usage.js).
const fs = require('fs');
const path = require('path');
const { paths } = require('../core/paths');
const { appendJsonl } = require('../core/fsx');

// Usage log files, oldest first.
function files() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.usageDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { /* none yet */ }
  return monthly.map((f) => path.join(paths.usageDir, f));
}

const append = (row) => appendJsonl(paths.usageFor(row.ts), row);

module.exports = { files, append };
