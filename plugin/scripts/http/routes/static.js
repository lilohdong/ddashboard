// GET /, /i18n.js, /web/<name>.mjs, /web/style.css. Names are matched, never joined from the URL as given, so
// nothing outside this list is served.
const fs = require('fs');
const path = require('path');
const { fail, raw } = require('../router');

const SCRIPTS = path.join(__dirname, '..', '..');
const WEB = path.join(SCRIPTS, 'web');
const JS = 'text/javascript; charset=utf-8';

function staticFile(pathname) {
  if (pathname === '/') return [path.join(WEB, 'index.html'), 'text/html; charset=utf-8'];
  if (pathname === '/i18n.js') return [path.join(SCRIPTS, 'i18n.js'), JS];
  if (pathname === '/web/style.css') return [path.join(WEB, 'style.css'), 'text/css; charset=utf-8'];
  const m = /^\/web\/([a-z0-9-]+\.mjs)$/.exec(pathname);
  return m ? [path.join(WEB, m[1]), JS] : null;
}

module.exports = [
  {
    method: 'GET', path: staticFile, sameOrigin: false, body: false,
    handler: ({ match: [file, type] }) => {
      try { return raw(fs.readFileSync(file, 'utf8'), type); } catch { throw fail(404, 'not found', 'not_found'); }
    },
  },
];
module.exports.staticFile = staticFile;
