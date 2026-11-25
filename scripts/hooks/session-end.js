#!/usr/bin/env node
// SessionEnd hook: mark a dashboard-connected session as ended (no output, zero tokens) and stop its wait command,
// which would otherwise keep running with nobody to wake (bug-005).
const { readHookInput, safeId, waitLockPath, stopWaiter } = require('../lib');
const lifecycle = require('../app/lifecycle');
const fs = require('fs');

(async () => {
  const input = await readHookInput();
  const sid = safeId(input.session_id);
  lifecycle.apply(sid, 'end', { reason: 'exit' });
  if (fs.existsSync(waitLockPath(sid))) try { stopWaiter(sid); } catch { /* best effort */ }
})();
