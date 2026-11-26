// Solo mode, from a fresh board: hooks with fixture transcripts, cards, key/fold/stopped, archive, search, reply, usage.
const L = require('./lib'); const { S, rec, note, hook, api, state, fs, sleep, cp } = L;
(async () => {
  const P = S.proj; const tx = (n) => S.tx + '/' + n + '.jsonl'; const cnt = {};
  const U = (i) => ({ input_tokens: 100 * i, cache_read_input_tokens: 1000 * i, cache_creation_input_tokens: 50 * i, output_tokens: 20 * i });
  const tot = (i) => 1170 * i; let expected = 0;
  const turn = async (sid, c, i = 1, text) => {
    cnt[sid] = (cnt[sid] || 0) + 1; const n = cnt[sid];
    L.transcript(tx(sid), 'prompt ' + n, text ?? L.cardText(c), U(i), sid + n); expected += tot(i);
    hook('prompt-submit', { session_id: sid, cwd: P, prompt: 'turn ' + n }); await sleep(30);
    const r = hook('stop-card', { session_id: sid, cwd: P, transcript_path: tx(sid) }); await sleep(30); return r;
  };
  const card = (st, title, extra = {}) => ({ status: st, title, summary: [title + ' s'], review: [], ...extra });

  note('--- A. activation from an empty board');
  rec('A0 board dir empty before activation', fs.readdirSync(S.board).length === 0, fs.readdirSync(S.board).join(','));
  let r = hook('prompt-submit', { session_id: 'S1', cwd: P, prompt: '/ddashboard:dashboard' });
  rec('A1 activation prompt starts the server and prints the rules (card block, wait command)', /Dashboard started/.test(r.out) && /```card/.test(r.out) && /wait\.js/.test(r.out) && r.code === 0, r.out.slice(0, 60));
  await sleep(500);
  rec('A2 wait.js installed in the board bin/', fs.existsSync(S.board + '/bin/wait.js'));
  L.pinPid('S1');
  let st = await state();
  rec('A3 fresh board: zero cards, one session, no teams', st.cards.length === 0 && Object.keys(st.sessions).length === 1 && Object.keys(st.teams || {}).length <= 1, `cards=${st.cards.length} (solo project row only) teams=${JSON.stringify(st.teams)}`);
  for (const s of ['S2', 'S3', 'S4']) {
    r = hook('session-start', { session_id: s, cwd: P, model: 'claude-sonnet-5-5', source: 'startup' });
    if (s === 'S2') rec('A4 SessionStart of a new session in a connected solo project registers it and prints the rules', /```card/.test(r.out), r.out.slice(0, 60));
    L.pinPid(s);
  }
  r = hook('session-start', { session_id: 'X9', cwd: S.root + '/not-connected', model: 'x' });
  rec('A5 SessionStart in a project that is not connected prints nothing (zero tokens)', r.out === '' && r.code === 0);
  st = await state(); rec('A6 four sessions registered, models.json written', Object.keys(st.sessions).length === 4 && fs.existsSync(S.board + '/models.json'), Object.keys(st.sessions).join(','));

  note('--- B. cards through the Stop hook');
  await turn('S1', card('wip', 'Login wip 1', { key: 'Login Fix' }));
  await turn('S1', card('wip', 'Login wip 2'));
  st = await state(); const c1 = st.cards.find((c) => c.title === 'Login wip 2');
  rec('B1 wip 1 folded under wip 2 (one top card, folded list of 1)', st.cards.length === 1 && c1 && (c1.folded || []).length === 1 && c1.folded[0].title === 'Login wip 1', JSON.stringify(st.cards.map((c) => [c.title, (c.folded || []).length])));
  await turn('S1', card('done', 'Login done', { details: 'line one\nline two' }));
  st = await state(); const c2 = st.cards.find((c) => c.title === 'Login done');
  rec('B2 a done card folds both wips and takes the outcome (folded 2, one top card)', st.cards.length === 1 && c2 && c2.folded.length === 2 && c2.status === 'done', JSON.stringify(st.cards.map((c) => [c.title, c.status, (c.folded || []).length])));
  rec('B3 details with real newlines kept', /line one\nline two/.test(c2.details || ''), c2.details);
  await turn('S2', card('review', 'Review me', { review: ['check A', 'check B'] }));
  await turn('S2', card('blocked', 'Blocked on key', { summary: ['need the key'] }));
  await turn('S3', card('done', 'Old payments card', { key: 'payments' }));
  await turn('S2', card('done', 'New payments card', { key: 'Payments' }));
  st = await state(); const titles = st.cards.map((c) => c.title);
  rec('B4 done/review/blocked on the board (wip: B1, B8)', ['done', 'review', 'blocked'].every((s) => st.cards.some((c) => c.status === s)), st.cards.map((c) => c.status).join(','));
  rec('B5 key replacement: "Payments" -> payments; the older same-key card of another session leaves the board', titles.includes('New payments card') && !titles.includes('Old payments card'), titles.join(' | '));
  const np = st.cards.find((c) => c.title === 'New payments card');
  rec('B6 new keyed card has key=payments and key_prev=1', np && np.key === 'payments' && np.key_prev === 1, JSON.stringify([np && np.key, np && np.key_prev]));
  await turn('S3', card('done', 'Old draft')); await turn('S3', card('done', 'Fresh draft', { replaces: 'last' }));
  st = await state(); rec('B7 replaces:last retires the previous card of that session', st.cards.some((c) => c.title === 'Fresh draft') && !st.cards.some((c) => c.title === 'Old draft'), st.cards.map((c) => c.title).join(' | '));
  await turn('S4', card('wip', 'Half done work')); st = await state();
  const hw0 = st.cards.find((c) => c.title === 'Half done work');
  rec('B8 open wip card of a live session is wip, not stopped', hw0 && hw0.status === 'wip' && !hw0.stopped, JSON.stringify([hw0 && hw0.status, hw0 && hw0.stopped]));
  const nb = st.cards.length;
  await turn('S2', null, 1, 'Just chatting, no card here.'); st = await state();
  rec('B9 a turn without a card block adds no card', st.cards.length === nb, `${nb} -> ${st.cards.length}`);
  await turn('S2', null, 1, 'x\n```card\n{not json at all\nsecond line\n```'); st = await state();
  rec('B10 malformed card JSON still yields a card from the raw lines (no crash)', st.cards.some((c) => /not json/.test(c.title)), st.cards.map((c) => c.title).join(' | '));
  await turn('S2', card('done', 'Idem card')); const n0 = (await state()).cards.length;
  hook('stop-card', { session_id: 'S2', cwd: P, transcript_path: tx('S2') }); await sleep(100);
  rec('B11 the same card again (reply-driven turn) is not duplicated', (await state()).cards.length === n0);

  note('--- C. stopped');
  hook('session-end', { session_id: 'S4', cwd: P, reason: 'exit' }); await sleep(300); st = await state();
  const hw = st.cards.find((c) => c.title === 'Half done work');
  rec('C1 SessionEnd on a session with an open wip card -> the card is stopped', hw && (hw.stopped === true || hw.outcome === 'stopped'), JSON.stringify([hw && hw.status, hw && hw.outcome, hw && hw.stopped]));
  rec('C2 S4 is ended', st.sessions.S4.view === 'ended' || st.sessions.S4.state === 'ended', st.sessions.S4.view);

  note('--- D. archive / restore / search');
  const idOf = (t, s) => s.cards.find((c) => c.title === t).id;
  const a0 = st.archived_count; let res = await api('POST', '/api/archive', { card_id: idOf('Blocked on key', st), archived: true });
  st = await state(); rec('D1 archive a card: leaves the board, archived_count+1', res.body.ok && !st.cards.some((c) => c.title === 'Blocked on key') && st.archived_count === a0 + 1, `count ${a0}->${st.archived_count}`);
  let q = (await api('GET', '/api/search?q=blocked&archived=only')).body; rec('D2 archived-only search finds it', q.cards.some((c) => c.title === 'Blocked on key'), q.cards.map((c) => c.title).join('|'));
  res = await api('POST', '/api/archive', { card_id: q.cards[0].id, archived: false }); st = await state();
  rec('D3 restore: back on the board', res.body.ok && st.cards.some((c) => c.title === 'Blocked on key') && st.archived_count === a0, 'count ' + st.archived_count);
  res = await api('POST', '/api/archive', { card_id: 'nope', archived: true });
  rec('D4 archive unknown card 404; non-boolean 400', res.status === 404 && (await api('POST', '/api/archive', { card_id: 'x', archived: 'yes' })).status === 400, res.status);
  q = (await api('GET', '/api/search?q=login')).body.cards; rec('D5 search "login" finds the folded wip cards too (3 cards, 2 folded)', q.length === 3 && q.filter((c) => c.folded_into).length === 2, q.map((c) => c.title + (c.folded_into ? '(folded)' : '')).join('|'));
  q = (await api('GET', '/api/search?q=payments')).body.cards; rec('D6 search also finds the replaced old keyed card', q.some((c) => c.title === 'Old payments card'), q.map((c) => c.title).join('|'));
  q = (await api('GET', '/api/search?key=payments&project_key=' + encodeURIComponent(np.project_key))).body.cards; rec('D7 key search (click on #key) returns exactly the 2 payments cards', q.length === 2, q.length);
  q = (await api('GET', '/api/search?q=' + encodeURIComponent('line two'))).body.cards; rec('D8 search matches inside details', q.length === 1 && q[0].title === 'Login done');
  q = (await api('GET', '/api/search?q=zzzzqq')).body.cards; rec('D9 no match -> empty list', q.length === 0);
  fs.writeFileSync(L.HERE + '/solo-state.json', JSON.stringify(st, null, 1));

  note('--- E. dashboard reply reaches wait.js / the Stop hook');
  const wait = cp.spawn(process.execPath, [S.board + '/bin/wait.js', 'S1'], { env: { ...L.env(), DDASH_WAIT_OWNER: String(S.dummy) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let wout = ''; wait.stdout.on('data', (d) => (wout += d)); let exited = null; wait.on('exit', (c) => (exited = c));
  await sleep(1200);
  rec('E1 wait.js is waiting (still running, no output)', exited === null && wout === '', wout);
  st = await state(); const rep = await api('POST', '/api/reply', { session_id: 'S1', text: 'Please also fix the logout bug ✓', card_id: idOf('Login done', st), card_title: 'Login done' });
  rec('E2 POST /api/reply ok', rep.status === 200 && rep.body.ok, JSON.stringify(rep.body));
  for (let i = 0; i < 30 && exited === null; i++) await sleep(200);
  rec('E3 wait.js printed the reply text and exited 0', exited === 0 && /Please also fix the logout bug ✓/.test(wout), `exit=${exited} out=${wout.replace(/\n/g, ' | ').slice(0, 200)}`);
  st = await state(); rec('E4 reply is in state.replies (card shows "replied")', st.replies.some((x) => /logout/.test(x.text) && x.card_id), st.replies.length);
  await api('POST', '/api/reply', { session_id: 'S2', text: 'Reply for the Stop hook' }); await sleep(200);
  L.transcript(tx('S2'), 'p', 'plain', U(1), 'S2z'); expected += tot(1);
  const sr = hook('stop-card', { session_id: 'S2', cwd: P, transcript_path: tx('S2') });
  let blk; try { blk = JSON.parse(sr.out); } catch {}
  rec('E5 no waiter: the Stop hook hands the reply over (decision block + text)', blk && blk.decision === 'block' && /Reply for the Stop hook/.test(blk.reason), sr.out.slice(0, 160));
  rec('E6 empty reply 400, unknown session 404, ended session 409', (await api('POST', '/api/reply', { session_id: 'S1', text: '  ' })).status === 400 && (await api('POST', '/api/reply', { session_id: 'nope', text: 'a' })).status === 404 && (await api('POST', '/api/reply', { session_id: 'S4', text: 'a' })).status === 409);
  rec('E7 cross-origin POST refused (403)', (await api('POST', '/api/reply', { session_id: 'S1', text: 'a' }, 'http://evil.example')).status === 403);

  note('--- F. usage / token meter');
  st = await state(); const ut = st.usage_total || {}; const sum = (u) => (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0) + (u.output || 0);
  note('usage_total ' + JSON.stringify(ut) + ' usage_today ' + JSON.stringify(st.usage_today) + ' expected ' + expected);
  rec('F1 usage_total equals the sum of the fixture turns', sum(ut) === expected, `${sum(ut)} vs ${expected}`);
  rec('F2 usage_today equals usage_total (all turns happened today)', sum(st.usage_today || {}) === expected);
  const s1 = st.sessions.S1; rec('F3 per-session usage and context recorded (S1: 3 turns, last_context>0)', s1.usage && s1.usage.turns >= 3 && s1.last_context > 0, JSON.stringify(s1.usage) + ' ctx ' + s1.last_context);
  fs.writeFileSync(L.HERE + '/solo-state-final.json', JSON.stringify(st, null, 1));
  wait.kill();
})().catch((e) => { console.error(e); process.exit(1); });
