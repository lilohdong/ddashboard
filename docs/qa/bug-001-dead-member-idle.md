# BUG-001: 죽은 팀원이 idle(살아 있음)로 계속 보임

- 상태: 수정됨 (feature/team-mode, 'fix: dead team members shown as alive (BUG-001)' 커밋). 수정안 1~4와 6(`team.js end`, 대시보드 '종료' 버튼)을 반영. 5(orca-launch.js의 exit 기록)는 하지 않음
- 심각도: 중간. 팀장이 죽은 팀원에게 일을 맡겼다고 믿고 기다리며, `send`가 엉뚱한 경로를 탈 수 있음
- 자동 테스트: `test/qa-dead-member.test.js` (버그 4건 FAIL, 대조 3건 PASS)
- 발견: 2026-11-25, feature/team-mode @ 18dd48f

## 증상

팀원의 Orca 터미널을 닫아 claude 프로세스가 죽어도 `team.js <lead> list`와 대시보드 사이드바가 그 팀원을 `idle`로 보여 준다.
작업 중(`working`)에 죽으면 영원히 `working`으로 남고, 그때는 대시보드의 `Mark ended`도 거부된다.

## 실제 사례 (읽기만 해서 확인)

| 항목 | 값 |
|---|---|
| 세션 | backend `00a0f258-4ca7-418a-8b7a-29c41861e0e6`, runner `orca`, headless `false` |
| sessions.json | `state: "idle"`, `ended` 없음, `last_seen 2026-11-25T20:07:28Z`, `claude_pid 29728` |
| `process.kill(29728, 0)` | `ESRCH` (죽음) |
| `orca terminal show --terminal term_aa7e28ba-…` | `connected:false, writable:false, orphaned:true` |
| `team.js e3346acf… list` | `00a0f258…  backend  idle orca \| last: done "종료 지시 확인, 할 작업 없음"` |
| `GET /api/state` | `view: "idle", unresponsive: false, waiting: false` |

참고: 이 팀원의 마지막 카드는 "`/exit`가 지시문 글자로 와서 세션을 닫지 못함"이었다. 사용자가 터미널을 직접 닫았고, 그 뒤 SessionEnd 훅은 돌지 않았다.

## 재현 단계

수동 (Orca 필요):
1. 팀 모드 팀장에서 `team.js <lead> spawn --orca --role be "아무 일"` → Orca 터미널에 팀원이 뜬다.
2. 팀원이 한 턴을 끝내고 카드를 남길 때까지 기다린다 (Stop 훅 → `state: idle`).
3. Orca에서 그 터미널 탭을 닫는다 (`/exit`가 아니라 창/탭 닫기). 또는 작업 중에 닫는다 (→ `working`인 채로 죽음).
4. `team.js <lead> list` → 여전히 `idle`(또는 `working`). 대시보드도 `Idle`.
5. `STALE_MIN`(60분)이 지나면 대시보드에 `unresponsive` 태그와 `Mark ended` 버튼만 생긴다. `working`으로 죽었으면 버튼도 없고 `markEnded`는 409.

자동: `node test/qa-dead-member.test.js` (가짜 orca: `DDASH_ORCA_BIN`, 가짜 claude: `claude-code/cli.js`를 돌리는 node, 죽은 pid는 테스트가 직접 띄웠다가 끝낸 프로세스).

```
FAIL QA-B001-1 list: ... dead member listed as "idle" (bug-001)
FAIL QA-B001-2 list: ... dead member listed as "working" (bug-001)
FAIL QA-B001-3 dashboard /api/state: ... shows the dead member as "idle" (unresponsive=false)
FAIL QA-B001-4 dashboard: ... markEnded refused a dead member: session is active (working, waiting or seen recently)
ok   QA-B001-C1..C3 (대조: 살아 있는 팀원, 옛 기록, headless finished)
3/7 passed
```

## 원인

### sessions.json의 `state`는 누가 언제 쓰나

| 쓰는 곳 | 시점 | 값 |
|---|---|---|
| `lib.registerSession` (SessionStart/프롬프트 훅) | 세션 시작·재개 | `working` 유지, 아니면 `idle`; `ended` 지움 |
| `hooks/prompt-submit.js` → `setState` | 프롬프트 제출 | `working` |
| `hooks/stop-card.js:193` | 턴 끝 (Stop 훅) | 남은 메시지 있으면 `working`, 없으면 `idle` |
| `wait-inbox.js:37` | 대기 명령이 메시지를 받음 | `working` |
| `team.js` spawn/send/sendOrca | 팀원 시작·재개·입력 | `working` |
| `hooks/session-end.js` → `setState(..., 'ended')` | **SessionEnd 훅** | `ended` |
| `lib.performHandoff` | 팀장 교대 | 옛 팀장 `ended` |
| `lib.markEnded` (대시보드 `Mark ended`) | 사용자 클릭, idle + stale + 대기 명령 없음일 때만 | `ended` |

즉 `ended`로 바뀌는 자동 경로는 **SessionEnd 훅 하나**뿐이다. Orca 터미널을 닫으면 PTY와 그 안의 프로세스가 강제로 끝나 SessionEnd 훅이 돌지 않는다(사례의 sessions.json에 `ended`가 없음). 그래서 마지막 Stop 훅이 쓴 `idle`이 그대로 남는다.

### 생존 확인은 있나

- `team.js cmdList` (`scripts/team.js:317`): `headless && pid && !alive(pid)`일 때만 `finished`. **Orca 팀원은 확인하지 않는다.** `claude_pid`도 `orca.writable(handle)`도 보지 않는다.
- `server.js /api/state` (`scripts/server.js:127-129`): `view`는 `ended > working > waiting > idle`를 sessions.json 값만으로 고른다. **pid·터미널 확인 없음.** 유일한 보조 장치는 `unresponsive` = idle + 대기 명령 없음 + `last_seen`이 `STALE_MIN`(60분) 넘음. 그래서 죽은 직후 60분 동안은 아무 표시가 없고, 그 뒤에도 `view`는 `idle`이다.
- `lib.markEnded` (`scripts/lib.js:1217`): `state === 'working'`이면 거부. 작업 중에 죽은 팀원은 사용자가 정리할 수 없다(사이드바 `Clear ended`도 ended만 지움).
- 확인 수단은 이미 있다: `lib.alive(pid)`, `lib.isClaudeProcess(processTable().get(pid))`, `orca.writable(handle)`, 그리고 spawn 시 SessionStart 훅이 `claude_pid`를 기록한다(`session-start.js:23`, `prompt-submit.js:64/88`). 다만 `list`/`/api/state`가 쓰지 않을 뿐이다. `sendOrca`는 `orca.writable`을 봐서 닫힌 터미널이면 새 터미널로 재개하므로 `send` 자체는 대체로 맞게 동작한다(표시만 틀림).

## 수정안 (제안만, 미적용)

1. **생존 판정 함수 하나** — `lib.memberGone(s)` (이름 예시):
   - `isEnded(s)` → 이미 끝.
   - `waitPid(sid)` 살아 있음 → 살아 있음.
   - `s.claude_pid`가 있으면: `!alive(pid)` → 죽음. (pid 재사용 대비는 비싼 `processTable()` 대신 `claude_pid_started` 같은 시작 시각을 기록해 비교하거나, 비싼 확인은 `list`에서만.)
   - `runner === 'orca'`이고 `claude_pid`가 없으면 `orca.writable(handle) === false` → 죽음 (Orca 호출이 느리므로 서버에서는 캐시).
   - `headless`면 지금처럼 `pid`.
2. **`team.js list`**: 위 함수로 `gone`이면 `ended`(또는 `gone`)로 표시. 가능하면 sessions.json에 `state:'ended', end_reason:'gone'`도 기록.
3. **`/api/state`**: 같은 판정을 `idle`/`working`인 세션에만 적용(`alive(pid)`는 싸다). 죽었으면 `view: 'ended'`로 보이고 `end_reason:'gone'`을 기록해 `Clear ended`로 지울 수 있게 한다. Orca 확인은 몇 초 캐시.
4. **`markEnded`**: `claude_pid`가 죽었으면 `working`이어도 허용.
5. (부수) SessionEnd에만 기대지 않기: `orca-launch.js`가 자식 claude의 `exit`를 받으면 그 세션을 `ended`로 표시할 수 있다(터미널을 닫으면 launcher도 같이 죽으므로 이것만으로는 부족; 1~3이 주 수정).
6. (관련 관찰, 별건) 팀장의 `/exit` 지시가 `orca terminal send`로 글자로 붙여 넣어져 슬래시 명령으로 실행되지 않았다. 팀원을 끝내는 정식 경로(`team.js <lead> stop <member>`: claude_pid 종료 + ended 기록)가 있으면 이런 일이 줄어든다.

테스트 `QA-B001-1..4`가 수정의 수용 기준이다. 대조 `C1`(살아 있는 Orca 팀원은 idle 유지), `C2`(pid/handle 없는 옛 기록은 죽었다고 추측하지 않음), `C3`(headless finished 유지)는 수정 후에도 통과해야 한다.
