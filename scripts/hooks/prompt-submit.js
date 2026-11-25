#!/usr/bin/env node
// UserPromptSubmit hook
// - "/ddashboard:dashboard" (or "/dashboard"): start the server, connect this project, register this session.
// - "... off": disconnect this project; stop the server when no project is left.
// - First prompt in a session that started before the dashboard was turned on: register it and inject the instructions.
// - Connected sessions are marked "working". Anything else prints nothing (zero tokens).
const {
  readHookInput, safeId, serverPid, projectActive, setProject, registerSession, setState, isRegistered, rulesText,
} = require('../lib');
const control = require('../control');

const ACTIVATE = /^\s*\/(?:ddashboard:)?dashboard\b(.*)$/i;

(async () => {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  const sid = safeId(input.session_id);
  const m = String(input.prompt || '').match(ACTIVATE);

  if (m && /^\s*off\b/i.test(m[1])) {
    const left = setProject(cwd, false);
    const msg = left ? '' : ` ${control.stop()}`;
    process.stdout.write(`[ddashboard] Disconnected this project from the dashboard.${msg}`);
    return;
  }

  if (m) {
    const started = await control.start();
    setProject(cwd, true);
    registerSession(sid, cwd);
    setState(sid, 'working');
    process.stdout.write(`${started}\n${rulesText(sid)}`);
    return;
  }

  if (!isRegistered(sid) && serverPid() && projectActive(cwd)) {
    registerSession(sid, cwd);
    process.stdout.write(rulesText(sid));
  }
  setState(sid, 'working');
})();
