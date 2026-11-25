#!/usr/bin/env node
// SessionStart hook: if the session belongs to a project connected to the dashboard,
// register it and inject the instructions. Otherwise print nothing (zero tokens).
// Team mode: a new session gets its instructions on its first prompt instead, because only the
// prompt carries the member tag. Known team sessions (e.g. resumed) also record their Claude pid.
const {
  paths, readJson, readHookInput, safeId, serverPid, projectActive, projectKey, registerSession, injectRules,
  recordClaudePid, replacedText,
} = require('../lib');

(async () => {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  if (!serverPid() || !projectActive(cwd)) return;
  const sid = safeId(input.session_id);
  const project = readJson(paths.projects, {})[projectKey(cwd)];
  const known = readJson(paths.sessions, {})[sid];
  if (known?.replaced_by) return void process.stdout.write(replacedText(known));
  if (project?.mode === 'team' && (!known || known.pending)) return;
  registerSession(sid, cwd);
  if (project?.mode === 'team') recordClaudePid(sid);
  process.stdout.write(injectRules(sid));
})();
