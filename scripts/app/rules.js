// Instructions a session gets (texts in domain/rules.js): for its place in its team, stamped with the versions
// they were given for (project mode, card language, text version), again once when one of them changes, and a
// member's start text (its group's brief first).
const { URL } = require('../core/paths');
const sessionsStore = require('../store/sessions');
const { deliver } = require('../store/inbox');
const rules = require('../domain/rules');
const { own, teamRole, teamOfLead, teamOfSession } = require('../domain/team');
const { ensureWaitBin, ensureTeamBin } = require('./bins');
const { readSettings } = require('./settings');
const { readProjects } = require('./teams');
const { setGroupFields } = require('./groups');
const { BRIEF_MAX_CHARS, groupContext } = require('./team-files');

const slash = (p) => p.replace(/\\/g, '/');

// What the rules texts need. The command paths are written only when a text uses them.
const rulesCtx = () => ({
  url: URL,
  lang: readSettings().lang,
  get waitBin() { return slash(ensureWaitBin()); },
  get teamBin() { return slash(ensureTeamBin()); },
});

const rulesText = (sid) => rules.soloText(sid, rulesCtx());

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

module.exports = { rulesCtx, rulesText, placeOf, rulesFor, rulesVersions, injectRules, rulesUpdate, pendingRules, memberStart };
