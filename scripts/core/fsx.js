// File helpers for board files: JSON, JSONL, atomic writes, tail reads.
// atomicWrite = tmp file + rename. On Windows a rename over a file another process has open fails for a moment
// with EPERM/EBUSY/EACCES; it is retried (10 times, 20-50 ms apart) before giving up.
const fs = require('fs');
const path = require('path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 10;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Rename with retries on transient Windows sharing errors. Throws the last error.
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (!RETRY_CODES.has(err.code) || i >= RETRIES - 1) throw err;
      sleep(20 + Math.floor(Math.random() * 31));
    }
  }
}

let seq = 0;
function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  fs.writeFileSync(tmp, text);
  try { renameRetry(tmp, file); } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

const writeJson = (file, data) => atomicWrite(file, JSON.stringify(data, null, 2));

function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file, limit) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
  }
  return limit ? rows.slice(-limit) : rows;
}

// The last `bytes` bytes of a file as a Buffer (the whole file when smaller); null when it cannot be read.
function readTail(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

module.exports = { ensureDir, readJson, writeJson, atomicWrite, renameRetry, appendJsonl, readJsonl, readTail, sleep };
