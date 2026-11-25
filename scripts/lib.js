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
  DEFAULT_SPAWN, RUNNER_VALUES, runnersOf, TEAM_NAME, GROUP_NAME, groupSettings,
  teamsOf, own, sameName, hasTeams, teamOfLead, teamOfSession, teamSlug, teamMembers, teamRole, routeCard,
} = require('./domain/team');
const { parseTag } = require('./domain/tags');


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

// Team use cases: app/teams.js (projects, migration, add/remove teams, runners), app/groups.js, app/handoff.js,
// app/members.js; team worktree files in app/team-files.js.
const { migrateProject, readProjects, updateProjects, setRunners, addTeam, removeTeams, setMode } = require('./app/teams');
const { BRIEF_STALE_COMMITS, groupsOf, createGroup, renameGroup, deleteGroup, checkBriefs, setGroupFields } = require('./app/groups');
const { performHandoff } = require('./app/handoff');
const { setMember } = require('./app/members');
const {
  worktreeRoot, leadRulesPath, existingLeadRules, ensureLeadRules, BRIEF_MAX_CHARS, ensureGroupDir, handoffs, latestHandoff,
  reserveHandoff, pruneGroup, groupContext,
} = require('./app/team-files');

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
