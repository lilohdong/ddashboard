#!/usr/bin/env node
// Stop hook: see onStop in app/hooks.js (what it does, what it prints).
require('../app/hooks').runHook('stop-card', 'onStop');
