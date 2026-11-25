#!/usr/bin/env node
// Typed into an Orca terminal by team.js: node orca-launch.js <spec.json>
// Starts an interactive claude in that terminal with the prompt as its first message. Going through this
// file keeps the shell command short (two paths), so long or multi-line prompts need no shell quoting.
// spec: { args: [claude options], prompt_file, cwd, sid?, kind? ('orca' | 'window') }
// In a terminal window it records its own pid and its shell's (window_launch_pid, window_shell_pid) on the session,
// so `team.js end` can close the window with everything in it.
const fs = require('fs');
const { spawn } = require('child_process');
const { claudeCommand, interactiveArgs, quoteCmd } = require('./team');
const lib = require('./lib');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (spec.kind === 'window' && spec.sid) {
  try {
    require('./store/sessions').patch(spec.sid, { window_launch_pid: process.pid, window_shell_pid: process.ppid });
  } catch { /* best effort */ }
}
const prompt = fs.readFileSync(spec.prompt_file, 'utf8');
const cmd = claudeCommand();
// No shell when claude can run without one (see claudeCommand); else the prompt text goes to its file.
const all = interactiveArgs(cmd, prompt, spec.args || [], spec.prompt_file);
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
process.on('SIGINT', () => {}); // claude handles Ctrl+C itself
const child = spawn(cmd.file, cmd.shell ? all.map(quoteCmd) : all, { cwd: spec.cwd || process.cwd(), stdio: 'inherit', shell: cmd.shell, env });
child.on('error', (err) => { console.error(`ddashboard: could not start claude: ${err.message}`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 0; });
