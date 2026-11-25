#!/usr/bin/env node
// SessionStart hook: if the session belongs to a project connected to the dashboard,
// register it and inject the instructions. Otherwise print nothing (zero tokens).
// Team mode: a new session gets its instructions on its first prompt instead, because only the
// prompt carries the member tag. A member started by team.js spawn is known already (pre-registered
// under its --session-id), so it gets its group brief and instructions here: SessionStart output lands
// before the first prompt, UserPromptSubmit output after it. Known team sessions also record their Claude pid.
const {
  paths, readJson, readHookInput, safeId, serverPid, projectActive, projectKey, registerSession, injectRules,
  recordClaudePid, replacedText, memberStart, readProjects, rememberModel,
} = require('../lib');

(async () => {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  if (!serverPid() || !projectActive(cwd)) return;
  const sid = safeId(input.session_id);
  if (input.model) try { rememberModel(sid, typeof input.model === 'string' ? input.model : input.model.id || input.model.display_name); } catch { /* best effort */ }
  const project = readProjects()[projectKey(cwd)];
  const known = readJson(paths.sessions, {})[sid];
  if (known?.replaced_by) return void process.stdout.write(replacedText(known));
  if (project?.mode === 'team' && (!known || (known.pending && known.kind !== 'member'))) return;
  registerSession(sid, cwd);
  if (project?.mode === 'team') recordClaudePid(sid);
  process.stdout.write(known?.pending ? memberStart(sid) : injectRules(sid));
})();
