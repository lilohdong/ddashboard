// Team member use cases: spawn, send, list, end, groups, lead handoff preparation. Shared by team.js (the CLI, which
// only parses arguments and prints) and the dashboard server. Every function works on the caller's own team only.
// Errors are thrown as Error with a one-line message for the user.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../core/config');
const { paths } = require('../core/paths');
const { readJsonl } = require('../core/fsx');
const sessionsStore = require('../store/sessions');
const cardsStore = require('../store/cards');
const inbox = require('../store/inbox');
const { alive, processTable, findClaudePid } = require('../proc/table');
const { waitPid } = require('../proc/waiter');
const supervisor = require('../proc/supervisor');
const orca = require('../runners/orca');
const terminal = require('../runners/window');
const headless = require('../runners/headless');
const { claudeArgs } = require('../runners/claude-cmd');
const { view, isEnded } = require('../domain/session');
const { DEFAULT_SPAWN, RUNNER_VALUES, own, teamOfLead, teamOfSession, teamMembers } = require('../domain/team');
const { estimateTokens, HANDOFF_MAX_TOKENS } = require('../domain/lead-context');
const lifecycle = require('./lifecycle');
const { readProjects, updateProjects } = require('./teams');
const groups = require('./groups');
const { pruneGroup, latestHandoff, reserveHandoff, existingLeadRules, leadRulesPath } = require('./team-files');

const slash = (p) => String(p).replace(/\\/g, '/');

// Register a session as a member (from its tag). The session must be registered already.
function setMember(sid, tag) {
  return sessionsStore.patch(sid, {
    kind: 'member', role: tag.role, lead: tag.lead, stay: Boolean(tag.stay), pending: undefined,
    ...(tag.group ? { group: tag.group } : {}),
    ...(config.get('DDASH_NAME') ? {} : { name: tag.role }),
  });
}

// Save the session's Claude Code pid (best effort). Returns the pid or 0.
function recordClaudePid(sid, startPid = process.ppid) {
  const pid = findClaudePid(startPid);
  if (!pid) return 0;
  return sessionsStore.patch(sid, { claude_pid: pid }) ? pid : 0;
}

function context(leadSid) {
  const sessions = sessionsStore.read();
  const lead = sessions[leadSid];
  if (!lead) throw new Error(`unknown session ${leadSid}. Pass your own session ID (it is in your [ddashboard] instructions).`);
  const projects = readProjects();
  const project = projects[lead.project_key];
  if (!project) throw new Error('this project is not connected to the dashboard.');
  return { sessions, projects, lead, project };
}

// The team this session leads: { name, team }. Throws if it leads none.
function ownTeam(project, leadSid) {
  const t = teamOfLead(project, leadSid);
  if (!t) throw new Error('you are not the lead of a team in this project.');
  return t;
}

// Headless permissions come from projects.json[<project>].spawn = { permission_mode, allowed_tools },
// default: auto (the auto-mode classifier) + Bash(git *), Bash(node *), Bash(npm *).
function spawnOptions(project, flags) {
  const conf = { ...DEFAULT_SPAWN, ...(project.spawn || {}) };
  return {
    model: flags.model || conf.model || undefined,
    permission_mode: conf.permission_mode,
    allowed_tools: [].concat(conf.allowed_tools || []),
  };
}

const tagValue = (v) => (/^[^\s\]"]+$/.test(v) ? v : `"${String(v).replace(/["\]]/g, '')}"`);

// Runners: headless (claude -p in the background), orca (Orca terminal), window (new OS terminal window).
const RUNNERS = RUNNER_VALUES;

// The project's runner for new leads ('lead') or members ('member'): projects.json spawn.runner_<kind>, default headless.
function configuredRunner(project, kind) {
  const r = project?.spawn?.[`runner_${kind}`];
  return RUNNERS.includes(r) ? r : 'headless';
}

// Why a runner cannot run here ('' when it can).
function runnerProblem(r) {
  if (r === 'orca') return orca.available() ? '' : 'Orca is not running (see: orca status)';
  if (r === 'window') return terminal.unavailableReason();
  return '';
}

// Where a new session runs. forced (a runner flag) must work here or it is refused; the configured runner
// falls back to headless with a note. Returns { how, note }.
function pickRunner(forced, configured = 'headless') {
  if (forced) {
    const why = runnerProblem(forced);
    if (why) throw new Error(`${why}. Use --headless, or leave out --${forced}.`);
    return { how: forced, note: '' };
  }
  const want = RUNNERS.includes(configured) ? configured : 'headless';
  const why = runnerProblem(want);
  return why ? { how: 'headless', note: `The configured runner ${want} is not available (${why}); started headless instead.` } : { how: want, note: '' };
}

const runnerLabel = (r) => (r === 'orca' ? 'Orca' : 'The terminal window');

// Start a member of this lead with the project's runner_member (see pickRunner). runner forces one
// ('headless' | 'orca' | 'window'). Returns { sid, runner, pid, terminal, log, note }.
function spawnMember(leadSid, { role, model, stay, task, group, runner } = {}) {
  role = String(role || '').trim().slice(0, 40);
  task = String(task || '').trim();
  group = group ? String(group).trim() : '';
  if (!role || !task) throw new Error('spawn needs a role and a task.');
  const { lead, project } = context(leadSid);
  const mine = ownTeam(project, leadSid);
  const g = group ? own(mine.team.groups, group) : null;
  if (group && !g) throw new Error(`no group ${group} in team ${mine.name}. Create it with: group create ${group}`);
  if (g) {
    pruneGroup(g);
    try { groups.checkBriefs(lead.project_key); } catch { /* best effort */ }
  }
  const picked = pickRunner(runner, configuredRunner(project, 'member'));
  let how = picked.how;
  const sid = crypto.randomUUID();
  const flags = { role, model: model ? String(model).trim() : undefined, stay: Boolean(stay) };
  const opts = spawnOptions(project, flags);
  // The lead may sit in a subfolder (e.g. scripts/); members start at the worktree root so they can reach the whole repo.
  const cwd = orca.worktreeRoot(lead.cwd || process.cwd());
  const prompt = `[ddash role=${tagValue(flags.role)} lead=${leadSid} stay=${flags.stay ? 1 : 0}${group ? ` group=${group}` : ''}] ${task}`;

  // Pre-register so the member shows up at once; its first-prompt hook completes the registration.
  lifecycle.apply(sid, 'spawn', {
    fields: {
      session_id: sid, name: flags.role, cwd, branch: lead.branch || '', project: lead.project, project_key: lead.project_key,
      kind: 'member', role: flags.role, lead: leadSid, stay: Boolean(flags.stay), headless: how === 'headless', runner: how,
      spawn: { ...opts, cwd }, log: paths.log(sid), ...(group ? { group } : {}),
    },
  });
  const log = slash(paths.log(sid));
  let note = picked.note;
  if (how !== 'headless') {
    try {
      const args = ['--session-id', sid, ...claudeArgs(opts)];
      const title = `${flags.role}${group ? ` · ${group}` : ''}`;
      if (how === 'window') {
        terminal.launch(sid, args, prompt, cwd, title);
        return { sid, runner: how, pid: 0, terminal: '', log, note };
      }
      const t = orca.launch(sid, args, prompt, cwd, title);
      sessionsStore.patch(sid, { orca: t });
      return { sid, runner: how, pid: 0, terminal: t.handle, log, note };
    } catch (err) {
      if (runner === how) {
        sessionsStore.update((all) => { delete all[sid]; });
        throw err;
      }
      note = `${runnerLabel(how)} could not open a terminal (${err.message}); started headless instead.`;
      how = 'headless';
      sessionsStore.patch(sid, { runner: how, headless: true });
    }
  }
  const pid = headless.run(sid, ['-p', '--session-id', sid, ...claudeArgs(opts)], prompt, cwd);
  sessionsStore.patch(sid, { pid });
  return { sid, runner: how, pid, terminal: '', log, note };
}

// A member of this lead by full id, id prefix or role (the most recently active one wins).
function findMember(sessions, leadSid, key) {
  const members = Object.values(sessions).filter((s) => s.kind === 'member' && s.lead === leadSid);
  const k = String(key || '').toLowerCase();
  const byId = members.filter((s) => s.session_id === key || (k.length >= 4 && s.session_id.toLowerCase().startsWith(k)));
  const list = byId.length ? byId : members.filter((s) => String(s.role || '').toLowerCase() === k);
  list.sort((a, b) => Number(isEnded(a)) - Number(isEnded(b)) || String(b.last_seen).localeCompare(String(a.last_seen)));
  return list[0] || null;
}

// Mark members ended (end_reason 'gone') that died without their SessionEnd hook. Returns the ids changed.
function endGone(sids) {
  const ts = new Date().toISOString();
  return sids.filter((sid) => lifecycle.apply(sid, 'end', { reason: 'gone', ts, seen: false }).ok);
}

const order = (leadSid, text) => ({ type: 'order', from: leadSid, text: text.slice(0, 8000) });

// An instruction to a member. Returns { role, sid, action, ... }:
//   queued  { wake: 'waiting' | 'turn' | 'window' | 'next' }   into its inbox
//   typed   { handle }                                          typed into its idle Orca terminal
//   resumed { runner, pid, handle, log, why }                   resumed (why: the reason it fell back to headless)
function sendMember(leadSid, target, text) {
  text = String(text || '').trim();
  if (!target || !text) throw new Error('send needs a member (session id or role) and the text.');
  const { sessions } = context(leadSid);
  let m = findMember(sessions, leadSid, target);
  if (!m) throw new Error(`no member "${target}" of this lead. See: list`);
  const sid = m.session_id;
  const base = { role: m.role, sid };
  if (m.runner === 'orca') return { ...base, ...sendOrca(leadSid, m, text) };
  if (m.runner === 'window' && !isEnded(m) && supervisor.gone(m) && endGone([sid]).length) m = sessionsStore.get(sid) || m;
  if (m.runner === 'window' && isEnded(m)) return { ...base, ...resumeWindow(m, text) };
  const running = m.headless && alive(m.pid);
  if (waitPid(sid) || running || !m.headless) {
    inbox.deliver(sid, order(leadSid, text));
    const wake = waitPid(sid) ? 'waiting' : running || m.state === 'working' ? 'turn' : m.runner === 'window' ? 'window' : 'next';
    return { ...base, action: 'queued', wake };
  }
  // Headless member that has finished: resume it with the same options.
  const opts = m.spawn || {};
  const pid = headless.run(sid, ['-p', '--resume', sid, ...claudeArgs(opts)], `[Lead instruction]\n${text}`, opts.cwd || m.cwd || process.cwd());
  lifecycle.apply(sid, 'resume', { fields: { pid } });
  return { ...base, action: 'resumed', runner: 'headless', pid, log: slash(paths.log(sid)) };
}

// An instruction to a member running in an Orca terminal:
// - terminal open and the member waiting or mid-turn: into its inbox (wait command or Stop hook hands it over)
// - terminal open and the member idle at its prompt: typed into the terminal (one line, so Enter submits it whole)
// - session ended or terminal closed: resumed in a new Orca terminal (headless if Orca is not running)
function sendOrca(leadSid, m, text) {
  const sid = m.session_id;
  const open = !isEnded(m) && orca.writable(m.orca?.handle);
  if (open && (waitPid(sid) || m.state === 'working')) {
    inbox.deliver(sid, order(leadSid, text));
    return { action: 'queued', wake: waitPid(sid) ? 'waiting' : 'turn' };
  }
  const now = new Date().toISOString();
  if (open) {
    orca.sendText(m.orca.handle, `[Lead instruction] ${text.replace(/\s*\r?\n\s*/g, ' ').trim()}`);
    lifecycle.apply(sid, 'prompt', { ts: now });
    return { action: 'typed', handle: m.orca.handle };
  }
  const opts = m.spawn || {};
  const cwd = opts.cwd || m.cwd || process.cwd();
  const prompt = `[Lead instruction]\n${text}`;
  if (orca.available()) {
    try {
      const t = orca.launch(sid, ['--resume', sid, ...claudeArgs(opts)], prompt, cwd, `${m.role}${m.group ? ` · ${m.group}` : ''}`);
      lifecycle.apply(sid, 'resume', { ts: now, fields: { orca: t } });
      return { action: 'resumed', runner: 'orca', handle: t.handle };
    } catch { /* fall back to headless */ }
  }
  const pid = headless.run(sid, ['-p', '--resume', sid, ...claudeArgs(opts)], prompt, cwd);
  lifecycle.apply(sid, 'resume', { ts: now, fields: { pid, runner: 'headless', headless: true } });
  return { action: 'resumed', runner: 'headless', pid, log: slash(paths.log(sid)), why: 'Orca is not available' };
}

// A member that ran in a terminal window and has ended: resumed in a new window (headless when none can open).
function resumeWindow(m, text) {
  const sid = m.session_id;
  const opts = m.spawn || {};
  const cwd = opts.cwd || m.cwd || process.cwd();
  const prompt = `[Lead instruction]\n${text}`;
  const now = new Date().toISOString();
  let why = terminal.unavailableReason();
  if (!why) {
    try {
      terminal.launch(sid, ['--resume', sid, ...claudeArgs(opts)], prompt, cwd, `${m.role}${m.group ? ` · ${m.group}` : ''}`);
      lifecycle.apply(sid, 'resume', { ts: now });
      return { action: 'resumed', runner: 'window' };
    } catch (err) { why = err.message; }
  }
  const pid = headless.run(sid, ['-p', '--resume', sid, ...claudeArgs(opts)], prompt, cwd);
  lifecycle.apply(sid, 'resume', { ts: now, fields: { pid, runner: 'headless', headless: true } });
  return { action: 'resumed', runner: 'headless', pid, log: slash(paths.log(sid)), why: `no terminal window (${why})` };
}

// This lead's members: [{ s, state, waiting, pending }]. Members that died without their SessionEnd hook (e.g. Orca
// terminal closed by hand) are marked ended first.
function listMembers(leadSid) {
  const { sessions, project } = context(leadSid);
  let members = Object.values(sessions).filter((s) => s.kind === 'member' && s.lead === leadSid);
  // A session that leads no team and has no members gets told why, instead of an empty list.
  if (!members.length && !teamOfLead(project, leadSid)) {
    const me = sessions[leadSid];
    throw new Error(me.kind === 'member'
      ? `this session is a member (role ${me.role || 'member'}); only its lead (${String(me.lead || '?').slice(0, 8)}) can list members.`
      : 'this session is not the lead of a team in this project. Make it one with /ddashboard:dashboard team <name>.');
  }
  if (endGone(members.filter((s) => supervisor.gone(s, orca.terminalOpen)).map((s) => s.session_id)).length) {
    const now = sessionsStore.read();
    members = members.map((s) => now[s.session_id] || s);
  }
  return members.map((s) => {
    const waiting = waitPid(s.session_id);
    const { state } = view(s, { waiting: Boolean(waiting), pidAlive: Boolean(s.pid && alive(s.pid)) });
    let pending = 0;
    try { pending = fs.readdirSync(paths.inbox(s.session_id)).filter((f) => f.endsWith('.json')).length; } catch {}
    return { s, state, waiting, pending };
  });
}

// The pid of a window member's shell when it is still that shell: the launcher it started is alive under it, or
// it is still a shell process (cmd, sh, ...). 0 otherwise (pid reused or gone).
function windowShell(m) {
  const shell = Number(m.window_shell_pid);
  if (!(shell > 0) || !alive(shell)) return 0;
  const table = processTable();
  const launcher = table.get(Number(m.window_launch_pid));
  if (launcher && launcher.ppid === shell) return shell;
  return /^(cmd|sh|bash|zsh|dash|fish|login)(\.exe)?$/i.test(String(table.get(shell)?.name || '')) ? shell : 0;
}

// Stop a member of this lead: close its Orca terminal, stop its wait command, Claude process and headless run,
// and mark it ended (end_reason 'stopped'). Returns { sid, role, done: [what was stopped] } or { ..., already, ended }.
function endMember(leadSid, key) {
  const { sessions } = context(leadSid);
  const m = findMember(sessions, leadSid, key);
  if (!m) throw new Error(`no member "${key}" of this lead. See: list`);
  const sid = m.session_id;
  // Already ended: nothing is closed or killed (its terminal handle or pids may belong to something else by now).
  if (isEnded(m)) return { sid, role: m.role, done: [], already: true, ended: m.ended || '' };
  // Entering ended(stopped) runs supervisor.stop: Orca terminal, window shell, wait command, Claude tree, tool
  // shells of a dead Claude, headless run.
  const r = lifecycle.apply(sid, 'end', { reason: 'stopped', stop: { closeTerminal: orca.closeTerminal, windowShell } });
  if (!r.ok) return { sid, role: m.role, done: [], already: true, ended: sessionsStore.get(sid)?.ended || '' };
  return { sid, role: m.role, done: r.stopped?.done || [] };
}

// A card by id (newest file first), or null.
function findCard(id) {
  const files = cardsStore.files().slice().reverse();
  for (const f of files) {
    const rows = readJsonl(f);
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id === id) return rows[i];
  }
  return null;
}

// Prepare a lead handoff: check the doc, record the handoff, and start the new lead when spawn (or a runner) is
// given. claudeStartPid: where to look for the lead's own Claude process (the CLI's parent).
// Returns { prompt, stop, team, configured, rulesMissing, started: { runner, sid, handle, pid, log, note } | null }.
function prepareHandoff(leadSid, docPath, { spawn = false, runner, model, claudeStartPid = process.ppid } = {}) {
  if (!docPath) throw new Error('handoff needs the path of your handoff doc.');
  const { lead, project } = context(leadSid);
  // A runner implies spawn. Check it before anything is written.
  const picked = spawn || runner ? pickRunner(runner, configuredRunner(project, 'lead')) : null;
  const doc = slash(path.resolve(docPath));
  if (!fs.existsSync(doc)) throw new Error(`handoff doc not found: ${doc}`);
  const tokens = estimateTokens(fs.readFileSync(doc, 'utf8'));
  if (HANDOFF_MAX_TOKENS && tokens > HANDOFF_MAX_TOKENS) throw new Error(`handoff doc is too long: about ${tokens} tokens (limit ${HANDOFF_MAX_TOKENS}). Shorten it to the current state only (open items, members and tasks, changed decisions, next steps); move finished work to the plan/commits and fixed rules to the team's lead-rules.md. Then run handoff again.`);
  const mine = ownTeam(project, leadSid);
  // This command runs under the lead's own Claude process: remember its pid so the takeover can stop it.
  const claudePid = module.exports.recordClaudePid(leadSid, claudeStartPid); // through exports: tests hook it
  const rules = existingLeadRules(mine.team, mine.name);
  // Re-read just before writing: only the handoff record changes (settings changed meanwhile, e.g. on the dashboard, stay).
  updateProjects((all) => {
    const t = teamOfLead(own(all, lead.project_key), leadSid);
    if (t) t.team.handoff = { from: leadSid, doc, ts: new Date().toISOString() };
  });
  const prompt = `[ddash lead-handoff from=${leadSid} doc=${tagValue(doc)}] Read only this handoff doc${rules ? ` and the team rules ${rules}` : ''} (not older handoff docs), then take over as team lead. Start the wait command from your instructions.`;
  const stop = claudePid ? `this session (Claude pid ${claudePid}) is stopped` : 'this session is told to stop (its Claude process was not found)';
  const out = { prompt, stop, team: mine.name, configured: configuredRunner(project, 'lead'), rulesMissing: rules ? '' : leadRulesPath(mine.team, mine.name), started: null };
  if (!picked) return out;
  const sid = crypto.randomUUID();
  const opts = spawnOptions(project, { model });
  const cwd = lead.cwd || process.cwd();
  const args = ['--session-id', sid, ...claudeArgs(opts)];
  let note = picked.note ? `${picked.note}\n` : '';
  if (picked.how !== 'headless') {
    // Interactive (no -p) in a visible terminal; Orca at the worktree root like members.
    try {
      if (picked.how === 'window') {
        terminal.launch(sid, args, prompt, orca.worktreeRoot(cwd), `lead ${mine.name}`);
        return { ...out, started: { runner: 'window', sid, note } };
      }
      const t = orca.launch(sid, args, prompt, orca.worktreeRoot(cwd), `lead ${mine.name}`);
      return { ...out, started: { runner: 'orca', sid, handle: t.handle, note } };
    } catch (err) {
      if (runner === picked.how) throw err;
      note += `${runnerLabel(picked.how)} could not open a terminal (${err.message}); started headless instead.\n`;
    }
  }
  const pid = headless.run(sid, ['-p', ...args], prompt, cwd);
  return { ...out, started: { runner: 'headless', sid, pid, log: slash(paths.log(sid)), note } };
}

// --- Groups of the lead's team ---

// create | rename | delete. Returns the app/groups result with the team name; throws on failure.
function groupAction(leadSid, action, { name, newName, purge } = {}) {
  const { lead, project } = context(leadSid);
  const key = lead.project_key;
  const t = teamOfLead(project, leadSid);
  if (!t) throw new Error('groups need team mode with you as a team lead.');
  const done = (r) => { if (!r.ok) throw new Error(r.error); return { ...r, team: t.name }; };
  if (action === 'create') return done(groups.createGroup(key, t.name, name));
  if (action === 'rename') return done(groups.renameGroup(key, t.name, name, newName));
  if (action === 'delete') return done(groups.deleteGroup(key, t.name, name, { purge }));
  throw new Error(`unknown group action ${action}`);
}

function leadTeam(leadSid) {
  const { lead, project, sessions } = context(leadSid);
  const t = teamOfLead(project, leadSid);
  if (!t) throw new Error('groups need team mode with you as a team lead.');
  return { lead, sessions, t, groups: t.team.groups || {} };
}

// The team's groups: { team, rows: [{ name, dir, live, total, latest }] }.
function listGroups(leadSid) {
  const { lead, sessions, t, groups: all } = leadTeam(leadSid);
  const rows = Object.keys(all).sort().map((n) => {
    const members = teamMembers(sessions, lead.project_key, t.team).filter((s) => s.group === n);
    return { name: n, dir: all[n].dir, live: members.filter((s) => !isEnded(s)).length, total: members.length, latest: latestHandoff(all[n].dir) };
  });
  return { team: t.name, rows };
}

// Prune one group (name) or all of them. Returns the removed paths.
function pruneGroups(leadSid, name) {
  const { groups: all } = leadTeam(leadSid);
  if (name && !own(all, name)) throw new Error(`no group ${name}`);
  return (name ? [name] : Object.keys(all)).flatMap((n) => pruneGroup(all[n]));
}

// A member reserves the next handoff file of its own group; a lead names one of its team's groups. Returns its path.
function nextHandoff(sid, groupName) {
  const { sessions, project } = context(sid);
  const me = sessions[sid];
  const t = teamOfSession(me, project);
  if (!t) throw new Error('next-handoff is for team leads and members.');
  const isLead = Boolean(teamOfLead(project, sid));
  const name = isLead ? groupName : me.group;
  if (!name) throw new Error(isLead ? 'next-handoff needs a group name.' : 'you are in no group; report to your lead instead.');
  const g = own(t.team.groups, name);
  if (!g) throw new Error(`no group ${name} in team ${t.name}`);
  return reserveHandoff(g.dir, `# ${name} handoff

`);
}

module.exports = {
  setMember, recordClaudePid, RUNNERS, configuredRunner, pickRunner, spawnOptions, spawnMember, findMember, sendMember, listMembers,
  endMember, findCard, prepareHandoff, groupAction, listGroups, pruneGroups, nextHandoff,
};
