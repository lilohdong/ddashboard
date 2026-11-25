// Shared test helpers. Starting a dashboard server: never a random port that may already be in use (another dev
// server, a parallel test run). startServer picks a port that is free right now, starts scripts/server.js on it and
// waits for its listen line ("ddashboard: http://127.0.0.1:<port>"); if the server exits first (the port was taken
// in between: EADDRINUSE), it tries again with another free port.
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'scripts', 'server.js');

// A TCP port on 127.0.0.1 that nothing listens on (the OS picks it: listen on port 0, read it, close).
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const exited = (p) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise((r) => p.once('exit', r)));

// One server start on a given port: resolves true once listening, false if it exited first; throws on timeout.
function waitListening(proc, port, timeout, log) {
  const ready = `ddashboard: http://127.0.0.1:${port} `;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`server on port ${port} did not start in ${timeout} ms:\n${log.text}`)), timeout);
    proc.stdout.on('data', () => { if (log.text.includes(ready)) finish(resolve, true); });
    proc.once('exit', () => finish(resolve, false));
  });
}

// Start scripts/server.js with process.env + env (DDASH_PORT is chosen here). track(proc) lets a test register the
// process for its own cleanup; nextPort (default freePort) is only replaced by the helper's own test. Returns
// { port, base, proc, output(), stop() }; stop() kills it and waits for exit.
async function startServer({ env = {}, track = (p) => p, timeout = 15000, attempts = 5, nextPort = freePort } = {}) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const port = await nextPort();
    const proc = track(spawn(process.execPath, [SERVER], { env: { ...process.env, ...env, DDASH_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }));
    const log = { text: '' };
    // Keep draining both pipes for the server's whole life (a full pipe would block it); keep the last 8 KB.
    const keep = (c) => { log.text = (log.text + c).slice(-8192); };
    proc.stdout.setEncoding('utf8').on('data', keep);
    proc.stderr.setEncoding('utf8').on('data', keep);
    try {
      if (await waitListening(proc, port, timeout, log)) {
        return {
          port,
          base: `http://127.0.0.1:${port}`,
          proc,
          output: () => log.text,
          stop: async () => { proc.kill(); await exited(proc); },
        };
      }
    } catch (err) { proc.kill(); await exited(proc); throw err; }
    last = log.text;
  }
  throw new Error(`server did not start after ${attempts} attempts:\n${last}`);
}

module.exports = { freePort, startServer, exited, SERVER };
