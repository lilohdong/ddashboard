// The claude command and its arguments, shared by every runner (headless, orca, window) and orca-launch.js.
// DDASH_CLAUDE_BIN overrides the claude command (a .js file runs with node; tests).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../core/config');
const { paths, safeId } = require('../core/paths');
const { ensureDir } = require('../core/fsx');

const slash = (p) => String(p).replace(/\\/g, '/');

// The claude command as [file, args prefix, use shell]. DDASH_CLAUDE_BIN may point at a .js file (tests).
// On Windows, claude.exe (native install) runs directly, and npm's claude.cmd is run as node + its cli.js, so no
// cmd.exe parses the arguments (a prompt with %VAR% or & stays as written). Only an unknown .cmd needs the shell.
function claudeCommand() {
  const bin = config.get('DDASH_CLAUDE_BIN');
  if (/\.(c|m)?js$/i.test(bin)) return { file: process.execPath, pre: [bin], shell: false };
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(bin)) return { file: bin, pre: [], shell: false };
  let found = [];
  if (fs.existsSync(bin)) found = [bin];
  else {
    try { found = execFileSync('where', [bin], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch {}
  }
  const exe = found.find((f) => /\.(exe|com)$/i.test(f));
  if (exe) return { file: exe, pre: [], shell: false };
  for (const f of found.filter((x) => /\.(cmd|bat)$/i.test(x))) {
    const cli = path.join(path.dirname(f), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cli)) return { file: process.execPath, pre: [cli], shell: false };
  }
  return { file: found.find((x) => /\.(cmd|bat)$/i.test(x)) || bin, pre: [], shell: true };
}

// Arguments for an interactive claude (prompt first: options such as --allowedTools take every following word).
// Through cmd.exe (cmd.shell) a newline would end the command line and %VAR% would expand, so then the text after
// the [ddash ...] tag moves to promptFile and the prompt only points at it.
function interactiveArgs(cmd, prompt, args, promptFile) {
  let p = String(prompt);
  if (cmd.shell && /[%\r\n"^&|<>!]/.test(p)) {
    const tag = (p.match(/^\[ddash [^\]]*\]/) || [''])[0];
    p = `${tag ? `${tag} ` : ''}Your first message is in ${slash(promptFile)} (moved there because the Windows shell would change it). Read that file first and follow it.`;
  }
  return [...cmd.pre, p, ...args];
}

const quoteCmd = (a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

// claude options from spawn options { model, permission_mode, allowed_tools }.
function claudeArgs(opts) {
  const args = [];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permission_mode) args.push('--permission-mode', opts.permission_mode);
  if (opts.allowed_tools?.length) args.push('--allowedTools', ...opts.allowed_tools);
  return args;
}

// The environment for a nested claude: it refuses to start when it thinks it runs inside Claude Code.
function claudeEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// orca-launch.js starts an interactive claude with the prompt as its first message, in an Orca terminal or a
// terminal window. Its spec goes through a file, which keeps long or multi-line prompts free of shell quoting.
const LAUNCH = path.join(__dirname, '..', 'orca-launch.js');

// Write the spec file for orca-launch.js. Returns { spec, name }.
function launchSpec(sid, args, prompt, cwd, kind) {
  ensureDir(paths.logsDir);
  const base = path.join(paths.logsDir, `${safeId(sid)}.${kind}-${Date.now()}`);
  fs.writeFileSync(`${base}.prompt.txt`, prompt);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ args, prompt_file: `${base}.prompt.txt`, cwd, sid, kind }));
  fs.appendFileSync(paths.log(sid), `\n--- ${new Date().toISOString()} ${kind} terminal: claude ${args.join(' ')}\n`);
  return { spec: `${base}.json`, name: path.basename(base) };
}

module.exports = { claudeCommand, interactiveArgs, quoteCmd, claudeArgs, claudeEnv, LAUNCH, launchSpec };
