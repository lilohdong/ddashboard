// Dashboard settings (store/settings.js): lang = dashboard and card language. Changing it bumps ver, so every
// session gets its instructions again once (app/rules.js rulesUpdate).
const store = require('../store/settings');
const { LANG_NAMES } = require('../domain/rules');

const readSettings = () => store.read();

// Set (or clear with null/'') the language.
function saveSettings({ lang } = {}) {
  if (lang && !LANG_NAMES[lang]) return { ok: false, error: `lang must be one of ${Object.keys(LANG_NAMES).join(', ')}` };
  return store.update((s) => {
    if ((s.lang || '') !== (lang || '')) {
      if (lang) s.lang = lang; else delete s.lang;
      s.ver = (Number(s.ver) || 0) + 1;
    }
    return { ok: true, settings: { ...s } };
  });
}

module.exports = { readSettings, saveSettings };
