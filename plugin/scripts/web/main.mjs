// Boot, language, rendering into the page, search, and the poll loop with its selection guards (BUG-004).
import { ui, model, store, searching } from './ui-state.mjs';
import { searchParams } from './select.mjs';
import { renderSide } from './render-side.mjs';
import { renderMain } from './render-main.mjs';
import { setHtml, renderCards, saveDrafts } from './dom.mjs';
import * as api from './api.mjs';
import { installActions } from './actions.mjs';

// --- Language: saved choice (settings.json) > browser language > English ---
const I18N = window.DDASH_I18N;
ui.lang = I18N.pickLang(null, navigator.language);
const t = (key, vars) => I18N.translate(ui.lang, key, vars);
const $ = (id) => document.getElementById(id);

// Text in the static markup (data-i18n-title / -placeholder / -aria) and the language picker.
function applyStatic() {
  document.documentElement.lang = ui.lang;
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  const sel = $('lang');
  sel.innerHTML = Object.entries(I18N.LANGS).map(([k, v]) => `<option value="${k}"${k === ui.lang ? ' selected' : ''}>${v}</option>`).join('');
}

const narrow = matchMedia('(max-width: 760px)');
const sideKey = () => (narrow.matches ? 'sideOpenNarrow' : 'sideOpen');
function applySide() {
  document.body.classList.toggle('side-closed', !store.get(sideKey(), !narrow.matches));
}
function toggleSide(open) {
  const next = open ?? document.body.classList.contains('side-closed');
  store.set(sideKey(), next);
  applySide();
}

function paintSide() {
  setHtml($('side'), renderSide(model.state, ui, t));
}

function paintMain() {
  saveDrafts(ui.drafts);
  const v = renderMain(model.state, ui, t);
  setHtml($('filters'), v.filters);
  $('scope').textContent = v.title;
  setHtml($('mode'), v.mode);
  const rep = $('reports');
  rep.hidden = v.reports.hidden;
  rep.classList.toggle('on', v.reports.on);
  rep.textContent = v.reports.text;
  renderCards($('cards'), v.cards);
}

function paint() { paintSide(); paintMain(); }

async function runSearch() {
  if (!searching(ui)) { ui.results = null; ui.searchError = ''; return; }
  const seq = ++ui.searchSeq;
  try {
    const { res, data } = await api.search(searchParams(ui));
    if (seq !== ui.searchSeq) return;
    if (!res.ok || !Array.isArray(data.cards)) throw new Error(data.error || res.status);
    ui.results = data.cards;
    ui.searchError = '';
  } catch {
    if (seq !== ui.searchSeq) return;
    ui.results = ui.results || [];
    ui.searchError = 'unavailable';
  }
}

async function load() {
  saveDrafts(ui.drafts);
  try {
    model.state = await api.getState(ui.showReports);
  } catch { return; }
  const next = I18N.pickLang(model.state.settings?.lang, navigator.language);
  if (next !== ui.lang) { ui.lang = next; applyStatic(); }
  if (ui.scope.kind === 'session' && !model.state.sessions[ui.scope.id]) ui.scope = { kind: 'all' };
  await runSearch();
  paint();
}

// Re-search now (new query or view), dropping results that belong to the old one.
async function refreshSearch() {
  clearTimeout(ui.searchTimer);
  ui.results = null;
  paint();
  await runSearch();
  paintMain();
}

installActions({ t, load, refreshSearch, paint, paintSide, paintMain, applyStatic, toggleSide, narrow });
$('toggle').addEventListener('click', () => toggleSide());
narrow.addEventListener('change', applySide);

applySide();
applyStatic();
load();
// Don't re-render while a reply is being typed, nor while text is being selected or dragged
// (a re-render would drop the selection); the skipped poll runs once the pointer is up / the selection is gone.
let pointerDown = false;
let pendingLoad = false;
const selecting = () => {
  const sel = getSelection();
  return Boolean(sel && !sel.isCollapsed && ['cards', 'side'].some((id) => $(id).contains(sel.anchorNode)));
};
const busy = () => pointerDown || selecting();
function runPending() {
  if (pendingLoad && !busy()) { pendingLoad = false; load(); }
}
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', () => { pointerDown = false; setTimeout(runPending, 0); }, true);
document.addEventListener('pointercancel', () => { pointerDown = false; runPending(); }, true);
document.addEventListener('selectionchange', runPending);
setInterval(() => {
  if (ui.spawnFor || ui.groupDel || document.activeElement?.matches('textarea, select, input')) return;
  if (busy()) { pendingLoad = true; return; }
  load();
}, 3000);
