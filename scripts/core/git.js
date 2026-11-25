// The one way to run git: execFileSync (no shell), no window, stderr ignored.
// args: an array, or a string of plain words (split on spaces; no quoting).
const { execFileSync } = require('child_process');

const argv = (args) => (Array.isArray(args) ? args : String(args).trim().split(/\s+/));

// git output (trimmed), or null when git fails or is missing.
function gitOrNull(args, cwd) {
  try { return execFileSync('git', argv(args), { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim(); } catch { return null; }
}

// git output (trimmed), or '' when git fails.
const git = (args, cwd) => gitOrNull(args, cwd) ?? '';

module.exports = { git, gitOrNull };
