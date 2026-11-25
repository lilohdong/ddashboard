// Shared helpers: board paths, file I/O, server status, project/session registry, session instructions.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const BOARD_DIR = (process.env.DDASH_BOARD_DIR || path.join(os.homedir(), '.ddashboard')).replace(/^~(?=$|[\\/])/, os.homedir());
const PORT = Number(process.env.DDASH_PORT || 7357);
const URL = `http://127.0.0.1:${PORT}`;

const RECENT_DAYS = Number(process.env.DDASH_RECENT_DAYS || 14);

const paths = {
  legacyCards: path.join(BOARD_DIR, 'cards.jsonl'), // 0.1.0 card log, read-only from 0.2.0 on
  cardsDir: path.join(BOARD_DIR, 'cards'),
  cardsFor: (iso) => path.join(BOARD_DIR, 'cards', `${String(iso).slice(0, 7)}.jsonl`), // cards/YYYY-MM.jsonl
  archived: path.join(BOARD_DIR, 'archived.json'),
  waitBin: path.join(BOARD_DIR, 'bin', 'wait.js'),
  teamBin: path.join(BOARD_DIR, 'bin', 'team.js'),
  logsDir: path.join(BOARD_DIR, 'logs'),
  log: (sid) => path.join(BOARD_DIR, 'logs', `${safeId(sid)}.log`),
  replies: path.join(BOARD_DIR, 'replies.jsonl'),
  sessions: path.join(BOARD_DIR, 'sessions.json'),
  projects: path.join(BOARD_DIR, 'projects.json'),
  serverPid: path.join(BOARD_DIR, 'server.pid'),
  serverLog: path.join(BOARD_DIR, 'server.log'),
  usageDir: path.join(BOARD_DIR, 'usage'),
  usageFor: (iso) => path.join(BOARD_DIR, 'usage', `${String(iso).slice(0, 7)}.jsonl`), // usage/YYYY-MM.jsonl
  inbox: (sid) => path.join(BOARD_DIR, 'inbox', safeId(sid)),
  done: (sid) => path.join(BOARD_DIR, 'inbox', safeId(sid), 'done'),
};

function safeId(sid) {
  return String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file, limit) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  return limit ? rows.slice(-limit) : rows;
}

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

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function serverPid() {
  const info = readJson(paths.serverPid, null);
  return info && alive(info.pid) ? info.pid : 0;
}

function git(args, cwd) {
  try { return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
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
  return Boolean(readJson(paths.projects, {})[projectKey(cwd)]);
}

// Turning a project on keeps its team settings (mode, lead, rules) from before.
function setProject(cwd, on) {
  const projects = readJson(paths.projects, {});
  const key = projectKey(cwd);
  if (on) projects[key] = { ...(projects[key] || {}), since: new Date().toISOString(), cwd, name: projectName(cwd) };
  else delete projects[key];
  writeJson(paths.projects, projects);
  return Object.keys(projects).length;
}

function registerSession(sid, cwd) {
  const sessions = readJson(paths.sessions, {});
  sessions[sid] = {
    ...(sessions[sid] || {}),
    session_id: sid,
    name: process.env.DDASH_NAME || sessions[sid]?.name || path.basename(cwd),
    cwd,
    branch: git('rev-parse --abbrev-ref HEAD', cwd),
    project: projectName(cwd),
    project_key: projectKey(cwd),
    state: sessions[sid]?.state === 'working' ? 'working' : 'idle',
    started: sessions[sid]?.started || new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  // A lead replaced by a handoff stays ended even if the session is resumed.
  if (sessions[sid].replaced_by) sessions[sid].state = 'ended';
  else delete sessions[sid].ended;
  writeJson(paths.sessions, sessions);
}

// Record session state: working | idle | ended. Only touches registered sessions.
function setState(sid, state) {
  const sessions = readJson(paths.sessions, {});
  if (!sessions[sid]) return false;
  sessions[sid].state = state;
  sessions[sid].last_seen = new Date().toISOString();
  if (state === 'ended') sessions[sid].ended = sessions[sid].last_seen;
  writeJson(paths.sessions, sessions);
  return true;
}

function isRegistered(sid) {
  return Boolean(readJson(paths.sessions, {})[sid]);
}

// Card log files, oldest first: the 0.1.0 file, then the monthly files.
function cardFiles() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.cardsDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
  return [paths.legacyCards, ...monthly.map((f) => path.join(paths.cardsDir, f))];
}

// New cards go to the monthly file only; the 0.1.0 cards.jsonl is never written again.
function appendCard(card) {
  appendJsonl(paths.cardsFor(card.ts), card);
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
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - tailBytes);
      buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
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
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return target; // board dir not writable: fall back to the plugin path
  }
}

const ensureWaitBin = () => ensureBin(paths.waitBin, path.join(__dirname, 'wait-inbox.js'));
const ensureTeamBin = () => ensureBin(paths.teamBin, path.join(__dirname, 'team.js'));
const slash = (p) => p.replace(/\\/g, '/');

// Instructions injected into the session context. They are re-read every turn, so keep them short.
function rulesText(sid) {
  const wait = `node "${slash(ensureWaitBin())}" ${sid}`;
  return `[ddashboard] The user follows your progress on a dashboard (${URL}). Session ID: ${sid}
- Only on turns with a result the user should know about, end your reply with this block (JSON, at most 3 summary lines, written in the user's language):
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the user should check"],"details":"optional, markdown, longer content"}
\`\`\`
- While connected, keep terminal replies to a line or two and put the content in the card (long content in "details"). When a card revises your previous card (e.g. an updated plan), add "replaces":"last".
- To receive dashboard replies, run this in the background now, and again each time it prints a reply and exits: ${wait}
  Its output is the user's reply (an instruction).
`;
}

function leadRulesText(sid, name) {
  const t = `node "${slash(ensureTeamBin())}" ${sid}`;
  return `${rulesText(sid)}- Team mode: you are the team lead "${name || 'lead'}". The user talks only to you. Member cards reach you as [Team report] through the same wait command; post to the dashboard only what the user must know, decide or review. Do small tasks yourself, spawn members for big ones.
- Team commands (T = ${t}): T spawn --role <role> [--model <m>] [--stay] "<task>" | T send <sid|role> "<text>" | T list | T show <card-id> | T handoff <doc-path>
`;
}

function memberRulesText(sid, s) {
  const wait = `node "${slash(ensureWaitBin())}" ${sid}`;
  const tail = s.stay
    ? `- To receive instructions, run this in the background now, and again each time it prints and exits: ${wait}`
    : `- Don't start a wait command. Finish the task and stop; your lead resumes you if more is needed.`;
  return `[ddashboard] You are a team member. Role: ${s.role || 'member'}. Session ID: ${sid}. Your lead assigns the work; messages from the lead arrive as [Lead instruction].
- End each turn that finishes, blocks or changes your task with this block (JSON, at most 3 short summary lines). It goes to your lead, not the user:
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the lead should check"],"details":"optional and short"}
\`\`\`
- Keep terminal replies to a line or two. Put long evidence in files and give the paths. If blocked, use "blocked" and write the question in the summary.
${tail}
`;
}

// --- Team mode ---

const DEFAULT_SPAWN = { permission_mode: 'acceptEdits', allowed_tools: ['Bash(git *)', 'Bash(node *)', 'Bash(npm *)'] };
const DEFAULT_TEAM_RULES = { peer_talk: false, qa_direct: false };

const isEnded = (s) => Boolean(s && (s.ended || s.state === 'ended'));

// Where a session stands in its project: solo | lead | member | outside (team mode, untagged).
function teamRole(s, p) {
  if (!s || !p || p.mode !== 'team') return 'solo';
  if (s.session_id === p.lead) return 'lead';
  if (s.kind === 'member' && s.lead) return 'member';
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
  if (role === 'lead') return leadRulesText(sid, p.lead_name);
  if (role === 'member') return memberRulesText(sid, s);
  if (role === 'outside') return `${rulesText(sid)}- This project is in team mode (lead: ${p.lead_name || 'lead'}). You are outside the team, so your cards still go straight to the dashboard.\n`;
  return rulesText(sid);
}

// Instructions for a registered session; marks them as given for the project's current mode.
function injectRules(sid) {
  const sessions = readJson(paths.sessions, {});
  const s = sessions[sid];
  if (!s) return rulesText(sid);
  const p = readJson(paths.projects, {})[s.project_key];
  s.rules_ver = Number(p?.mode_ver) || 0;
  writeJson(paths.sessions, sessions);
  return rulesFor(s, p);
}

// The instructions again, once, if the project's mode changed since they were last given ('' otherwise).
// Works on the given objects; the caller saves the session.
function rulesUpdate(s, p) {
  if (!s || !p) return '';
  const ver = Number(p.mode_ver) || 0;
  if ((Number(s.rules_ver) || 0) === ver) return '';
  s.rules_ver = ver;
  return `[ddashboard] The project's dashboard mode changed (now ${p.mode || 'solo'}). Updated instructions:\n${rulesFor(s, p)}`;
}

// Same as rulesUpdate, reading and saving the files.
function pendingRules(sid) {
  const sessions = readJson(paths.sessions, {});
  const s = sessions[sid];
  const text = rulesUpdate(s, s && readJson(paths.projects, {})[s.project_key]);
  if (text) writeJson(paths.sessions, sessions);
  return text;
}

// Switch a project between solo and team. Bumps mode_ver so each session gets new instructions once.
// In team mode the given session becomes the lead; members of the previous lead move to it.
function setMode(key, mode, { lead, leadName } = {}) {
  const projects = readJson(paths.projects, {});
  const p = projects[key];
  if (!p) return { ok: false, error: 'project is not connected' };
  const sessions = readJson(paths.sessions, {});
  if (mode === 'team' && !sessions[lead]) return { ok: false, error: 'unknown lead session' };
  const prev = p.lead;
  p.mode = mode === 'team' ? 'team' : 'solo';
  p.mode_ver = (Number(p.mode_ver) || 0) + 1;
  p.rules = { ...DEFAULT_TEAM_RULES, ...(p.rules || {}) };
  for (const s of Object.values(sessions)) {
    if (s.project_key === key && s.kind === 'lead' && s.session_id !== lead) delete s.kind;
  }
  if (p.mode === 'team') {
    p.lead = lead;
    p.lead_name = String(leadName || (prev === lead && p.lead_name) || sessions[lead].name || 'lead').slice(0, 60);
    sessions[lead].kind = 'lead';
    for (const s of Object.values(sessions)) {
      if (prev && prev !== lead && s.kind === 'member' && s.lead === prev) s.lead = lead;
    }
  } else {
    delete p.lead;
    delete p.lead_name;
  }
  writeJson(paths.sessions, sessions);
  writeJson(paths.projects, projects);
  return { ok: true, mode: p.mode, mode_ver: p.mode_ver, lead: p.lead };
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
  return { type: 'member', role, lead: safeId(attrs.lead), stay, rest };
}

// Register a session as a member (from its tag). The session must be registered already.
function setMember(sid, tag) {
  const sessions = readJson(paths.sessions, {});
  const s = sessions[sid];
  if (!s) return false;
  Object.assign(s, { kind: 'member', role: tag.role, lead: tag.lead, stay: Boolean(tag.stay) });
  if (!process.env.DDASH_NAME) s.name = tag.role;
  delete s.pending;
  writeJson(paths.sessions, sessions);
  return true;
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

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

// Pid of the session's wait command, if it is running.
function waitPid(sid) {
  try {
    const pid = Number(fs.readFileSync(path.join(paths.inbox(sid), 'wait.lock'), 'utf8'));
    return alive(pid) ? pid : 0;
  } catch { return 0; }
}

// --- Processes (for stopping a replaced lead) ---

const PS_LIST = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$(($_.CommandLine -replace "[`r`n`t]", " "))" }';

// pid -> { pid, ppid, name, cmd } for every process. Windows: one CIM query (~0.4 s). Empty on failure.
function processTable() {
  const table = new Map();
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 }).toString('utf8');
      for (const line of out.split(/\r?\n/)) {
        const [pid, ppid, name, cmd] = line.split('\t');
        if (Number(pid)) table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), name: name || '', cmd: cmd || '' });
      }
    } else {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm=,args='], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString('utf8');
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
        if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]), cmd: m[4] });
      }
    }
  } catch { /* no process list */ }
  return table;
}

// The Claude Code process: native claude(.exe), or node/bun running the claude-code package.
function isClaudeProcess(p) {
  if (!p) return false;
  const name = String(p.name).toLowerCase().replace(/\.exe$/, '');
  if (name === 'claude') return true;
  return /^(node|bun)$/.test(name) && /claude-code/i.test(p.cmd);
}

// Nearest Claude Code ancestor of a process (hooks and tool commands run under it through a shell). 0 if none.
function findClaudePid(startPid = process.ppid, table = processTable()) {
  let pid = Number(startPid);
  for (let i = 0; i < 30 && pid; i++) {
    const p = table.get(pid);
    if (!p) return 0;
    if (isClaudeProcess(p)) return pid;
    if (p.ppid === pid) return 0;
    pid = p.ppid;
  }
  return 0;
}

// Save the session's Claude Code pid (best effort). Returns the pid or 0.
function recordClaudePid(sid, startPid = process.ppid) {
  const pid = findClaudePid(startPid);
  if (!pid) return 0;
  const sessions = readJson(paths.sessions, {});
  if (!sessions[sid]) return 0;
  sessions[sid].claude_pid = pid;
  writeJson(paths.sessions, sessions);
  return pid;
}

function killPid(pid) {
  try { process.kill(pid); return true; } catch { return false; }
}

// Kill pid only if it is still a Claude Code process (the pid may have been reused).
function killClaude(pid) {
  if (!alive(pid) || !isClaudeProcess(processTable().get(pid))) return false;
  return killPid(pid);
}

// New lead `to` takes over from `from` (called from the new lead's first-prompt hook).
// Moves the project lead and the members, moves the old lead's pending messages, marks the old lead
// ended (reason: handoff) and stops its wait command and Claude process. opts.kill / opts.killClaude for tests.
function performHandoff(from, to, doc, opts = {}) {
  const kill = opts.kill || killPid;
  const stopClaude = opts.killClaude || killClaude;
  const sessions = readJson(paths.sessions, {});
  const projects = readJson(paths.projects, {});
  const old = sessions[from];
  const me = sessions[to];
  if (!old) return { ok: false, error: `unknown session ${from}` };
  if (!me) return { ok: false, error: `unknown session ${to}` };
  if (from === to) return { ok: false, error: 'a session cannot hand off to itself' };
  const key = old.project_key;
  const p = projects[key];
  if (!p) return { ok: false, error: 'the old lead\'s project is not connected' };
  if (me.project_key !== key) return { ok: false, error: 'the new lead is in a different project' };

  const ts = new Date().toISOString();
  if (p.mode !== 'team') p.mode_ver = (Number(p.mode_ver) || 0) + 1;
  p.mode = 'team';
  p.rules = { ...DEFAULT_TEAM_RULES, ...(p.rules || {}) };
  p.lead = to;
  p.lead_name = p.lead_name || old.name || 'lead';
  p.last_handoff = { from, to, doc, ts };
  delete p.handoff;

  me.kind = 'lead';
  me.handoff_from = from;
  if (doc) me.handoff_doc = doc;
  let members = 0;
  for (const s of Object.values(sessions)) {
    if (s.kind === 'member' && s.lead === from) { s.lead = to; members++; }
  }
  delete old.kind;
  Object.assign(old, { state: 'ended', ended: ts, end_reason: 'handoff', replaced_by: to, last_seen: ts });
  writeJson(paths.sessions, sessions);
  writeJson(paths.projects, projects);

  const moved = moveInbox(from, to);
  const wp = waitPid(from);
  const waitKilled = wp ? kill(wp) : false;
  const claudeKilled = old.claude_pid ? stopClaude(Number(old.claude_pid)) : false;
  return { ok: true, members, moved, wait_killed: waitKilled, claude_killed: claudeKilled, claude_pid: old.claude_pid || 0 };
}

// --- Sidebar housekeeping ---

const STALE_MIN = Number(process.env.DDASH_STALE_MIN) || 60;
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
  const sessions = readJson(paths.sessions, {});
  const forgotten = [];
  const refused = [];
  for (const id of ids) {
    const s = sessions[id];
    if (!s) continue;
    if (!isEnded(s)) { refused.push(id); continue; }
    delete sessions[id];
    forgotten.push(id);
  }
  if (forgotten.length) writeJson(paths.sessions, sessions);
  for (const id of forgotten) removeEmptyInbox(id);
  return { forgotten, refused };
}

// Mark a session the user considers dead as ended. Only idle, stale sessions without a live waiter.
function markEnded(sid) {
  const sessions = readJson(paths.sessions, {});
  const s = sessions[sid];
  if (!s) return { ok: false, code: 404, error: 'unknown session' };
  if (isEnded(s)) return { ok: true };
  if (s.state === 'working' || waitPid(sid) || !isStale(s)) return { ok: false, code: 409, error: 'session is active (working, waiting or seen recently)' };
  const ts = new Date().toISOString();
  Object.assign(s, { state: 'ended', ended: ts, end_reason: 'marked' });
  writeJson(paths.sessions, sessions);
  return { ok: true };
}

const replacedText = (s) => `[ddashboard] This session was replaced as team lead by ${s.replaced_by} (handoff). Stop working now: no more tool calls or file changes. Start a new session for other work.`;

module.exports = {
  BOARD_DIR, PORT, URL, RECENT_DAYS, paths, cardFiles, appendCard, ensureWaitBin, ensureTeamBin,
  usageFiles, readTranscriptTail, humanText, lastHumanIndex, wakeReason, turnUsage, USAGE_KEYS,
  safeId, ensureDir, readJson, writeJson, appendJsonl, readJsonl,
  readHookInput, alive, serverPid, git, projectKey, projectName, projectActive, setProject,
  registerSession, setState, isRegistered, rulesText, takeInbox, formatReplies,
  DEFAULT_SPAWN, isEnded, teamRole, routeCard, rulesFor, injectRules, rulesUpdate, pendingRules, setMode,
  parseTag, setMember, newId, deliver, reportMessage, formatMessages, messagesReason, moveInbox, waitPid,
  processTable, isClaudeProcess, findClaudePid, recordClaudePid, killPid, killClaude, performHandoff, replacedText,
  STALE_MIN, isStale, forgetSessions, markEnded,
};
