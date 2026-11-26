// A JSON map file ({ id: record }) behind a lock: read(), get(id), update(fn), patch(id, fields),
// patchDiff(id, before, after).
// update(fn): lock, read the file, let fn change the map, write it only when it changed, unlock. Returns fn's result.
// Nested updates of the same file in one process share the map of the outermost one (written once, at its end),
// and reads during an update see that map, so code called from inside an update never works on a stale copy.
const { withLock } = require('../core/lock');
const { readJson, writeJson } = require('../core/fsx');

function mapStore(file, lockName) {
  let current = null;

  const readFile = () => {
    const m = readJson(file, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  };

  // The whole map: a fresh copy from disk, or the map of an update in progress.
  const read = () => current || readFile();
  const get = (id) => {
    const m = read();
    return Object.hasOwn(m, id) ? m[id] : undefined;
  };

  function update(fn) {
    if (current) return fn(current);
    return withLock(lockName, () => {
      const m = readFile();
      const before = JSON.stringify(m);
      current = m;
      let r;
      try { r = fn(m); } finally { current = null; }
      if (JSON.stringify(m) !== before) writeJson(file, m);
      return r;
    });
  }

  const apply = (rec, fields) => {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) delete rec[k];
      else rec[k] = v;
    }
  };

  // Set fields of one record (undefined deletes the field). False when the record does not exist.
  function patch(id, fields) {
    return update((m) => {
      if (!Object.hasOwn(m, id)) return false;
      apply(m[id], fields);
      return true;
    });
  }

  // Write only the top-level fields that differ between two copies of a record (before: as read; after: as
  // changed by slow code that ran without the lock). Fields others changed meanwhile are kept.
  // guard(currentRecord, changes) may edit changes before they are applied. False when the record is gone.
  function patchDiff(id, before, after, guard) {
    const changes = {};
    for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
      if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) changes[k] = after?.[k];
    }
    return update((m) => {
      if (!Object.hasOwn(m, id)) return false;
      if (guard) guard(m[id], changes);
      apply(m[id], changes);
      return true;
    });
  }

  const inUpdate = () => current !== null;

  return { read, get, update, patch, patchDiff, inUpdate, file };
}

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

module.exports = { mapStore, clone };
