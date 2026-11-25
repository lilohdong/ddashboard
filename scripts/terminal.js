// OS terminal windows (runner 'window'): a new, visible terminal window that runs a program in a folder.
//   Windows: a .cmd script (cd + program) in the logs folder, opened with cmd /c start "<title>" cmd /k .\<script name>.
//            The command line holds only the title and a plain file name, so paths with spaces, &, %, ^ or quotes
//            never meet cmd's parser there; inside the script they are quoted and % is doubled. The .\ prefix is
//            needed: with NoDefaultCurrentDirectoryInExePath set (Claude Code sets it) cmd does not look up a bare
//            name in the current folder. The script closes the window when the program exits normally and
//            keeps it open (with a note) when it fails.
//   macOS:   osascript: tell application "Terminal" to do script "cd '<cwd>' && <program>"
//   Linux:   x-terminal-emulator -T <title> -e sh -c "cd '<cwd>' && <program> || { echo ...; read x; }" (needs a display;
//            on failure the window stays open until Enter)
// DDASH_WINDOW=0 turns windows off. DDASH_WINDOW_BIN overrides the launcher (a .js file runs with node and
// gets <title> <cwd> <argv as JSON>; tests).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const disabled = () => /^(0|false|off|no)$/i.test(process.env.DDASH_WINDOW || '');

function onPath(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

// Why no window can be opened here ('' when one can).
function unavailableReason() {
  if (disabled()) return 'terminal windows are turned off (DDASH_WINDOW=0)';
  if (process.env.DDASH_WINDOW_BIN) return '';
  if (process.platform === 'win32') return '';
  if (process.platform === 'darwin') return onPath('osascript') ? '' : 'osascript was not found';
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'no graphical display (DISPLAY/WAYLAND_DISPLAY unset)';
  return onPath('x-terminal-emulator') ? '' : 'x-terminal-emulator was not found';
}

const available = () => !unavailableReason();

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cleanTitle = (t) => String(t || 'claude').replace(/[^\p{L}\p{N} ._·:-]/gu, '').trim().slice(0, 60) || 'claude';
// A value inside double quotes in a .cmd script: % doubled (no expansion); quotes cannot occur in Windows paths.
const batchQuote = (s) => `"${String(s).replace(/%/g, '%%').replace(/"/g, '')}"`;

// How to open the window (pure; exported for tests). argv = [program, ...args] to run in the window.
// Returns { file, args, verbatim?, script?: { name, content }, sync }.
function launcher({ title, cwd, argv, name = 'window', platform = process.platform }) {
  const bin = process.env.DDASH_WINDOW_BIN;
  if (bin) {
    const js = /\.(c|m)?js$/i.test(bin);
    return { file: js ? process.execPath : bin, args: [...(js ? [bin] : []), cleanTitle(title), cwd, JSON.stringify(argv)], sync: true };
  }
  if (platform === 'win32') {
    const script = `${String(name).replace(/[^\w.-]/g, '_')}.cmd`;
    const content = [
      '@echo off', 'chcp 65001 >nul', `cd /d ${batchQuote(cwd)}`, argv.map(batchQuote).join(' '),
      'if errorlevel 1 (echo. & echo ddashboard: the command failed ^(exit %errorlevel%^). This window stays open.) else exit', '',
    ].join('\r\n');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', `start "${cleanTitle(title)}" cmd /k .\\${script}`],
      verbatim: true, script: { name: script, content }, sync: true,
    };
  }
  const line = `cd ${sh(cwd)} && ${argv.map(sh).join(' ')}`;
  if (platform === 'darwin') {
    const as = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { file: 'osascript', args: ['-e', `tell application "Terminal" to do script "${as}"`, '-e', 'tell application "Terminal" to activate'], sync: true };
  }
  // x-terminal-emulator keeps running while the window is open: not waited for.
  return { file: 'x-terminal-emulator', args: ['-T', cleanTitle(title), '-e', 'sh', '-c', `${line} || { echo; echo "ddashboard: the command failed (exit $?). Press Enter to close."; read x; }`], sync: false };
}

// Open the window. dir: where a Windows script is written. Throws when no window can be opened (turned off,
// missing folder, launcher missing or failing). Returns { pid }.
function openWindow({ title, cwd, argv, dir, name }) {
  const why = unavailableReason();
  if (why) throw new Error(why);
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* missing */ }
  if (!isDir) throw new Error(`folder does not exist: ${cwd}`);
  const l = launcher({ title, cwd, argv, name });
  let runIn = cwd;
  if (l.script) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, l.script.name), l.script.content);
    runIn = dir; // cmd finds the script by its plain name
  }
  const opts = { cwd: runIn, windowsHide: false, windowsVerbatimArguments: Boolean(l.verbatim) };
  if (l.sync) {
    // The launchers (start, osascript, the test fake) return at once: wait and check how they ended.
    const r = spawnSync(l.file, l.args, { ...opts, stdio: 'ignore', timeout: 15000 });
    if (r.error) throw new Error(`could not run ${path.basename(l.file)}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${path.basename(l.file)} failed (exit ${r.status})`);
    return { pid: r.pid || 0 };
  }
  let child;
  try {
    child = spawn(l.file, l.args, { ...opts, detached: true, stdio: 'ignore' });
  } catch (err) { throw new Error(`could not run ${l.file}: ${err.message}`); }
  child.on('error', () => { /* checked on PATH beforehand; a later failure shows as a session that never registers */ });
  child.unref();
  return { pid: child.pid || 0 };
}

module.exports = { available, unavailableReason, launcher, openWindow, cleanTitle };
