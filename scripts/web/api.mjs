// fetch wrappers for the server's /api/*.
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function getState(reports) {
  return (await fetch(reports ? '/api/state?reports=1' : '/api/state')).json();
}

export async function search(params) {
  const res = await fetch('/api/search?' + params);
  const data = await res.json();
  return { res, data };
}

// POST that throws the server's error message; returns the JSON body.
export async function post(url, body) {
  const res = await fetch(url, json(body));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}

// POST that returns the raw response (callers read res.ok / res.text()).
export function postRaw(url, body) {
  return fetch(url, json(body));
}
