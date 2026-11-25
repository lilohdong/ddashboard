// Every text the plugin injects into a Claude session, and the one place that knows which version of the
// instructions a session was given (rules_ver = project mode, lang_ver = card language, text_ver = this text).
// Pure: callers pass what the texts need in c = { url, waitBin, teamBin, lang } (waitBin/teamBin may be getters,
// read only by the texts that use them). Model-facing text stays English on purpose (docs/architecture.md §3.6).
const config = require('../core/config');

// Version of the instruction text itself. Bump it when soloText/leadText/memberText/outsideText change, so
// running sessions get the new text once (test/rules.test.js fails until you do). 1: card "key".
const RULES_TEXT_VER = 1;

const LANG_NAMES = { en: 'English', ko: 'Korean', 'zh-CN': 'Simplified Chinese' };
// "written in ..." for cards: the chosen language, or the user's language when none is set.
const cardLanguage = (lang) => LANG_NAMES[lang] || "the user's language";

// Instructions are re-read every turn, so keep them short.
// One model call per reply instead of two: handle the output and restart the waiter together.
const RESTART = 'When it exits, read its output and start it again in the same response, as parallel tool calls.';

const handoffMax = () => config.get('DDASH_HANDOFF_MAX_TOKENS');

function soloText(sid, c) {
  const wait = `node "${c.waitBin}" ${sid}`;
  return `[ddashboard] The user follows your progress on a dashboard (${c.url}). Session ID: ${sid}
- Only on turns with a result the user should know about, end your reply with this block (JSON, at most 3 summary lines, written in ${cardLanguage(c.lang)}):
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the user should check"],"details":"optional, markdown, longer content"}
\`\`\`
- While connected, keep terminal replies to a line or two and put the content in the card (long content in "details"). When a card revises your previous card (e.g. an updated plan), add "replaces":"last".
- For an ongoing task, add "key":"task-name" (a-z, 0-9, -, _; max 60): a newer card with the same key in this project replaces the older ones, even from another session (e.g. after a lead handoff).
- To receive dashboard replies, run this in the background now: ${wait}
  Its output is the user's reply (an instruction). ${RESTART}
`;
}

function leadText(sid, name, c) {
  const t = `node "${c.teamBin}" ${sid}`;
  return `${soloText(sid, c)}- Team mode: you are the lead of team "${name || 'lead'}" (other teams in this repo have their own leads and members). The user talks only to you. Member cards reach you as [Team report] through the same wait command; post to the dashboard only what the user must know, decide or review. Do small tasks yourself, spawn members for big ones.
- Team commands (T = ${t}): T spawn --role <role> [--group <g>] [--model <m>] [--stay] [--headless] "<task>" (visible in Orca when it runs) | T send <sid|role> "<text>" | T list | T show <card-id> | T handoff <doc-path>
- Handoff: when told, write a new doc with only the current state (under ${handoffMax()} tokens; never copy older handoff docs). Fixed rules for every lead of this team go in docs/teams/${name || 'lead'}/lead-rules.md.
- Groups (shared memory in docs/teams/${name || 'lead'}/<g>/ of your worktree: brief.md, handoff-NNN.md, notes/; you commit it): T group create|rename|delete [--purge]|list|prune <g> [<new>]
`;
}

// s: the member's session (role, group, stay); g: its group ({ dir }) or null.
function memberText(sid, s, g, c) {
  const wait = `node "${c.waitBin}" ${sid}`;
  const tail = s.stay
    ? `- To receive instructions, run this in the background now: ${wait}
  ${RESTART}`
    : `- Don't start a wait command. Finish the task and stop; your lead resumes you if more is needed.`;
  const group = g ? `- Group "${s.group}" folder: ${g.dir}. When you finish (or near your context limit), run node "${c.teamBin}" ${sid} next-handoff: it creates the next handoff-NNN.md there and prints its path. Write into that file: what was done, open items, where things are. Update brief.md if its facts changed. Don't commit; the lead does.
` : '';
  const notes = g ? `${g.dir}/notes/` : 'a file';
  return `[ddashboard] You are a team member. Role: ${s.role || 'member'}${s.group ? `, group: ${s.group}` : ''}. Session ID: ${sid}. Your lead assigns the work; messages from the lead arrive as [Lead instruction].
- End each turn that finishes, blocks or changes your task with this block (JSON, at most 3 short summary lines${c.lang ? `, written in ${cardLanguage(c.lang)}` : ''}). It goes to your lead, not the user:
\`\`\`card
{"status":"done|review|blocked|wip","title":"one-line title","summary":["..."],"review":["what the lead should check"],"details":"optional and short"}
\`\`\`
- Keep terminal replies to a line or two. A report is a summary of at most 3 lines: put the evidence in ${notes} and give the path. If blocked, use "blocked" and write the question in the summary.
${group}${tail}
`;
}

const outsideText = (sid, teams, c) => `${soloText(sid, c)}- This project is in team mode (teams: ${[...teams].sort().join(', ')}). You are outside every team, so your cards still go straight to the dashboard.\n`;

// Instructions for a session's place in its project. place = { role: solo|lead|member|outside, team (lead's team
// name), teams (all team names, for outside), group (member's group record or null) }.
function rulesFor(sid, s, place, c) {
  if (place.role === 'lead') return leadText(sid, place.team, c);
  if (place.role === 'member') return memberText(sid, s, place.group || null, c);
  if (place.role === 'outside') return outsideText(sid, place.teams || [], c);
  return soloText(sid, c);
}

// --- Version stamping: the single place that reads and writes rules_ver / lang_ver / text_ver ---

// v = { mode: project mode_ver, lang: settings.ver }. The fields a session gets when it is given the rules.
const stamp = (v) => ({ rules_ver: Number(v.mode) || 0, lang_ver: Number(v.lang) || 0, text_ver: RULES_TEXT_VER });

// Why a session needs its instructions again: 'mode' | 'lang' | 'text', or '' when they are current.
function needsUpdate(s, v) {
  if (!s) return '';
  if ((Number(s.rules_ver) || 0) !== (Number(v.mode) || 0)) return 'mode';
  if ((Number(s.lang_ver) || 0) !== (Number(v.lang) || 0)) return 'lang';
  if ((Number(s.text_ver) || 0) !== RULES_TEXT_VER) return 'text';
  return '';
}

// The notice that carries updated instructions (why = needsUpdate's answer; mode = the project's mode).
function updateText(why, { mode, lang }, rules) {
  const head = why === 'mode' ? `The project's dashboard mode changed (now ${mode || 'solo'})`
    : why === 'lang' ? `The card language changed (now ${cardLanguage(lang)})`
    : 'The dashboard instructions were updated';
  return `[ddashboard] ${head}. Updated instructions:\n${rules}`;
}

// --- Other injected notices ---

const replacedText = (s) => `[ddashboard] This session was replaced as team lead by ${s.replaced_by} (handoff). Stop working now: no more tool calls or file changes. Start a new session for other work.`;

// lim = { baseline, at, window } (lead-context maths); teamBin: the team command path.
function leadContextText(sid, ctx, lim, teamBin) {
  const where = lim.baseline
    ? `has grown by ${ctx - lim.baseline} since you started as team lead (start ${lim.baseline}, handoff at ${lim.at})`
    : `is past the team lead handoff point (${lim.at}, 80% of the ${lim.window}-token context window)`;
  const max = handoffMax();
  const rules = `${max ? ` (under ${max} tokens)` : ''}`;
  return `[ddashboard] Your context (${ctx} tokens) ${where}. Finish the current step, then write a NEW handoff doc${rules} with only the current state: open items, members and their tasks, decisions changed since the last handoff, next steps. Do not copy or point to older handoff docs; finished work belongs in the plan, commits and CHANGELOG, and fixed rules in the team's lead-rules.md. Then run: node "${teamBin}" ${sid} handoff <doc-path>`;
}

// A group's memory for a new member: the (already capped) brief and the latest handoff.
const groupContextText = (name, briefPath, body, last) => `[ddashboard] Group "${name}" brief (${briefPath}):
${body.trim() || '(empty)'}
Latest handoff: ${last ? `${last} (read it before you start)` : 'none yet'}
`;

module.exports = {
  RULES_TEXT_VER, LANG_NAMES, cardLanguage, RESTART,
  soloText, leadText, memberText, outsideText, rulesFor,
  stamp, needsUpdate, updateText,
  replacedText, leadContextText, groupContextText,
};
