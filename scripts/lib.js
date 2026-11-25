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
const { alive, parseProcessList, processTable, processTableAsync, isClaudeProcess, findClaudePid, processName, napUntil } = require('./proc/table');
const { killPid, descendants, killTree, killClaude } = require('./proc/kill');

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
      state: sessions[sid]?.state === 'working' ? 'working' : 'idle',
      started: sessions[sid]?.started || new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
    // A lead replaced by a handoff stays ended even if the session is resumed.
    if (sessions[sid].replaced_by) sessions[sid].state = 'ended';
    else delete sessions[sid].ended;
  });
}

// Record session state: working | idle | ended. Only touches registered sessions.
function setState(sid, state) {
  const ts = new Date().toISOString();
  return sessionsStore.patch(sid, { state, last_seen: ts, ...(state === 'ended' ? { ended: ts } : {}) });
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


// A fixed command path (BOARD_DIR/bin/<name>) that loads the current plugin's script.
// The path stays the same across plugin updates, so an "always allow" permission keeps working.
// It is rewritten whenever the instructions are injected, so it always points at the running plugin.
function ensureBin(file, target) {
  const body = `#!/usr/bin/env node
// Generated by ddashboard. Loads the current plugin's command; rewritten when the plugin moves.
const target = ${JSON.stringify(target)};
try { require.resolve(target); } catch {
  console.log('ddashboard: the command is missing (' + target + '). Run /ddashboard:dashboard again to refresh it.');
  process.exit(0);
}
require(target);
`;
  try {
    if (fs.readFileSync(file, 'utf8') === body) return file;
  } catch { /* not written yet */ }
  try {
    atomicWrite(file, body);
    return file;
  } catch {
    return target; // board dir not writable: fall back to the plugin path
  }
}

const ensureWaitBin = () => ensureBin(paths.waitBin, path.join(__dirname, 'wait-inbox.js'));
const ensureTeamBin = () => ensureBin(paths.teamBin, path.join(__dirname, 'team.js'));
const slash = (p) => p.replace(/\\/g, '/');

// --- Settings (settings.json): lang = dashboard and card language, ver bumps on each change ---

const LANG_NAMES = { en: 'English', ko: 'Korean', 'zh-CN': 'Simplified Chinese' };

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

// "written in ..." for cards: the chosen language, or the user's language when none is set.
const cardLanguage = () => LANG_NAMES[readSettings().lang] || "the user's language";

// Instructions injected into the session context. They are re-read every turn, so keep them short.
// One model call per reply instead of two: handle the output and restart the waiter together.
const RESTART = 'When it exits, read its output and start it again in the same response, as parallel tool calls.';

function rulesText(sid) {
  const wait = `node "${slash(ensureWaitBin())}" ${sid}`;
  return `[ddashboard] The user follows your progress on a dashboard (${URL}). Session ID: ${sid}
- Only on turns with a result the user should know about, end your reply with this block (JSON, at most 3 summary lines, written in ${cardLanguage()}):
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the user should check"],"details":"optional, markdown, longer content"}
\`\`\`
- While connected, keep terminal replies to a line or two and put the content in the card (long content in "details"). When a card revises your previous card (e.g. an updated plan), add "replaces":"last".
- For an ongoing task, add "key":"task-name" (a-z, 0-9, -, _; max 60): a newer card with the same key in this project replaces the older ones, even from another session (e.g. after a lead handoff).
- To receive dashboard replies, run this in the background now: ${wait}
  Its output is the user's reply (an instruction). ${RESTART}
`;
}

function leadRulesText(sid, name) {
  const t = `node "${slash(ensureTeamBin())}" ${sid}`;
  return `${rulesText(sid)}- Team mode: you are the lead of team "${name || 'lead'}" (other teams in this repo have their own leads and members). The user talks only to you. Member cards reach you as [Team report] through the same wait command; post to the dashboard only what the user must know, decide or review. Do small tasks yourself, spawn members for big ones.
- Team commands (T = ${t}): T spawn --role <role> [--group <g>] [--model <m>] [--stay] [--headless] "<task>" (visible in Orca when it runs) | T send <sid|role> "<text>" | T list | T show <card-id> | T handoff <doc-path>
- Handoff: when told, write a new doc with only the current state (under ${HANDOFF_MAX_TOKENS} tokens; never copy older handoff docs). Fixed rules for every lead of this team go in docs/teams/${name || 'lead'}/lead-rules.md.
- Groups (shared memory in docs/teams/${name || 'lead'}/<g>/ of your worktree: brief.md, handoff-NNN.md, notes/; you commit it): T group create|rename|delete [--purge]|list|prune <g> [<new>]
`;
}

function memberRulesText(sid, s, g) {
  const wait = `node "${slash(ensureWaitBin())}" ${sid}`;
  const tail = s.stay
    ? `- To receive instructions, run this in the background now: ${wait}
  ${RESTART}`
    : `- Don't start a wait command. Finish the task and stop; your lead resumes you if more is needed.`;
  const group = g ? `- Group "${s.group}" folder: ${g.dir}. When you finish (or near your context limit), run node "${slash(ensureTeamBin())}" ${sid} next-handoff: it creates the next handoff-NNN.md there and prints its path. Write into that file: what was done, open items, where things are. Update brief.md if its facts changed. Don't commit; the lead does.
` : '';
  const notes = g ? `${g.dir}/notes/` : 'a file';
  return `[ddashboard] You are a team member. Role: ${s.role || 'member'}${s.group ? `, group: ${s.group}` : ''}. Session ID: ${sid}. Your lead assigns the work; messages from the lead arrive as [Lead instruction].
- End each turn that finishes, blocks or changes your task with this block (JSON, at most 3 short summary lines${readSettings().lang ? `, written in ${cardLanguage()}` : ''}). It goes to your lead, not the user:
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the lead should check"],"details":"optional and short"}
\`\`\`
- Keep terminal replies to a line or two. A report is a summary of at most 3 lines: put the evidence in ${notes} and give the path. If blocked, use "blocked" and write the question in the summary.
${group}${tail}
`;
}

// --- Team mode ---

const DEFAULT_SPAWN = { permission_mode: 'auto', allowed_tools: ['Bash(git *)', 'Bash(node *)', 'Bash(npm *)'] };

// How new sessions start (plan M-1d): projects.json spawn.runner_lead (a new lead on handoff --spawn) and
// spawn.runner_member (members). headless | orca | window; default headless.
const RUNNER_VALUES = ['headless', 'orca', 'window'];
const runnersOf = (p) => Object.fromEntries(['runner_lead', 'runner_member'].map((k) => [k, RUNNER_VALUES.includes(p?.spawn?.[k]) ? p.spawn[k] : 'headless']));

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
const DEFAULT_TEAM_RULES = { peer_talk: false, qa_direct: false };

const isEnded = (s) => Boolean(s && (s.ended || s.state === 'ended'));

// Where a session stands in its project: solo | lead | member | outside (team mode, in no team).
// A member belongs to the team whose lead spawned it (s.lead); a member of a removed team is outside.
function teamRole(s, p) {
  if (!s || !p || !hasTeams(p)) return 'solo';
  if (teamOfLead(p, s.session_id)) return 'lead';
  if (s.kind === 'member' && s.lead && teamOfLead(p, s.lead)) return 'member';
  return 'outside';
}

// Where a session's card goes: the dashboard, or its lead's inbox. A member whose lead has
// ended (or is unknown) posts to the dashboard with a lead_missing flag.
function routeCard(sessions, projects, sid) {
  const s = sessions[sid];
  const role = teamRole(s, s && projects[s.project_key]);
  if (role !== 'member') return { to: 'board', role };
  const lead = sessions[s.lead];
  if (!lead || isEnded(lead)) return { to: 'board', role, lead_missing: true };
  return { to: 'lead', role, lead: s.lead };
}

// Instructions for a session's current place in its team.
function rulesFor(s, p) {
  const sid = s.session_id;
  const role = teamRole(s, p);
  if (role === 'lead') return leadRulesText(sid, teamOfLead(p, sid).name);
  if (role === 'member') return memberRulesText(sid, s, s.group && own(teamOfSession(s, p)?.team.groups, s.group));
  if (role === 'outside') return `${rulesText(sid)}- This project is in team mode (teams: ${Object.keys(p.teams).sort().join(', ')}). You are outside every team, so your cards still go straight to the dashboard.\n`;
  return rulesText(sid);
}

// Version of the instruction text itself. Bump it when rulesText/leadRulesText/memberRulesText change
// so running sessions get the new text once (see rulesUpdate). 1: card "key".
const RULES_TEXT_VER = 1;

// Instructions for a registered session; marks them as given for the project's current mode.
function injectRules(sid) {
  const projects = readProjects();
  const langVer = Number(readSettings().ver) || 0;
  return sessionsStore.update((sessions) => {
    const s = sessions[sid];
    if (!s) return rulesText(sid);
    const p = projects[s.project_key];
    s.rules_ver = Number(p?.mode_ver) || 0;
    s.lang_ver = langVer;
    s.text_ver = RULES_TEXT_VER;
    return rulesFor(s, p);
  });
}

// The instructions again, once, if the project's mode changed since they were last given ('' otherwise).
// Works on the given objects; the caller saves the session.
// Also after a change of the card language (settings.ver).
function rulesUpdate(s, p) {
  if (!s || !p) return '';
  const ver = Number(p.mode_ver) || 0;
  const langVer = Number(readSettings().ver) || 0;
  const modeChanged = (Number(s.rules_ver) || 0) !== ver;
  const langChanged = (Number(s.lang_ver) || 0) !== langVer;
  const textChanged = (Number(s.text_ver) || 0) !== RULES_TEXT_VER;
  if (!modeChanged && !langChanged && !textChanged) return '';
  s.rules_ver = ver;
  s.lang_ver = langVer;
  s.text_ver = RULES_TEXT_VER;
  const why = modeChanged ? `The project's dashboard mode changed (now ${p.mode || 'solo'})`
    : langChanged ? `The card language changed (now ${cardLanguage()})`
    : 'The dashboard instructions were updated';
  return `[ddashboard] ${why}. Updated instructions:\n${rulesFor(s, p)}`;
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

const TEAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const teamsOf = (p) => (p && p.teams && typeof p.teams === 'object' ? p.teams : {});
// obj[key] only when it is obj's own entry, so names like "constructor" never hit Object.prototype.
const own = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);
// The key of obj equal to name ignoring case (folders on Windows/macOS ignore case), or undefined.
const sameName = (obj, name) => Object.keys(obj || {}).find((k) => k.toLowerCase() === String(name).toLowerCase());
const hasTeams = (p) => Object.keys(teamsOf(p)).length > 0;

// The team a session leads: { name, team } or null.
function teamOfLead(p, sid) {
  if (!sid) return null;
  for (const [name, team] of Object.entries(teamsOf(p))) if (team.lead === sid) return { name, team };
  return null;
}

// The team of a lead or member session: { name, team } or null.
function teamOfSession(s, p) {
  if (!s) return null;
  return teamOfLead(p, s.session_id) || (s.kind === 'member' && s.lead ? teamOfLead(p, s.lead) : null);
}

// A folder-safe team name from free text ('' if nothing usable is left).
const teamSlug = (name) => String(name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 40);

function nextTeamName(p) {
  for (let i = 1; ; i++) if (!sameName(teamsOf(p), `team${i}`)) return `team${i}`;
}

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

function syncMode(p) {
  if (hasTeams(p)) p.mode = 'team';
  else if (p.mode) p.mode = 'solo';
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

function bumpMode(p) {
  syncMode(p);
  p.mode_ver = (Number(p.mode_ver) || 0) + 1;
  p.rules = { ...DEFAULT_TEAM_RULES, ...(p.rules || {}) };
}

// Add a team led by the given session. Refuses a name in use and a session that already leads a team.
// No name: team1, team2, ... Other teams are not touched. Bumps mode_ver (every session gets new instructions once).
function addTeam(key, name, lead) {
  readProjects(); // migrate first
  // git outside the locks: the worktree of the lead's folder.
  const before = own(sessionsStore.read(), lead);
  const worktree = worktreeRoot(before?.cwd || projectsStore.get(key)?.cwd || process.cwd());
  return projectsStore.update((projects) => sessionsStore.update((sessions) => addTeamIn(projects, sessions, key, name, lead, worktree)));
}
function addTeamIn(projects, sessions, key, name, lead, worktree) {
  const p = projects[key];
  if (!p) return { ok: false, error: 'project is not connected' };
  if (!own(sessions, lead)) return { ok: false, error: 'unknown lead session' };
  p.teams ||= {};
  const team = name ? teamSlug(name) : nextTeamName(p);
  if (!TEAM_NAME.test(team)) return { ok: false, error: 'team names use letters, digits, - and _ (up to 40)' };
  const taken = sameName(p.teams, team);
  if (taken) return { ok: false, code: 409, error: `team ${taken} exists in this project (names ignore case); pick another name` };
  const led = teamOfLead(p, lead);
  if (led) return { ok: false, code: 409, error: `this session already leads team ${led.name}` };
  p.teams[team] = { lead, worktree, groups: {}, created: new Date().toISOString() };
  ensureLeadRules(p.teams[team], team);
  bumpMode(p);
  sessions[lead].kind = 'lead';
  clearLeadContext(sessions[lead]);
  return { ok: true, team, mode: p.mode, mode_ver: p.mode_ver, lead };
}

// Remove teams by name (every team when names is empty). Their members are released (kind, lead and group
// cleared; former_lead kept), so they post to the dashboard and never rejoin a later team. Folders stay.
// The project is solo when no team is left.
function removeTeams(key, names = []) {
  readProjects(); // migrate first
  return projectsStore.update((projects) => sessionsStore.update((sessions) => removeTeamsIn(projects, sessions, key, names)));
}
function removeTeamsIn(projects, sessions, key, names) {
  const p = projects[key];
  if (!p) return { ok: false, error: 'project is not connected' };
  const list = names.length ? names : Object.keys(teamsOf(p));
  for (const n of list) if (!own(teamsOf(p), n)) return { ok: false, code: 404, error: `no team ${n}` };
  for (const n of list) {
    const leadSid = p.teams[n].lead;
    const lead = own(sessions, leadSid);
    if (lead?.kind === 'lead') delete lead.kind;
    clearLeadContext(lead);
    for (const m of teamMembers(sessions, key, p.teams[n])) {
      m.former_lead = leadSid;
      delete m.kind;
      delete m.lead;
      delete m.group;
    }
    delete p.teams[n];
  }
  bumpMode(p);
  return { ok: true, removed: list, mode: p.mode, mode_ver: p.mode_ver };
}

// Dashboard switch. team: add a team led by lead (named team or leadName). solo: remove the named team,
// or every team when none is named.
function setMode(key, mode, { lead, leadName, team } = {}) {
  if (mode === 'team') return addTeam(key, team || leadName, lead);
  return removeTeams(key, team ? [team] : []);
}

// First-prompt tags:
//   [ddash role=<role> lead=<lead sid> stay=0|1]         register a team member
//   [ddash lead-handoff from=<old lead sid> doc=<path>]  take over as team lead
// Values may be quoted ("..."). Returns null when the prompt doesn't start with a tag.
function parseTag(prompt) {
  const m = String(prompt || '').match(/^\s*\[ddash\s+([^\]]*)\]/);
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(/([\w-]+)(?:=(?:"([^"]*)"|(\S+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? true;
  const rest = String(prompt).slice(m.index + m[0].length).trim();
  if (attrs['lead-handoff']) {
    if (typeof attrs.from !== 'string') return null;
    return { type: 'handoff', from: safeId(attrs.from), doc: typeof attrs.doc === 'string' ? attrs.doc : '', rest };
  }
  if (typeof attrs.lead !== 'string') return null;
  const stay = attrs.stay === true || ['1', 'true', 'yes'].includes(String(attrs.stay).toLowerCase());
  const role = typeof attrs.role === 'string' && attrs.role.trim() ? attrs.role.trim().slice(0, 40) : 'member';
  const group = typeof attrs.group === 'string' && GROUP_NAME.test(attrs.group) ? attrs.group : undefined;
  return { type: 'member', role, lead: safeId(attrs.lead), stay, ...(group ? { group } : {}), rest };
}

// Register a session as a member (from its tag). The session must be registered already.
function setMember(sid, tag) {
  return sessionsStore.patch(sid, {
    kind: 'member', role: tag.role, lead: tag.lead, stay: Boolean(tag.stay), pending: undefined,
    ...(tag.group ? { group: tag.group } : {}),
    ...(config.get('DDASH_NAME') ? {} : { name: tag.role }),
  });
}


// Put a message into a session's inbox. type: reply | report | order.
function deliver(sid, msg) {
  const m = { id: newId(), ts: new Date().toISOString(), type: 'reply', ...msg, session_id: safeId(sid) };
  ensureDir(paths.inbox(sid));
  writeJson(path.join(paths.inbox(sid), `${m.id}.json`), m);
  return m;
}

const REPORT_DETAILS_MAX = 300;

// A member's card as a report message for the lead. Long details stay on the card (read with team.js show).
function reportMessage(card, s) {
  const msg = {
    type: 'report', from: s.session_id, role: s.role || 'member', card_id: card.id,
    status: card.status, title: card.title, summary: card.summary || [], review: card.review || [],
  };
  if (card.details) {
    if (card.details.length > REPORT_DETAILS_MAX) msg.details_ref = card.id;
    else msg.details = card.details;
  }
  return msg;
}

function formatReplies(msgs) {
  return msgs.map((m) => `- ${m.card_title ? `[card: ${m.card_title}] ` : ''}${m.text}`).join('\n');
}

function formatReports(msgs) {
  return msgs.map((m) => {
    const lines = [`- ${m.role || 'member'} (${String(m.from || '').slice(0, 8)}) ${m.status || 'done'}: ${m.title || ''}`];
    for (const x of [].concat(m.summary || [])) lines.push(`  ${x}`);
    for (const x of [].concat(m.review || [])) lines.push(`  check: ${x}`);
    if (m.details) lines.push(`  details: ${m.details}`);
    if (m.details_ref) lines.push(`  details: long, read with: team.js show ${m.details_ref}`);
    return lines.join('\n');
  }).join('\n');
}

const formatOrders = (msgs) => msgs.map((m) => `- ${m.text}`).join('\n');

const HEADERS = { reply: '[Dashboard reply]', report: '[Team report]', order: '[Lead instruction]' };

// Inbox messages grouped by type, each group under its header. Untyped messages are dashboard replies.
function formatMessages(msgs) {
  const by = { reply: [], report: [], order: [] };
  for (const m of msgs) (by[m.type] || by.reply).push(m);
  const out = [];
  if (by.reply.length) out.push(`${HEADERS.reply}\n${formatReplies(by.reply)}`);
  if (by.report.length) out.push(`${HEADERS.report}\n${formatReports(by.report)}`);
  if (by.order.length) out.push(`${HEADERS.order}\n${formatOrders(by.order)}`);
  return out.join('\n\n');
}

// Wake reason for a batch of handed-over messages (dashboard replies win).
function messagesReason(msgs) {
  const types = new Set(msgs.map((m) => m.type || 'reply'));
  return types.has('reply') ? 'reply' : types.has('report') ? 'report' : 'order';
}

// Move pending replies from the inbox to done/. rename is atomic, so each reply is taken exactly once even with competing processes.
function takeInbox(sid) {
  const dir = paths.inbox(sid);
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const src = path.join(dir, f);
    const dst = path.join(paths.done(sid), f);
    try {
      ensureDir(paths.done(sid));
      fs.renameSync(src, dst);
      const msg = readJson(dst, null);
      if (msg) out.push(msg);
    } catch { /* another process took it first */ }
  }
  return out;
}

// Move pending messages from one inbox to another. Returns how many moved.
function moveInbox(from, to) {
  let files;
  try { files = fs.readdirSync(paths.inbox(from)).filter((f) => f.endsWith('.json')); } catch { return 0; }
  ensureDir(paths.inbox(to));
  let n = 0;
  for (const f of files) {
    try { fs.renameSync(path.join(paths.inbox(from), f), path.join(paths.inbox(to), f)); n++; } catch { /* taken meanwhile */ }
  }
  return n;
}

// --- Wait commands (bug-005: a waiter must never outlive the Claude process that started it) ---
// inbox/<sid>/wait.lock holds the waiter's pid (format kept for older readers); wait.info next to it (not .json: inbox messages are the .json files) holds
// { pid, owner, owner_name, ppid, started } written by wait-inbox.js. owner = the Claude process it serves.
const waitLockPath = (sid) => path.join(paths.inbox(sid), 'wait.lock');
const waitInfoPath = (sid) => path.join(paths.inbox(sid), 'wait.info');
const readWaitInfo = (sid) => readJson(waitInfoPath(sid), null);

// Pid of the session's wait command, if it is running and its owner (when known) is alive. A waiter whose
// Claude process died is an orphan, not "waiting" (it exits by itself; older waiters are swept).
function waitPid(sid) {
  let pid;
  try { pid = Number(fs.readFileSync(waitLockPath(sid), 'utf8')); } catch { return 0; }
  if (!alive(pid)) return 0;
  const info = readWaitInfo(sid);
  if (info && Number(info.pid) === pid && Number(info.owner) > 0 && !alive(Number(info.owner))) return 0;
  return pid;
}

// --- Processes (for stopping a replaced lead) ---

// Save the session's Claude Code pid (best effort). Returns the pid or 0.
function recordClaudePid(sid, startPid = process.ppid) {
  const pid = findClaudePid(startPid);
  if (!pid) return 0;
  return sessionsStore.patch(sid, { claude_pid: pid }) ? pid : 0;
}

// --- Orphans (bug-005) ---

// The session id a command line runs the wait command for ('' if it is none). Matches every plugin version
// (.../scripts/wait-inbox.js <sid>, ~/.ddashboard/bin/wait.js <sid>), also inside Claude's bash -c "..." wrapper.
const WAIT_CMD = /(?:wait-inbox\.js|[\\/]bin[\\/]wait\.js)[\\"']*\s+[\\"']*([A-Za-z0-9_-]{1,80})/i;
const waitCommandSid = (cmd) => (String(cmd || '').match(WAIT_CMD) || [])[1] || '';
const isNodeLike = (p) => /^(node|bun)(\.exe)?$/i.test(String(p?.name || ''));

// A waiter process (node running the wait command) and the shell wrappers above it that run the same command
// (Claude starts it as bash -c "... node wait.js <sid> ..."). [] if pid is not a waiter. Waiter first.
function waiterChain(pid, table) {
  const p = table.get(Number(pid));
  const sid = p && isNodeLike(p) ? waitCommandSid(p.cmd) : '';
  if (!sid) return [];
  const chain = [p.pid];
  let q = table.get(p.ppid);
  for (let i = 0; i < 10 && q && !chain.includes(q.pid) && !isClaudeProcess(q) && waitCommandSid(q.cmd) === sid; i++) {
    chain.push(q.pid);
    q = table.get(q.ppid);
  }
  return chain;
}

// Kill a waiter and its wrapper shells. Only pids whose command line is the wait command are touched.
function killWaiterChain(pid, table) {
  const chain = waiterChain(pid, table);
  if (!chain.length) return false;
  for (const k of chain) killPid(k);
  return napUntil(() => !alive(pid), 1000);
}

// A waiter whose session is provably gone (it would wait forever): the process that started its chain is dead
// (Windows keeps the dead pid as parent; a live process with that pid started later is a reuse), or it was
// re-parented to init/launchd/systemd (POSIX). A chain under a live Claude, or under a live program that is not
// recognized as Claude, is never called an orphan (no guessing: a wrong answer would kill a working session's waiter).
function orphanWaiter(pid, table) {
  const chain = waiterChain(pid, table);
  if (!chain.length) return false;
  const top = table.get(chain[chain.length - 1]);
  const parent = table.get(top.ppid);
  if (!top.ppid || !parent || !alive(top.ppid)) return true;
  if (parent.start && top.start && parent.start > top.start) return true; // pid reused after the parent died
  if (isClaudeProcess(parent)) return false;
  return top.ppid === 1 || /^(init|systemd|launchd)$/i.test(parent.name);
}

// Stop every orphan waiter in the process table (any plugin version, see orphanWaiter) with its wrapper shells, and
// remove lock files whose waiter is dead. Run by the server at start and every minute. Returns { killed, locks }.
// With DDASH_BOARD_DIR set (tests, a second board), only waiters whose command line lies under that board are
// touched, so a test never stops the real install's waiters or another run's. The real install never sets it.
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const inScope = (p) => !config.isSet('DDASH_BOARD_DIR') || norm(p.cmd).includes(norm(BOARD_DIR));
function sweepWaiters(table) {
  const killed = [];
  if (table?.size) {
    for (const p of table.values()) {
      const sid = isNodeLike(p) && inScope(p) ? waitCommandSid(p.cmd) : '';
      if (sid && alive(p.pid) && orphanWaiter(p.pid, table) && killWaiterChain(p.pid, table)) killed.push({ pid: p.pid, sid });
    }
  }
  let locks = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(BOARD_DIR, 'inbox')); } catch { /* no inbox yet */ }
  for (const d of dirs) {
    let pid = 0;
    try { pid = Number(fs.readFileSync(waitLockPath(d), 'utf8')); } catch { continue; }
    if (pid > 0 && alive(pid)) continue;
    try { fs.unlinkSync(waitLockPath(d)); locks++; } catch { /* gone */ }
    try { if (!alive(Number(readWaitInfo(d)?.pid))) fs.unlinkSync(waitInfoPath(d)); } catch { /* gone */ }
  }
  return { killed, locks };
}

// Stop the session's wait command, if it runs (pid-reuse safe: the pid must still run the wait command for
// this session), and remove its lock files. Returns true if a waiter was stopped.
function stopWaiter(sid, table) {
  sid = safeId(sid);
  let pid = 0;
  try { pid = Number(fs.readFileSync(waitLockPath(sid), 'utf8')); } catch { /* no lock */ }
  let stopped = false;
  if (pid > 0 && alive(pid)) {
    table = table || processTable();
    if (waitCommandSid(table.get(pid)?.cmd) === sid) stopped = killWaiterChain(pid, table);
  }
  if (!(pid > 0) || !alive(pid)) {
    try { if (Number(fs.readFileSync(waitLockPath(sid), 'utf8')) === pid) fs.unlinkSync(waitLockPath(sid)); } catch { /* gone */ }
    try { if (Number(readWaitInfo(sid)?.pid) === pid) fs.unlinkSync(waitInfoPath(sid)); } catch { /* gone */ }
  }
  return stopped;
}

// Tool shells a dead Claude process left behind. Windows keeps the dead pid as their parent pid, so they can be
// found; a Claude Code tool shell is recognizable by its command (bash -c "source .../shell-snapshots/snapshot-...").
// Each is killed with everything under it. Returns the pids killed. Does nothing while claudePid is alive.
function reapToolShells(claudePid, table) {
  claudePid = Number(claudePid);
  if (!(claudePid > 0) || alive(claudePid)) return [];
  const out = [];
  for (const p of (table || processTable()).values()) {
    if (p.ppid === claudePid && /shell-snapshots[\\/]snapshot-/.test(p.cmd) && killTree(p.pid, table)) out.push(p.pid);
  }
  return out;
}

// Everything a finished session may have left running: its wait command and, if its Claude process is dead,
// that process's tool shells. Returns { waiter, shells }.
// True when a session may have something left to stop (a lock file, or a recorded Claude pid that is dead).
const needsProcesses = (s) => Boolean(s?.session_id) && (fs.existsSync(waitLockPath(s.session_id)) || (Number(s.claude_pid) > 0 && !alive(Number(s.claude_pid))));

function stopSessionProcesses(s, table) {
  if (!needsProcesses(s)) return { waiter: false, shells: [] };
  table = table || processTable();
  return { waiter: stopWaiter(s.session_id, table), shells: reapToolShells(s.claude_pid, table) };
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
  const stopClaude = opts.killClaude || killClaude;
  const projects = readProjects();
  const r = sessionsStore.update((sessions) => handoffSessions(sessions, projects, from, to, doc));
  if (!r.ok) return r;
  const { key, t, old, members, ts } = r;
  // Re-read before writing: only this team's lead and handoff records change.
  updateProjects((all) => {
    const ft = teamOfLead(own(all, key), from);
    if (!ft) return;
    ft.team.lead = to;
    ft.team.last_handoff = { from, to, doc, ts };
    delete ft.team.handoff;
  });

  const moved = moveInbox(from, to);
  const wp = waitPid(from);
  const waitKilled = wp ? (opts.kill ? opts.kill(wp) : stopWaiter(from)) : false;
  const claudeKilled = old.claude_pid ? stopClaude(Number(old.claude_pid)) : false;
  const rules = existingLeadRules(t.team, t.name);
  return { ok: true, team: t.name, rules, members, moved, wait_killed: waitKilled, claude_killed: claudeKilled, claude_pid: old.claude_pid || 0 };
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
  Object.assign(old, { state: 'ended', ended: ts, end_reason: 'handoff', replaced_by: to, last_seen: ts });
  return { ok: true, key, t, old, members, ts };
}

// --- Groups (team mode): docs/teams/<team>/<group>/ in the team lead's worktree holds a group's memory ---
// brief.md (injected into every new member before its task), handoff-NNN.md, notes/.
// Groups belong to one team: two teams may use the same group name, and one team's upkeep never
// touches another team's folders.

const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const BRIEF_MAX_CHARS = 16000; // about 4000 tokens
const GROUP_DEFAULTS = { keep_handoffs: 3, notes_days: 30 };

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

function groupSettings(g) {
  return { ...GROUP_DEFAULTS, ...(g || {}) };
}

// A group folder with notes/ and a brief template (an existing brief is kept).
function ensureGroupDir(dir, name) {
  ensureDir(path.join(dir, 'notes'));
  const brief = path.join(dir, 'brief.md');
  if (!fs.existsSync(brief)) fs.writeFileSync(brief, briefTemplate(name));
}

const badGroupName = (name) => !GROUP_NAME.test(String(name || '')) || String(name).startsWith('_');
const GROUP_NAME_ERROR = 'group names use letters, digits, - and _ (up to 40)';

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

// Members of a team (by its current lead).
const teamMembers = (sessions, key, team) => Object.values(sessions).filter((s) => s.project_key === key && s.kind === 'member' && s.lead === team.lead);

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
  const text = `[ddashboard] Group "${name}" brief (${slash(path.join(g.dir, 'brief.md'))}):
${body.trim() || '(empty)'}
Latest handoff: ${last ? `${last} (read it before you start)` : 'none yet'}
`;
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
  const stamp = { rules_ver: Number(p?.mode_ver) || 0, lang_ver: Number(readSettings().ver) || 0, text_ver: RULES_TEXT_VER, start_rules: true };
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
      if (!isEnded(s)) { refused.push(id); continue; }
      delete sessions[id];
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
  return { forgotten, refused };
}

// True when a session (any kind: solo, lead, member, outside) is known to be gone without its SessionEnd hook
// having run (bug-001, bug-005: a terminal closed by hand kills claude before the hook): its recorded Claude
// process is dead, or its pid now belongs to another program (table: a process table taken after the session was
// last seen), or, with no recorded pid, its Orca terminal is closed (isOpen(handle) -> true | false | null for
// unknown; left out: not checked). Never guesses: a live wait command with a live owner, an old record with no pid
// and no terminal, or an unknown terminal state count as alive. Headless sessions keep their own rule (pid exited
// = "finished", resumable).
function sessionGone(s, isOpen, table) {
  if (!s || isEnded(s) || s.headless) return false;
  const cp = Number(s.claude_pid);
  if (cp > 0) {
    if (!alive(cp)) return true;
    const p = table?.get(cp);
    const fresh = table?.taken && table.taken > new Date(s.last_seen || 0).getTime();
    return Boolean(fresh && p && !isClaudeProcess(p));
  }
  if (waitPid(s.session_id)) return false;
  if (isOpen && s.runner === 'orca' && s.orca?.handle) return isOpen(s.orca.handle) === false;
  return false;
}
const memberGone = sessionGone;

// Mark these sessions ended (end_reason 'gone') in sessions.json. Returns the ids changed.
function markGone(sids) {
  if (!sids.length) return [];
  const ts = new Date().toISOString();
  const done = [];
  sessionsStore.update((sessions) => {
    for (const sid of sids) {
      const s = own(sessions, sid);
      if (!s || isEnded(s)) continue;
      Object.assign(s, { state: 'ended', ended: ts, end_reason: 'gone' });
      done.push(sid);
    }
  });
  return done;
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
  if (!gone && (s.state === 'working' || waiting || !isStale(s))) return { ok: false, code: 409, error: 'session is active (working, waiting or seen recently)' };
  const ts = new Date().toISOString();
  const fields = { state: 'ended', ended: ts, end_reason: gone ? 'gone' : 'marked' };
  Object.assign(s, fields);
  sessionsStore.update((all) => {
    const cur = own(all, sid);
    if (cur && !isEnded(cur)) Object.assign(cur, fields);
  });
  try { stopSessionProcesses(s, table || undefined); } catch { /* best effort */ }
  return { ok: true };
}

// Lead context limit, relative to where the lead started (plan M-1c):
//   baseline   = the lead's first measured context (first assistant message in its transcript: system prompt,
//                tools, skills, first prompt). Unknown (no transcript) → the absolute cap below.
//   handoff at = baseline + work budget, cut to 80% of the model context window (a lead that starts near
//                the cap is told soon; one that starts above it at once).
// DDASH_LEAD_CONTEXT_LIMIT, when set, is an absolute point that replaces baseline + budget (still cut to 80%).
// Numbers from the environment: an empty or invalid value means the default; 0 is a value.
const { envNum } = config;
const LEAD_WORK_BUDGET = config.get('DDASH_LEAD_WORK_BUDGET');
const LEAD_CONTEXT_LIMIT = config.get('DDASH_LEAD_CONTEXT_LIMIT'); // 0: relative
const CONTEXT_WINDOW = config.get('DDASH_CONTEXT_WINDOW'); // 0: detect (200k, 1M for [1m] models)
const DEFAULT_WINDOW = 200000;
const LARGE_WINDOW = 1000000;
const WINDOW_CAP = 0.8;
const BASELINE_WARN = 0.5;
const HANDOFF_MAX_TOKENS = config.get('DDASH_HANDOFF_MAX_TOKENS'); // 0: no cap

// Model names a session may run with: its SessionStart model, the transcript's model, Claude settings
// (user, project, local) and ANTHROPIC_MODEL. Used only to spot 1M-context models ("opus[1m]").
const ONE_M = /\[1m\]/i;
function settingsModels(cwd) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [path.join(home, 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return [process.env.ANTHROPIC_MODEL, ...files.map((f) => readJson(f, {})?.model)].filter(Boolean);
}

// SessionStart hook input carries the model; kept per session id (also for sessions not registered yet).
function rememberModel(sid, model) {
  if (!sid || !model) return;
  const all = readJson(paths.models, {});
  all[sid] = { model: String(model), ts: new Date().toISOString() };
  const keep = Object.entries(all).sort((a, b) => String(b[1].ts).localeCompare(String(a[1].ts))).slice(0, 300);
  writeJson(paths.models, Object.fromEntries(keep));
}
const knownModel = (sid) => readJson(paths.models, {})[sid]?.model || '';

// Model context window: DDASH_CONTEXT_WINDOW when set; 1M when a model name says [1m]; else the largest
// window stored for the session (200k at least), so a compacted 1M session never falls back to 200k.
// A context above the window means the window is larger (1M).
function contextWindow({ models = [], stored = 0, seen = 0 } = {}) {
  if (CONTEXT_WINDOW) return CONTEXT_WINDOW;
  if (models.some((m) => ONE_M.test(String(m || '')))) return LARGE_WINDOW;
  const w = Math.max(DEFAULT_WINDOW, Number(stored) || 0);
  return Number(seen) > w ? LARGE_WINDOW : w;
}

// The handoff point of a lead: { baseline, window, at, budget, big }. baseline 0 = unknown (absolute cap).
function leadLimit(baseline, window) {
  const b = Number(baseline) || 0;
  const w = Number(window) || CONTEXT_WINDOW || DEFAULT_WINDOW;
  const cap = Math.floor(w * WINDOW_CAP);
  const wanted = LEAD_CONTEXT_LIMIT || (b ? b + LEAD_WORK_BUDGET : cap);
  const at = Math.min(wanted, cap);
  return { baseline: b, window: w, at, budget: Math.max(0, at - b), big: b > w * BASELINE_WARN };
}

// Context of the first main-thread assistant message in a transcript (0 when there is none in its first 4 MB).
function firstContext(transcriptPath) {
  if (!transcriptPath) return 0;
  let text = '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return 0; }
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  for (const line of text.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.type === 'assistant' && !o.isSidechain ? o.message?.usage : null;
    if (!u || typeof u !== 'object') continue;
    const c = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    if (c) return c;
  }
  return 0;
}

// Token estimate for a text, on the high side: ASCII ~3.5 chars per token; other characters
// (Korean, CJK, symbols) count 1.5 tokens each.
function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (ch.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.5 + other * 1.5);
}

// Forget a session's lead context state (it becomes or stops being a lead).
function clearLeadContext(s) {
  if (!s) return;
  for (const k of ['lead_baseline', 'lead_baseline_unknown', 'lead_handoff_at', 'context_handoff_told']) delete s[k];
}

const leadContextText = (sid, ctx, lim) => {
  const where = lim.baseline
    ? `has grown by ${ctx - lim.baseline} since you started as team lead (start ${lim.baseline}, handoff at ${lim.at})`
    : `is past the team lead handoff point (${lim.at}, 80% of the ${lim.window}-token context window)`;
  const rules = `${HANDOFF_MAX_TOKENS ? ` (under ${HANDOFF_MAX_TOKENS} tokens)` : ''}`;
  return `[ddashboard] Your context (${ctx} tokens) ${where}. Finish the current step, then write a NEW handoff doc${rules} with only the current state: open items, members and their tasks, decisions changed since the last handoff, next steps. Do not copy or point to older handoff docs; finished work belongs in the plan, commits and CHANGELOG, and fixed rules in the team's lead-rules.md. Then run: node "${slash(ensureTeamBin())}" ${sid} handoff <doc-path>`;
};

// Once per lead session: the handoff notice when its last turn's context is past its handoff point ('' otherwise).
// opts: transcript (path, for the baseline), models (model names seen this turn), cwd (Claude settings).
// Works on the given objects; the caller saves the session.
function leadContextNotice(s, p, opts = {}) {
  if (!s || teamRole(s, p) !== 'lead') return '';
  const ctx = Number(s.last_context) || 0;
  if (!ctx) return '';
  if (s.lead_baseline === undefined) {
    const first = firstContext(opts.transcript);
    s.lead_baseline = first;
    if (!first) s.lead_baseline_unknown = true;
  }
  const models = [...(opts.models || []), knownModel(s.session_id), ...settingsModels(opts.cwd || s.cwd)];
  s.context_window = contextWindow({ models, stored: s.context_window, seen: Math.max(ctx, Number(s.lead_baseline) || 0) });
  const lim = leadLimit(s.lead_baseline, s.context_window);
  s.lead_handoff_at = lim.at;
  if (s.context_handoff_told || ctx < lim.at) return '';
  s.context_handoff_told = true;
  return leadContextText(s.session_id, ctx, lim);
}

const replacedText = (s) => `[ddashboard] This session was replaced as team lead by ${s.replaced_by} (handoff). Stop working now: no more tool calls or file changes. Start a new session for other work.`;

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
