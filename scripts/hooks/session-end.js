#!/usr/bin/env node
// SessionEnd hook: mark a dashboard-connected session as ended (no output, zero tokens) and stop its wait command,
// which would otherwise keep running with nobody to wake (bug-005).
const { readHookInput, safeId, setState, waitLockPath, stopWaiter } = require('../lib');
const fs = require('fs');

(async () => {
  const input = await readHookInput();
  const sid = safeId(input.session_id);
  setState(sid, 'ended');
  if (fs.existsSync(waitLockPath(sid))) try { stopWaiter(sid); } catch { /* best effort */ }
})();
