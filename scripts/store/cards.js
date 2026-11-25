// Card files: the 0.1.0 cards.jsonl (read only) and the monthly cards/YYYY-MM.jsonl files, plus archived.json.
// reader() reads only the bytes appended since its last call. A line still being written (no trailing newline
// yet) is kept as a byte buffer and finished on the next call. Lifecycle rules live in domain/card.js.
const fs = require('fs');
const path = require('path');
const { paths } = require('../core/paths');
const { appendJsonl } = require('../core/fsx');
const { mapStore } = require('./record');
const { legacyCardFiles } = require('./migrate');

const NL = 0x0a;

// Card log files, oldest first: the 0.1.0 file (store/migrate.js), then the monthly files.
function files() {
  let monthly = [];
  try { monthly = fs.readdirSync(paths.cardsDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch {}
  return [...legacyCardFiles(), ...monthly.map((f) => path.join(paths.cardsDir, f))];
}

// New cards go to the monthly file only; the 0.1.0 cards.jsonl is never written again.
function append(card) {
  appendJsonl(paths.cardsFor(card.ts), card);
}

// An incremental reader: read(onCard) calls onCard for every new complete line's object and returns true,
// or returns false when a file shrank or was replaced (then call reset() and read again from the start).
function reader() {
  const state = new Map(); // file -> { offset, partial: Buffer }

  function parseLines(buf, st, onCard) {
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== NL) continue;
      const line = buf.toString('utf8', start, i).trim();
      start = i + 1;
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; } // skip malformed lines
      onCard(obj);
    }
    st.partial = buf.subarray(start);
  }

  function readFile(file, onCard) {
    let st = state.get(file);
    let size;
    try { size = fs.statSync(file).size; } catch { return true; } // missing file: nothing to read
    if (!st) state.set(file, (st = { offset: 0, partial: Buffer.alloc(0) }));
    if (size < st.offset) return false;
    if (size === st.offset) return true;
    const buf = Buffer.alloc(size - st.offset);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, st.offset); } finally { fs.closeSync(fd); }
    st.offset = size;
    parseLines(st.partial.length ? Buffer.concat([st.partial, buf]) : buf, st, onCard);
    return true;
  }

  return {
    read(onCard) {
      for (const f of files()) if (!readFile(f, onCard)) return false;
      return true;
    },
    reset() { state.clear(); },
  };
}

// archived.json: { <card_id>: { archived: true|false, ts } } — the user's explicit archive choices.
const archivedStore = mapStore(paths.archived, 'archived');

function readArchived() {
  return archivedStore.read();
}

function setArchived(id, archived) {
  archivedStore.update((m) => { m[id] = { archived: Boolean(archived), ts: new Date().toISOString() }; });
}

module.exports = { files, append, reader, readArchived, setArchived };
