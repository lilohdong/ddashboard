// Pure text helpers shared by the render modules (no DOM, importable from Node tests).
export const STATUS_KEYS = ['review', 'blocked', 'wip', 'done'];
export const VIEW_KEYS = ['working', 'waiting', 'idle', 'ended'];
export const URGENT = new Set(['review', 'blocked']);

export const statusName = (k, t) => (STATUS_KEYS.includes(k) ? t(`status.${k}`) : k);
export const viewName = (k, t) => t(`view.${k}`);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const time = (iso, lang) => new Date(iso).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const ago = (iso, t) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? t('ago.now') : m < 60 ? t('ago.m', { n: m }) : m < 1440 ? t('ago.h', { n: Math.round(m / 60) }) : t('ago.d', { n: Math.round(m / 1440) });
};
export const shortId = (sid) => String(sid).slice(0, 8);

// Token usage (recorded by the Stop hook, no model calls).
export const num = (v) => Number(v) || 0;
export const fmtTok = (v) => {
  const n = num(v);
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
};
export const fullTok = (v, lang) => num(v).toLocaleString(lang);
export const sumTok = (u) => num(u?.input) + num(u?.cache_read) + num(u?.cache_write) + num(u?.output);

export function usageTitle(u, extra, t, lang) {
  return [...extra,
    `${t('usage.input')}: ${fullTok(u.input, lang)}`,
    `${t('usage.cacheRead')}: ${fullTok(u.cache_read, lang)}`,
    `${t('usage.cacheWrite')}: ${fullTok(u.cache_write, lang)}`,
    `${t('usage.output')}: ${fullTok(u.output, lang)}`,
    `${t('usage.turns')}: ${fullTok(u.turns, lang)}`,
  ].join('\n');
}
