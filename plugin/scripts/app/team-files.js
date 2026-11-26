// Files a team keeps in its worktree (not on the board): docs/teams/<team>/lead-rules.md and the group folders
// docs/teams/<team>/<group>/ (brief.md, handoff-NNN.md, notes/). The lead commits them.
const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../core/fsx');
const { gitOrNull: gitIn } = require('../core/git');
const { groupSettings } = require('../domain/team');
const rules = require('../domain/rules');

const slash = (p) => p.replace(/\\/g, '/');

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

// --- Group folders ---

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

module.exports = {
  slash, worktreeRoot, teamDir, leadRulesPath, existingLeadRules, ensureLeadRules, BRIEF_MAX_CHARS, ensureGroupDir,
  moveDir, handoffs, latestHandoff, reserveHandoff, pruneGroup, groupContext,
};
