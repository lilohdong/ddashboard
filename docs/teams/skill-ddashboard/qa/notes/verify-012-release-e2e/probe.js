const L = require('./lib'); const { S, hook, api, state, team, sleep } = L;
(async () => {
  const P = S.proj;
  let r = hook('prompt-submit', { session_id: 'S1', cwd: P, prompt: '/ddashboard:dashboard team Alpha' }); console.log(r.out.slice(0, 600));
  L.pinPid('S1'); let st = await state(); console.log(JSON.stringify(st.teams), Object.values(st.sessions).map(s => s.session_id + ':' + s.team + ':' + s.view).join(' '));
  r = hook('prompt-submit', { session_id: 'S1', cwd: P, prompt: 'next' }); console.log('--next prompt:', r.out.slice(0, 300));
  console.log(team('S1', 'group', 'create', 'g1').out);
  console.log(team('S1', 'spawn', '--role', 'qa-a', '--group', 'g1', 'do the thing').out);
  console.log(team('S1', 'list').out);
})();
