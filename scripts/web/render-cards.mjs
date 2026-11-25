// One card and the card list. Pure: (state, ui, t) -> html. Card rendering lives only here
// (track A adds folded / stopped cards in this module).
import { esc, time, statusName } from './format.mjs';

export function cardHtml(c, byCard, state, ui, t) {
  const sess = state.sessions[c.session_id];
  const open = sess && sess.view !== 'ended';
  const details = typeof c.details === 'string' && c.details.trim() ? c.details : '';
  const leadName = c.via_lead ? state.sessions[c.via_lead]?.name || t('tag.lead') : '';
  const replyBox = c.via_lead
    ? `<div class="closed">${esc(t('card.reportClosed', { name: leadName }))}</div>`
    : open ? `<form data-sid="${esc(c.session_id)}" data-id="${esc(c.id)}" data-title="${esc(c.title)}">
        <textarea data-card="${esc(c.id)}" placeholder="${esc(t('card.replyPlaceholder'))}" title="${esc(t('card.sendTitle'))}">${esc(ui.drafts[c.id] || '')}</textarea>
        <button>${esc(t('card.send'))}</button>
      </form>` : `<div class="closed">${esc(t('card.closed'))}</div>`;
  return `
    <article class="card${c.via_lead ? ' report' : ''}" data-id="${esc(c.id)}">
      <div class="card-head">
        <span class="badge s-${esc(c.status)}${c.answered ? ' answered' : ''}">${esc(statusName(c.status, t))}</span>${c.answered ? `<span class="badge replied">${esc(t('card.replied'))}</span>` : ''}
        ${c.archived ? `<span class="badge archived">${esc(t('card.archived'))}</span>` : ''}
        ${c.via_lead ? `<span class="badge report">${esc(t('card.reportTo', { name: leadName }))}</span>` : ''}
        ${c.lead_missing ? `<span class="badge warn" title="${esc(t('card.leadMissingTitle'))}">${esc(t('card.leadMissing'))}</span>` : ''}
        ${c.key ? `<button class="badge key" data-key="${esc(c.key)}" data-key-project="${esc(c.project_key || '')}" title="${esc(t('card.keyTitle'))}">#${esc(c.key)}${c.key_prev ? ` · ${esc(t('card.keyPrev', { n: c.key_prev }))}` : ''}</button>` : ''}
        <span class="title">${esc(c.title)}</span>
        ${c.archived
          ? `<button class="card-act" data-unarchive="${esc(c.id)}" title="${esc(t('card.unarchiveTitle'))}">${esc(t('card.unarchive'))}</button>`
          : `<button class="card-act" data-archive="${esc(c.id)}" title="${esc(t('card.archiveTitle'))}">${esc(t('card.archive'))}</button>`}
      </div>
      <div class="meta">${esc(sess?.project || c.project || '')} · ${esc(c.session_name)} · ${esc(c.branch)} · ${time(c.ts, ui.lang)}${c.diffstat ? ' · ' + esc(c.diffstat) : ''}</div>
      ${c.summary?.length ? `<ul>${c.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${c.review?.length ? `<div class="review"><b>${esc(t('card.check'))}</b><ul>${c.review.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${details ? `<details data-details="${esc(c.id)}"${ui.openDetails.has(c.id) ? ' open' : ''}><summary>${esc(t('card.details'))}</summary><div class="details-body">${esc(details)}</div></details>` : ''}
      <div class="replies">${(byCard[c.id] || []).map((r) => `<div class="reply"><b>${esc(t('card.you'))}</b> ${esc(r.text)} · ${time(r.ts, ui.lang)}</div>`).join('')}</div>
      ${replyBox}
    </article>`;
}

// The list for the cards box: every card, or the empty-view message ('' while the first search loads).
export function cardsHtml(list, empty, state, ui, t) {
  const byCard = {};
  for (const r of state.replies) (byCard[r.card_id] ||= []).push(r);
  return list.length ? list.map((c) => cardHtml(c, byCard, state, ui, t)).join('') : empty ? `<div class="empty">${esc(empty)}</div>` : '';
}
