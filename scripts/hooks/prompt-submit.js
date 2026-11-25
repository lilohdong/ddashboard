#!/usr/bin/env node
// UserPromptSubmit hook
// - "/ddashboard:dashboard" (or "/dashboard"): start the server, connect this project, register this session.
//   "... team <name>": add a team named <name> with this session as its lead (other teams stay; a name in use
//   is refused). "... solo": remove the team this session leads; the project is solo when no team is left.
// - "... off": disconnect this project; stop the server when no project is left.
// - A first prompt starting with a tag registers a team member or a new lead taking over:
//   [ddash role=<role> lead=<lead sid> stay=0|1] / [ddash lead-handoff from=<old lead sid> doc=<path>]
// - First prompt in a session that started before the dashboard was turned on: register it and inject the instructions.
// - After a mode switch, the next prompt gets the new instructions once.
// - Connected sessions are marked "working". Anything else prints nothing (zero tokens).
const {
  paths, readJson, writeJson, readHookInput, safeId, serverPid, projectActive, projectKey, setProject, registerSession, setState,
  isRegistered, injectRules, pendingRules, parseTag, setMember, performHandoff, recordClaudePid, replacedText,
  memberStart, addTeam, removeTeams, teamOfLead, readProjects,
} = require('../lib');
const control = require('../control');

const ACTIVATE = /^\s*\/(?:ddashboard:)?dashboard\b(.*)$/i;

function handoffNote(tag, res) {
  if (!res.ok) return `[ddashboard] Lead handoff failed: ${res.error}. You are registered as an ordinary session.\n`;
  const stopped = res.claude_killed ? 'its Claude process was stopped'
    : 'its Claude process could not be stopped, so it gets a stop notice on its next turn';
  return `[ddashboard] You took over as lead of team "${res.team}" from ${tag.from}${tag.doc ? `. Read the handoff doc first: ${tag.doc}` : ''}${res.rules ? `${tag.doc ? ' and' : '. Read'} the team's fixed rules: ${res.rules}` : ''}. Read only these (not older handoff docs).
The members (${res.members}) now report to you; ${res.moved} pending message(s) moved to your inbox; the old lead is ended and ${stopped}.
`;
}

// Record the session's Claude pid; when none is found, remember that (claude_pid 0) so later prompts don't search again.
function recordPidOnce(sid) {
  if (recordClaudePid(sid)) return;
  const sessions = readJson(paths.sessions, {});
  if (sessions[sid] && sessions[sid].claude_pid === undefined) { sessions[sid].claude_pid = 0; writeJson(paths.sessions, sessions); }
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
    const key = projectKey(cwd);
    if (team) {
      const name = team[1].trim().replace(/^["']|["']$/g, '');
      const r = addTeam(key, name || undefined, sid);
      if (r.ok) {
        recordClaudePid(sid);
        note = `Team "${r.team}" was added to this project; this session is its lead. Other teams are unchanged.\n`;
      } else note = `No team was added: ${r.error}.\n`;
    } else if (solo) {
      const own = teamOfLead(readProjects()[key], sid);
      if (own) {
        const r = removeTeams(key, [own.name]);
        note = r.mode === 'team'
          ? `Team "${own.name}" was removed; this session posts its own cards. Other teams are unchanged.\n`
          : `Team "${own.name}" was removed; no team is left, so the project is solo: every connected session posts its own cards.\n`;
      } else note = 'This session leads no team, so nothing changed. Remove other teams from the dashboard.\n';
    }
    process.stdout.write(`${started}\n${note}${injectRules(sid)}`);
    return;
  }

  const tag = parseTag(prompt);
  if (tag && serverPid() && projectActive(cwd)) {
    registerSession(sid, cwd);
    if (tag.type === 'member') {
      // A spawned member already got its brief and instructions at SessionStart.
      setMember(sid, tag);
      if (!me?.start_rules) process.stdout.write(memberStart(sid));
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
    recordPidOnce(sid);
    process.stdout.write(injectRules(sid));
  } else if (me) {
    if (me.claude_pid === undefined && !me.headless) recordPidOnce(sid); // registered before pids were recorded
    const update = pendingRules(sid);
    if (update) process.stdout.write(update);
  }
  setState(sid, 'working');
})();
