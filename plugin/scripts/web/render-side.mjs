// Sidebar: projects, teams, groups, sessions, usage. Pure: (state, ui, t) -> html.
import { VIEW_KEYS, esc, ago, shortId, num, fmtTok, fullTok, sumTok, usageTitle, viewName } from './format.mjs';
import { teams, underLead, staleMin, stale, urgentBySession } from './select.mjs';

function usageLine(state, s, t, lang) {
  if (!s.usage && s.last_context == null) return '';
  const warnAt = num(state.context_warn) || 150000;
  const ctx = num(s.last_context);
  const warn = ctx > warnAt;
  const u = s.usage || {};
  const title = usageTitle(u, [`${t('usage.context', { n: fullTok(ctx, lang) })}${warn ? t('usage.over', { n: fullTok(warnAt, lang) }) : ''}`, t('usage.total', { n: fullTok(sumTok(u), lang) }), ''], t, lang);
  return `<span class="usage" title="${esc(title)}"><span class="${warn ? 'warn' : ''}">ctx ${fmtTok(ctx)}</span> · ${fmtTok(sumTok(u))} tok</span>`;
}

function todayHtml(state, t, lang) {
  const day = state.usage_today;
  if (!day) return '';
  const all = state.usage_total || {};
  const title = usageTitle(day, [t('usage.todayAll'), ''], t, lang) + `\n\n${t('usage.allTime', { tokens: fullTok(sumTok(all), lang), turns: fullTok(all.turns, lang) })}`;
  return `<div class="today" title="${esc(title)}"><b>${esc(t('usage.today'))}</b>
    <div class="row"><span>${esc(t('usage.input'))}</span><span>${fmtTok(day.input)}</span></div>
    <div class="row"><span>${esc(t('usage.cacheRead'))}</span><span>${fmtTok(day.cache_read)}</span></div>
    <div class="row"><span>${esc(t('usage.output'))}</span><span>${fmtTok(day.output)}</span></div>
  </div>`;
}

// Sidebar order in team mode: project > team > its lead > groups > members, then everyone else.
// Rows: { thead } team headers, { s, depth } sessions, { ghead } group headers, { spawn } "+ member",
// { gtools } "+ group". Groups and "+ member" belong to one team; "unassigned" holds members without a (known) group.
export function teamOrder(list, cmp, tm) {
  const byLead = {};
  for (const s of list) if (underLead(s)) (byLead[s.lead] ||= []).push(s);
  const out = [];
  for (const team of Object.keys(tm.teams || {}).sort()) {
    const conf = tm.teams[team];
    const l = list.find((s) => s.session_id === conf.lead);
    out.push({ thead: team, lead: conf.lead });
    if (!l) continue; // lead hidden (ended) or forgotten
    const live = l.view !== 'ended';
    const members = (byLead[l.session_id] || []).sort(cmp);
    delete byLead[l.session_id];
    const groupNames = Object.keys(conf.groups || {}).sort();
    out.push({ s: l, depth: 0 });
    if (!groupNames.length) {
      for (const m of members) out.push({ s: m, depth: 1 });
      if (live) out.push({ spawn: l.session_id, group: '', depth: 1 });
      if (live) out.push({ gtools: team });
      continue;
    }
    for (const g of groupNames) {
      const ms = members.filter((m) => m.group === g);
      out.push({ ghead: g, team, count: ms.length, live });
      for (const m of ms) out.push({ s: m, depth: 2 });
      if (live) out.push({ spawn: l.session_id, group: g, depth: 2 });
    }
    const rest = members.filter((m) => !groupNames.includes(m.group));
    out.push({ ghead: '', team, count: rest.length, live });
    for (const m of rest) out.push({ s: m, depth: 2 });
    if (live) out.push({ spawn: l.session_id, group: '', depth: 2 });
    if (live) out.push({ gtools: team });
  }
  for (const ms of Object.values(byLead)) for (const m of ms.sort(cmp)) out.push({ s: m, depth: 1 });
  for (const s of list.filter((x) => x.team !== 'lead' && !underLead(x)).sort(cmp)) out.push({ s, depth: 0 });
  return out;
}

// Team header: its name and "remove team" (members of a removed team post to the dashboard themselves).
function teamHeadHtml(r, p, t) {
  return `<div class="thead"><span class="tname">${esc(t('team.label', { name: r.thead }))}</span><button class="sess-act" data-team-remove="${esc(r.thead)}" data-project="${esc(p)}" title="${esc(t('team.removeTitle'))}">${esc(t('team.remove'))}</button></div>`;
}

function groupHeadHtml(state, ui, r, p, t) {
  if (!r.ghead) return `<div class="ghead"><span class="gname unassigned">${esc(t('group.unassigned'))}</span><span>${r.count}</span></div>`;
  const acts = r.live ? `<button class="sess-act" data-group-rename="${esc(r.ghead)}" data-team="${esc(r.team)}" data-project="${esc(p)}" title="${esc(t('group.renameTitle'))}">${esc(t('group.rename'))}</button><button class="sess-act" data-group-del="${esc(r.ghead)}" data-team="${esc(r.team)}" data-project="${esc(p)}" title="${esc(t('group.deleteTitle'))}">${esc(t('group.delete'))}</button>` : '';
  const dir = teams(state)[p]?.teams?.[r.team]?.groups?.[r.ghead]?.dir || '';
  let html = `<div class="ghead" title="${esc(dir)}"><span class="gname">${esc(r.ghead)}</span><span>${r.count}</span>${acts}</div>`;
  const { groupDel } = ui;
  if (groupDel && groupDel.project === p && groupDel.team === r.team && groupDel.name === r.ghead) {
    html += `<div class="group-del">${esc(t('group.deleteAsk', { name: r.ghead, team: r.team }))}
      <label><input type="checkbox" data-group-purge> ${esc(t('group.purge'))}</label>
      <div class="row"><button class="danger" data-group-del-ok>${esc(t('btn.delete'))}</button><button data-group-del-cancel>${esc(t('btn.cancel'))}</button></div>
    </div>`;
  }
  return html;
}

// "+ member" under a live lead in team mode, or its form when open.
function spawnHtml(ui, lead, group, depth, t) {
  const id = `${lead}|${group}`;
  const cls = depth > 1 ? ' depth2' : '';
  if (ui.spawnFor !== id) return `<button class="nav side-act${cls}" data-spawn-for="${esc(id)}" title="${esc(group ? t('spawn.titleIn', { group }) : t('spawn.title'))}">${esc(t('spawn.button'))}</button>`;
  const d = ui.spawnDraft;
  return `<form class="spawn-form${cls}" data-spawn="${esc(lead)}" data-group="${esc(group)}">
    <input type="text" name="role" placeholder="${esc(t('spawn.role'))}" value="${esc(d.role)}" required>
    <input type="text" name="model" placeholder="${esc(t('spawn.model'))}" value="${esc(d.model)}">
    <label><input type="checkbox" name="stay"${d.stay ? ' checked' : ''}> ${esc(t('spawn.stay'))}</label>
    <textarea name="task" placeholder="${esc(t('spawn.task'))}" required>${esc(d.task)}</textarea>
    <div class="row"><button>${esc(t('spawn.submit'))}</button><button type="button" data-spawn-cancel>${esc(t('btn.cancel'))}</button></div>
  </form>`;
}

// Session row actions: remove an ended session, end a team member, or mark an idle, stale one as ended.
function sessAct(state, s, t) {
  if (s.view === 'ended') return `<button class="sess-act" data-forget="${esc(s.session_id)}" title="${esc(t('sess.forget'))}">×</button>`;
  if (s.team === 'member') return `<button class="sess-act" data-end-member="${esc(s.session_id)}" title="${esc(t('sess.endTitle'))}">${esc(t('sess.end'))}</button>`;
  if (s.view === 'idle' && stale(state, s)) return `<button class="sess-act" data-mark-ended="${esc(s.session_id)}" title="${esc(t('sess.markEndedTitle', { n: staleMin(state) }))}">${esc(t('sess.markEnded'))}</button>`;
  return '';
}

// The project's mode (solo, or how many teams), "+ team" with each live session that leads no team, and
// "solo" to remove every team. Teams are added, never replaced; one team is removed from its header.
function modeSelect(state, p, t) {
  const tm = teams(state)[p];
  if (!tm) return '';
  const leads = new Set(Object.values(tm.teams || {}).map((x) => x.lead));
  // Lead candidates: live sessions, newest first, labelled so same-named sessions can be told apart.
  // Sessions not seen for stale_min minutes go into a "stale" group.
  const live = Object.values(state.sessions).filter((s) => s.project === p && s.view !== 'ended' && !leads.has(s.session_id) && s.team !== 'member')
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  const n = Object.keys(tm.teams || {}).length;
  const opt = (v, label, selected = false) => `<option value="${esc(v)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const label = (s) => `${t('mode.addTeam')} · ${s.name} · ${shortId(s.session_id)} · ${ago(s.last_seen, t)}`;
  const fresh = live.filter((s) => !stale(state, s));
  const old = live.filter((s) => stale(state, s));
  let html = opt('', n ? t('mode.teams', { n }) : t('mode.solo'), true) + fresh.map((s) => opt(`team:${s.session_id}`, label(s))).join('');
  if (old.length) html += `<optgroup label="${esc(t('mode.stale', { n: staleMin(state) }))}">${old.map((s) => opt(`team:${s.session_id}`, label(s))).join('')}</optgroup>`;
  if (n) html += opt('solo', t('mode.soloAll'));
  return `<select class="mode-sel" data-mode-key="${esc(tm.key)}" data-project="${esc(p)}" title="${esc(t('mode.title'))}">${html}</select>`;
}

function sessTags(s, tm, t, lang) {
  if (tm?.mode !== 'team') return '';
  if (s.team === 'lead') {
    const limit = num(s.lead_handoff_at);
    let over = limit && num(s.last_context) >= limit ? ` <span class="tag warn" title="${esc(t('tag.handoffTitle', { n: fullTok(limit, lang), base: s.lead_baseline_unknown ? '?' : fullTok(num(s.lead_baseline), lang) }))}">${esc(t('tag.handoff'))}</span>` : '';
    if (s.baseline_big) over += ` <span class="tag warn" title="${esc(t('tag.bigStartTitle', { n: fullTok(num(s.lead_baseline), lang), w: fullTok(num(s.context_window), lang) }))}">${esc(t('tag.bigStart'))}</span>`;
    return ` <span class="tag lead" title="${esc(t('tag.leadTitle'))}">${esc(t('tag.lead'))}${s.team_name ? ` · ${esc(s.team_name)}` : ''}</span>${over}`;
  }
  if (s.team === 'member') return ` <span class="tag" title="${esc(t('tag.roleTitle'))}">${esc(s.role || t('tag.member'))}</span>${s.lead_missing ? ` <span class="tag warn" title="${esc(t('tag.leadMissingTitle'))}">${esc(t('tag.leadMissing'))}</span>` : ''}`;
  return ` <span class="tag" title="${esc(t('tag.outsideTitle'))}">${esc(t('tag.outside'))}</span>`;
}

export function renderSide(state, ui, t) {
  const { lang, scope, showEnded } = ui;
  const sessions = Object.values(state.sessions);
  const urgent = urgentBySession(state, ui);
  const shown = (s) => showEnded || s.view !== 'ended' || underLead(s);
  const ended = sessions.filter((s) => s.view === 'ended' && !underLead(s));
  const visible = sessions.filter(shown);

  const groups = {};
  for (const s of visible) (groups[s.project] ||= []).push(s);
  const order = { working: 0, waiting: 1, idle: 2, ended: 3 };
  const totalUrgent = Object.keys(urgent).length;

  const sel = (kind, id) => (scope.kind === kind && (kind === 'all' || scope.id === id) ? 'sel' : '');
  let html = `<div class="brand">DDashboard</div>
    <button class="nav ${sel('all')}" data-kind="all"><span class="grow">${esc(t('all'))}</span>${totalUrgent ? `<span class="count">${totalUrgent}</span>` : ''}</button>`;

  const names = Object.keys(groups).sort();
  if (!names.length) html += `<div class="side-empty">${t('side.empty')}</div>`;
  for (const p of names) {
    const cmp = (a, b) => order[a.view] - order[b.view] || String(a.name).localeCompare(String(b.name));
    const tm = teams(state)[p];
    const list = tm?.mode === 'team' ? teamOrder(groups[p], cmp, tm) : groups[p].sort(cmp).map((s) => ({ s, depth: 0 }));
    const sessRows = list.filter((r) => r.s);
    const pu = sessRows.filter((r) => urgent[r.s.session_id]).length;
    const nameCount = {};
    for (const { s } of sessRows) nameCount[s.name] = (nameCount[s.name] || 0) + 1;
    const endedHere = sessions.filter((s) => s.project === p && s.view === 'ended').length;
    html += `<div class="group">
      <div class="group-head">
        <button class="nav group-title ${sel('project', p)}" data-kind="project" data-id="${esc(p)}"><span class="grow">${esc(p)}</span>${pu ? `<span class="count">${pu}</span>` : ''}</button>
        ${modeSelect(state, p, t)}
      </div>
      ${list.map((r) => {
        if (r.thead != null) return teamHeadHtml(r, p, t);
        if (r.ghead != null) return groupHeadHtml(state, ui, r, p, t);
        if (r.spawn) return spawnHtml(ui, r.spawn, r.group, r.depth, t);
        if (r.gtools) return `<button class="nav side-act" data-group-add="${esc(p)}" data-team="${esc(r.gtools)}" title="${esc(t('group.addTitle', { team: r.gtools }))}">${esc(t('group.add'))}</button>`;
        const s = r.s;
        return `
        <div class="sess-row">
        <button class="nav sess${r.depth ? ' member' : ''}${r.depth > 1 ? ' depth2' : ''} ${sel('session', s.session_id)}" data-kind="session" data-id="${esc(s.session_id)}" title="${esc(s.cwd)}\n${esc(s.session_id)}">
          <span class="dot ${s.view}"></span>
          <span class="grow">
            <span class="sname">${esc(s.name)}${nameCount[s.name] > 1 ? ` <span class="sid">${shortId(s.session_id)}</span>` : ''}${sessTags(s, tm, t, lang)}${s.unresponsive ? ` <span class="tag warn" title="${esc(t('side.unresponsiveTitle', { n: staleMin(state) }))}">${esc(t('side.unresponsive'))}</span>` : ''}${urgent[s.session_id] ? ` <span class="count">${esc(t('side.needsYou'))}</span>` : ''}</span>
            <span class="sub">${esc(s.branch || '')} · ${esc(viewName(s.view, t))}${s.pending ? ` · ${esc(t('side.queued', { n: s.pending }))}` : ''}${s.view === 'ended' ? '' : ` · ${ago(s.last_seen, t)}`}</span>
            ${usageLine(state, s, t, lang)}
          </span>
        </button>${sessAct(state, s, t)}
        </div>`;
      }).join('')}
      ${endedHere ? `<button class="nav side-act flat" data-clear-ended="${esc(p)}" title="${esc(t('side.clearEndedTitle'))}">${esc(t('side.clearEnded', { n: endedHere }))}</button>` : ''}
    </div>`;
  }
  if (ended.length) html += `<button class="nav ended-toggle" data-toggle-ended>${esc(showEnded ? t('side.hideEnded') : t('side.showEnded', { n: ended.length }))}</button>`;
  html += `<button class="nav archive-link ${ui.archivedView ? 'sel' : ''}" data-archived><span class="grow">${esc(t('side.archived', { n: state.archived_count || 0 }))}</span></button>`;
  html += todayHtml(state, t, lang);
  html += `<div class="legend">${VIEW_KEYS.map((k) => `<span><span class="dot ${k}"></span>${esc(viewName(k, t))}</span>`).join('')}</div>`;
  return html;
}
