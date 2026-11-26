// Pure selectors over the server state and the UI state.
import { URGENT, num } from './format.mjs';
import { searching } from './ui-state.mjs';

export const teams = (state) => state.teams || {};
// A member of a live lead stays listed under it even when its own run has ended.
export const underLead = (s) => s.team === 'member' && !s.lead_missing;
export const staleMin = (state) => num(state.stale_min) || 60;
export const stale = (state, s) => !s.last_seen || Date.now() - new Date(s.last_seen) > staleMin(state) * 60000;

// A card's effective status: its lifecycle outcome (wip folded into a newer card, stopped), else its own status.
export const outcome = (c) => c.outcome || c.status;

// A "Needs review" or "Blocked" card counts as answered once you have replied to it.
export const repliedIds = (state) => new Set(state.replies.map((r) => r.card_id));
export const answered = (c, replied) => URGENT.has(outcome(c)) && replied.has(c.id);

// A session needs you when its latest card's outcome is "needs review" or "blocked".
// last_by_session covers archived and older cards too; fall back to cards for 0.1.0 servers.
export function urgentBySession(state, ui) {
  let last = state.last_by_session;
  if (!last) {
    last = {};
    for (const c of state.cards) last[c.session_id] = c;
  }
  const replied = repliedIds(state);
  const out = {};
  for (const [sid, c] of Object.entries(last)) {
    // Archived cards and ended sessions no longer need you.
    const archived = c.id in ui.overrides ? ui.overrides[c.id] : c.archived;
    // Member reports go to their lead, so they don't need you either.
    if (archived || c.via_lead || state.sessions[sid]?.view === 'ended') continue;
    if (URGENT.has(outcome(c)) && !answered(c, replied)) out[sid] = 1;
  }
  return out;
}

export function inScope(state, ui, c) {
  const { scope } = ui;
  if (scope.kind === 'session') return c.session_id === scope.id;
  if (scope.kind === 'project') return (state.sessions[c.session_id]?.project || c.project) === scope.id;
  return true;
}

// Cards for the current view, newest first (null while the first search is loading).
export function viewCards(state, ui) {
  if (searching(ui)) {
    if (!ui.results) return null;
    return ui.results
      .map((c) => (c.id in ui.overrides ? { ...c, archived: ui.overrides[c.id] } : c))
      .filter((c) => !ui.archivedView || c.archived);
  }
  return state.cards.filter((c) => ui.overrides[c.id] !== true).slice().reverse();
}

// Query string of /api/search for the current search view.
export function searchParams(ui) {
  const params = new URLSearchParams({ q: ui.query, archived: ui.archivedView ? 'only' : 'include', limit: '100' });
  if (ui.keyFilter) { params.set('key', ui.keyFilter.key); params.set('project_key', ui.keyFilter.project_key); }
  return params;
}
