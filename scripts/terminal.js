// OS terminal windows (runner 'window'): a new, visible terminal window that runs a command in a folder.
//   Windows: cmd /c start "<title>" /D <cwd> cmd /k <command>
//   macOS:   osascript: tell application "Terminal" to do script "cd <cwd> && <command>"
//   Linux:   x-terminal-emulator -T <title> -e sh -c "cd <cwd> && <command>" (needs a display)
// DDASH_WINDOW=0 turns windows off. DDASH_WINDOW_BIN overrides the launcher (a .js file runs with node and
// gets <title> <cwd> <command>; tests).
const { spawn, execFileSync } = require('child_process');

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
const cleanTitle = (t) => String(t || 'claude').replace(/["\r\n]/g, '').slice(0, 60);

// The program and arguments that open the window (exported for tests).
function launcher({ title, cwd, command }) {
  const bin = process.env.DDASH_WINDOW_BIN;
  if (bin) {
    const js = /\.(c|m)?js$/i.test(bin);
    return { file: js ? process.execPath : bin, args: [...(js ? [bin] : []), cleanTitle(title), cwd, command] };
  }
  if (process.platform === 'win32') {
    // /s: cmd strips only the outer quotes, so the quoted paths inside stay intact.
    const line = `"start "${cleanTitle(title)}" /D "${cwd}" cmd /k "${command}""`;
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line], verbatim: true };
  }
  if (process.platform === 'darwin') {
    const script = `cd ${sh(cwd)} && ${command}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { file: 'osascript', args: ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'] };
  }
  return { file: 'x-terminal-emulator', args: ['-T', cleanTitle(title), '-e', 'sh', '-c', `cd ${sh(cwd)} && ${command}`] };
}

// Open the window. Throws when no window can be opened here. Returns { pid } of the launcher.
function openWindow({ title, cwd, command }) {
  const why = unavailableReason();
  if (why) throw new Error(why);
  const l = launcher({ title, cwd, command });
  const child = spawn(l.file, l.args, { cwd, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: Boolean(l.verbatim) });
  child.on('error', () => { /* reported by the session never registering */ });
  child.unref();
  return { pid: child.pid || 0 };
}

module.exports = { available, unavailableReason, launcher, openWindow };
