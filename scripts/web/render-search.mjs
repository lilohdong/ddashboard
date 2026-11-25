// The bar above the cards (search status, or the project's runner pickers) and the empty-view text. Pure.
import { esc } from './format.mjs';
import { teams } from './select.mjs';
import { searching } from './ui-state.mjs';

// all: the view's cards (null while the first search loads); label: the query or "#key"; n: cards shown.
export function modeBarHtml(state, ui, t, { all, label, n }) {
  let mode = '';
  if (searching(ui)) {
    const where = ui.archivedView ? t('search.inArchived') : t('search.inAll');
    const status = ui.searchError ? t('search.unavailable') : !all ? t('search.searching')
      : label ? t('search.results', { q: label, where, n }) : t('search.count', { where, n });
    mode = `<span>${esc(status)}</span>
      ${label ? `<button data-clear-search>${esc(t('search.clear'))}</button>` : ''}
      ${ui.archivedView ? `<button data-archived>${esc(t('search.back'))}</button>` : ''}`;
  }
  // Project scope: how its new leads and members start (projects.json spawn.runner_lead / runner_member).
  const tp = ui.scope.kind === 'project' && !searching(ui) ? teams(state)[ui.scope.id] : null;
  if (tp) {
    const runnerSel = (k, lbl) => `<label class="runner">${esc(t(lbl))} <select class="mode-sel" data-runner="${k}" data-project="${esc(ui.scope.id)}" title="${esc(t('runner.title'))}">${['headless', 'orca', 'window'].map((v) => `<option value="${v}"${tp[k] === v ? ' selected' : ''}>${esc(t(`runner.${v}`))}</option>`).join('')}</select></label>`;
    mode = runnerSel('runner_lead', 'runner.lead') + runnerSel('runner_member', 'runner.member');
  }
  return mode;
}

export function emptyText(ui, t, { all, label }) {
  return searching(ui) ? (all ? (label ? t('empty.noMatch') : t('empty.noArchived')) : '') : t('empty.none');
}
