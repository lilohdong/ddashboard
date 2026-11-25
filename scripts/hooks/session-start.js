#!/usr/bin/env node
// SessionStart hook: if the session belongs to a project connected to the dashboard,
// register it and inject the instructions. Otherwise print nothing (zero tokens).
const { readHookInput, safeId, serverPid, projectActive, registerSession, rulesText } = require('../lib');

(async () => {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  if (!serverPid() || !projectActive(cwd)) return;
  const sid = safeId(input.session_id);
  registerSession(sid, cwd);
  process.stdout.write(rulesText(sid));
})();
