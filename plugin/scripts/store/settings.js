// settings.json: the user's dashboard choices, { lang, ver } (ver bumps on each change). Writes go through
// update (lock + re-read); app/settings.js validates.
const { paths } = require('../core/paths');
const { mapStore } = require('./record');

module.exports = mapStore(paths.settings, 'settings');
