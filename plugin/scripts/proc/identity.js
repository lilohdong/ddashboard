// A remembered process: { pid, name, start } taken from a process table. Pids are reused, so a bare pid says
// nothing a moment later; same(identity, table) is the one pid-reuse check: the pid runs, with the same image name
// and (when both are known) the same start time.
const norm = (name) => String(name || '').toLowerCase().replace(/\.exe$/, '');

// Identity of a pid in a table, or null when the table does not list it.
function identityOf(pid, table) {
  const p = table?.get(Number(pid));
  if (!p) return null;
  return { pid: p.pid, name: p.name || '', start: Number(p.start) || 0 };
}

// True when the process in the table still is the remembered one.
function same(id, table) {
  if (!id || !(Number(id.pid) > 0)) return false;
  const p = table?.get(Number(id.pid));
  if (!p) return false;
  if (id.name && norm(p.name) !== norm(id.name)) return false;
  if (Number(id.start) && Number(p.start) && Number(p.start) !== Number(id.start)) return false;
  return true;
}

module.exports = { identityOf, same };
