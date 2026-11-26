// Settings/language, solo -> team -> solo, groups, member spawn/send/end/handoff with the fake claude. Runs after solo.js.
const L = require('./lib'); const { S, rec, note, hook, api, state, team, fs, sleep, cp } = L;
const P = S.proj; const tx = (n) => S.tx + '/' + n + '.jsonl'; const U = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 2 };
const calls = () => fs.readdirSync(S.fakeDir).filter((f) => f.startsWith('call-')).map((f) => ({ f, ...L.readJ(S.fakeDir + '/' + f) }));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sidFrom = (out) => (out.match(/Spawned \S+ (?:in \S+ )?: ?([0-9a-f-]{36})/) || out.match(/([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1];
const stopWith = (sid, c, text) => { L.transcript(tx(sid), 'p', text ?? L.cardText(c), U, sid + Date.now()); return hook('stop-card', { session_id: sid, cwd: P, transcript_path: tx(sid) }); };
(async () => {
  note('--- G. settings / language');
  let r = await api('GET', '/api/settings'); rec('G1 fresh board: lang null', r.body.lang === null, JSON.stringify(r.body));
  for (const lg of ['ko', 'zh-CN', 'en']) { r = await api('POST', '/api/settings', { lang: lg }); const g = await api('GET', '/api/settings'); const st = await state();
    rec(`G2 set lang ${lg}: POST ok, GET and state.settings agree`, r.body.ok && g.body.lang === lg && st.settings.lang === lg, JSON.stringify([r.body, g.body, st.settings])); }
  rec('G3 bad language 400; empty body 400 and keeps lang; non-object body 400', (await api('POST', '/api/settings', { lang: 'xx' })).status === 400 && (await api('POST', '/api/settings', {})).status === 400 && (await api('GET', '/api/settings')).body.lang === 'en' && (await api('POST', '/api/settings', [])).status === 400);
  await api('POST', '/api/settings', { lang: 'ko' });
  r = hook('prompt-submit', { session_id: 'S1', cwd: P, prompt: 'noop' });
  const ruleText = hook('session-start', { session_id: 'S3', cwd: P, model: 'm' }).out; rec('G4 with lang=ko the injected rules ask for Korean cards', /한국어|Korean|ko\b/i.test(ruleText), ruleText.slice(0, 220).replace(/\n/g, ' | '));
  await api('POST', '/api/settings', { lang: null });

  note('--- H. solo -> team -> solo');
  await api('POST', '/api/settings', { lang: 'en' });
  hook('prompt-submit', { session_id: 'S2', cwd: P, prompt: 'p' }); // S2 outside
  r = hook('prompt-submit', { session_id: 'S1', cwd: P, prompt: '/ddashboard:dashboard team Alpha' });
  rec('H1 "/dashboard team Alpha": team added, S1 is its lead', /Team "Alpha" was added/.test(r.out), r.out.slice(0, 120)); L.pinPid('S1');
  let st = await state(); const pj = st.teams.proj;
  rec('H2 state: mode team, lead S1, S1 tagged lead, S2 outside', pj.mode === 'team' && pj.teams.Alpha.lead === 'S1' && st.sessions.S1.team === 'lead' && st.sessions.S2.team === 'outside', JSON.stringify([pj.mode, st.sessions.S1.team, st.sessions.S2.team]));
  r = hook('prompt-submit', { session_id: 'S2', cwd: P, prompt: 'after switch' }); const r2 = hook('prompt-submit', { session_id: 'S2', cwd: P, prompt: 'again' });
  rec('H3 after the switch the next prompt gets the new instructions once (second prompt: nothing)', r.out.length > 0 && r2.out === '', `first ${r.out.length} chars, second ${r2.out.length}`);
  rec('H4 outside session still posts its own card in team mode', (stopWith('S2', { status: 'done', title: 'Outside card', summary: [], review: [] }), true) && (await state()).cards.some((c) => c.title === 'Outside card' && !c.via_lead));
  r = await api('POST', '/api/mode', { project: 'proj', mode: 'solo' }); st = await state();
  rec('H5 POST /api/mode solo: project solo, no teams', r.body.ok && st.teams.proj.mode === 'solo' && Object.keys(st.teams.proj.teams).length === 0, JSON.stringify(r.body).slice(0, 150));
  r = await api('POST', '/api/mode', { project: 'proj', mode: 'team', lead: 'S1', team: 'Alpha' }); st = await state();
  rec('H6 POST /api/mode team with lead S1: team again', r.body.ok && st.teams.proj.mode === 'team' && st.teams.proj.teams.Alpha.lead === 'S1', JSON.stringify(r.body).slice(0, 150));
  rec('H7 mode errors: unknown project 404, bad mode 400, lead from elsewhere 400, ended lead 409', (await api('POST', '/api/mode', { project: 'zz', mode: 'solo' })).status === 404 && (await api('POST', '/api/mode', { project: 'proj', mode: 'x' })).status === 400 && (await api('POST', '/api/mode', { project: 'proj', mode: 'team', lead: 'nobody', team: 'B' })).status === 400 && (await api('POST', '/api/mode', { project: 'proj', mode: 'team', lead: 'S4', team: 'B' })).status === 409);

  note('--- I. groups');
  rec('I1 API create g2', (await api('POST', '/api/groups', { project: 'proj', action: 'create', name: 'g2' })).body.ok !== false && fs.existsSync(P + '/docs/teams/Alpha/g2/brief.md'));
  rec('I2 API rename g2 -> g3 (folder renamed)', (await api('POST', '/api/groups', { project: 'proj', action: 'rename', name: 'g2', new_name: 'g3' })).status === 200 && fs.existsSync(P + '/docs/teams/Alpha/g3') && !fs.existsSync(P + '/docs/teams/Alpha/g2'));
  rec('I3 duplicate name (case-insensitive) refused 400', (await api('POST', '/api/groups', { project: 'proj', action: 'create', name: 'G3' })).status === 400);
  rec('I4 API delete g3: folder archived, group gone', (await api('POST', '/api/groups', { project: 'proj', action: 'delete', name: 'g3' })).status === 200 && !fs.existsSync(P + '/docs/teams/Alpha/g3'));
  rec('I5 bad action 400, unknown project 404', (await api('POST', '/api/groups', { project: 'proj', action: 'zap', name: 'a' })).status === 400 && (await api('POST', '/api/groups', { project: 'zz', action: 'create', name: 'a' })).status === 404);
  r = team('S1', 'group', 'create', 'g1'); rec('I6 CLI group create g1', /Created group g1/.test(r.out), r.out.slice(0, 80));
  fs.writeFileSync(P + '/docs/teams/Alpha/g1/brief.md', '# g1 brief\nBRIEFMARK-7731 keep it short\n');
  rec('I7 CLI group list shows g1', /g1/.test(team('S1', 'group', 'list').out));

  note('--- J. members: spawn / hooks / reports');
  r = team('S1', 'spawn', '--role', 'qa-a', '--group', 'g1', 'do the thing'); const A = sidFrom(r.out);
  rec('J1 CLI spawn qa-a in g1 (headless, fake claude)', Boolean(A) && /headless/.test(r.out), r.out.replace(/\n/g, ' | ').slice(0, 200));
  await sleep(800);
  const ca = calls().find((c) => c.argv.includes(A));
  rec('J2 fake claude got --session-id, permission-mode, and the first prompt tag with role/lead/group', ca && ca.argv.includes('--session-id') && /\[ddash role=qa-a lead=S1 stay=0 group=g1\]/.test(ca.input) && /do the thing/.test(ca.input), ca ? JSON.stringify(ca.argv).slice(0, 200) + ' IN:' + ca.input.slice(0, 80) : 'no call');
  r = await api('POST', '/api/team/spawn', { lead: 'S1', role: 'qa-b', task: 'second task', model: 'haiku' }); const B = r.body.session_id; const recordedB = r.body.pid;
  rec('J3 HTTP spawn qa-b ok; bad runner 400; unknown lead 404; missing task 400', r.status === 200 && Boolean(B) && (await api('POST', '/api/team/spawn', { lead: 'S1', role: 'x', task: 'y', runner: 'zz' })).status === 400 && (await api('POST', '/api/team/spawn', { lead: 'nope', role: 'x', task: 'y' })).status === 404 && (await api('POST', '/api/team/spawn', { lead: 'S1', role: 'x' })).status === 400, JSON.stringify(r.body).slice(0, 120));
  r = hook('session-start', { session_id: A, cwd: P, model: 'haiku' }); rec('J4 member SessionStart injects the group brief and the member rules', /BRIEFMARK-7731/.test(r.out) && /```card/.test(r.out), r.out.slice(0, 120).replace(/\n/g, ' | '));
  hook('prompt-submit', { session_id: A, cwd: P, prompt: '[ddash role=qa-a lead=S1 stay=0 group=g1] do the thing' });
  hook('session-start', { session_id: B, cwd: P }); hook('prompt-submit', { session_id: B, cwd: P, prompt: '[ddash role=qa-b lead=S1 stay=0] second task' });
  st = await state(); rec('J5 sidebar: A is member in group g1 under lead S1, B member without group', st.sessions[A].team === 'member' && st.sessions[A].group === 'g1' && st.sessions[A].lead === 'S1' && st.sessions[B].team === 'member' && !st.sessions[B].group, JSON.stringify([st.sessions[A].team, st.sessions[A].group, st.sessions[A].lead, st.sessions[B].group]));
  stopWith(A, { status: 'review', title: 'qa-a report', summary: ['done checking'], review: ['look'], key: 'task-x' });
  st = await state(); const stR = await state(true);
  rec('J6 member card is a report: hidden from the default board, visible with reports=1 (via_lead S1), key dropped', !st.cards.some((c) => c.title === 'qa-a report') && stR.cards.some((c) => c.title === 'qa-a report' && c.via_lead === 'S1' && !c.key), JSON.stringify(stR.cards.filter((c) => c.title === 'qa-a report').map((c) => [c.via_lead, c.key])));
  const lr = stopWith('S1', null, 'lead idle'); let blk; try { blk = JSON.parse(lr.out); } catch {}
  rec('J7 lead\'s Stop hook hands over the report as [Team report]', blk && blk.decision === 'block' && /qa-a report/.test(blk.reason) && /report/i.test(blk.reason), lr.out.slice(0, 200));
  r = team('S1', 'list'); rec('J8 list shows both members working with roles and group', /qa-a \[g1\]/.test(r.out) && /qa-b/.test(r.out) && /working/.test(r.out), r.out.replace(/\n/g, ' | '));

  note('--- K. send / resume / end');
  r = team('S1', 'send', 'qa-a', 'please add tests'); rec('K1 send to a running member is queued', /queued/i.test(r.out), r.out.trim().slice(0, 140));
  st = await state(); rec('K2 sidebar data shows pending 1 for A', st.sessions[A].pending === 1, st.sessions[A].pending);
  const sr = stopWith(A, null, 'member turn'); try { blk = JSON.parse(sr.out); } catch { blk = null; }
  rec('K3 member Stop hook receives the lead instruction', blk && /please add tests/.test(blk.reason), sr.out.slice(0, 160));
  const pidB = recordedB; // pid recorded from the spawn response; never read from sessions.json
  note('B recorded spawn pid=' + pidB);
  const killPid = pidB; if (!killPid || [...L.ancestors()].includes(Number(killPid))) throw new Error('refusing to kill ' + killPid);
  const before = calls().length; cp.spawnSync('taskkill', ['/PID', String(killPid), '/T', '/F']); await sleep(2500);
  st = await state(); rec('K4 killed headless member B shows finished (resumable)', /finished/.test(team('S1', 'list').out) || st.sessions[B].view !== 'working', team('S1', 'list').out.replace(/\n/g, ' | ').slice(0, 200));
  r = team('S1', 'send', 'qa-b', 'resume please'); await sleep(900);
  const resumed = calls().find((c) => c.argv.includes('--resume') && c.argv.includes(B)); rec('K5 send to a finished member resumes it (--resume <sid>, text on stdin)', resumed && /resume please/.test(resumed.input), r.out.trim().slice(0, 100) + ' ARGV ' + (resumed && JSON.stringify(resumed.argv).slice(0, 120)));
  r = team('S1', 'end', 'qa-a'); await sleep(800); st = await state(); const pa = L.readJ(S.board + '/sessions.json', {})[A];
  rec('K6 end qa-a: ended, run stopped', st.sessions[A].view === 'ended' && /ended|stopped/i.test(r.out), r.out.trim().slice(0, 100));
  rec('K7 second end says already', /already/i.test(team('S1', 'end', 'qa-a').out));
  r = await api('POST', '/api/team/end', { session_id: B }); st = await state(); rec('K8 HTTP end of qa-b ok; ended in sidebar', r.status === 200 && st.sessions[B].view === 'ended', JSON.stringify(r.body));
  rec('K9 end of a non-member 404', (await api('POST', '/api/team/end', { session_id: 'S2' })).status === 404);

  note('--- L. lead handoff');
  r = team('S1', 'spawn', '--role', 'qa-c', '--group', 'g1', 'third task'); const C = sidFrom(r.out); hook('session-start', { session_id: C, cwd: P }); hook('prompt-submit', { session_id: C, cwd: P, prompt: '[ddash role=qa-c lead=S1 stay=0 group=g1] third task' });
  const d2 = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},3600000)', 'claude-code-qa-dummy2'], { detached: true, stdio: 'ignore' }); d2.unref();
  cp.spawnSync(process.execPath, ['-e', `require(process.argv[1]+'/scripts/store/sessions.js').update(s=>{s.S1.claude_pid=Number(process.argv[2])})`, S.src, String(d2.pid)], { env: L.env() });
  fs.writeFileSync(P + '/docs/teams/Alpha/g1/lead-handoff.md', '# lead handoff\nstate: all good\n');
  r = team('S1', 'handoff', P + '/docs/teams/Alpha/g1/lead-handoff.md'); const tagLine = (r.out.match(/\[ddash lead-handoff[^\]]*\]/) || [])[0];
  rec('L1 handoff prints the first prompt with the [ddash lead-handoff ...] tag', Boolean(tagLine), r.out.replace(/\n/g, ' | ').slice(0, 300));
  hook('session-start', { session_id: 'S5', cwd: P, model: 'm' });
  r = hook('prompt-submit', { session_id: 'S5', cwd: P, prompt: tagLine + ' continue' }); L.pinPid('S5'); await sleep(500);
  rec('L2 new lead S5 told it took over (members, moved messages)', /took over as lead/.test(r.out), r.out.slice(0, 200).replace(/\n/g, ' | '));
  st = await state(); const raw = L.readJ(S.board + '/sessions.json', {});
  rec('L3 old lead S1 ended with reason handoff; replaced_by S5', raw.S1.state === 'ended' && raw.S1.end_reason === 'handoff' && raw.S1.replaced_by === 'S5', JSON.stringify([raw.S1.state, raw.S1.end_reason, raw.S1.replaced_by]));
  rec('L4 live member qa-c now reports to S5; project lead is S5', raw[C].lead === 'S5' && st.teams.proj.teams.Alpha.lead === 'S5', JSON.stringify([raw[C].lead, st.teams.proj.teams.Alpha.lead]));
  await sleep(1500); rec('L5 old lead\'s Claude process (our dummy2) was stopped', !alive(d2.pid), 'alive=' + alive(d2.pid));
  rec('L6 S5 list shows qa-c; S1 list empty', /qa-c/.test(team('S5', 'list').out) && !/qa-c/.test(team('S1', 'list').out), team('S5', 'list').out.replace(/\n/g, ' | '));
  r = hook('prompt-submit', { session_id: 'S1', cwd: P, prompt: 'still here?' }); rec('L7 a prompt to the replaced lead is blocked with a stop notice', /block/.test(r.out) && /S5|took over|replaced/i.test(r.out), r.out.slice(0, 160));
  team('S5', 'end', 'qa-c');

  note('--- M. back to solo');
  r = hook('prompt-submit', { session_id: 'S5', cwd: P, prompt: '/ddashboard:dashboard solo' }); st = await state();
  rec('M1 "/dashboard solo" from the lead: team removed, project solo', /removed/.test(r.out) && st.teams.proj.mode === 'solo' && Object.keys(st.teams.proj.teams).length === 0, r.out.slice(0, 120));
  rec('M2 solo again: a session posts its own card', (stopWith('S2', { status: 'done', title: 'Solo again card', summary: [], review: [] }), true) && (await state()).cards.some((c) => c.title === 'Solo again card' && !c.via_lead));
  fs.writeFileSync(L.HERE + '/team-state-final.json', JSON.stringify(await state(true), null, 1));
  fs.writeFileSync(L.HERE + '/team-ids.json', JSON.stringify({ A, B, C }));
})().catch((e) => { console.error(e); process.exit(1); });
