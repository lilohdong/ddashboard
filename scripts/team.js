#!/usr/bin/env node
// Team commands for a team lead (run through the fixed path BOARD_DIR/bin/team.js).
//   node team.js <lead sid> spawn --role <role> [--group <g>] [--model <m>] [--stay] "<task>"
//       start a headless member (claude -p) in the background; log: BOARD_DIR/logs/<sid>.log
//       With --group it gets the group's brief and latest handoff before its task.
//   node team.js <lead sid> send <sid|role> "<text>"
//       instruction to a member: into its inbox if it is waiting or still running, else resume it (claude -p --resume)
//   node team.js <lead sid> list                 members: role, state, waiting, last card
//   node team.js <lead sid> show <card-id>       a card in full (long report details)
//   node team.js <lead sid> handoff <doc> [--spawn] [--model <m>]
//       prepare a lead handoff; prints the first prompt for the new lead (--spawn starts it headless)
//   node team.js <lead sid> group create <g> | rename <g> <new> | delete <g> [--purge] | list | prune [<g>]
//       groups keep shared memory in docs/groups/<g>/ of the lead's worktree (brief.md, handoff-NNN.md, notes/).
//       Nothing is committed; the lead commits the docs.
// Headless permissions come from projects.json[<project>].spawn = { permission_mode, allowed_tools },
// default: acceptEdits + Bash(git *), Bash(node *), Bash(npm *). DDASH_CLAUDE_BIN overrides the claude command.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const lib = require('./lib');

const { paths, readJson, writeJson, ensureDir, safeId, alive, DEFAULT_SPAWN } = lib;

function usage() {
  return `Usage: node team.js <lead session id> <command>
  spawn --role <role> [--group <g>] [--model <m>] [--stay] "<task>"
  send <sid|role> "<text>"
  list
  show <card-id>
  handoff <doc-path> [--spawn] [--model <m>]
  group create <g> | rename <g> <new> | delete <g> [--purge] | list | prune [<g>]`;
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
  const projects = readJson(paths.projects, {});
  const project = projects[lead.project_key];
  if (!project) throw new Error('this project is not connected to the dashboard.');
  return { sessions, projects, lead, project };
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

// Start a headless member of this lead. Used by `team.js spawn` and the dashboard (POST /api/team/spawn).
// Returns { sid, pid, log }.
function spawnMember(leadSid, { role, model, stay, task, group } = {}) {
  role = String(role || '').trim().slice(0, 40);
  task = String(task || '').trim();
  group = group ? String(group).trim() : '';
  if (!role || !task) throw new Error('spawn needs a role and a task.');
  const { lead, project } = context(leadSid);
  const g = group ? project.groups?.[group] : null;
  if (group && !g) throw new Error(`no group ${group}. Create it with: group create ${group}`);
  if (g) lib.pruneGroup(g);
  const sid = crypto.randomUUID();
  const flags = { role, model: model ? String(model).trim() : undefined, stay: Boolean(stay) };
  const opts = spawnOptions(project, flags);
  const cwd = lead.cwd || process.cwd();
  const prompt = `[ddash role=${tagValue(flags.role)} lead=${leadSid} stay=${flags.stay ? 1 : 0}${group ? ` group=${group}` : ''}] ${task}`;

  // Pre-register so the member shows up at once; its first-prompt hook completes the registration.
  const sessions = readJson(paths.sessions, {});
  const now = new Date().toISOString();
  sessions[sid] = {
    session_id: sid, name: flags.role, cwd, branch: lead.branch || '', project: lead.project, project_key: lead.project_key,
    state: 'working', started: now, last_seen: now, pending: true,
    kind: 'member', role: flags.role, lead: leadSid, stay: Boolean(flags.stay), headless: true,
    spawn: { ...opts, cwd }, log: paths.log(sid),
  };
  if (group) sessions[sid].group = group;
  writeJson(paths.sessions, sessions);
  const pid = runClaude(sid, ['-p', '--session-id', sid, ...claudeArgs(opts)], prompt, cwd);
  setPid(sid, pid);
  return { sid, pid, log: paths.log(sid).replace(/\\/g, '/') };
}

function cmdSpawn(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['stay']);
  if (!flags.role || !words.length) throw new Error('spawn needs --role <role> and a task.');
  const r = spawnMember(leadSid, { role: flags.role, model: flags.model, stay: flags.stay, task: words.join(' '), group: flags.group });
  return `Spawned ${flags.role}${flags.group ? ` in ${flags.group}` : ''}: ${r.sid} (pid ${r.pid || '?'}). Log: ${r.log}\nIts cards come to you as [Team report].`;
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

function cmdList(leadSid) {
  const { sessions } = context(leadSid);
  const members = Object.values(sessions).filter((s) => s.kind === 'member' && s.lead === leadSid);
  if (!members.length) return 'No members yet. Start one with: spawn --role <role> "<task>"';
  return members.map((s) => {
    const waiting = lib.waitPid(s.session_id);
    const state = lib.isEnded(s) ? 'ended' : s.headless && s.pid && !alive(s.pid) && !waiting ? 'finished' : s.state || 'idle';
    let pending = 0;
    try { pending = fs.readdirSync(paths.inbox(s.session_id)).filter((f) => f.endsWith('.json')).length; } catch {}
    const last = s.last_title ? ` | last: ${s.last_status} "${s.last_title}"` : '';
    return `${s.session_id}  ${s.role}${s.group ? ` [${s.group}]` : ''}  ${state}${waiting ? ' (waiting)' : ''}${pending ? ` ${pending} queued` : ''}${s.headless ? ' headless' : ''}${s.stay ? ' stay' : ''}${last}`;
  }).join('\n');
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
  const { flags, words } = parseArgs(argv, ['spawn']);
  if (!words[0]) throw new Error('handoff needs the path of your handoff doc.');
  const doc = path.resolve(words.join(' ')).replace(/\\/g, '/');
  if (!fs.existsSync(doc)) throw new Error(`handoff doc not found: ${doc}`);
  const { lead, project, projects } = context(leadSid);
  if (project.lead !== leadSid) throw new Error('you are not the team lead of this project.');
  // This command runs under the lead's own Claude process: remember its pid so the takeover can stop it.
  const claudePid = lib.recordClaudePid(leadSid, process.ppid);
  project.handoff = { from: leadSid, doc, ts: new Date().toISOString() };
  writeJson(paths.projects, projects);
  const prompt = `[ddash lead-handoff from=${leadSid} doc=${tagValue(doc)}] Read the handoff doc and take over as team lead. Start the wait command from your instructions.`;
  const stop = claudePid ? `this session (Claude pid ${claudePid}) is stopped` : 'this session is told to stop (its Claude process was not found)';
  if (flags.spawn) {
    const sid = crypto.randomUUID();
    const opts = spawnOptions(project, flags);
    const pid = runClaude(sid, ['-p', '--session-id', sid, ...claudeArgs(opts)], prompt, lead.cwd || process.cwd());
    return `Started the new lead headless: ${sid} (pid ${pid || '?'}). When it registers, ${stop}. Log: ${paths.log(sid).replace(/\\/g, '/')}`;
  }
  return `Handoff ready. Start the new lead (terminal, Orca, or headless with --spawn) with this first prompt:\n${prompt}\nWhen it registers, the members move to it and ${stop}.`;
}

// group create|rename|delete|list|prune. Shared by the dashboard (POST /api/groups) through groupAction.
function groupAction(leadSid, action, { name, newName, purge } = {}) {
  const { lead, project } = context(leadSid);
  const key = lead.project_key;
  if (project.mode !== 'team' || project.lead !== leadSid) throw new Error('groups need team mode with you as the lead.');
  const done = (r) => { if (!r.ok) throw new Error(r.error); return r; };
  if (action === 'create') return done(lib.createGroup(key, name, lead.cwd || process.cwd()));
  if (action === 'rename') return done(lib.renameGroup(key, name, newName));
  if (action === 'delete') return done(lib.deleteGroup(key, name, { purge }));
  throw new Error(`unknown group action ${action}`);
}

function cmdGroup(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['purge']);
  const [action, name, next] = words;
  const { lead, project, sessions } = context(leadSid);
  const groups = project.groups || {};
  if (action === 'list' || !action) {
    const names = Object.keys(groups).sort();
    if (!names.length) return 'No groups. Create one with: group create <name>';
    return names.map((n) => {
      const members = Object.values(sessions).filter((s) => s.project_key === lead.project_key && s.kind === 'member' && s.group === n);
      const live = members.filter((s) => !lib.isEnded(s)).length;
      const last = lib.latestHandoff(groups[n].dir);
      return `${n}  ${groups[n].dir}  members ${live}/${members.length}${last ? `  latest ${path.basename(last)}` : ''}`;
    }).join('\n');
  }
  if (action === 'prune') {
    const names = name ? [name] : Object.keys(groups);
    if (name && !groups[name]) throw new Error(`no group ${name}`);
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

const COMMANDS = { spawn: cmdSpawn, send: cmdSend, list: cmdList, show: cmdShow, handoff: cmdHandoff, group: cmdGroup };

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

module.exports = { main, spawnMember, groupAction, parseArgs, findMember, claudeArgs, spawnOptions };

// Run directly, or through the fixed bin path (which requires this file).
const viaBin = String(require.main?.filename || '').toLowerCase() === path.resolve(paths.teamBin).toLowerCase();
if (require.main === module || viaBin) {
  const { code, out } = main(process.argv.slice(2));
  console.log(out);
  process.exitCode = code;
}
