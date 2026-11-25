// Shared helpers: board paths, file I/O, server status, project/session registry, session instructions.
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./core/config');
const { BOARD_DIR, PORT, URL, paths, safeId } = require('./core/paths');
const { ensureDir, readJson, writeJson, atomicWrite, appendJsonl, readJsonl, readTail } = require('./core/fsx');
const { git, gitOrNull: gitIn } = require('./core/git');
const { newId } = require('./core/ids');
const sessionsStore = require('./store/sessions');
const projectsStore = require('./store/projects');
const cardsStore = require('./store/cards');
const rules = require('./domain/rules');
const { ensureWaitBin, ensureTeamBin } = require('./app/bins');
const { alive, parseProcessList, processTable, processTableAsync, isClaudeProcess, findClaudePid, processName, napUntil } = require('./proc/table');
const { killPid, descendants, killTree, killClaude } = require('./proc/kill');
const { isEnded, transition } = require('./domain/session');
const lifecycle = require('./app/lifecycle');
const waiter = require('./proc/waiter');
const supervisor = require('./proc/supervisor');
const {
  waitLockPath, waitInfoPath, readWaitInfo, waitPid, waitCommandSid, waiterChain, killWaiterChain, orphanWaiter,
  sweepWaiters, stopWaiter, reapToolShells, needsProcesses, stopSessionProcesses,
} = waiter;

const RECENT_DAYS = config.get('DDASH_RECENT_DAYS');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function readHookInput() {
  try { return JSON.parse((await readStdin()) || '{}'); } catch { return {}; }
}

function serverPid() {
  const info = readJson(paths.serverPid, null);
  return info && alive(info.pid) ? info.pid : 0;
}

// Worktrees of the same repository count as one project (keyed by the git common dir).
function projectKey(cwd) {
  const common = git('rev-parse --path-format=absolute --git-common-dir', cwd);
  return path.resolve(common || cwd).toLowerCase();
}

// Project name shown on the dashboard: the repository folder name (worktrees group under the original repo).
function projectName(cwd) {
  const common = git('rev-parse --path-format=absolute --git-common-dir', cwd);
  if (!common) return path.basename(cwd);
  const dir = path.resolve(common);
  return path.basename(dir) === '.git' ? path.basename(path.dirname(dir)) : path.basename(dir).replace(/\.git$/, '');
}

function projectActive(cwd) {
  return Boolean(readProjects()[projectKey(cwd)]);
}

// Turning a project on keeps its team settings (mode, teams, rules) from before.
function setProject(cwd, on) {
  const key = projectKey(cwd);
  const name = on ? projectName(cwd) : '';
  readProjects(); // migrate first (outside our update)
  return projectsStore.update((projects) => {
    if (on) projects[key] = { ...(projects[key] || {}), since: new Date().toISOString(), cwd, name };
    else delete projects[key];
    return Object.keys(projects).length;
  });
}

function registerSession(sid, cwd) {
  // git first, outside the lock.
  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  const project = projectName(cwd);
  const key = projectKey(cwd);
  sessionsStore.update((sessions) => {
    sessions[sid] = {
      ...(sessions[sid] || {}),
      session_id: sid,
      name: config.get('DDASH_NAME') || sessions[sid]?.name || path.basename(cwd),
      cwd,
      branch,
      project,
      project_key: key,
    };
    // working stays working, anything else is idle; an ended session is revived, except a lead replaced by a
    // handoff, which stays ended even if the session is resumed.
    lifecycle.applyIn(sessions, sid, 'register');
  });
}

// Old entry for state writes (kept for callers and tests): working -> prompt, idle -> stop, ended -> end (exit).
// Only touches registered sessions; an ended session keeps its state. Returns true when the record exists.
function setState(sid, state) {
  const r = state === 'ended' ? lifecycle.apply(sid, 'end', { reason: 'exit' })
    : lifecycle.apply(sid, state === 'working' ? 'prompt' : 'stop', { busy: false });
  return r.ok || r.code !== 404;
}

function isRegistered(sid) {
  return Boolean(sessionsStore.get(sid));
}

// Usage log files (usage/YYYY-MM.jsonl), oldest first.
function usageFiles() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.usageDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
  return monthly.map((f) => path.join(paths.usageDir, f));
}

// --- Transcript parsing (Stop hook) ---

const TAIL_BYTES = 4 * 1024 * 1024; // read only the tail of large transcripts

// Parsed transcript lines (jsonl) from the tail of the file. The first line may be cut off; it is skipped.
function readTranscriptTail(transcriptPath, tailBytes = TAIL_BYTES) {
  const buf = readTail(transcriptPath, tailBytes);
  if (!buf) return [];
  const rows = [];
  for (const line of buf.toString('utf8').split('\n')) {
    try { rows.push(JSON.parse(line)); } catch { /* partial or malformed line */ }
  }
  return rows;
}

// Text of a user line typed by a person (or injected as a prompt), or null for tool results and other lines.
function humanText(o) {
  if (o?.type !== 'user' || o.isSidechain) return null;
  const content = o.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.some((c) => c?.type === 'text')) {
    return content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
  }
  return null;
}

// Index of the last human input line, or -1.
function lastHumanIndex(rows) {
  for (let i = rows.length - 1; i >= 0; i--) if (humanText(rows[i]) != null) return i;
  return -1;
}

// What woke the session for this turn: reply | report | order | background | human.
function wakeReason(text) {
  const t = String(text || '');
  if (t.includes('[Dashboard reply]')) return 'reply';
  if (t.includes('[Team report]')) return 'report';
  if (t.includes('[Lead instruction]') || /^\s*\[ddash\s+role=/.test(t)) return 'order';
  if (t.trimStart().startsWith('<task-notification>')) return 'background';
  return 'human';
}

const USAGE_KEYS = ['input', 'cache_read', 'cache_write', 'output'];

// Token usage of the assistant messages after the last human input.
// One API response is split into several transcript lines that share message.id and usage,
// so each id is counted once (its last line wins). Ids in `skip` were already counted.
// Returns { input, cache_read, cache_write, output, context, ids, boundary, reason } (ids: newly counted).
function turnUsage(rows, skip = new Set()) {
  const start = lastHumanIndex(rows);
  const boundaryRow = start >= 0 ? rows[start] : null;
  const byId = new Map();
  let last = null;
  for (let i = start + 1; i < rows.length; i++) {
    const o = rows[i];
    if (o?.type !== 'assistant' || o.isSidechain) continue;
    const u = o.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const id = String(o.message.id || o.uuid || `line-${i}`);
    last = u; // context comes from the turn's last assistant message, counted before or not
    if (skip.has(id)) continue;
    byId.delete(id); // keep the order of the last line per id
    byId.set(id, u);
  }
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = { input: 0, cache_read: 0, cache_write: 0, output: 0 };
  for (const u of byId.values()) {
    out.input += n(u.input_tokens);
    out.cache_read += n(u.cache_read_input_tokens);
    out.cache_write += n(u.cache_creation_input_tokens);
    out.output += n(u.output_tokens);
  }
  out.context = last ? n(last.input_tokens) + n(last.cache_read_input_tokens) + n(last.cache_creation_input_tokens) : 0;
  out.ids = [...byId.keys()];
  out.boundary = boundaryRow ? String(boundaryRow.uuid || boundaryRow.timestamp || start) : '';
  out.reason = boundaryRow ? wakeReason(humanText(boundaryRow)) : 'human';
  return out;
}

const slash = (p) => p.replace(/\\/g, '/');

// --- Settings (settings.json): lang = dashboard and card language, ver bumps on each change ---

const { LANG_NAMES, RULES_TEXT_VER, replacedText } = rules;

function readSettings() {
  const s = readJson(paths.settings, {});
  return s && typeof s === 'object' ? s : {};
}

// Set (or clear with null/'') the language. Sessions get their instructions again once (see rulesUpdate).
function saveSettings({ lang } = {}) {
  if (lang && !LANG_NAMES[lang]) return { ok: false, error: `lang must be one of ${Object.keys(LANG_NAMES).join(', ')}` };
  const s = readSettings();
  if ((s.lang || '') === (lang || '')) return { ok: true, settings: s };
  if (lang) s.lang = lang; else delete s.lang;
  s.ver = (Number(s.ver) || 0) + 1;
  writeJson(paths.settings, s);
  return { ok: true, settings: s };
}

// What the rules texts need (domain/rules). The command paths are written only when a text uses them.
const rulesCtx = () => ({
  url: URL,
  lang: readSettings().lang,
  get waitBin() { return slash(ensureWaitBin()); },
  get teamBin() { return slash(ensureTeamBin()); },
});

const rulesText = (sid) => rules.soloText(sid, rulesCtx());

// --- Team mode --- (pure rules in domain/team.js, tags in domain/tags.js)
const {
  DEFAULT_SPAWN, RUNNER_VALUES, runnersOf, TEAM_NAME, GROUP_NAME, GROUP_NAME_ERROR, GROUP_DEFAULTS, badGroupName, groupSettings,
  teamsOf, own, sameName, hasTeams, teamOfLead, teamOfSession, teamSlug, teamMembers, teamRole, routeCard,
  syncMode, addTeamIn, removeTeamsIn,
} = require('./domain/team');
const { parseTag } = require('./domain/tags');

// Save a project's runners (either or both). Returns { ok, runner_lead, runner_member } or { ok: false, code, error }.
function setRunners(key, values = {}) {
  readProjects(); // migrate first
  return projectsStore.update((projects) => {
    const p = own(projects, key);
    if (!p) return { ok: false, code: 404, error: 'project is not connected' };
    const keys = ['runner_lead', 'runner_member'].filter((k) => values[k] !== undefined);
    if (!keys.length) return { ok: false, code: 400, error: 'runner_lead or runner_member required' };
    for (const k of keys) if (!RUNNER_VALUES.includes(values[k])) return { ok: false, code: 400, error: `${k} must be one of ${RUNNER_VALUES.join(', ')}` };
    p.spawn = { ...(p.spawn || {}) };
    for (const k of keys) p.spawn[k] = values[k];
    return { ok: true, ...runnersOf(p) };
  });
}


// A session's place in its team, as domain/rules.rulesFor needs it.
function placeOf(s, p) {
  const role = teamRole(s, p);
  if (role === 'lead') return { role, team: teamOfLead(p, s.session_id).name };
  if (role === 'member') return { role, group: s.group && own(teamOfSession(s, p)?.team.groups, s.group) };
  if (role === 'outside') return { role, teams: Object.keys(p.teams) };
  return { role };
}

// Instructions for a session's current place in its team.
const rulesFor = (s, p) => rules.rulesFor(s.session_id, s, placeOf(s, p), rulesCtx());

// The versions the rules are stamped with: the project's mode and the card language.
const rulesVersions = (p) => ({ mode: p?.mode_ver, lang: readSettings().ver });

// Instructions for a registered session; marks them as given for the project's current mode.
function injectRules(sid) {
  const projects = readProjects();
  return sessionsStore.update((sessions) => {
    const s = sessions[sid];
    if (!s) return rulesText(sid);
    const p = projects[s.project_key];
    Object.assign(s, rules.stamp(rulesVersions(p)));
    return rulesFor(s, p);
  });
}

// The instructions again, once, if the project's mode, the card language or the text changed since they were
// last given ('' otherwise). Works on the given objects; the caller saves the session.
function rulesUpdate(s, p) {
  if (!s || !p) return '';
  const v = rulesVersions(p);
  const why = rules.needsUpdate(s, v);
  if (!why) return '';
  Object.assign(s, rules.stamp(v));
  return rules.updateText(why, { mode: p.mode, lang: readSettings().lang }, rulesFor(s, p));
}

// Same as rulesUpdate, reading and saving the files.
function pendingRules(sid) {
  const projects = readProjects();
  return sessionsStore.update((sessions) => {
    const s = sessions[sid];
    return rulesUpdate(s, s && projects[s.project_key]);
  });
}

// --- Teams: projects.json[key].teams = { <name>: { lead, worktree, groups, created } } ---
// A repo can have several teams. Each has one lead session; its members report only to that lead.
// A handoff changes only lead; name, worktree and groups stay. mode is 'team' while any team is left.

// Root of the git worktree that holds dir (dir itself outside git), with forward slashes.
const worktreeRoot = (dir) => slash(gitIn(['rev-parse', '--show-toplevel'], dir) || dir);

// docs/teams/<name>/ in the team's worktree: the parent of its group folders.
const teamDir = (team, name) => slash(path.join(team.worktree, 'docs', 'teams', name));

// docs/teams/<name>/lead-rules.md: the lead's fixed rules (how to work with the user, Git rules, ...).
// Every new lead reads it together with the latest handoff doc, so handoff docs carry only the current state.
const leadRulesPath = (team, name) => slash(path.join(teamDir(team, name), 'lead-rules.md'));
const leadRulesTemplate = (name) => `# Team ${name}: lead rules

<!-- Read by every lead of this team, together with the latest handoff doc. Put here what does not change
     between leads: how to work with the user, Git and review rules, who decides what. Keep it short.
     The current state (open items, members, recent decisions) goes in the handoff doc, not here. -->

## Working with the user

## Git and review

## Members
`;

// The team's lead-rules.md if it exists ('' otherwise). Handoffs never create it.
const existingLeadRules = (team, name) => (team?.worktree && fs.existsSync(leadRulesPath(team, name)) ? leadRulesPath(team, name) : '');

// Create the team's lead-rules.md from the template when it is missing (on team creation); returns its path ('' on failure).
function ensureLeadRules(team, name) {
  if (!team?.worktree) return '';
  const file = leadRulesPath(team, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, leadRulesTemplate(name), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') return '';
  }
  return file;
}

// 0.3.0 settings before M-1b kept one lead per project (lead, lead_name, groups). They become one team named
// after lead_name, and docs/groups/<g>/ moves to docs/teams/<team>/<g>/ (git mv when tracked) inside the
// worktree that holds docs/groups/ (which becomes the team's worktree, even if the lead has moved since).
// A group folder in another worktree is not moved: it keeps its path and the lead is told once.
// Bumps mode_ver so running sessions get the new instructions. Returns true if p changed.
function migrateProject(p, sessions) {
  if (!p || typeof p !== 'object' || (p.teams && typeof p.teams === 'object')) return false;
  p.teams = {};
  if (p.mode === 'team' && p.lead) {
    const name = teamSlug(p.lead_name) || 'team1';
    const groups = Object.entries(p.groups && typeof p.groups === 'object' ? p.groups : {}).filter(([g]) => GROUP_NAME.test(g));
    const existing = groups.map(([, g]) => g?.dir).filter((d) => d && fs.existsSync(d));
    const base = existing[0] || own(sessions, p.lead)?.cwd || p.cwd;
    const team = { lead: p.lead, worktree: worktreeRoot(base), groups: {} };
    if (p.handoff) team.handoff = p.handoff;
    if (p.last_handoff) team.last_handoff = p.last_handoff;
    const oldRoots = new Set();
    const skipped = [];
    for (const [g, conf] of groups) {
      if (sameName(team.groups, g)) continue;
      let dir = slash(path.join(teamDir(team, name), g));
      try {
        if (conf?.dir && fs.existsSync(conf.dir) && !fs.existsSync(dir)) {
          if (worktreeRoot(conf.dir).toLowerCase() !== team.worktree.toLowerCase()) {
            dir = slash(conf.dir); // another worktree: a move would leave deletions in its index
            skipped.push(`${g} (${dir})`);
          } else {
            moveDir(conf.dir, dir);
            oldRoots.add(path.dirname(conf.dir));
          }
        }
        ensureGroupDir(dir, g);
      } catch (err) {
        dir = slash(conf?.dir || dir);
        skipped.push(`${g} (${err.message})`);
      }
      team.groups[g] = { ...conf, dir };
    }
    // Drop the old docs/groups/ folder if nothing is left in it.
    for (const d of oldRoots) try { fs.rmdirSync(d); } catch { /* not empty */ }
    p.teams[name] = team;
    p.mode_ver = (Number(p.mode_ver) || 0) + 1;
    if (skipped.length) {
      try {
        deliver(p.lead, {
          type: 'report', from: 'ddashboard', role: 'ddashboard', status: 'review',
          title: `group folders not moved to docs/teams/${name}/ (move them by hand in their worktree): ${skipped.join(', ')}`,
        });
      } catch { /* best effort */ }
    }
  }
  for (const k of ['lead', 'lead_name', 'groups', 'handoff', 'last_handoff']) delete p[k];
  syncMode(p);
  return true;
}

// projects.json, with settings from before M-1b moved to teams (saved once, on first read).
// Inside a sessions update the migration is applied in memory only (lock order: projects before sessions); the
// next read outside it saves it.
const needsMigration = (projects) => Object.values(projects).some((p) => p && typeof p === 'object' && !p.teams);
function migrateAll(projects) {
  const sessions = sessionsStore.read();
  for (const p of Object.values(projects)) {
    if (p && typeof p === 'object' && !p.teams) migrateProject(p, sessions);
  }
  return projects;
}
function readProjects() {
  const projects = projectsStore.read();
  if (!needsMigration(projects)) return projects;
  if (projectsStore.inUpdate() || sessionsStore.inUpdate()) return migrateAll(projects);
  return projectsStore.update(migrateAll);
}

// Add a team led by the given session. Refuses a name in use and a session that already leads a team.
// No name: team1, team2, ... Other teams are not touched. Bumps mode_ver (every session gets new instructions once).
function addTeam(key, name, lead) {
  readProjects(); // migrate first
  // git outside the locks: the worktree of the lead's folder.
  const before = own(sessionsStore.read(), lead);
  const worktree = worktreeRoot(before?.cwd || projectsStore.get(key)?.cwd || process.cwd());
  const r = projectsStore.update((projects) => sessionsStore.update((sessions) => addTeamIn(projects, sessions, key, name, lead, worktree)));
  if (r.ok) ensureLeadRules({ worktree }, r.team);
  return r;
}

// Remove teams by name (every team when names is empty). Their members are released (kind, lead and group
// cleared; former_lead kept), so they post to the dashboard and never rejoin a later team. Folders stay.
// The project is solo when no team is left.
function removeTeams(key, names = []) {
  readProjects(); // migrate first
  return projectsStore.update((projects) => sessionsStore.update((sessions) => removeTeamsIn(projects, sessions, key, names)));
}

// Dashboard switch. team: add a team led by lead (named team or leadName). solo: remove the named team,
// or every team when none is named.
function setMode(key, mode, { lead, leadName, team } = {}) {
  if (mode === 'team') return addTeam(key, team || leadName, lead);
  return removeTeams(key, team ? [team] : []);
}

// Register a session as a member (from its tag). The session must be registered already.
function setMember(sid, tag) {
  return sessionsStore.patch(sid, {
    kind: 'member', role: tag.role, lead: tag.lead, stay: Boolean(tag.stay), pending: undefined,
    ...(tag.group ? { group: tag.group } : {}),
    ...(config.get('DDASH_NAME') ? {} : { name: tag.role }),
  });
}


// Inbox (store/inbox.js) and message text (domain/messages.js).
const { deliver, take: takeInbox, move: moveInbox } = require('./store/inbox');
const { reportMessage, formatReplies, formatMessages, messagesReason } = require('./domain/messages');

// --- Processes (for stopping a replaced lead) ---

// Save the session's Claude Code pid (best effort). Returns the pid or 0.
function recordClaudePid(sid, startPid = process.ppid) {
  const pid = findClaudePid(startPid);
  if (!pid) return 0;
  return sessionsStore.patch(sid, { claude_pid: pid }) ? pid : 0;
}

// Read projects.json, let fn change it, write it at once (keeps changes made since an earlier read). Returns fn's result.
function updateProjects(fn) {
  readProjects(); // migrate first
  return projectsStore.update(fn);
}

// New lead `to` takes over from `from` (called from the new lead's first-prompt hook).
// Only the old lead's team changes: its lead and its members move; other teams are untouched. Moves the old lead's pending messages, marks the old lead
// ended (reason: handoff) and stops its wait command and Claude process. opts.kill / opts.killClaude for tests.
function performHandoff(from, to, doc, opts = {}) {
  const projects = readProjects();
  const r = sessionsStore.update((sessions) => handoffSessions(sessions, projects, from, to, doc));
  if (!r.ok) return r;
  const { key, t, old, members, ts, end } = r;
  // Re-read before writing: only this team's lead and handoff records change.
  updateProjects((all) => {
    const ft = teamOfLead(own(all, key), from);
    if (!ft) return;
    ft.team.lead = to;
    ft.team.last_handoff = { from, to, doc, ts };
    delete ft.team.handoff;
  });

  const moved = moveInbox(from, to);
  const stopped = lifecycle.runEffects(end, { kill: opts.kill, killClaude: opts.killClaude }) || {};
  const rules = existingLeadRules(t.team, t.name);
  return { ok: true, team: t.name, rules, members, moved, wait_killed: Boolean(stopped.waiter), claude_killed: Boolean(stopped.claude), claude_pid: old.claude_pid || 0 };
}

// The sessions part of a handoff (inside the sessions lock): checks, new lead, members, old lead ended.
function handoffSessions(sessions, projects, from, to, doc) {
  const old = sessions[from];
  const me = sessions[to];
  if (!old) return { ok: false, error: `unknown session ${from}` };
  if (!me) return { ok: false, error: `unknown session ${to}` };
  if (from === to) return { ok: false, error: 'a session cannot hand off to itself' };
  const key = old.project_key;
  const p = projects[key];
  if (!p) return { ok: false, error: 'the old lead\'s project is not connected' };
  if (me.project_key !== key) return { ok: false, error: 'the new lead is in a different project' };

  const t = teamOfLead(p, from);
  if (!t) return { ok: false, error: 'the old session leads no team' };
  const mine = teamOfLead(p, to);
  if (mine) return { ok: false, error: `the new lead already leads team ${mine.name}` };

  const ts = new Date().toISOString();

  me.kind = 'lead';
  clearLeadContext(me);
  me.handoff_from = from;
  if (doc) me.handoff_doc = doc;
  let members = 0;
  for (const s of Object.values(sessions)) {
    if (s.kind === 'member' && s.lead === from) { s.lead = to; members++; }
  }
  delete old.kind;
  const end = lifecycle.applyIn(sessions, from, 'end', { reason: 'handoff', replaced_by: to, ts });
  return { ok: true, key, t, old, members, ts, end };
}

// --- Groups (team mode): docs/teams/<team>/<group>/ in the team lead's worktree holds a group's memory ---
// brief.md (injected into every new member before its task), handoff-NNN.md, notes/.
// Groups belong to one team: two teams may use the same group name, and one team's upkeep never
// touches another team's folders.

const BRIEF_MAX_CHARS = 16000; // about 4000 tokens

const briefTemplate = (name) => `# ${name} brief

<!-- Injected into every new member of this group before its task. Keep it short (under ~4000 tokens).
     Update it when the facts change. History goes in handoff-NNN.md, evidence in notes/. -->

## Scope

## Key files

## Rules

## Current state
`;

// True if git tracks any file under dir.
const gitTracked = (dir) => Boolean(gitIn(['ls-files', '--', '.'], dir));

// A group folder with notes/ and a brief template (an existing brief is kept).
function ensureGroupDir(dir, name) {
  ensureDir(path.join(dir, 'notes'));
  const brief = path.join(dir, 'brief.md');
  if (!fs.existsSync(brief)) fs.writeFileSync(brief, briefTemplate(name));
}

// The team's entry in a copy of projects (for checks and folder work outside the lock): { p, team } or { error }.
// Its worktree is filled in when missing (git), so teamIn can store it.
function teamFor(key, teamName) {
  const p = own(readProjects(), key);
  if (!p) return { error: 'project is not connected' };
  const team = own(teamsOf(p), teamName);
  if (!team) return { error: `no team ${teamName}` };
  team.groups ||= {};
  if (!team.worktree) team.worktree = worktreeRoot(sessionsStore.get(team.lead)?.cwd || p.cwd || process.cwd());
  return { p, team };
}

// The same team inside a projects update (the map being written), or null when it is gone meanwhile.
function teamIn(projects, key, teamName, worktree) {
  const team = own(teamsOf(own(projects, key)), teamName);
  if (!team) return null;
  team.groups ||= {};
  team.worktree ||= worktree;
  return team;
}
const TEAM_GONE = (teamName) => ({ ok: false, error: `no team ${teamName}` });

function groupsOf(key, teamName) {
  return teamsOf(readProjects()[key])[teamName]?.groups || {};
}

function createGroup(key, teamName, name) {
  if (badGroupName(name)) return { ok: false, error: GROUP_NAME_ERROR };
  const { team, error } = teamFor(key, teamName);
  if (error) return { ok: false, error };
  const taken = sameName(team.groups, name);
  if (taken) return { ok: false, error: `group ${taken} exists in team ${teamName} (names ignore case)` };
  const dir = slash(path.join(teamDir(team, teamName), name));
  ensureGroupDir(dir, name);
  return projectsStore.update((projects) => {
    const t = teamIn(projects, key, teamName, team.worktree);
    if (!t) return TEAM_GONE(teamName);
    const again = sameName(t.groups, name);
    if (again) return { ok: false, error: `group ${again} exists in team ${teamName} (names ignore case)` };
    t.groups[name] = { dir, created: new Date().toISOString(), ...GROUP_DEFAULTS };
    return { ok: true, dir };
  });
}

// Move a folder: git mv when tracked (the lead commits it), a plain rename otherwise. A tracked folder that
// git cannot move (e.g. the target is in another worktree) is left alone: a plain rename would leave its
// files as deletions in the index.
function moveDir(from, to) {
  ensureDir(path.dirname(to));
  if (gitTracked(from)) {
    if (gitIn(['mv', from, to], path.dirname(from)) !== null) return 'git mv';
    throw new Error(`git mv failed: ${slash(from)} -> ${slash(to)}`);
  }
  fs.renameSync(from, to);
  return 'rename';
}

function renameGroup(key, teamName, name, next) {
  if (badGroupName(next)) return { ok: false, error: GROUP_NAME_ERROR };
  const { team, error } = teamFor(key, teamName);
  if (error) return { ok: false, error };
  const g = own(team.groups, name);
  if (!g) return { ok: false, error: `no group ${name} in team ${teamName}` };
  const taken = sameName(team.groups, next);
  if (taken) return { ok: false, error: `group ${taken} exists in team ${teamName} (names ignore case)` };
  const dir = slash(path.join(path.dirname(g.dir), next));
  if (fs.existsSync(dir)) return { ok: false, error: `folder exists: ${dir}` };
  let how = 'none';
  if (fs.existsSync(g.dir)) how = moveDir(g.dir, dir);
  projectsStore.update((projects) => {
    const t = teamIn(projects, key, teamName, team.worktree);
    if (!t) return;
    t.groups[next] = { ...(own(t.groups, name) || g), dir };
    delete t.groups[name];
  });
  sessionsStore.update((sessions) => {
    for (const s of teamMembers(sessions, key, team)) if (s.group === name) s.group = next;
  });
  return { ok: true, dir, moved: how };
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

// Remove a group: its members become unassigned; the folder moves to docs/teams/<team>/_archived/<name>-<date>/
// (purge: deleted instead).
function deleteGroup(key, teamName, name, { purge = false } = {}) {
  const { team, error } = teamFor(key, teamName);
  if (error) return { ok: false, error };
  const g = own(team.groups, name);
  if (!g) return { ok: false, error: `no group ${name} in team ${teamName}` };
  let folder = null;
  if (fs.existsSync(g.dir)) {
    if (purge) {
      fs.rmSync(g.dir, { recursive: true, force: true });
      folder = 'deleted';
    } else {
      const base = path.join(path.dirname(g.dir), '_archived', `${name}-${stamp()}`);
      let to = base;
      for (let i = 2; fs.existsSync(to); i++) to = `${base}-${i}`;
      moveDir(g.dir, to);
      folder = slash(to);
    }
  }
  projectsStore.update((projects) => {
    const t = teamIn(projects, key, teamName, team.worktree);
    if (t) delete t.groups[name];
  });
  sessionsStore.update((sessions) => {
    for (const s of teamMembers(sessions, key, team)) if (s.group === name) delete s.group;
  });
  return { ok: true, folder };
}

const HANDOFF = /^handoff-(\d+)\.md$/;

function handoffs(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => HANDOFF.test(f)); } catch {}
  return files.sort((a, b) => Number(a.match(HANDOFF)[1]) - Number(b.match(HANDOFF)[1]));
}

const latestHandoff = (dir) => {
  const list = handoffs(dir);
  return list.length ? slash(path.join(dir, list[list.length - 1])) : '';
};

// Create the next handoff-NNN.md in dir and return its path. The file is created exclusively ('wx'), so two
// members finishing at the same time never get the same number: on a clash the next number is tried.
function reserveHandoff(dir, header = '') {
  ensureDir(dir);
  const list = handoffs(dir);
  let n = list.length ? Number(list[list.length - 1].match(HANDOFF)[1]) + 1 : 1;
  for (let tries = 0; tries < 1000; tries++, n++) {
    const file = path.join(dir, `handoff-${String(n).padStart(3, '0')}.md`);
    let fd;
    try { fd = fs.openSync(file, 'wx'); } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try { fs.writeSync(fd, header); } finally { fs.closeSync(fd); }
    return slash(file);
  }
  throw new Error(`could not create a handoff file in ${dir}`);
}

// Keep the newest keep_handoffs handoffs and drop notes older than notes_days. Only touches the
// group folder. The lead commits the result. Returns the removed paths.
function pruneGroup(g, now = Date.now()) {
  const conf = groupSettings(g);
  const removed = [];
  const list = handoffs(g.dir);
  for (const f of list.slice(0, Math.max(0, list.length - Math.max(1, Number(conf.keep_handoffs) || 3)))) {
    try { fs.unlinkSync(path.join(g.dir, f)); removed.push(slash(path.join(g.dir, f))); } catch {}
  }
  const cutoff = now - (Number(conf.notes_days) || 30) * 86400000;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        try { if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); removed.push(slash(f)); } } catch {}
      }
    }
  };
  walk(path.join(g.dir, 'notes'));
  return removed;
}

const BRIEF_STALE_COMMITS = config.get('DDASH_BRIEF_STALE_COMMITS');

// Brief staleness for a team project's groups. When a brief.md changes (new mtime), remember the git HEAD
// of its worktree; once HEAD is BRIEF_STALE_COMMITS or more commits past that, tell that team's lead once
// (until the brief changes again). Called from the Stop hook and team.js spawn. Returns the groups reported
// (as <team>/<group>).
function checkBriefs(key) {
  const p = own(readProjects(), key);
  if (!hasTeams(p)) return [];
  const changes = []; // [teamName, group name, fields (undefined deletes)]
  const told = [];
  for (const [teamName, team] of Object.entries(p.teams)) {
    for (const [name, g] of Object.entries(team.groups || {})) {
      let mtime;
      try { mtime = fs.statSync(path.join(g.dir, 'brief.md')).mtimeMs; } catch { continue; }
      const head = gitIn(['rev-parse', 'HEAD'], g.dir);
      if (!head) continue;
      if (g.brief_mtime !== mtime || !g.brief_head) {
        changes.push([teamName, name, { brief_mtime: mtime, brief_head: head, brief_stale_warned: undefined }]);
        continue;
      }
      if (g.brief_stale_warned || g.brief_head === head || !team.lead) continue;
      const n = Number(gitIn(['rev-list', '--count', `${g.brief_head}..HEAD`], g.dir));
      if (!(n >= BRIEF_STALE_COMMITS)) continue;
      deliver(team.lead, {
        type: 'report', from: name, role: 'ddashboard', status: 'review',
        title: `brief ${name} may be stale: ${n} commits since it was last updated (${slash(path.join(g.dir, 'brief.md'))})`,
      });
      changes.push([teamName, name, { brief_stale_warned: head }]);
      told.push(`${teamName}/${name}`);
    }
  }
  if (changes.length) setGroupFields(key, changes);
  return told;
}

// Set fields of groups in projects.json: changes = [[teamName, groupName, { field: value | undefined }]].
// Groups removed meanwhile are skipped.
function setGroupFields(key, changes) {
  projectsStore.update((projects) => {
    for (const [teamName, name, fields] of changes) {
      const g = own(own(teamsOf(own(projects, key)), teamName)?.groups, name);
      if (!g) continue;
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    }
  });
}

// Group memory for a new member, put before its task: the brief (capped) and the latest handoff.
// Returns { text, truncated, chars }.
function groupContext(name, g) {
  let brief = '';
  try { brief = fs.readFileSync(path.join(g.dir, 'brief.md'), 'utf8'); } catch {}
  const truncated = brief.length > BRIEF_MAX_CHARS;
  const body = truncated ? `${brief.slice(0, BRIEF_MAX_CHARS)}\n[... brief cut at ${BRIEF_MAX_CHARS} characters ...]` : brief;
  const last = latestHandoff(g.dir);
  const text = rules.groupContextText(name, slash(path.join(g.dir, 'brief.md')), body, last);
  return { text, truncated, chars: brief.length };
}

// What a member gets when it starts: its group's memory first (same text for every member of the
// group, so it can share the prompt cache), then its own instructions. Marks the instructions as given.
// If the brief had to be cut, the lead is told once per brief size.
function memberStart(sid) {
  const projects = readProjects();
  const s = sessionsStore.get(sid);
  if (!s) return rulesText(sid);
  const p = projects[s.project_key];
  const g = s.group && own(teamOfSession(s, p)?.team.groups, s.group);
  let head = '';
  if (g) {
    const ctx = groupContext(s.group, g);
    head = `${ctx.text}\n`;
    if (ctx.truncated && g.brief_warned !== ctx.chars && s.lead) {
      deliver(s.lead, {
        type: 'report', from: sid, role: s.role || 'member', status: 'review',
        title: `brief ${s.group} needs trimming (${ctx.chars} characters; members get the first ${BRIEF_MAX_CHARS})`,
      });
      g.brief_warned = ctx.chars;
      const t = teamOfSession(s, p);
      setGroupFields(s.project_key, [[t.name, s.group, { brief_warned: ctx.chars }]]);
    }
  }
  const stamp = { ...rules.stamp(rulesVersions(p)), start_rules: true };
  Object.assign(s, stamp);
  sessionsStore.patch(sid, stamp);
  return head + rulesFor(s, p);
}

// --- Sidebar housekeeping ---

const STALE_MIN = config.get('DDASH_STALE_MIN');
const isStale = (s, now = Date.now()) => !s.last_seen || now - new Date(s.last_seen).getTime() > STALE_MIN * 60000;

// Remove a session's inbox dir if nothing is left in it (no pending messages, no live waiter).
function removeEmptyInbox(sid) {
  const dir = paths.inbox(sid);
  if (waitPid(sid)) return;
  try { fs.unlinkSync(path.join(dir, 'wait.lock')); } catch {}
  try { fs.rmdirSync(paths.done(sid)); } catch {}
  try { fs.rmdirSync(dir); } catch {}
}

// Drop ended sessions from sessions.json (cards and usage stay). Returns { forgotten, refused }:
// sessions that are not ended are refused.
function forgetSessions(ids) {
  const forgotten = [];
  const refused = [];
  sessionsStore.update((sessions) => {
    for (const id of ids) {
      const s = own(sessions, id);
      if (!s) continue;
      if (!lifecycle.applyIn(sessions, id, 'forget').ok) { refused.push(id); continue; }
      forgotten.push(s);
    }
  });
  // Nothing of a forgotten session may keep running (bug-005): its waiter, a dead Claude's tool shells.
  let table = null;
  for (const s of forgotten) {
    if (needsProcesses(s)) try { stopSessionProcesses(s, (table = table || processTable())); } catch { /* best effort */ }
    removeEmptyInbox(s.session_id);
  }
  return { forgotten: forgotten.map((s) => s.session_id), refused };
}

const sessionGone = supervisor.gone;
const memberGone = sessionGone;

// Mark these sessions ended (end_reason 'gone') in sessions.json and stop what they left running. Returns the ids changed.
function markGone(sids, table) {
  if (!sids.length) return [];
  const ts = new Date().toISOString();
  const ended = [];
  sessionsStore.update((sessions) => {
    for (const sid of sids) {
      const r = own(sessions, sid) && lifecycle.applyIn(sessions, sid, 'end', { reason: 'gone', ts, seen: false });
      if (r?.ok) ended.push([sid, r]);
    }
  });
  for (const [, r] of ended) lifecycle.runEffects(r, { table: table || undefined });
  return ended.map(([sid]) => sid);
}

function markEnded(sid) {
  const s = sessionsStore.get(sid);
  if (!s) return { ok: false, code: 404, error: 'unknown session' };
  if (isEnded(s)) return { ok: true };
  // A session whose Claude process is dead may be marked ended even while it still says "working".
  const gone = memberGone(s);
  // A wait command with no live Claude above it (bug-005, e.g. one from an older plugin version) is not activity.
  let table = null;
  const wp = waitPid(sid);
  const waiting = wp && !orphanWaiter(wp, (table = processTable()));
  const ctx = { reason: 'marked', gone, waiting: Boolean(waiting), stale: isStale(s), seen: false, ts: new Date().toISOString() };
  const check = transition(s, 'end', ctx);
  if (!check.ok) return { ok: false, code: check.code, error: check.error };
  const r = lifecycle.apply(sid, 'end', { ...ctx, stop: { table: table || undefined } });
  if (!r.ok && !isEnded(sessionsStore.get(sid))) return { ok: false, code: r.code, error: r.error };
  return { ok: true };
}

// Lead context limit: domain/lead-context.js (maths), app/lead-context.js (transcript, models, notice).
const { envNum } = config;
const { LEAD_WORK_BUDGET, LEAD_CONTEXT_LIMIT, CONTEXT_WINDOW, HANDOFF_MAX_TOKENS, contextWindow, leadLimit, estimateTokens, clearLeadContext } = require('./domain/lead-context');
const { leadContextNotice, firstContext, rememberModel } = require('./app/lead-context');

const cardFiles = cardsStore.files; // moved to store/cards.js
const appendCard = cardsStore.append;

module.exports = {
  BOARD_DIR, PORT, URL, RECENT_DAYS, paths, cardFiles, appendCard, ensureWaitBin, ensureTeamBin,
  usageFiles, readTranscriptTail, humanText, lastHumanIndex, wakeReason, turnUsage, USAGE_KEYS,
  safeId, ensureDir, readJson, writeJson, appendJsonl, readJsonl,
  readHookInput, alive, serverPid, git, projectKey, projectName, projectActive, setProject,
  registerSession, setState, isRegistered, rulesText, takeInbox, formatReplies,
  DEFAULT_SPAWN, RUNNER_VALUES, runnersOf, setRunners, isEnded, teamRole, routeCard, rulesFor, injectRules, rulesUpdate, RULES_TEXT_VER, pendingRules, setMode,
  parseTag, setMember, newId, deliver, reportMessage, formatMessages, messagesReason, moveInbox, waitPid,
  waitLockPath, waitInfoPath, readWaitInfo, processName, napUntil, waitCommandSid, waiterChain, killWaiterChain, orphanWaiter, stopWaiter, sweepWaiters,
  reapToolShells, stopSessionProcesses,
  processTable, processTableAsync, parseProcessList, isClaudeProcess, findClaudePid, recordClaudePid, killPid, killTree, descendants, killClaude, performHandoff, replacedText,
  STALE_MIN, isStale, forgetSessions, markEnded, memberGone, sessionGone, markGone, LEAD_CONTEXT_LIMIT, LEAD_WORK_BUDGET, CONTEXT_WINDOW, HANDOFF_MAX_TOKENS, leadContextNotice, leadLimit, contextWindow, estimateTokens,
  firstContext, rememberModel, clearLeadContext, envNum,
  leadRulesPath, ensureLeadRules, existingLeadRules,
  GROUP_NAME, BRIEF_MAX_CHARS, groupSettings, groupsOf, createGroup, renameGroup, deleteGroup, handoffs, latestHandoff,
  pruneGroup, groupContext, memberStart, BRIEF_STALE_COMMITS, checkBriefs, LANG_NAMES, readSettings, saveSettings,
  TEAM_NAME, teamsOf, hasTeams, teamOfLead, teamOfSession, teamSlug, worktreeRoot, migrateProject, readProjects,
  updateProjects, addTeam, removeTeams, teamMembers, ensureGroupDir, reserveHandoff, own, sameName,
};
