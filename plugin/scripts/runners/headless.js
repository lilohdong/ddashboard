// Runner 'headless': claude -p in the background, detached, output to BOARD_DIR/logs/<sid>.log.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { paths, safeId } = require('../core/paths');
const { ensureDir } = require('../core/fsx');
const { claudeCommand, quoteCmd, claudeEnv } = require('./claude-cmd');

// Start claude detached with the prompt on stdin (no quoting trouble with long prompts), output to the log.
// args: the claude arguments (-p, --session-id/--resume, options). Returns its pid (0 when unknown).
function run(sid, args, prompt, cwd) {
  ensureDir(paths.logsDir);
  const promptFile = path.join(paths.logsDir, `${safeId(sid)}.prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt);
  const log = fs.openSync(paths.log(sid), 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} claude ${args.join(' ')}\n`);
  const input = fs.openSync(promptFile, 'r');
  const cmd = claudeCommand();
  const all = [...cmd.pre, ...args];
  const child = spawn(cmd.file, cmd.shell ? all.map(quoteCmd) : all, {
    cwd, detached: true, windowsHide: true, shell: cmd.shell, stdio: [input, log, log], env: claudeEnv(),
  });
  child.on('error', (err) => fs.appendFileSync(paths.log(sid), `ddashboard: could not start claude: ${err.message}\n`));
  child.unref();
  fs.closeSync(input);
  fs.closeSync(log);
  return child.pid || 0;
}

module.exports = { run };
