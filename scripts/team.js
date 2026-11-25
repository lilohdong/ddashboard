#!/usr/bin/env node
// Team commands for a team lead (run through the fixed path BOARD_DIR/bin/team.js).
//   node team.js <lead sid> spawn --role <role> [--group <g>] [--model <m>] [--stay] [--headless|--orca|--window] "<task>"
//       start a member with the project's runner_member (projects.json spawn; default headless): headless (claude -p in
//       the background), orca (a visible interactive claude in an Orca terminal, see orca.js) or window (a new OS
//       terminal window, see terminal.js). A configured runner that cannot run here falls back to headless (noted);
//       a runner flag overrides the setting and is refused when it cannot run here.
//       Log: BOARD_DIR/logs/<sid>.log. With --group it gets the group's brief and latest handoff before its task.
//   node team.js <lead sid> send <sid|role> "<text>"
//       instruction to a member: into its inbox if it is waiting or still running; an idle Orca member gets it
//       typed into its terminal; else resume it (in a new Orca terminal, or claude -p --resume)
//   node team.js <lead sid> list                 members: role, state, waiting, last card (a member whose Claude
//       process is dead or whose Orca terminal is closed is marked ended)
//   node team.js <lead sid> end <sid|role>       stop a member: close its Orca terminal / stop its processes, mark it ended
//   node team.js <lead sid> show <card-id>       a card in full (long report details)
//   node team.js <lead sid> handoff <doc> [--spawn] [--headless|--orca|--window] [--model <m>]
//       prepare a lead handoff; prints the first prompt for the new lead. --spawn starts it with the project's
//       runner_lead (same rules as members; terminal title 'lead <team>'). A runner flag forces one and implies --spawn. The doc must be under DDASH_HANDOFF_MAX_TOKENS (6000) estimated tokens.
//   node team.js <lead sid> group create <g> | rename <g> <new> | delete <g> [--purge] | list | prune [<g>]
//       groups of the lead's team keep shared memory in docs/teams/<team>/<g>/ of the team's worktree
//       (brief.md, handoff-NNN.md, notes/). Nothing is committed; the lead commits the docs.
//   node team.js <member sid> next-handoff        (a lead: next-handoff <g>)
//       create the next handoff-NNN.md in the group folder (exclusively: never a number in use) and print its path
// Each command works on the caller's own team only; other teams in the repo are never touched.
// Headless permissions come from projects.json[<project>].spawn = { permission_mode, allowed_tools },
// default: auto (the auto-mode classifier) + Bash(git *), Bash(node *), Bash(npm *). DDASH_CLAUDE_BIN overrides the claude command.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const lib = require('./lib');
const orca = require('./orca');
const terminal = require('./terminal');

const { paths, readJson, writeJson, ensureDir, safeId, alive, DEFAULT_SPAWN } = lib;
const slash = (p) => String(p).replace(/\\/g, '/');

function usage() {
  return `Usage: node team.js <lead session id> <command>
  spawn --role <role> [--group <g>] [--model <m>] [--stay] [--headless|--orca|--window] "<task>"
  send <sid|role> "<text>"
  list
  end <sid|role>
  show <card-id>
  handoff <doc-path> [--spawn] [--headless|--orca|--window] [--model <m>]
  group create <g> | rename <g> <new> | delete <g> [--purge] | list | prune [<g>]
  next-handoff [<g>]`;
}

// Split argv into flags (--name value / --flag) and positional words.
function parseArgs(argv, booleans = []) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (booleans.includes(name)) flags[name] = true;
      else flags[name] = argv[++i];
    } else words.push(a);
  }
  return { flags, words };
}

// The claude command as [file, args prefix, use shell]. DDASH_CLAUDE_BIN may point at a .js file (tests).
function claudeCommand() {
  const bin = process.env.DDASH_CLAUDE_BIN || 'claude';
  if (/\.(c|m)?js$/i.test(bin)) return { file: process.execPath, pre: [bin], shell: false };
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(bin)) {
    // claude.exe (native install) runs directly; claude.cmd (npm install) needs cmd.exe.
    let found = '';
    try { found = execFileSync('where', [bin], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().split(/\r?\n/)[0].trim(); } catch {}
    if (found && /\.(exe|com)$/i.test(found)) return { file: found, pre: [], shell: false };
    return { file: bin, pre: [], shell: true };
  }
  return { file: bin, pre: [], shell: false };
}

const quoteCmd = (a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

// Start claude detached with the prompt on stdin (no quoting trouble with long prompts), output to the log.
function runClaude(sid, args, prompt, cwd) {
  ensureDir(paths.logsDir);
  const promptFile = path.join(paths.logsDir, `${safeId(sid)}.prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt);
  const log = fs.openSync(paths.log(sid), 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} claude ${args.join(' ')}\n`);
  const input = fs.openSync(promptFile, 'r');
  const env = { ...process.env };
  delete env.CLAUDECODE; // a nested claude refuses to start when it thinks it runs inside Claude Code
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const cmd = claudeCommand();
  const all = [...cmd.pre, ...args];
  const child = spawn(cmd.file, cmd.shell ? all.map(quoteCmd) : all, {
    cwd, detached: true, windowsHide: true, shell: cmd.shell, stdio: [input, log, log], env,
  });
  child.on('error', (err) => fs.appendFileSync(paths.log(sid), `ddashboard: could not start claude: ${err.message}\n`));
  child.unref();
  fs.closeSync(input);
  fs.closeSync(log);
  return child.pid || 0;
}

function claudeArgs(opts) {
  const args = [];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permission_mode) args.push('--permission-mode', opts.permission_mode);
  if (opts.allowed_tools?.length) args.push('--allowedTools', ...opts.allowed_tools);
  return args;
}

function context(leadSid) {
  const sessions = readJson(paths.sessions, {});
  const lead = sessions[leadSid];
  if (!lead) throw new Error(`unknown session ${leadSid}. Pass your own session ID (it is in your [ddashboard] instructions).`);
  const projects = lib.readProjects();
  const project = projects[lead.project_key];
  if (!project) throw new Error('this project is not connected to the dashboard.');
  return { sessions, projects, lead, project };
}

// The team this session leads: { name, team }. Throws if it leads none.
function ownTeam(project, leadSid) {
  const t = lib.teamOfLead(project, leadSid);
  if (!t) throw new Error('you are not the lead of a team in this project.');
  return t;
}

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
const RUNNERS = ['headless', 'orca', 'window'];

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

// The runner flag (--headless | --orca | --window) or undefined.
function runnerFlag(flags) {
  const set = RUNNERS.filter((r) => flags[r]);
  if (set.length > 1) throw new Error('use only one of --headless, --orca, --window.');
  return set[0];
}

const runnerLabel = (r) => (r === 'orca' ? 'Orca' : 'The terminal window');

// Spec file for orca-launch.js (starts an interactive claude with the prompt as its first message) and the
// short command that runs it. Going through a file keeps long or multi-line prompts free of shell quoting.
function launchCommand(sid, args, prompt, cwd, kind) {
  ensureDir(paths.logsDir);
  const base = path.join(paths.logsDir, `${safeId(sid)}.${kind}-${Date.now()}`);
  fs.writeFileSync(`${base}.prompt.txt`, prompt);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ args, prompt_file: `${base}.prompt.txt`, cwd }));
  fs.appendFileSync(paths.log(sid), `\n--- ${new Date().toISOString()} ${kind} terminal: claude ${args.join(' ')}\n`);
  return `node "${slash(path.join(__dirname, 'orca-launch.js'))}" "${slash(base)}.json"`;
}

// Start an interactive claude in a new, visible Orca terminal in the worktree of cwd. Returns { handle, pane }.
function runOrca(sid, args, prompt, cwd, title) {
  return orca.openTerminal({ cwd, title, command: launchCommand(sid, args, prompt, cwd, 'orca') });
}

// Start an interactive claude in a new OS terminal window in cwd. Returns { pid } of the launcher.
function runWindow(sid, args, prompt, cwd, title) {
  return terminal.openWindow({ cwd, title, command: launchCommand(sid, args, prompt, cwd, 'window') });
}

function updateSession(sid, fields, drop = []) {
  const sessions = readJson(paths.sessions, {});
  if (!sessions[sid]) return;
  Object.assign(sessions[sid], fields);
  for (const k of drop) delete sessions[sid][k];
  writeJson(paths.sessions, sessions);
}

// Start a member of this lead with the project's runner_member (see pickRunner). Used by `team.js spawn` and the
// dashboard (POST /api/team/spawn). runner forces one ('headless' | 'orca' | 'window').
// Returns { sid, runner, pid, terminal, log, note }.
function spawnMember(leadSid, { role, model, stay, task, group, runner } = {}) {
  role = String(role || '').trim().slice(0, 40);
  task = String(task || '').trim();
  group = group ? String(group).trim() : '';
  if (!role || !task) throw new Error('spawn needs a role and a task.');
  const { lead, project } = context(leadSid);
  const own = ownTeam(project, leadSid);
  const g = group ? lib.own(own.team.groups, group) : null;
  if (group && !g) throw new Error(`no group ${group} in team ${own.name}. Create it with: group create ${group}`);
  if (g) {
    lib.pruneGroup(g);
    try { lib.checkBriefs(lead.project_key); } catch { /* best effort */ }
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
  const sessions = readJson(paths.sessions, {});
  const now = new Date().toISOString();
  sessions[sid] = {
    session_id: sid, name: flags.role, cwd, branch: lead.branch || '', project: lead.project, project_key: lead.project_key,
    state: 'working', started: now, last_seen: now, pending: true,
    kind: 'member', role: flags.role, lead: leadSid, stay: Boolean(flags.stay), headless: how === 'headless', runner: how,
    spawn: { ...opts, cwd }, log: paths.log(sid),
  };
  if (group) sessions[sid].group = group;
  writeJson(paths.sessions, sessions);
  const log = slash(paths.log(sid));
  let note = picked.note;
  if (how !== 'headless') {
    try {
      const args = ['--session-id', sid, ...claudeArgs(opts)];
      const title = `${flags.role}${group ? ` · ${group}` : ''}`;
      if (how === 'window') {
        runWindow(sid, args, prompt, cwd, title);
        return { sid, runner: how, pid: 0, terminal: '', log, note };
      }
      const t = runOrca(sid, args, prompt, cwd, title);
      updateSession(sid, { orca: t });
      return { sid, runner: how, pid: 0, terminal: t.handle, log, note };
    } catch (err) {
      if (runner === how) {
        const all = readJson(paths.sessions, {});
        delete all[sid];
        writeJson(paths.sessions, all);
        throw err;
      }
      note = `${runnerLabel(how)} could not open a terminal (${err.message}); started headless instead.`;
      how = 'headless';
      updateSession(sid, { runner: how, headless: true });
    }
  }
  const pid = runClaude(sid, ['-p', '--session-id', sid, ...claudeArgs(opts)], prompt, cwd);
  setPid(sid, pid);
  return { sid, runner: how, pid, terminal: '', log, note };
}

function cmdSpawn(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['stay', ...RUNNERS]);
  if (!flags.role || !words.length) throw new Error('spawn needs --role <role> and a task.');
  const runner = runnerFlag(flags);
  const r = spawnMember(leadSid, { role: flags.role, model: flags.model, stay: flags.stay, task: words.join(' '), group: flags.group, runner });
  const where = r.runner === 'orca' ? `in a visible Orca terminal (${r.terminal})` : r.runner === 'window' ? 'in a new terminal window' : `headless (pid ${r.pid || '?'}). Log: ${r.log}`;
  return `${r.note ? `${r.note}\n` : ''}Spawned ${flags.role}${flags.group ? ` in ${flags.group}` : ''}: ${r.sid} ${where}\nIts cards come to you as [Team report].`;
}

function setPid(sid, pid) {
  const sessions = readJson(paths.sessions, {});
  if (!sessions[sid]) return;
  sessions[sid].pid = pid;
  writeJson(paths.sessions, sessions);
}

// A member of this lead by full id, id prefix or role (the most recently active one wins).
function findMember(sessions, leadSid, key) {
  const members = Object.values(sessions).filter((s) => s.kind === 'member' && s.lead === leadSid);
  const k = String(key || '').toLowerCase();
  const byId = members.filter((s) => s.session_id === key || (k.length >= 4 && s.session_id.toLowerCase().startsWith(k)));
  const list = byId.length ? byId : members.filter((s) => String(s.role || '').toLowerCase() === k);
  list.sort((a, b) => Number(lib.isEnded(a)) - Number(lib.isEnded(b)) || String(b.last_seen).localeCompare(String(a.last_seen)));
  return list[0] || null;
}

function cmdSend(leadSid, argv) {
  const [target, ...rest] = argv;
  const text = rest.join(' ').trim();
  if (!target || !text) throw new Error('send needs a member (session id or role) and the text.');
  const { sessions } = context(leadSid);
  const m = findMember(sessions, leadSid, target);
  if (!m) throw new Error(`no member "${target}" of this lead. See: list`);
  const sid = m.session_id;
  if (m.runner === 'orca') return sendOrca(leadSid, m, text);
  if (m.runner === 'window' && lib.isEnded(m)) return resumeWindow(m, text);
  const running = m.headless && alive(m.pid);
  if (lib.waitPid(sid) || running || !m.headless) {
    lib.deliver(sid, { type: 'order', from: leadSid, text: text.slice(0, 8000) });
    const how = lib.waitPid(sid) ? 'it is waiting and wakes up now' : running ? 'it gets it when its current turn ends' : 'it gets it on its next turn';
    return `Queued for ${m.role} (${sid.slice(0, 8)}): ${how}.`;
  }
  // Headless member that has finished: resume it with the same options.
  const opts = m.spawn || {};
  const pid = runClaude(sid, ['-p', '--resume', sid, ...claudeArgs(opts)], `[Lead instruction]\n${text}`, opts.cwd || m.cwd || process.cwd());
  const all = readJson(paths.sessions, {});
  if (all[sid]) {
    Object.assign(all[sid], { pid, state: 'working', last_seen: new Date().toISOString() });
    delete all[sid].ended;
    writeJson(paths.sessions, all);
  }
  return `Resumed ${m.role} (${sid.slice(0, 8)}, pid ${pid || '?'}). Log: ${paths.log(sid).replace(/\\/g, '/')}`;
}

// An instruction to a member running in an Orca terminal:
// - terminal open and the member waiting or mid-turn: into its inbox (wait command or Stop hook hands it over)
// - terminal open and the member idle at its prompt: typed into the terminal (one line, so Enter submits it whole)
// - session ended or terminal closed: resumed in a new Orca terminal (headless if Orca is not running)
function sendOrca(leadSid, m, text) {
  const sid = m.session_id;
  const open = !lib.isEnded(m) && orca.writable(m.orca?.handle);
  if (open && (lib.waitPid(sid) || m.state === 'working')) {
    lib.deliver(sid, { type: 'order', from: leadSid, text: text.slice(0, 8000) });
    return `Queued for ${m.role} (${sid.slice(0, 8)}): ${lib.waitPid(sid) ? 'it is waiting and wakes up now' : 'it gets it when its current turn ends'}.`;
  }
  const now = new Date().toISOString();
  if (open) {
    orca.sendText(m.orca.handle, `[Lead instruction] ${text.replace(/\s*\r?\n\s*/g, ' ').trim()}`);
    updateSession(sid, { state: 'working', last_seen: now });
    return `Typed into ${m.role}'s Orca terminal (${sid.slice(0, 8)}, ${m.orca.handle}).`;
  }
  const opts = m.spawn || {};
  const cwd = opts.cwd || m.cwd || process.cwd();
  const prompt = `[Lead instruction]\n${text}`;
  if (orca.available()) {
    try {
      const t = runOrca(sid, ['--resume', sid, ...claudeArgs(opts)], prompt, cwd, `${m.role}${m.group ? ` · ${m.group}` : ''}`);
      updateSession(sid, { orca: t, state: 'working', last_seen: now }, ['ended', 'end_reason']);
      return `Resumed ${m.role} (${sid.slice(0, 8)}) in a new Orca terminal (${t.handle}).`;
    } catch { /* fall back to headless */ }
  }
  const pid = runClaude(sid, ['-p', '--resume', sid, ...claudeArgs(opts)], prompt, cwd);
  updateSession(sid, { pid, runner: 'headless', headless: true, state: 'working', last_seen: now }, ['ended', 'end_reason']);
  return `Resumed ${m.role} (${sid.slice(0, 8)}, pid ${pid || '?'}) headless: Orca is not available. Log: ${slash(paths.log(sid))}`;
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
      runWindow(sid, ['--resume', sid, ...claudeArgs(opts)], prompt, cwd, `${m.role}${m.group ? ` · ${m.group}` : ''}`);
      updateSession(sid, { state: 'working', last_seen: now }, ['ended', 'end_reason']);
      return `Resumed ${m.role} (${sid.slice(0, 8)}) in a new terminal window.`;
    } catch (err) { why = err.message; }
  }
  const pid = runClaude(sid, ['-p', '--resume', sid, ...claudeArgs(opts)], prompt, cwd);
  updateSession(sid, { pid, runner: 'headless', headless: true, state: 'working', last_seen: now }, ['ended', 'end_reason']);
  return `Resumed ${m.role} (${sid.slice(0, 8)}, pid ${pid || '?'}) headless: no terminal window (${why}). Log: ${slash(paths.log(sid))}`;
}

function cmdList(leadSid) {
  const { sessions } = context(leadSid);
  const members = Object.values(sessions).filter((s) => s.kind === 'member' && s.lead === leadSid);
  if (!members.length) return 'No members yet. Start one with: spawn --role <role> "<task>"';
  // Members that died without their SessionEnd hook (e.g. Orca terminal closed by hand) are marked ended.
  const gone = new Set(lib.markGone(members.filter((s) => lib.memberGone(s, orca.terminalOpen)).map((s) => s.session_id)));
  for (const s of members) if (gone.has(s.session_id)) Object.assign(s, { state: 'ended', ended: new Date().toISOString(), end_reason: 'gone' });
  return members.map((s) => {
    const waiting = lib.waitPid(s.session_id);
    const state = lib.isEnded(s) ? 'ended' : s.headless && s.pid && !alive(s.pid) && !waiting ? 'finished' : s.state || 'idle';
    let pending = 0;
    try { pending = fs.readdirSync(paths.inbox(s.session_id)).filter((f) => f.endsWith('.json')).length; } catch {}
    const last = s.last_title ? ` | last: ${s.last_status} "${s.last_title}"` : '';
    return `${s.session_id}  ${s.role}${s.group ? ` [${s.group}]` : ''}  ${state}${waiting ? ' (waiting)' : ''}${pending ? ` ${pending} queued` : ''}${s.headless ? ' headless' : s.runner === 'orca' || s.runner === 'window' ? ` ${s.runner}` : ''}${s.stay ? ' stay' : ''}${last}`;
  }).join('\n');
}

// Stop a member of this lead: close its Orca terminal, stop its wait command, Claude process and headless run,
// and mark it ended (end_reason 'stopped'). Used by `team.js end` and the dashboard (POST /api/team/end).
// Returns { sid, role, done: [what was stopped] }.
function endMember(leadSid, key) {
  const { sessions } = context(leadSid);
  const m = findMember(sessions, leadSid, key);
  if (!m) throw new Error(`no member "${key}" of this lead. See: list`);
  const sid = m.session_id;
  const done = [];
  if (m.runner === 'orca' && m.orca?.handle) {
    try { orca.closeTerminal(m.orca.handle); done.push(`closed its Orca terminal (${m.orca.handle})`); } catch (err) { done.push(`could not close its Orca terminal: ${err.message}`); }
  }
  const wp = lib.waitPid(sid);
  if (wp && lib.killPid(wp)) done.push('stopped its wait command');
  if (Number(m.claude_pid) > 0 && lib.killClaude(Number(m.claude_pid))) done.push(`stopped Claude (pid ${m.claude_pid})`);
  if (m.headless && Number(m.pid) > 0 && alive(Number(m.pid)) && lib.killPid(Number(m.pid))) done.push(`stopped the headless run (pid ${m.pid})`);
  const now = new Date().toISOString();
  updateSession(sid, { state: 'ended', ended: now, end_reason: 'stopped', last_seen: now });
  return { sid, role: m.role, done };
}

function cmdEnd(leadSid, argv) {
  if (!argv[0]) throw new Error('end needs a member (session id or role).');
  const r = endMember(leadSid, argv.join(' '));
  return `Ended ${r.role} (${r.sid.slice(0, 8)})${r.done.length ? `: ${r.done.join('; ')}` : ' (nothing was running)'}. Its cards stay; send resumes it.`;
}

function findCard(id) {
  const files = lib.cardFiles().slice().reverse();
  for (const f of files) {
    const rows = lib.readJsonl(f);
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id === id) return rows[i];
  }
  return null;
}

function cmdShow(_leadSid, argv) {
  const id = argv[0];
  if (!id) throw new Error('show needs a card id.');
  const c = findCard(id);
  if (!c) throw new Error(`no card ${id}`);
  const lines = [`${c.status}: ${c.title}`, `${c.session_name} (${c.session_id}) · ${c.branch || ''} · ${c.ts}`];
  for (const x of c.summary || []) lines.push(`- ${x}`);
  for (const x of c.review || []) lines.push(`check: ${x}`);
  if (c.details) lines.push('', c.details);
  return lines.join('\n');
}

function cmdHandoff(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['spawn', ...RUNNERS]);
  if (!words[0]) throw new Error('handoff needs the path of your handoff doc.');
  const runner = runnerFlag(flags);
  const { lead, project, projects } = context(leadSid);
  // A runner flag implies --spawn. Check it before anything is written.
  const picked = flags.spawn || runner ? pickRunner(runner, configuredRunner(project, 'lead')) : null;
  const doc = path.resolve(words.join(' ')).replace(/\\/g, '/');
  if (!fs.existsSync(doc)) throw new Error(`handoff doc not found: ${doc}`);
  const tokens = lib.estimateTokens(fs.readFileSync(doc, 'utf8'));
  if (lib.HANDOFF_MAX_TOKENS && tokens > lib.HANDOFF_MAX_TOKENS) throw new Error(`handoff doc is too long: about ${tokens} tokens (limit ${lib.HANDOFF_MAX_TOKENS}). Shorten it to the current state only (open items, members and tasks, changed decisions, next steps); move finished work to the plan/commits and fixed rules to the team's lead-rules.md. Then run handoff again.`);
  const own = ownTeam(project, leadSid);
  // This command runs under the lead's own Claude process: remember its pid so the takeover can stop it.
  const claudePid = lib.recordClaudePid(leadSid, process.ppid);
  own.team.handoff = { from: leadSid, doc, ts: new Date().toISOString() };
  const rules = lib.existingLeadRules(own.team, own.name);
  if (!rules) process.stderr.write(`team.js handoff: warning: ${lib.leadRulesPath(own.team, own.name)} does not exist (it is created with the team); the new lead is not told to read it.\n`);
  writeJson(paths.projects, projects);
  const prompt = `[ddash lead-handoff from=${leadSid} doc=${tagValue(doc)}] Read only this handoff doc${rules ? ` and the team rules ${rules}` : ''} (not older handoff docs), then take over as team lead. Start the wait command from your instructions.`;
  const stop = claudePid ? `this session (Claude pid ${claudePid}) is stopped` : 'this session is told to stop (its Claude process was not found)';
  if (picked) {
    const sid = crypto.randomUUID();
    const opts = spawnOptions(project, flags);
    const cwd = lead.cwd || process.cwd();
    const args = ['--session-id', sid, ...claudeArgs(opts)];
    let note = picked.note ? `${picked.note}\n` : '';
    if (picked.how !== 'headless') {
      // Interactive (no -p) in a visible terminal; Orca at the worktree root like members.
      try {
        if (picked.how === 'window') {
          runWindow(sid, args, prompt, cwd, `lead ${own.name}`);
          return `${note}Started the new lead in a new terminal window: ${sid}. When it registers, ${stop}.`;
        }
        const t = runOrca(sid, args, prompt, orca.worktreeRoot(cwd), `lead ${own.name}`);
        return `${note}Started the new lead in a visible Orca terminal (${t.handle}): ${sid}. When it registers, ${stop}.`;
      } catch (err) {
        if (runner === picked.how) throw err;
        note += `${runnerLabel(picked.how)} could not open a terminal (${err.message}); started headless instead.\n`;
      }
    }
    const pid = runClaude(sid, ['-p', ...args], prompt, cwd);
    return `${note}Started the new lead headless: ${sid} (pid ${pid || '?'}). When it registers, ${stop}. Log: ${paths.log(sid).replace(/\\/g, '/')}`;
  }
  return `Handoff ready. Start the new lead (a terminal, Orca, or --spawn with this project's runner_lead: ${configuredRunner(project, 'lead')}) with this first prompt:\n${prompt}\nWhen it registers, the members of team ${own.name} move to it and ${stop}.`;
}

// group create|rename|delete|list|prune. Shared by the dashboard (POST /api/groups) through groupAction.
// Works on the caller's own team only.
function groupAction(leadSid, action, { name, newName, purge } = {}) {
  const { lead, project } = context(leadSid);
  const key = lead.project_key;
  const t = lib.teamOfLead(project, leadSid);
  if (!t) throw new Error('groups need team mode with you as a team lead.');
  const done = (r) => { if (!r.ok) throw new Error(r.error); return { ...r, team: t.name }; };
  if (action === 'create') return done(lib.createGroup(key, t.name, name));
  if (action === 'rename') return done(lib.renameGroup(key, t.name, name, newName));
  if (action === 'delete') return done(lib.deleteGroup(key, t.name, name, { purge }));
  throw new Error(`unknown group action ${action}`);
}

function cmdGroup(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['purge']);
  const [action, name, next] = words;
  const { lead, project, sessions } = context(leadSid);
  const own = lib.teamOfLead(project, leadSid);
  const groups = own?.team.groups || {};
  if (action === 'list' || !action) {
    if (!own) throw new Error('groups need team mode with you as a team lead.');
    const names = Object.keys(groups).sort();
    if (!names.length) return `No groups in team ${own.name}. Create one with: group create <name>`;
    return names.map((n) => {
      const members = lib.teamMembers(sessions, lead.project_key, own.team).filter((s) => s.group === n);
      const live = members.filter((s) => !lib.isEnded(s)).length;
      const last = lib.latestHandoff(groups[n].dir);
      return `${n}  ${groups[n].dir}  members ${live}/${members.length}${last ? `  latest ${path.basename(last)}` : ''}`;
    }).join('\n');
  }
  if (action === 'prune') {
    if (!own) throw new Error('groups need team mode with you as a team lead.');
    const names = name ? [name] : Object.keys(groups);
    if (name && !lib.own(groups, name)) throw new Error(`no group ${name}`);
    const removed = names.flatMap((n) => lib.pruneGroup(groups[n]));
    return removed.length ? `Removed ${removed.length} file(s):\n${removed.join('\n')}\nCommit the docs when ready.` : 'Nothing to prune.';
  }
  if (!name) throw new Error(`group ${action} needs a group name.`);
  if (action === 'create') {
    const r = groupAction(leadSid, 'create', { name });
    return `Created group ${name}: ${r.dir}\nFill in ${r.dir}/brief.md (scope, key files, rules, current state); members get it before their task.`;
  }
  if (action === 'rename') {
    if (!next) throw new Error('group rename needs the new name.');
    const r = groupAction(leadSid, 'rename', { name, newName: next });
    return `Renamed ${name} to ${next} (${r.moved}): ${r.dir}`;
  }
  if (action === 'delete') {
    const r = groupAction(leadSid, 'delete', { name, purge: flags.purge });
    return `Deleted group ${name}; its members are unassigned. Folder: ${r.folder || 'none'}.`;
  }
  throw new Error(`unknown group command ${action}`);
}

// A member reserves the next handoff file of its own group; a lead names one of its team's groups.
function cmdNextHandoff(sid, argv) {
  const { sessions, project } = context(sid);
  const me = sessions[sid];
  const t = lib.teamOfSession(me, project);
  if (!t) throw new Error('next-handoff is for team leads and members.');
  const name = lib.teamOfLead(project, sid) ? argv[0] : me.group;
  if (!name) throw new Error(lib.teamOfLead(project, sid) ? 'next-handoff needs a group name.' : 'you are in no group; report to your lead instead.');
  const g = lib.own(t.team.groups, name);
  if (!g) throw new Error(`no group ${name} in team ${t.name}`);
  return lib.reserveHandoff(g.dir, `# ${name} handoff

`);
}

const COMMANDS = { spawn: cmdSpawn, send: cmdSend, list: cmdList, end: cmdEnd, show: cmdShow, handoff: cmdHandoff, group: cmdGroup, 'next-handoff': cmdNextHandoff };

function main(argv) {
  const [leadArg, cmd, ...rest] = argv;
  const run = COMMANDS[cmd];
  if (!leadArg || !run) return { code: 1, out: usage() };
  try {
    return { code: 0, out: run(safeId(leadArg), rest) };
  } catch (err) {
    return { code: 1, out: `team.js ${cmd}: ${err.message}` };
  }
}

module.exports = { main, spawnMember, endMember, groupAction, parseArgs, findMember, claudeArgs, spawnOptions, claudeCommand, quoteCmd, pickRunner, configuredRunner, RUNNERS };

// Run directly, or through the fixed bin path (which requires this file).
const viaBin = String(require.main?.filename || '').toLowerCase() === path.resolve(paths.teamBin).toLowerCase();
if (require.main === module || viaBin) {
  const { code, out } = main(process.argv.slice(2));
  console.log(out);
  process.exitCode = code;
}
