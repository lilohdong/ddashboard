#!/usr/bin/env node
// UserPromptSubmit hook
// - "/ddashboard:dashboard" (or "/dashboard"): start the server, connect this project, register this session.
//   "... team <name>": team mode with this session as the lead. "... solo": back to solo mode.
// - "... off": disconnect this project; stop the server when no project is left.
// - A first prompt starting with a tag registers a team member or a new lead taking over:
//   [ddash role=<role> lead=<lead sid> stay=0|1] / [ddash lead-handoff from=<old lead sid> doc=<path>]
// - First prompt in a session that started before the dashboard was turned on: register it and inject the instructions.
// - After a mode switch, the next prompt gets the new instructions once.
// - Connected sessions are marked "working". Anything else prints nothing (zero tokens).
const {
  paths, readJson, readHookInput, safeId, serverPid, projectActive, projectKey, setProject, registerSession, setState,
  isRegistered, injectRules, pendingRules, setMode, parseTag, setMember, performHandoff, recordClaudePid, replacedText,
} = require('../lib');
const control = require('../control');

const ACTIVATE = /^\s*\/(?:ddashboard:)?dashboard\b(.*)$/i;

function handoffNote(tag, res) {
  if (!res.ok) return `[ddashboard] Lead handoff failed: ${res.error}. You are registered as an ordinary session.\n`;
  const stopped = res.claude_killed ? 'its Claude process was stopped'
    : 'its Claude process could not be stopped, so it gets a stop notice on its next turn';
  return `[ddashboard] You took over as team lead from ${tag.from}${tag.doc ? `. Read the handoff doc first: ${tag.doc}` : ''}.
The members (${res.members}) now report to you; ${res.moved} pending message(s) moved to your inbox; the old lead is ended and ${stopped}.
`;
}

(async () => {
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  const sid = safeId(input.session_id);
  const prompt = String(input.prompt || '');
  const m = prompt.match(ACTIVATE);

  // A lead replaced by a handoff does no more work (fallback when its process could not be stopped).
  const me = readJson(paths.sessions, {})[sid];
  if (me?.replaced_by) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: replacedText(me) }));
    return;
  }

  if (m && /^\s*off\b/i.test(m[1])) {
    const left = setProject(cwd, false);
    const msg = left ? '' : ` ${control.stop()}`;
    process.stdout.write(`[ddashboard] Disconnected this project from the dashboard.${msg}`);
    return;
  }

  if (m) {
    const team = m[1].match(/^\s*team\b\s*(.*)$/i);
    const solo = /^\s*solo\b/i.test(m[1]);
    const started = await control.start();
    setProject(cwd, true);
    registerSession(sid, cwd);
    setState(sid, 'working');
    let note = '';
    if (team) {
      const name = team[1].trim().replace(/^["']|["']$/g, '');
      setMode(projectKey(cwd), 'team', { lead: sid, leadName: name || undefined });
      recordClaudePid(sid);
      note = 'Team mode is on for this project; this session is the lead.\n';
    } else if (solo) {
      setMode(projectKey(cwd), 'solo');
      note = 'Solo mode is on for this project: every connected session posts its own cards.\n';
    }
    process.stdout.write(`${started}\n${note}${injectRules(sid)}`);
    return;
  }

  const tag = parseTag(prompt);
  if (tag && serverPid() && projectActive(cwd)) {
    registerSession(sid, cwd);
    if (tag.type === 'member') {
      setMember(sid, tag);
      process.stdout.write(injectRules(sid));
    } else {
      recordClaudePid(sid);
      const res = performHandoff(tag.from, sid, tag.doc);
      process.stdout.write(`${handoffNote(tag, res)}${injectRules(sid)}`);
    }
    setState(sid, 'working');
    return;
  }

  if (!isRegistered(sid) && serverPid() && projectActive(cwd)) {
    registerSession(sid, cwd);
    process.stdout.write(injectRules(sid));
  } else if (me) {
    const update = pendingRules(sid);
    if (update) process.stdout.write(update);
  }
  setState(sid, 'working');
})();
