// Orca integration: run team members as visible, interactive claude sessions in Orca terminals.
// CLI calls used (checked against Orca 1.4.272, `orca <cmd> --help` and real runs):
//   orca status --json                         -> result.runtime.reachable
//   orca terminal create --worktree path:<dir> --title <t> --command <cmd> --json -> result.terminal.handle
//   orca terminal show --terminal <h> --json   -> result.terminal.writable (false once the terminal is closed)
//   orca terminal send --terminal <h> --text <t> --enter --json -> result.send.accepted
// DDASH_ORCA=0 turns Orca off. DDASH_ORCA_BIN overrides the orca command (a .js file runs with node; tests).
const { execFileSync } = require('child_process');

const slash = (p) => String(p).replace(/\\/g, '/');

function orcaCommand() {
  const bin = process.env.DDASH_ORCA_BIN || 'orca';
  return /\.(c|m)?js$/i.test(bin) ? { file: process.execPath, pre: [bin] } : { file: bin, pre: [] };
}

// Run orca with --json and return its parsed reply ({ ok, result } or { ok: false, error }).
function run(args, timeout = 15000) {
  const { file, pre } = orcaCommand();
  let out;
  try {
    out = execFileSync(file, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout }).toString('utf8');
  } catch (err) {
    try { return JSON.parse(String(err.stdout || '')); } catch { /* not json */ }
    return { ok: false, error: { message: String(err.stderr || err.message || err).trim().split(/\r?\n/)[0] } };
  }
  try { return JSON.parse(out); } catch { return { ok: false, error: { message: 'unexpected orca output' } }; }
}

const errText = (r) => r?.error?.message || JSON.stringify(r?.error || r || '').slice(0, 200);

const disabled = () => /^(0|false|off|no)$/i.test(process.env.DDASH_ORCA || '');

// True if the Orca app/runtime is reachable on this machine.
function available() {
  if (disabled()) return false;
  const r = run(['status', '--json'], 5000);
  return Boolean(r.ok && r.result?.runtime?.reachable);
}

// Open a visible terminal in the Orca worktree that contains dir and run command in it.
// Returns { handle, pane }. Throws when Orca refuses (e.g. dir is not in an Orca worktree).
function openTerminal({ cwd, title, command }) {
  const r = run(['terminal', 'create', '--worktree', `path:${slash(cwd)}`, '--title', title, '--command', command, '--json']);
  const t = r.ok && r.result?.terminal;
  if (!t?.handle) throw new Error(`orca terminal create failed: ${errText(r)}`);
  return { handle: t.handle, pane: t.paneKey || '' };
}

// True while the terminal is open and accepts input.
function writable(handle) {
  if (!handle) return false;
  const r = run(['terminal', 'show', '--terminal', handle, '--json']);
  return Boolean(r.ok && r.result?.terminal?.writable);
}

// Type text into the terminal and press Enter (Orca bracket-pastes it into a running agent).
function sendText(handle, text) {
  const r = run(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json']);
  if (!(r.ok && r.result?.send?.accepted)) throw new Error(`orca terminal send failed: ${errText(r)}`);
  return true;
}

module.exports = { run, available, openTerminal, writable, sendText, orcaCommand };
