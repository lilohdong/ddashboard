#!/usr/bin/env node
// SessionEnd hook: see onSessionEnd in app/hooks.js (what it does, what it prints).
require('../app/hooks').runHook('session-end', 'onSessionEnd');
