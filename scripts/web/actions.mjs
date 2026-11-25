// Event delegation: clicks, forms, keys, pickers. Changes ui-state, calls the API, then re-renders or reloads
// through the functions main.mjs hands in.
import { ui, model, store, emptySpawnDraft } from './ui-state.mjs';
import { shortId } from './format.mjs';
import { teams } from './select.mjs';
import { post, postRaw } from './api.mjs';

export function installActions({ t, load, refreshSearch, paint, paintSide, paintMain, applyStatic, toggleSide, narrow }) {
  const qInput = document.getElementById('q');
  const sessions = () => model.state.sessions;

  async function setArchived(id, archived) {
    const { overrides } = ui;
    const had = id in overrides;
    const prev = overrides[id];
    const delta = archived ? 1 : -1;
    overrides[id] = archived;
    model.state.archived_count = Math.max(0, (model.state.archived_count || 0) + delta);
    paint();
    try {
      const res = await postRaw('/api/archive', { card_id: id, archived });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      if (had) overrides[id] = prev; else delete overrides[id];
      model.state.archived_count = Math.max(0, model.state.archived_count - delta);
      paint();
      alert(t(archived ? 'err.archive' : 'err.unarchive', { e: err.message }));
      return;
    }
    load();
  }

  qInput.addEventListener('input', () => {
    clearTimeout(ui.searchTimer);
    ui.searchTimer = setTimeout(() => {
      const next = qInput.value.trim();
      if (ui.keyFilter) { ui.keyFilter = null; ui.query = next; refreshSearch(); } // typing leaves the key history
      else if (next !== ui.query) { ui.query = next; refreshSearch(); }
    }, 300);
  });
  function clearSearch() {
    qInput.value = '';
    if (ui.query || ui.keyFilter) { ui.query = ''; ui.keyFilter = null; refreshSearch(); } else clearTimeout(ui.searchTimer);
  }

  // Sidebar actions; true = reload the state afterwards.
  async function sideAction(e) {
    const el = e.target;
    const forget = el.closest('[data-forget]')?.dataset.forget;
    if (forget) { await post('/api/sessions/forget', { session_id: forget }); return true; }
    const end = el.closest('[data-end-member]')?.dataset.endMember;
    if (end) {
      if (!confirm(t('sess.confirmEnd', { name: sessions()[end]?.role || sessions()[end]?.name || end, id: shortId(end) }))) return true;
      try { await post('/api/team/end', { session_id: end }); } catch (err) { alert(t('err.end', { e: err.message })); }
      return true;
    }
    const mark = el.closest('[data-mark-ended]')?.dataset.markEnded;
    if (mark) {
      if (!confirm(t('sess.confirmMarkEnded', { name: sessions()[mark]?.name || mark, id: shortId(mark) }))) return true;
      await post('/api/sessions/end', { session_id: mark });
      return true;
    }
    const clear = el.closest('[data-clear-ended]')?.dataset.clearEnded;
    if (clear) {
      if (!confirm(t('sess.confirmClearEnded', { project: clear }))) return true;
      await post('/api/sessions/forget', { project: clear, ended: true });
      return true;
    }
    const rm = el.closest('[data-team-remove]');
    if (rm) {
      if (!confirm(t('team.confirmRemove', { team: rm.dataset.teamRemove, project: rm.dataset.project }))) return false;
      await post('/api/mode', { project: rm.dataset.project, mode: 'solo', team: rm.dataset.teamRemove });
      return true;
    }
    const addEl = el.closest('[data-group-add]');
    if (addEl) {
      const name = prompt(t('group.newPrompt', { team: addEl.dataset.team }));
      if (!name) return false;
      await post('/api/groups', { project: addEl.dataset.groupAdd, team: addEl.dataset.team, action: 'create', name: name.trim() });
      return true;
    }
    const ren = el.closest('[data-group-rename]');
    if (ren) {
      const next = prompt(t('group.renamePrompt', { name: ren.dataset.groupRename }), ren.dataset.groupRename);
      if (!next || next.trim() === ren.dataset.groupRename) return false;
      await post('/api/groups', { project: ren.dataset.project, team: ren.dataset.team, action: 'rename', name: ren.dataset.groupRename, new_name: next.trim() });
      return true;
    }
    const del = el.closest('[data-group-del]');
    if (del) { ui.groupDel = { project: del.dataset.project, team: del.dataset.team, name: del.dataset.groupDel }; paintSide(); return false; }
    if (el.closest('[data-group-del-cancel]')) { ui.groupDel = null; paintSide(); return false; }
    if (el.closest('[data-group-del-ok]') && ui.groupDel) {
      const purge = Boolean(el.closest('.group-del')?.querySelector('[data-group-purge]')?.checked);
      const g = ui.groupDel;
      ui.groupDel = null;
      await post('/api/groups', { project: g.project, team: g.team, action: 'delete', name: g.name, purge });
      return true;
    }
    const spawn = el.closest('[data-spawn-for]')?.dataset.spawnFor;
    if (spawn) { ui.spawnFor = spawn; paintSide(); document.querySelector('.spawn-form input[name=role]')?.focus(); return false; }
    if (el.closest('[data-spawn-cancel]')) { ui.spawnFor = null; ui.spawnDraft = emptySpawnDraft(); paintSide(); return false; }
    return null;
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-forget], [data-end-member], [data-mark-ended], [data-clear-ended], [data-spawn-for], [data-spawn-cancel], [data-team-remove], [data-group-add], [data-group-rename], [data-group-del], [data-group-del-ok], [data-group-del-cancel]')) {
      try { if (await sideAction(e)) load(); } catch (err) { alert(t('err.generic', { e: err.message })); }
      return;
    }
    const arch = e.target.closest('[data-archive], [data-unarchive]');
    if (arch) {
      if (arch.dataset.archive) setArchived(arch.dataset.archive, true);
      else setArchived(arch.dataset.unarchive, false);
      return;
    }
    if (e.target.closest('[data-archived]')) {
      ui.archivedView = !ui.archivedView;
      refreshSearch();
      if (narrow.matches && ui.archivedView) toggleSide(false);
      return;
    }
    if (e.target.closest('[data-clear-search]')) { clearSearch(); return; }
    const keyTag = e.target.closest('[data-key]');
    if (keyTag) { // a key's whole history: active and archived cards with exactly this key in this project
      ui.keyFilter = { key: keyTag.dataset.key, project_key: keyTag.dataset.keyProject || '' };
      ui.query = '';
      qInput.value = `#${ui.keyFilter.key}`;
      ui.archivedView = false;
      refreshSearch();
      return;
    }
    if (e.target.closest('#reports')) { ui.showReports = !ui.showReports; store.set('showReports', ui.showReports); load(); return; }
    const nav = e.target.closest('[data-kind]');
    if (nav) {
      ui.scope = nav.dataset.kind === 'all' ? { kind: 'all' } : { kind: nav.dataset.kind, id: nav.dataset.id };
      store.set('scope', ui.scope);
      paint();
      if (narrow.matches) toggleSide(false); // on small screens, get out of the way after picking
      return;
    }
    if (e.target.closest('[data-toggle-ended]')) {
      ui.showEnded = !ui.showEnded; store.set('showEnded', ui.showEnded); paintSide();
      return;
    }
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f) { ui.filter = f; store.set('filter', ui.filter); paintMain(); }
  });

  // Keep Details sections open across re-renders. ("toggle" doesn't bubble, so listen in the capture phase.)
  document.addEventListener('toggle', (e) => {
    const id = e.target.dataset?.details;
    if (!id) return;
    if (e.target.open) ui.openDetails.add(id); else ui.openDetails.delete(id);
  }, true);

  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('textarea, input');
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.target === qInput && e.key === 'Escape') {
      e.preventDefault();
      if (qInput.value) clearSearch(); else qInput.blur();
    } else if (e.key === 'Enter' && e.ctrlKey && e.target.form) e.target.form.requestSubmit();
    else if (e.key === '/' && !typing && plain) { e.preventDefault(); qInput.focus(); qInput.select(); }
    else if (e.key === '[' && !typing && plain) toggleSide();
  });

  // Language picker: saved for the dashboard and for new cards (settings.json), applied at once.
  document.getElementById('lang').addEventListener('change', async (e) => {
    const prev = ui.lang;
    ui.lang = e.target.value;
    applyStatic(); paint();
    try {
      await post('/api/settings', { lang: ui.lang });
    } catch (err) {
      ui.lang = prev;
      applyStatic(); paint();
      alert(t('err.lang', { e: err.message }));
    }
  });

  // "+ team" adds a team led by the chosen session (its name is asked; a name in use is refused by the server).
  // "solo" removes every team of the project.
  const nextTeamName = (p) => { const used = teams(model.state)[p]?.teams || {}; for (let i = 1; ; i++) if (!used[`team${i}`]) return `team${i}`; };
  // Runner pickers (project scope): saved through the settings API.
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-runner]');
    if (!sel) return;
    try {
      await post('/api/settings', { project: sel.dataset.project, [sel.dataset.runner]: sel.value });
    } catch (err) { alert(t('err.runner', { e: err.message })); }
    load();
  });

  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-mode-key]');
    if (!sel || !sel.value) return;
    const [mode, lead] = sel.value.split(':');
    const body = { project: sel.dataset.modeKey, mode };
    if (mode === 'team') {
      const who = sessions()[lead]?.name || lead;
      const team = prompt(t('mode.confirmTeam', { project: sel.dataset.project, who }), nextTeamName(sel.dataset.project));
      if (!team || !team.trim()) { sel.blur(); paintSide(); return; }
      Object.assign(body, { lead, team: team.trim() });
    } else if (!confirm(t('mode.confirmSolo', { project: sel.dataset.project }))) { sel.blur(); paintSide(); return; }
    const res = await postRaw('/api/mode', body);
    if (!res.ok) alert(t('err.switch', { e: await res.text() }));
    sel.blur();
    load();
  });

  // Keep the "+ member" form's values across sidebar re-renders.
  document.addEventListener('input', (e) => {
    const f = e.target.closest('form[data-spawn]');
    if (!f) return;
    ui.spawnDraft = { role: f.elements.role.value, model: f.elements.model.value, stay: f.elements.stay.checked, task: f.elements.task.value };
  });

  let spawnBusy = false;
  async function submitSpawn(form) {
    const body = { lead: form.dataset.spawn, group: form.dataset.group || undefined, role: form.elements.role.value.trim(), model: form.elements.model.value.trim() || undefined, stay: form.elements.stay.checked, task: form.elements.task.value.trim() };
    if (!body.role || !body.task) return;
    // One spawn at a time: a second click or Enter while the first request runs would start a second member.
    if (spawnBusy) return;
    spawnBusy = true;
    form.querySelectorAll('button, input, textarea').forEach((el) => { el.disabled = true; });
    try {
      await post('/api/team/spawn', body);
    } catch (err) {
      alert(t('err.spawn', { e: err.message }));
      form.querySelectorAll('button, input, textarea').forEach((el) => { el.disabled = false; });
      return;
    } finally { spawnBusy = false; }
    ui.spawnFor = null;
    ui.spawnDraft = emptySpawnDraft();
    load();
  }

  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.dataset.spawn) return submitSpawn(form);
    const ta = form.querySelector('textarea');
    const text = ta.value.trim();
    if (!text) return;
    const res = await postRaw('/api/reply', { session_id: form.dataset.sid, card_id: form.dataset.id, card_title: form.dataset.title, text });
    if (res.ok) { ta.value = ''; delete ui.drafts[form.dataset.id]; load(); }
    else alert(t('err.send', { e: await res.text() }));
  });
}
