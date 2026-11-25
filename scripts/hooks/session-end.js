#!/usr/bin/env node
// SessionEnd hook: mark a dashboard-connected session as ended (no output, zero tokens).
const { readHookInput, safeId, setState } = require('../lib');

(async () => {
  const input = await readHookInput();
  setState(safeId(input.session_id), 'ended');
})();
