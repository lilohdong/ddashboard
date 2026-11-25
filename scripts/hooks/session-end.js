#!/usr/bin/env node
// SessionEnd hook: mark a dashboard-connected session as ended (reason exit; no output, zero tokens). Entering ended
// stops its wait command (supervisor.stop), which would otherwise keep running with nobody to wake (bug-005).
const fs = require('fs');
const { readHookInput, safeId, waitLockPath, stopWaiter } = require('../lib');
const lifecycle = require('../app/lifecycle');

(async () => {
  const input = await readHookInput();
  const sid = safeId(input.session_id);
  const r = lifecycle.apply(sid, 'end', { reason: 'exit' });
  // Already ended (team end, handoff, gone): its waiter still goes.
  if (!r.ok && fs.existsSync(waitLockPath(sid))) try { stopWaiter(sid); } catch { /* best effort */ }
})();
