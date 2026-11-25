// DOM writes. BUG-004: an unchanged poll leaves the DOM (selection, scroll) alone, and a changed card list keeps
// the scroll positions.
export { esc } from './format.mjs';

// Replace an element's HTML only when it changed.
export function setHtml(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

// The card list, keeping scroll positions when it does change: each open Details body keeps its scrollTop,
// and the card at the top of the window stays where it was (new cards are added above it).
export function renderCards(box, html) {
  if (box._html === html) return;
  const scrolls = {};
  box.querySelectorAll('details[data-details] .details-body').forEach((el) => {
    if (el.scrollTop) scrolls[el.parentElement.dataset.details] = el.scrollTop;
  });
  const anchor = [...box.querySelectorAll('article[data-id]')].find((a) => a.getBoundingClientRect().bottom > 0);
  const anchorId = anchor?.dataset.id;
  const anchorTop = anchor?.getBoundingClientRect().top;
  setHtml(box, html);
  for (const [id, top] of Object.entries(scrolls)) {
    const body = box.querySelector(`details[data-details="${CSS.escape(id)}"] .details-body`);
    if (body) body.scrollTop = top;
  }
  if (anchorId && window.scrollY > 0) {
    const again = box.querySelector(`article[data-id="${CSS.escape(anchorId)}"]`);
    if (again) window.scrollBy(0, again.getBoundingClientRect().top - anchorTop);
  }
}

// Reply drafts typed into the cards, kept across re-renders.
export function saveDrafts(drafts) {
  document.querySelectorAll('textarea[data-card]').forEach((t) => (drafts[t.dataset.card] = t.value));
}
