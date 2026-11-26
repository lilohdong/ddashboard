import { mkdirSync, writeFileSync } from 'node:fs';
const B = process.argv[2], WT = process.argv[3];
mkdirSync(B + '/cards', { recursive: true });
const now = Date.now(), iso = (m) => new Date(now - m * 60000).toISOString();
const card = (id, m, sid, name, proj, pk, status, title, extra = {}) => ({ id: id + '', ts: iso(m), session_id: sid, session_name: name, project: proj, project_key: pk, branch: 'x', diffstat: '', status, title, summary: ['sum ' + title], ...extra });
const cards = [
 card(1, 50, 'sA', 'alpha', 'soloproj', 'PK1', 'done', 'Card One', { key: 'fix' }),
 card(2, 40, 'sA', 'alpha', 'soloproj', 'PK1', 'review', 'Card Two', { key: 'fix', review: ['check it'], details: 'detail\ntext' }),
 card(3, 30, 'sA', 'alpha', 'soloproj', 'PK1', 'blocked', 'Card Three'),
 card(4, 20, 'sL', 'lead', 'teamproj', 'PK2', 'wip', 'Team lead card'),
 card(5, 10, 'sM', 'm1', 'teamproj', 'PK2', 'done', 'Member card'),
];
writeFileSync(B + '/cards/' + new Date().toISOString().slice(0, 7) + '.jsonl', cards.map((c) => JSON.stringify(c)).join('\n') + '\n');
const ses = (sid, name, proj, pk, extra = {}) => ({ session_id: sid, name, project: proj, project_key: pk, cwd: WT, branch: 'main', state: 'idle', started: iso(60), last_seen: iso(1), ...extra });
writeFileSync(B + '/sessions.json', JSON.stringify({
  sA: ses('sA', 'alpha', 'soloproj', 'PK1'), sB: ses('sB', 'beta', 'soloproj', 'PK1', { state: 'working' }),
  sL: ses('sL', 'lead', 'teamproj', 'PK2', { state: 'working' }),
  sM: ses('sM', 'm1', 'teamproj', 'PK2', { kind: 'member', lead: 'sL', group: 'g1', role: 'front', state: 'idle' }),
}));
writeFileSync(B + '/projects.json', JSON.stringify({
  PK1: { key: 'PK1', name: 'soloproj', root: WT, enabled: true, teams: {} },
  PK2: { key: 'PK2', name: 'teamproj', root: WT, enabled: true, teams: { T1: { lead: 'sL', worktree: WT, created: iso(70), groups: { g1: { dir: WT + '/docs/teams/T1/g1' }, g2: { dir: WT + '/docs/teams/T1/g2' } } } } },
}));
