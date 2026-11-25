// Lead context limit, relative to where the lead started (plan M-1c). Pure: the transcript, model names and the
// team command path come from the caller (app/lead-context.js).
//   baseline   = the lead's first measured context (first assistant message in its transcript: system prompt,
//                tools, skills, first prompt). Unknown (no transcript) → the absolute cap below.
//   handoff at = baseline + work budget, cut to 80% of the model context window (a lead that starts near
//                the cap is told soon; one that starts above it at once).
// DDASH_LEAD_CONTEXT_LIMIT, when set, is an absolute point that replaces baseline + budget (still cut to 80%).
const config = require('../core/config');
const { leadContextText } = require('./rules');

const LEAD_WORK_BUDGET = config.get('DDASH_LEAD_WORK_BUDGET');
const LEAD_CONTEXT_LIMIT = config.get('DDASH_LEAD_CONTEXT_LIMIT'); // 0: relative
const CONTEXT_WINDOW = config.get('DDASH_CONTEXT_WINDOW'); // 0: detect (200k, 1M for [1m] models)
const HANDOFF_MAX_TOKENS = config.get('DDASH_HANDOFF_MAX_TOKENS'); // 0: no cap
const DEFAULT_WINDOW = 200000;
const LARGE_WINDOW = 1000000;
const WINDOW_CAP = 0.8;
const BASELINE_WARN = 0.5;
const ONE_M = /\[1m\]/i;

// Model context window: DDASH_CONTEXT_WINDOW when set; 1M when a model name says [1m]; else the largest
// window stored for the session (200k at least), so a compacted 1M session never falls back to 200k.
// A context above the window means the window is larger (1M).
function contextWindow({ models = [], stored = 0, seen = 0 } = {}) {
  if (CONTEXT_WINDOW) return CONTEXT_WINDOW;
  if (models.some((m) => ONE_M.test(String(m || '')))) return LARGE_WINDOW;
  const w = Math.max(DEFAULT_WINDOW, Number(stored) || 0);
  return Number(seen) > w ? LARGE_WINDOW : w;
}

// The handoff point of a lead: { baseline, window, at, budget, big }. baseline 0 = unknown (absolute cap).
function leadLimit(baseline, window) {
  const b = Number(baseline) || 0;
  const w = Number(window) || CONTEXT_WINDOW || DEFAULT_WINDOW;
  const cap = Math.floor(w * WINDOW_CAP);
  const wanted = LEAD_CONTEXT_LIMIT || (b ? b + LEAD_WORK_BUDGET : cap);
  const at = Math.min(wanted, cap);
  return { baseline: b, window: w, at, budget: Math.max(0, at - b), big: b > w * BASELINE_WARN };
}

// Token estimate for a text, on the high side: ASCII ~3.5 chars per token; other characters
// (Korean, CJK, symbols) count 1.5 tokens each.
function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text || '')) {
    if (ch.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3.5 + other * 1.5);
}

// Forget a session's lead context state (it becomes or stops being a lead).
function clearLeadContext(s) {
  if (!s) return;
  for (const k of ['lead_baseline', 'lead_baseline_unknown', 'lead_handoff_at', 'context_handoff_told']) delete s[k];
}

// Once per lead session (the caller checks the role): the handoff notice when its last turn's context is past
// its handoff point ('' otherwise). Works on s; the caller saves it.
// io: firstContext() → baseline from the transcript, models() → model names, teamBin() → team command path.
function leadContextCheck(s, io) {
  const ctx = Number(s.last_context) || 0;
  if (!ctx) return '';
  if (s.lead_baseline === undefined) {
    const first = io.firstContext();
    s.lead_baseline = first;
    if (!first) s.lead_baseline_unknown = true;
  }
  s.context_window = contextWindow({ models: io.models(), stored: s.context_window, seen: Math.max(ctx, Number(s.lead_baseline) || 0) });
  const lim = leadLimit(s.lead_baseline, s.context_window);
  s.lead_handoff_at = lim.at;
  if (s.context_handoff_told || ctx < lim.at) return '';
  s.context_handoff_told = true;
  return leadContextText(s.session_id, ctx, lim, io.teamBin());
}

module.exports = {
  LEAD_WORK_BUDGET, LEAD_CONTEXT_LIMIT, CONTEXT_WINDOW, HANDOFF_MAX_TOKENS,
  contextWindow, leadLimit, estimateTokens, clearLeadContext, leadContextCheck,
};
