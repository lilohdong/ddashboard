// The main column: status filters, scope title, mode bar, reports pill and cards. Pure: returns each part.
import { STATUS_KEYS, esc, statusName } from './format.mjs';
import { teams, repliedIds, answered, inScope, viewCards } from './select.mjs';
import { modeBarHtml, emptyText } from './render-search.mjs';
import { cardsHtml } from './render-cards.mjs';

export function renderMain(state, ui, t) {
  const { scope, filter, keyFilter } = ui;
  const all = viewCards(state, ui);
  const replied = repliedIds(state);
  const scoped = (all || []).filter((c) => keyFilter || inScope(state, ui, c)) // a key's history spans sessions
    .map((c) => ({ ...c, answered: answered(c, replied) }));
  const label = keyFilter ? `#${keyFilter.key}` : ui.query;
  const counts = {};
  for (const c of scoped) if (!c.answered) counts[c.status] = (counts[c.status] || 0) + 1;
  const filters = [['all', t('all'), scoped.length], ...STATUS_KEYS.map((k) => [k, statusName(k, t), counts[k] || 0])]
    .map(([k, v, n]) => `<button class="${filter === k ? 'on' : ''}" data-f="${k}">${esc(v)} ${n}</button>`).join('');

  const s = scope.kind === 'session' ? state.sessions[scope.id] : null;
  const scopeName = scope.kind === 'all' ? t('all') : scope.kind === 'project' ? scope.id : s ? `${s.project} / ${s.name}` : t('scope.session');
  const title = ui.archivedView ? t('scope.archived', { scope: scopeName }) : scopeName;

  const list = scoped.filter((c) => filter === 'all' || (c.status === filter && !c.answered));
  const mode = modeBarHtml(state, ui, t, { all, label, n: list.length });
  const reports = {
    hidden: !Object.values(teams(state)).some((x) => x.mode === 'team'),
    on: ui.showReports,
    text: ui.showReports ? t('reports.shown') : t('reports.hidden'),
  };
  const cards = cardsHtml(list, emptyText(ui, t, { all, label }), state, ui, t);
  return { filters, title, mode, reports, cards };
}
