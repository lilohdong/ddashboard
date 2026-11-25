// HTTP router (docs/architecture.md §3.2, §3.5). A route is { method, path, sameOrigin, body, handler }:
//   path       a string, or a function (pathname) -> truthy match (passed to the handler as ctx.match)
//   sameOrigin refuse requests from other origins (403 forbidden); every POST route sets it
//   body       parse a JSON object body (at most 64 KB) into ctx.body
//   handler    async ({ req, url, body, match }) -> a JSON value (200), or raw(text, type); throws fail(...) for errors
// Errors are { error: message, code }; unexpected exceptions are 500 internal.
const MAX_BODY = 64 * 1024;

const STATUS_CODES = { 400: 'bad_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 500: 'internal' };

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || STATUS_CODES[status] || 'error';
  }
}

// An error reply: throw fail(404, 'unknown session', 'unknown_session').
const fail = (status, message, code) => new HttpError(status, message, code);

const RAW = Symbol('raw');
// A non-JSON 200 reply (static files).
const raw = (body, type) => ({ [RAW]: true, body, type });

function send(res, status, body, type = 'application/json; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Accept same-origin requests only, so other websites cannot post through the browser.
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      body += c;
      if (body.length > MAX_BODY) {
        over = true;
        reject(fail(413, 'body too large', 'too_large'));
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return;
      let msg;
      try { msg = JSON.parse(body); } catch { return reject(fail(400, 'bad json', 'bad_json')); }
      if (!msg || typeof msg !== 'object') return reject(fail(400, 'bad json', 'bad_json'));
      resolve(msg);
    });
  });
}

const matchPath = (p, pathname) => (typeof p === 'function' ? p(pathname) : p === pathname);

function find(routes, method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = matchPath(r.path, pathname);
    if (match) return { route: r, match };
  }
  return null;
}

async function handle(routes, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const hit = find(routes, req.method, url.pathname);
  if (!hit) return send(res, 404, { error: 'not found', code: 'not_found' });
  const { route, match } = hit;
  try {
    if (route.sameOrigin && !sameOrigin(req)) throw fail(403, 'forbidden', 'forbidden');
    const body = route.body ? await readBody(req) : undefined;
    const out = await route.handler({ req, url, body, match });
    if (out && out[RAW]) return send(res, 200, out.body, out.type);
    send(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, code: err.code });
    send(res, 500, { error: String(err?.message || err), code: 'internal' });
  }
}

// (req, res) handler for http.createServer.
function createRouter(routes) {
  return (req, res) => { handle(routes, req, res).catch((err) => send(res, 500, { error: String(err?.message || err), code: 'internal' })); };
}

module.exports = { createRouter, fail, raw, send, sameOrigin, HttpError, MAX_BODY };
