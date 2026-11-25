// Runner 'orca' (was scripts/orca.js): run team members as visible, interactive claude sessions in Orca terminals.
// CLI calls used (checked against Orca 1.4.272, `orca <cmd> --help` and real runs):
//   orca status --json                         -> result.runtime.reachable
//   orca terminal create --worktree path:<dir> --title <t> --command <cmd> --json -> result.terminal.handle
//   orca terminal show --terminal <h> --json   -> result.terminal.writable (false once the terminal is closed)
//   orca terminal send --terminal <h> --text <t> --enter --json -> result.send.accepted
// DDASH_ORCA=0 turns Orca off. DDASH_ORCA_BIN overrides the orca command (a .js file runs with node; tests).
const { execFileSync, execFile } = require('child_process');
const config = require('../core/config');

const slash = (p) => String(p).replace(/\\/g, '/');

function orcaCommand() {
  const bin = config.get('DDASH_ORCA_BIN');
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

const disabled = () => !config.get('DDASH_ORCA');

// True if the Orca app/runtime is reachable on this machine.
function available() {
  if (disabled()) return false;
  const r = run(['status', '--json'], 5000);
  return Boolean(r.ok && r.result?.runtime?.reachable);
}

// Open a visible terminal in the Orca worktree that contains dir and run command in it.
// Returns { handle, pane }. Throws when Orca refuses (e.g. dir is not in an Orca worktree).
// Orca's path: selector matches a worktree root only, so a subfolder cwd (e.g. <repo>/scripts) is mapped to its git root.
function worktreeRoot(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8').trim() || dir;
  } catch { return dir; }
}

function openTerminal({ cwd, title, command }) {
  const r = run(['terminal', 'create', '--worktree', `path:${slash(worktreeRoot(cwd))}`, '--title', title, '--command', command, '--json']);
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

// Like run, without blocking: cb(reply).
function runAsync(args, timeout, cb) {
  const { file, pre } = orcaCommand();
  execFile(file, [...pre, ...args], { windowsHide: true, timeout }, (err, stdout, stderr) => {
    try { return cb(JSON.parse(String(stdout || ''))); } catch { /* not json */ }
    if (err) return cb({ ok: false, error: { message: String(stderr || err.message || err).trim().split(/\r?\n/)[0] } });
    cb({ ok: false, error: { message: 'unexpected orca output' } });
  });
}

// Terminal state from an orca reply: true | false (closed, orphaned or unknown to Orca) | null (cannot tell).
const openFrom = (r) => (r.ok ? Boolean(r.result?.terminal?.writable) : /unknown terminal|not found|no such terminal/i.test(errText(r)) ? false : null);

// Is the terminal open? true | false | null (Orca off or not answering). Blocks: for CLI commands.
function terminalOpen(handle) {
  if (disabled() || !handle) return null;
  return openFrom(run(['terminal', 'show', '--terminal', handle, '--json'], 5000));
}

// Same, without blocking (the dashboard server): cb(true | false | null).
function terminalOpenAsync(handle, cb) {
  if (disabled() || !handle) return void cb(null);
  runAsync(['terminal', 'show', '--terminal', handle, '--json'], 5000, (r) => cb(openFrom(r)));
}

// Close a terminal (stops what runs in it).
function closeTerminal(handle) {
  const r = run(['terminal', 'close', '--terminal', handle, '--json']);
  if (!r.ok) throw new Error(`orca terminal close failed: ${errText(r)}`);
  return true;
}

// Type text into the terminal and press Enter (Orca bracket-pastes it into a running agent).
function sendText(handle, text) {
  const r = run(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json']);
  if (!(r.ok && r.result?.send?.accepted)) throw new Error(`orca terminal send failed: ${errText(r)}`);
  return true;
}

module.exports = { run, available, openTerminal, writable, terminalOpen, terminalOpenAsync, closeTerminal, sendText, orcaCommand, worktreeRoot };
