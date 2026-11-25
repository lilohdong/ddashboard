// The lead context notice with its inputs: the transcript's first context, model names (SessionStart, Claude
// settings, ANTHROPIC_MODEL) and the team command path. The maths is in domain/lead-context.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require('../core/fsx');
const models = require('../store/models');
const { leadContextCheck } = require('../domain/lead-context');
const { teamRole } = require('../domain/team');
const { ensureTeamBin } = require('./bins');

// Model names from Claude settings (user, project, local) and ANTHROPIC_MODEL.
function settingsModels(cwd) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [path.join(home, 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return [process.env.ANTHROPIC_MODEL, ...files.map((f) => readJson(f, {})?.model)].filter(Boolean);
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

// Once per lead session: the handoff notice when its last turn's context is past its handoff point ('' otherwise).
// opts: transcript (path, for the baseline), models (model names seen this turn), cwd (Claude settings).
// Works on the given objects; the caller saves the session.
function leadContextNotice(s, p, opts = {}) {
  if (!s || teamRole(s, p) !== 'lead') return '';
  return leadContextCheck(s, {
    firstContext: () => firstContext(opts.transcript),
    models: () => [...(opts.models || []), models.known(s.session_id), ...settingsModels(opts.cwd || s.cwd)],
    teamBin: () => ensureTeamBin().replace(/\\/g, '/'),
  });
}

module.exports = { leadContextNotice, firstContext, settingsModels, rememberModel: models.remember };
