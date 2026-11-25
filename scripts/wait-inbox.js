#!/usr/bin/env node
// Wait command the session runs in the background.
// It waits quietly (no tokens) until a reply arrives, prints it, and exits.
// Claude Code reports the background command's exit, which wakes the session.
// Messages are dashboard replies, team reports (to a lead) or lead instructions (to a member).
const fs = require('fs');
const path = require('path');
const { paths, ensureDir, safeId, alive, takeInbox, formatMessages, setState, pendingRules } = require('./lib');

const sid = safeId(process.argv[2]);
const POLL_MS = Number(process.env.DDASH_POLL_MS || 1500);
const dir = paths.inbox(sid);
const lock = path.join(dir, 'wait.lock');
ensureDir(dir);

// Don't start a second waiter for the same session.
try {
  const other = Number(fs.readFileSync(lock, 'utf8'));
  if (other && other !== process.pid && alive(other)) {
    console.log('Already waiting for replies. Nothing to do.');
    process.exit(0);
  }
} catch { /* no lock */ }
fs.writeFileSync(lock, String(process.pid));

const release = () => {
  try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock); } catch {}
};
process.on('exit', release);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const timer = setInterval(() => {
  const msgs = takeInbox(sid);
  if (!msgs.length) return;
  clearInterval(timer);
  setState(sid, 'working');
  const rules = pendingRules(sid); // new instructions once, after a mode switch
  console.log(`${formatMessages(msgs)}\n\n${rules ? `${rules}\n` : ''}(After handling it, start this wait command again in the background.)`);
  process.exit(0);
}, POLL_MS);
