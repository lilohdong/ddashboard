// The page's only mutable state: per-viewer UI state (localStorage, best effort) and the last server state.
// Render modules read it as arguments; only main.mjs and actions.mjs change it.
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('ddash.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ddash.' + k, JSON.stringify(v)); } catch {} },
};

export const emptySpawnDraft = () => ({ role: '', model: '', stay: false, task: '' });
export const emptyState = () => ({ sessions: {}, cards: [], replies: [], last_by_session: {}, archived_count: 0 });

export function initialUi() {
  return {
    lang: 'en',
    scope: store.get('scope', { kind: 'all' }), // { kind: 'all' | 'project' | 'session', id }
    filter: store.get('filter', 'all'),
    showEnded: store.get('showEnded', false),
    showReports: store.get('showReports', false), // team mode: also show member reports (dimmed)
    spawnFor: null, // "<lead sid>|<group>" whose "+ member" form is open
    groupDel: null, // { project, team, name } whose delete confirmation is open
    spawnDraft: emptySpawnDraft(),
    drafts: {},
    // Search / archive view. results is null while not searching (or while the first search is loading).
    query: '',
    keyFilter: null, // { key, project_key } while showing one task key's history (exact match, that project only)
    archivedView: false,
    results: null,
    searchError: '',
    searchSeq: 0,
    searchTimer: 0,
    overrides: {}, // card_id -> archived, applied optimistically until the server catches up
    openDetails: new Set(), // card ids whose Details section is expanded
    openFolds: new Set(), // card ids whose earlier progress cards are expanded
  };
}

export const ui = initialUi();
export const model = { state: emptyState() };

export const searching = (u) => Boolean(u.query) || Boolean(u.keyFilter) || u.archivedView;
