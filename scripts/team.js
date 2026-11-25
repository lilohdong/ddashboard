#!/usr/bin/env node
// Team commands for a team lead (run through the fixed path BOARD_DIR/bin/team.js). A CLI only: it parses the
// arguments and prints; the work is done by app/members.js (shared with the dashboard server).
//   node team.js <lead sid> spawn --role <role> [--group <g>] [--model <m>] [--stay] [--headless|--orca|--window] "<task>"
//       start a member with the project's runner_member (projects.json spawn; default headless): headless (claude -p in
//       the background), orca (a visible interactive claude in an Orca terminal, see runners/orca.js) or window (a new
//       OS terminal window, see runners/window.js). A configured runner that cannot run here falls back to headless
//       (noted); a runner flag overrides the setting and is refused when it cannot run here.
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
const path = require('path');
const { paths, safeId } = require('./core/paths');
const members = require('./app/members');
const { claudeCommand, interactiveArgs, quoteCmd, claudeArgs } = require('./runners/claude-cmd');

const { RUNNERS } = members;

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

// The runner flag (--headless | --orca | --window) or undefined.
function runnerFlag(flags) {
  const set = RUNNERS.filter((r) => flags[r]);
  if (set.length > 1) throw new Error('use only one of --headless, --orca, --window.');
  return set[0];
}

function cmdSpawn(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['stay', ...RUNNERS]);
  if (!flags.role || !words.length) throw new Error('spawn needs --role <role> and a task.');
  const runner = runnerFlag(flags);
  const r = members.spawnMember(leadSid, { role: flags.role, model: flags.model, stay: flags.stay, task: words.join(' '), group: flags.group, runner });
  const where = r.runner === 'orca' ? `in a visible Orca terminal (${r.terminal})` : r.runner === 'window' ? 'in a new terminal window' : `headless (pid ${r.pid || '?'}). Log: ${r.log}`;
  return `${r.note ? `${r.note}\n` : ''}Spawned ${flags.role}${flags.group ? ` in ${flags.group}` : ''}: ${r.sid} ${where}\nIts cards come to you as [Team report].`;
}

const WAKE = {
  waiting: 'it is waiting and wakes up now',
  turn: 'it gets it when its current turn ends',
  window: 'it is idle in its terminal window and reads it only on its next turn. Nothing can type into that window: type something there yourself (or end it and send again to resume it)',
  next: 'it gets it on its next turn',
};

function cmdSend(leadSid, argv) {
  const [target, ...rest] = argv;
  const r = members.sendMember(leadSid, target, rest.join(' '));
  const who = `${r.role} (${r.sid.slice(0, 8)}`;
  if (r.action === 'queued') return `Queued for ${who}): ${WAKE[r.wake]}.`;
  if (r.action === 'typed') return `Typed into ${r.role}'s Orca terminal (${r.sid.slice(0, 8)}, ${r.handle}).`;
  if (r.runner === 'orca') return `Resumed ${who}) in a new Orca terminal (${r.handle}).`;
  if (r.runner === 'window') return `Resumed ${who}) in a new terminal window.`;
  if (r.why) return `Resumed ${who}, pid ${r.pid || '?'}) headless: ${r.why}. Log: ${r.log}`;
  return `Resumed ${who}, pid ${r.pid || '?'}). Log: ${r.log}`;
}

function cmdList(leadSid) {
  const rows = members.listMembers(leadSid);
  if (!rows.length) return 'No members yet. Start one with: spawn --role <role> "<task>"';
  return rows.map(({ s, state, waiting, pending }) => {
    const last = s.last_title ? ` | last: ${s.last_status} "${s.last_title}"` : '';
    return `${s.session_id}  ${s.role}${s.group ? ` [${s.group}]` : ''}  ${state}${waiting ? ' (waiting)' : ''}${pending ? ` ${pending} queued` : ''}${s.headless ? ' headless' : s.runner === 'orca' || s.runner === 'window' ? ` ${s.runner}` : ''}${s.stay ? ' stay' : ''}${last}`;
  }).join('\n');
}

function cmdEnd(leadSid, argv) {
  if (!argv[0]) throw new Error('end needs a member (session id or role).');
  const r = members.endMember(leadSid, argv.join(' '));
  if (r.already) return `${r.role} (${r.sid.slice(0, 8)}) is already ended${r.ended ? ` (${r.ended})` : ''}; nothing was stopped.`;
  return `Ended ${r.role} (${r.sid.slice(0, 8)})${r.done.length ? `: ${r.done.join('; ')}` : ' (nothing was running)'}. Its cards stay; send resumes it.`;
}

function cmdShow(_leadSid, argv) {
  const id = argv[0];
  if (!id) throw new Error('show needs a card id.');
  const c = members.findCard(id);
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
  const r = members.prepareHandoff(leadSid, words.join(' '), { spawn: flags.spawn, runner, model: flags.model, claudeStartPid: process.ppid });
  if (r.rulesMissing) process.stderr.write(`team.js handoff: warning: ${r.rulesMissing} does not exist (it is created with the team); the new lead is not told to read it.\n`);
  const s = r.started;
  if (!s) return `Handoff ready. Start the new lead (a terminal, Orca, or --spawn with this project's runner_lead: ${r.configured}) with this first prompt:\n${r.prompt}\nWhen it registers, the members of team ${r.team} move to it and ${r.stop}.`;
  if (s.runner === 'window') return `${s.note}Started the new lead in a new terminal window: ${s.sid}. When it registers, ${r.stop}.`;
  if (s.runner === 'orca') return `${s.note}Started the new lead in a visible Orca terminal (${s.handle}): ${s.sid}. When it registers, ${r.stop}.`;
  return `${s.note}Started the new lead headless: ${s.sid} (pid ${s.pid || '?'}). When it registers, ${r.stop}. Log: ${s.log}`;
}

function cmdGroup(leadSid, argv) {
  const { flags, words } = parseArgs(argv, ['purge']);
  const [action, name, next] = words;
  if (action === 'list' || !action) {
    const { team, rows } = members.listGroups(leadSid);
    if (!rows.length) return `No groups in team ${team}. Create one with: group create <name>`;
    return rows.map((g) => `${g.name}  ${g.dir}  members ${g.live}/${g.total}${g.latest ? `  latest ${path.basename(g.latest)}` : ''}`).join('\n');
  }
  if (action === 'prune') {
    const removed = members.pruneGroups(leadSid, name);
    return removed.length ? `Removed ${removed.length} file(s):\n${removed.join('\n')}\nCommit the docs when ready.` : 'Nothing to prune.';
  }
  if (!name) throw new Error(`group ${action} needs a group name.`);
  if (action === 'create') {
    const r = members.groupAction(leadSid, 'create', { name });
    return `Created group ${name}: ${r.dir}\nFill in ${r.dir}/brief.md (scope, key files, rules, current state); members get it before their task.`;
  }
  if (action === 'rename') {
    if (!next) throw new Error('group rename needs the new name.');
    const r = members.groupAction(leadSid, 'rename', { name, newName: next });
    return `Renamed ${name} to ${next} (${r.moved}): ${r.dir}`;
  }
  if (action === 'delete') {
    const r = members.groupAction(leadSid, 'delete', { name, purge: flags.purge });
    return `Deleted group ${name}; its members are unassigned. Folder: ${r.folder || 'none'}.`;
  }
  throw new Error(`unknown group command ${action}`);
}

const cmdNextHandoff = (sid, argv) => members.nextHandoff(sid, argv[0]);

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

// The use cases are re-exported for older callers and tests; new code requires app/members and runners/* directly.
const { spawnMember, endMember, groupAction, findMember, spawnOptions, pickRunner, configuredRunner } = members;
module.exports = { main, spawnMember, endMember, groupAction, parseArgs, findMember, claudeArgs, spawnOptions, claudeCommand, interactiveArgs, quoteCmd, pickRunner, configuredRunner, RUNNERS };

// Run directly, or through the fixed bin path (which requires this file).
const viaBin = String(require.main?.filename || '').toLowerCase() === path.resolve(paths.teamBin).toLowerCase();
if (require.main === module || viaBin) {
  const { code, out } = main(process.argv.slice(2));
  console.log(out);
  process.exitCode = code;
}
