// Hook use cases (docs/architecture.md §3.3): onSessionStart, onPrompt, onStop, onSessionEnd take the hook's input
// object and return { stdout } (what the hook prints; '' for nothing, zero tokens). The hook files only call
// runHook(name, fn): read stdin, run, print; never throw, always exit 0, errors go to the plugin log with the hook
// name and session id.
const fs = require('fs');
const path = require('path');
const {
  paths, readJson, readHookInput, safeId, serverPid, projectActive, projectKey, setProject, registerSession, injectRules,
  isRegistered, pendingRules, parseTag, setMember, performHandoff, recordClaudePid, replacedText, memberStart, addTeam,
  removeTeams, teamOfLead, readProjects, rememberModel, appendCard, appendJsonl, git, takeInbox, formatMessages,
  messagesReason, readTranscriptTail, lastHumanIndex, turnUsage, USAGE_KEYS, routeCard, deliver, reportMessage,
  rulesUpdate, pruneGroup, leadContextNotice, checkBriefs, teamRole, teamOfSession, own, newId, waitLockPath, stopWaiter,
} = require('../lib');
const control = require('../control');
const sessionsStore = require('../store/sessions');
const { clone } = require('../store/record');
const { log } = require('../core/log');
const { parseCard } = require('../domain/card');
const { transition } = require('../domain/session');
const lifecycle = require('./lifecycle');

// Each use case runs its body with a write(text) collector, so the bodies read like the old hook scripts.
const collect = (fn) => async (input = {}) => {
  const out = [];
  await fn(input || {}, (s) => out.push(String(s)));
  return { stdout: out.join('') };
};

// --- SessionStart ---
// SessionStart hook: if the session belongs to a project connected to the dashboard,
// register it and inject the instructions. Otherwise print nothing (zero tokens).
// Team mode: a new session gets its instructions on its first prompt instead, because only the
// prompt carries the member tag. A member started by team.js spawn is known already (pre-registered
// under its --session-id), so it gets its group brief and instructions here: SessionStart output lands
// before the first prompt, UserPromptSubmit output after it. Every registered session records its Claude pid.
const onSessionStart = collect(async (input, write) => {
  const cwd = input.cwd || process.cwd();
  if (!serverPid() || !projectActive(cwd)) return;
  const sid = safeId(input.session_id);
  if (input.model) try { rememberModel(sid, typeof input.model === 'string' ? input.model : input.model.id || input.model.display_name); } catch { /* best effort */ }
  const project = readProjects()[projectKey(cwd)];
  const known = readJson(paths.sessions, {})[sid];
  if (known?.replaced_by) return void write(replacedText(known));
  if (project?.mode === 'team' && (!known || (known.pending && known.kind !== 'member'))) return;
  registerSession(sid, cwd);
  recordClaudePid(sid); // every kind of session: its death is detected by this pid (bug-005)
  write(known?.pending ? memberStart(sid) : injectRules(sid));
});

// --- UserPromptSubmit ---
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
// Record the session's Claude pid; when none is found, remember that (claude_pid 0) so later prompts don't search again.
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
  sessionsStore.update((sessions) => {
    if (sessions[sid] && sessions[sid].claude_pid === undefined) sessions[sid].claude_pid = 0;
  });
}

const onPrompt = collect(async (input, write) => {
  const cwd = input.cwd || process.cwd();
  const sid = safeId(input.session_id);
  const prompt = String(input.prompt || '');
  const m = prompt.match(ACTIVATE);

  // A lead replaced by a handoff does no more work (fallback when its process could not be stopped).
  const me = readJson(paths.sessions, {})[sid];
  if (me?.replaced_by) {
    write(JSON.stringify({ decision: 'block', reason: replacedText(me) }));
    return;
  }

  if (m && /^\s*off\b/i.test(m[1])) {
    const left = setProject(cwd, false);
    const msg = left ? '' : ` ${control.stop()}`;
    write(`[ddashboard] Disconnected this project from the dashboard.${msg}`);
    return;
  }

  if (m) {
    const team = m[1].match(/^\s*team\b\s*(.*)$/i);
    const solo = /^\s*solo\b/i.test(m[1]);
    const started = await control.start();
    setProject(cwd, true);
    registerSession(sid, cwd);
    lifecycle.apply(sid, 'prompt');
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
    write(`${started}\n${note}${injectRules(sid)}`);
    return;
  }

  const tag = parseTag(prompt);
  if (tag && serverPid() && projectActive(cwd)) {
    registerSession(sid, cwd);
    if (tag.type === 'member') {
      // A spawned member already got its brief and instructions at SessionStart.
      setMember(sid, tag);
      if (!me?.start_rules) write(memberStart(sid));
    } else {
      recordClaudePid(sid);
      const res = performHandoff(tag.from, sid, tag.doc);
      write(`${handoffNote(tag, res)}${injectRules(sid)}`);
    }
    lifecycle.apply(sid, 'prompt');
    return;
  }

  if (!isRegistered(sid) && serverPid() && projectActive(cwd)) {
    registerSession(sid, cwd);
    recordPidOnce(sid);
    write(injectRules(sid));
  } else if (me) {
    if (me.claude_pid === undefined && !me.headless) recordPidOnce(sid); // registered before pids were recorded
    const update = pendingRules(sid);
    if (update) write(update);
  }
  lifecycle.apply(sid, 'prompt');
});

// --- Stop ---
// Stop hook (no model calls, zero tokens). Only acts on dashboard-connected sessions.
// 1) Find the ```card block in this turn's reply and append it to cards/YYYY-MM.jsonl.
//    "replaces":"last" retires this session's previous card (the server treats it as archived).
//    "key":"<task>" retires every earlier board card of the same project with that key, from any session.
// 2) Add this turn's token usage to usage/YYYY-MM.jsonl and the session's running totals (cards or not).
//    Team mode: a member's card is stored with via_lead and sent to its lead's inbox as a report
//    (if the lead has ended, it goes to the dashboard marked lead_missing).
// 3) If messages are waiting in the inbox (dashboard replies, team reports, lead instructions),
//    keep the session going and hand them over as the next instruction.
// 4) A team lead whose context is over the limit is told once to write a handoff doc and run T handoff.
// Assistant text after the last human input.
// Record this turn's usage. A turn continued by this hook (dashboard reply handed over) has no new
// human input in the transcript, so message ids already counted since the same input are skipped.
const MAX_MARK_IDS = 500;

// Assistant text after the last human input.
function lastTurnText(rows) {
  const texts = [];
  for (let i = lastHumanIndex(rows) + 1; i < rows.length; i++) {
    const o = rows[i];
    if (o?.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue;
    for (const c of o.message.content) if (c?.type === 'text') texts.push(c.text);
  }
  return texts.join('\n');
}

// Record this turn's usage. A turn continued by this hook (dashboard reply handed over) has no new
// human input in the transcript, so message ids already counted since the same input are skipped.
function recordUsage(s, sid, rows) {
  const mark = s.usage_mark || {};
  const probe = turnUsage(rows);
  const sameTurn = probe.boundary && probe.boundary === mark.boundary;
  const u = sameTurn ? turnUsage(rows, new Set(mark.ids || [])) : probe;
  let reason = u.reason;
  if (sameTurn && s.reply_handed) reason = typeof s.reply_handed === 'string' ? s.reply_handed : 'reply';
  delete s.reply_handed;
  s.usage_mark = { boundary: u.boundary, ids: [...(sameTurn ? mark.ids || [] : []), ...u.ids].slice(-MAX_MARK_IDS) };
  if (!u.ids.length) return; // nothing new (e.g. no transcript)

  const ts = new Date().toISOString();
  appendJsonl(paths.usageFor(ts), {
    ts, session_id: sid, project: s.project || '',
    input: u.input, cache_read: u.cache_read, cache_write: u.cache_write, output: u.output,
    context: u.context, reason,
  });
  const total = s.usage || {};
  s.usage = Object.fromEntries(USAGE_KEYS.map((k) => [k, (Number(total[k]) || 0) + u[k]]));
  s.usage.turns = (Number(total.turns) || 0) + 1;
  s.last_context = u.context;
}

const onStop = collect(async (input, write) => {
  const sid = safeId(input.session_id);
  // Works on a copy; at the end only the fields this hook changed are written (patchDiff), so the slow parts
  // (git, transcript, group upkeep) never overwrite what other processes wrote meanwhile.
  const sessions = sessionsStore.read();
  if (!sessions[sid]) return; // not a dashboard session
  const before = clone(sessions[sid]);
  const projects = readProjects();
  const cwd = input.cwd || process.cwd();
  const rows = input.transcript_path ? readTranscriptTail(input.transcript_path) : [];

  // A lead replaced by a handoff posts nothing and gets no messages (its inbox moved to the new lead).
  // It is told once to stop: the fallback for when its Claude process could not be stopped.
  if (sessions[sid].replaced_by) {
    const s = sessions[sid];
    try { recordUsage(s, sid, rows); } catch { /* usage is best effort */ }
    const tell = !s.replaced_told;
    s.replaced_told = true;
    sessionsStore.patchDiff(sid, before, s);
    if (tell) write(JSON.stringify({ decision: 'block', reason: replacedText(s) }));
    return;
  }

  // 1) Record the card. Skip it if it is the same card again (e.g. a reply-driven turn without a new card).
  const text = input.last_assistant_message || lastTurnText(rows);
  const card = parseCard(text);
  const cardKey = card && JSON.stringify(card);
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  if (card && sessions[sid].last_card !== cardKey) {
    const id = newId();
    // "replaces":"last" is stored as the id of the card it replaces, so the server can archive that one.
    if (card.replaces === 'last') {
      if (sessions[sid].last_card_id) card.replaces = sessions[sid].last_card_id;
      else delete card.replaces;
    }
    const route = routeCard(sessions, projects, sid);
    // Keys only link cards on the board (lead and solo cards); a member's card is a report, so its key is dropped.
    if (route.role === 'member') delete card.key;
    const stored = {
      id,
      ts: new Date().toISOString(),
      session_id: sid,
      session_name: sessions[sid].name || path.basename(cwd),
      project: sessions[sid].project || '',
      project_key: sessions[sid].project_key || '',
      branch,
      diffstat: git('diff --shortstat HEAD', cwd),
      ...card,
    };
    if (route.to === 'lead') stored.via_lead = route.lead;
    if (route.lead_missing) stored.lead_missing = true;
    appendCard(stored);
    if (route.to === 'lead') deliver(route.lead, reportMessage(stored, sessions[sid]));
    sessions[sid].last_card = cardKey;
    sessions[sid].last_card_id = id;
    sessions[sid].last_status = card.status;
    sessions[sid].last_title = card.title;
  }

  // Group folder upkeep: keep the newest handoffs, drop old notes (only inside its own team's docs/teams/<team>/<group>/).
  const group = sessions[sid].group && own(teamOfSession(sessions[sid], projects[sessions[sid].project_key])?.team.groups, sessions[sid].group);
  if (group) try { pruneGroup(group); } catch { /* best effort */ }
  // Brief staleness (lead and members only): the lead is told once when a brief falls behind HEAD.
  if (['lead', 'member'].includes(teamRole(sessions[sid], projects[sessions[sid].project_key]))) {
    try { checkBriefs(sessions[sid].project_key); } catch { /* best effort */ }
  }

  // 2) Token usage of this turn (never blocks the rest of the hook).
  try { recordUsage(sessions[sid], sid, rows); } catch { /* usage is best effort */ }

  // 4) Lead context limit (once per lead session).
  const lastModel = [...rows].reverse().find((r) => r?.type === 'assistant' && r.message?.model)?.message.model;
  const notice = leadContextNotice(sessions[sid], projects[sessions[sid].project_key], { transcript: input.transcript_path, models: [lastModel], cwd });

  // 3) Hand over waiting messages (the session then stays "working").
  //    After a mode switch, the new instructions ride along once.
  const msgs = takeInbox(sid);
  let rules = '';
  if (msgs.length) {
    sessions[sid].reply_handed = messagesReason(msgs);
    rules = rulesUpdate(sessions[sid], projects[sessions[sid].project_key]);
  }
  if (branch) sessions[sid].branch = branch;
  const busy = Boolean(msgs.length || notice);
  const stop = transition(sessions[sid], 'stop', { busy });
  Object.assign(sessions[sid], stop.patch, { last_seen: new Date().toISOString() });
  // A session ended meanwhile (team end, handoff, marked ended) stays ended: the transition is checked again on
  // the current record, under the lock.
  sessionsStore.patchDiff(sid, before, sessions[sid], (cur, changes) => {
    if (!transition(cur, 'stop', { busy }).ok) delete changes.state;
  });

  const parts = [];
  if (msgs.length) parts.push(`${formatMessages(msgs)}${rules ? `\n\n${rules}` : ''}`);
  if (notice) parts.push(notice);
  if (parts.length) write(JSON.stringify({ decision: 'block', reason: parts.join('\n\n') }));
});

// --- SessionEnd ---
// SessionEnd hook: mark a dashboard-connected session as ended (reason exit; no output, zero tokens). Entering ended
// stops its wait command (supervisor.stop), which would otherwise keep running with nobody to wake (bug-005).
const onSessionEnd = collect(async (input) => {
  const sid = safeId(input.session_id);
  const r = lifecycle.apply(sid, 'end', { reason: 'exit' });
  // Already ended (team end, handoff, gone): its waiter still goes.
  if (!r.ok && fs.existsSync(waitLockPath(sid))) try { stopWaiter(sid); } catch { /* best effort */ }
});

const USE_CASES = { onSessionStart, onPrompt, onStop, onSessionEnd };

// The whole hook process: stdin -> use case -> stdout. Never throws, exit code 0 (a failing hook must never break
// Claude); an error prints nothing and is logged as "hook <name>: <session id>: <stack>".
async function runHook(name, fn) {
  let input = {};
  try {
    input = await readHookInput();
    const use = typeof fn === 'function' ? fn : USE_CASES[fn];
    const r = await use(input);
    if (r?.stdout) process.stdout.write(r.stdout);
  } catch (err) {
    log(`hook ${name}`, `${safeId(input?.session_id) || '-'}: ${err?.stack || err}`);
  }
  process.exitCode = 0;
}

module.exports = { ...USE_CASES, runHook, lastTurnText, recordUsage };
