// First-prompt tags:
//   [ddash role=<role> lead=<lead sid> stay=0|1 group=<g>]  register a team member
//   [ddash lead-handoff from=<old lead sid> doc=<path>]      take over as team lead
// Values may be quoted ("..."). parseTag returns null when the prompt doesn't start with a tag.
const { GROUP_NAME } = require('./team');

// Same rule as core/paths safeId (domain/ does not use core/paths).
const safeId = (sid) => String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';

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

module.exports = { parseTag };
