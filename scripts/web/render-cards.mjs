// One card and the card list. Pure: (state, ui, t) -> html. Card rendering lives only here.
import { esc, time, statusName, cardWho } from './format.mjs';
import { outcome } from './select.mjs';

// A card's displayed state, decided in this one place: the status badge and filter bucket, answered, whether it
// can take a reply, and its lifecycle (§4.2, computed by the server): a wip card folded into a newer card takes
// that card's outcome; an ended session's open wip card is 'stopped'.
export function cardView(c, state) {
  const sess = state.sessions[c.session_id];
  return {
    status: outcome(c), // badge s-<status>, its label, and the status filter
    answered: Boolean(c.answered), // urgent card you replied to (set by render-main)
    open: Boolean(sess && sess.view !== 'ended'), // its session can still take a reply
    stopped: Boolean(c.stopped),
    folded: Array.isArray(c.folded) ? c.folded : [], // earlier progress cards shown under this one, oldest first
    foldedInto: c.folded_into || '', // set on a folded card (search results)
  };
}

// The earlier progress cards folded under a card: a collapsed list (title, time, summary).
function foldsHtml(c, folded, ui, t) {
  if (!folded.length) return '';
  const items = folded.map((f) => `<div class="fold">
      <div class="fold-head"><span class="fold-title">${esc(f.title)}</span> <span class="meta">${time(f.ts, ui.lang)}</span></div>
      ${f.summary?.length ? `<ul>${f.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  return `<details class="folds" data-folds="${esc(c.id)}"${ui.openFolds?.has(c.id) ? ' open' : ''}><summary>${esc(t('card.folded', { n: folded.length }))}</summary><div class="fold-list">${items}</div></details>`;
}

// One card. Every per-card decision comes from cardView.
export function cardHtml(c, byCard, state, ui, t) {
  const sess = state.sessions[c.session_id];
  const v = cardView(c, state);
  const open = v.open;
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
        <span class="badge s-${esc(v.status)}${v.answered ? ' answered' : ''}"${v.stopped ? ` title="${esc(t('card.stoppedTitle'))}"` : ''}>${esc(statusName(v.status, t))}</span>${v.answered ? `<span class="badge replied">${esc(t('card.replied'))}</span>` : ''}
        ${v.foldedInto ? `<span class="badge folded" title="${esc(t('card.foldedIntoTitle'))}">${esc(t('card.foldedInto'))}</span>` : ''}
        ${c.archived ? `<span class="badge archived">${esc(t('card.archived'))}</span>` : ''}
        ${c.via_lead ? `<span class="badge report">${esc(t('card.reportTo', { name: leadName }))}</span>` : ''}
        ${c.lead_missing ? `<span class="badge warn" title="${esc(t('card.leadMissingTitle'))}">${esc(t('card.leadMissing'))}</span>` : ''}
        ${c.key ? `<button class="badge key" data-key="${esc(c.key)}" data-key-project="${esc(c.project_key || '')}" title="${esc(t('card.keyTitle'))}">#${esc(c.key)}${c.key_prev ? ` · ${esc(t('card.keyPrev', { n: c.key_prev }))}` : ''}</button>` : ''}
        <span class="title">${esc(c.title)}</span>
        ${c.archived
          ? `<button class="card-act" data-unarchive="${esc(c.id)}" title="${esc(t('card.unarchiveTitle'))}">${esc(t('card.unarchive'))}</button>`
          : `<button class="card-act" data-archive="${esc(c.id)}" title="${esc(t('card.archiveTitle'))}">${esc(t('card.archive'))}</button>`}
      </div>
      <div class="meta">${esc(cardWho(sess?.project || c.project || '', c.session_name, c.session_id, state.sessions))} · ${esc(c.branch)} · ${time(c.ts, ui.lang)}${c.diffstat ? ' · ' + esc(c.diffstat) : ''}</div>
      ${c.summary?.length ? `<ul>${c.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${c.review?.length ? `<div class="review"><b>${esc(t('card.check'))}</b><ul>${c.review.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${details ? `<details data-details="${esc(c.id)}"${ui.openDetails.has(c.id) ? ' open' : ''}><summary>${esc(t('card.details'))}</summary><div class="details-body">${esc(details)}</div></details>` : ''}
      ${foldsHtml(c, v.folded, ui, t)}
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
