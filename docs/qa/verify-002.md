# VERIFY-002: 실제 Orca 검증 (M-1d, BUG-001 수정)

- 대상: feature/team-mode @ 28d8c68. 설치본 `~/.claude/plugins/cache/ddashboard/ddashboard/0.2.0/scripts`는 저장소와 같음(`wait-inbox.js`만 줄 끝 CRLF 차이). 서버는 재시작된 것(pid 28948 이후)을 씀
- 날짜: 2026-11-26 (KST 05:36~), Windows 11, Orca 앱 실행 중
- 시험용 팀원: 모두 `--model haiku`, 과제 "아무것도 하지 말고 '대기 테스트' 카드 하나만 남기기" (qa-t5는 2분 대기 후 카드)
- 팀장 e3346acf, handoff 7aeb8889 세션은 건드리지 않음. 시험용 팀원 qa-t1~t6은 모두 ended이고 남은 프로세스·터미널 없음(마지막에 확인)

## 결과 요약

| # | 항목 | 결과 |
|---|---|---|
| 1 | `orca terminal close` 뒤 list/대시보드 ended | **통과**. 닫은 뒤 0.6초 안에 `/api/state` ended:gone, 0.9초 안에 sessions.json에 기록 |
| 2 | `team end <role>` (Orca) | **통과**. 터미널 닫힘(writable:false), claude 종료, ended:stopped. 남은 프로세스 없음 |
| 3 | `--window` | **실패 (BUG-002)**. 창은 뜨지만 claude가 시작되지 않음. 원인 확인, 아래 참조. 원인을 피한 실행에서는 시작·카드·end 통과(창은 남음) |
| 4 | `--headless` + `end` | **통과, 단 고아 프로세스 남음 (BUG-003)** |
| 5 | 대시보드 실행 방식 저장 / 팀원 '종료' 버튼 | **통과** (API 기준). 작은 지적 2건 |
| 6 | team.test.js 10회 반복 | **10/10 통과** (75/75 × 10, 회당 25~26초). 실패한 적 없음 |
| + | `test/qa-dead-member.test.js` (BUG-001) | 수정 후 **7/7 통과** |

## 1. Orca 터미널을 닫으면 ended가 되는지

qa-t1 (43ba58e6, term_df68b563): 카드를 남겨 idle이 된 뒤, 250ms마다 sessions.json과 `/api/state`를 읽으면서 `orca terminal close --terminal …`를 실행.

```
0.03s file=idle/      api=idle        claude_pid=24744:true
0.80s (close 실행)
1.36s file=idle/      api=ended:gone  claude_pid=24744:false
1.62s file=ended/gone api=ended:gone  claude_pid=24744:false
list: 43ba58e6…  qa-t1  ended orca | last: done "대기 테스트"
```

예전 사례의 backend 00a0f258도 list에 `ended`로 나옴(나중에 사이드바 정리로 목록에서 빠짐).

## 2. `team end`로 Orca 팀원 끄기

qa-t2 (3dc431fb, claude_pid 25696, term_9976a0ce):

```
$ team.js <lead> end qa-t2      (0.66초)
Ended qa-t2 (3dc431fb): closed its Orca terminal (term_9976a0ce-…). Its cards stay; send resumes it.
pid 25696: dead
orca terminal show: connected:false, writable:false, orphaned:true
list: ended / api: view ended, end_reason stopped
sid가 들어간 프로세스: 없음
```

참고: 메시지에 "stopped Claude"가 없는 것은 터미널을 닫을 때 claude가 먼저 죽어서 `killClaude`가 할 일이 없었기 때문임(정상).

## 3. `--window` (Windows 새 창)

### BUG-002: 창의 cmd가 스크립트를 찾지 못해 claude가 시작되지 않음

qa-t3 (bfaa779a): `Spawned qa-t3 … in a new terminal window`가 나오고 창은 열리지만, 40초가 지나도 `claude_pid`가 없고 `working`에 머묾. 프로세스는 `cmd /k bfaa779a-….window-….cmd`와 conhost뿐이고 node/claude가 없음.

원인 (재현 확인):
- `terminal.js`는 Windows에서 `start "<title>" cmd /k <스크립트 이름>`을 logs 폴더를 cwd로 실행함(이름만 쓰는 이유: cmd 파서 회피).
- Claude Code가 띄운 프로세스에는 `NoDefaultCurrentDirectoryInExePath=1`이 들어 있음(이 세션 env에서 확인). 이 값이 있으면 cmd는 **현재 폴더의 실행 파일·스크립트를 이름만으로 찾지 않음**.
- 그래서 창의 cmd는 "'….cmd'은(는) 내부 또는 외부 명령… 이 아닙니다"를 출력하고 `/k` 때문에 프롬프트로 남음. 팀장은 항상 Claude Code 안에서 `team.js`를 부르므로 **항상** 재현됨.

재현 (가짜 스크립트, 같은 환경):
```
cmd /d /c t.cmd                         -> exit 1, "'t.cmd' is not recognized" (변수 있음)
env 변수 제거 후 cmd /d /c t.cmd        -> exit 0, 스크립트 실행됨
cmd /d /c .\t.cmd   (변수 있음)          -> exit 0, 스크립트 실행됨
```

수정안: `launcher()`의 Windows 명령을 `cmd /k .\<script>`로 바꾸기(이름은 이미 `[\w.-]`만 남으니 파서 문제 없음). 또는 `openWindow`의 spawn env에서 `NoDefaultCurrentDirectoryInExePath`를 지우기(창 안의 cmd에도 상속되지 않게). 전자가 간단하고 확실함. 테스트: env에 이 변수를 넣고 `launcher()`가 만든 명령이 `.\`로 시작하는지 확인하는 단위 테스트 추가 권장.

### 원인을 피한 실행 (수정 후 동작 모사)

`env -u NoDefaultCurrentDirectoryInExePath team.js <lead> spawn --window …` 로 qa-t4 (e8fe8266):

```
5초 안에 claude_pid 9504 기록 (cmd 26060 -> node orca-launch 8892 -> claude.exe 9504)
10초: idle, 카드 "대기 테스트"
$ team.js <lead> end qa-t4
Ended qa-t4 (e8fe8266): stopped Claude (pid 9504).
claude.exe, node 런처 종료됨. list: ended window
남은 것: cmd 26060 (`cmd /k …cmd` 창)  -> 직접 닫음
```

지적(작음): end 뒤에도 빈 cmd 창이 열린 채 남음(`/k`). 창 pid를 기록하지 않아 end가 닫을 수 없음. 제안: 스크립트 마지막 줄에 `exit` 추가(claude가 끝나면 창이 닫힘. 실패 메시지를 보이려면 `if errorlevel 1 pause` 뒤에 exit), 또는 `/k` 대신 `/c`.

BUG-002 상태의 qa-t3에 `end`를 하면 "nothing was running"과 함께 ended가 되지만 창(cmd 16520)은 남음(위와 같은 이유). 직접 닫음.

## 4. `--headless` 팀원 `end`

qa-t5 (1b6a6450, pid = claude_pid = 11888). 과제가 `node -e "setTimeout(…,120000)"`를 포그라운드로 돌리는 중에 end:

```
end 전: claude.exe 11888 -> bash 27136 -> node(2분 대기), git 7952
$ team.js <lead> end qa-t5
Ended qa-t5 (1b6a6450): stopped Claude (pid 11888).
list: ended headless
end 뒤: claude 11888 없음. 그러나 node.exe 2168 ("setTimeout(()=>{},120000)")이 고아로 남음 -> 직접 종료
```

### BUG-003 (작음): end가 Claude만 끄고 그 자식(도구 명령)은 남김

`killPid`는 `process.kill(pid)`(Windows에서 해당 프로세스만 TerminateProcess)라 프로세스 트리를 끄지 않음. 팀원이 긴 빌드·테스트·서버를 돌리는 중에 end하면 그 프로세스가 계속 돈다(포트 점유, 파일 잠금 가능). Orca·창 팀원도 claude를 직접 끄는 경로에서는 같음(Orca는 터미널을 닫으면 PTY 쪽이 정리해서 이번 시험에서는 남지 않았음).
제안: Windows에서는 `taskkill /PID <pid> /T /F`, 그 밖에서는 프로세스 그룹 kill(headless는 이미 `detached`라 `process.kill(-pid)` 가능). `killClaude`의 isClaudeProcess 확인은 유지.

## 5. 대시보드

API로 확인(대시보드가 쓰는 같은 요청, Origin `http://127.0.0.1:7357`):

| 요청 | 결과 |
|---|---|
| `POST /api/settings {project, runner_member:'orca'}` | 200, `/api/state`의 팀 항목과 projects.json `spawn.runner_member`에 저장됨 |
| `{runner_lead:'window'}` | 200, 다른 값(runner_member)은 유지 |
| `{runner_member:'bogus'}` | 400 "runner_member must be one of headless, orca, window" |
| Origin evil.example | 403 |
| 연결 안 된 project | 404 |
| 원래대로 (`headless/headless`) | 200 |
| `POST /api/team/spawn {runner:'orca', model:'haiku'}` (qa-t6) | 200, Orca 터미널, 12초 안에 idle + claude_pid |
| `POST /api/team/end` Origin evil | 403 |
| `POST /api/team/end` 팀장 sid | 404 "not a team member" |
| `POST /api/team/end` qa-t6 | 200 `done:["closed its Orca terminal …"]` 614ms, 그 뒤 view ended / end_reason stopped, claude 종료 |

페이지 코드 확인: 팀원 줄에 `종료`(en End, zh 结束) 버튼(`sessAct`, `s.team === 'member'`이고 ended가 아닐 때), 누르면 `confirm` 후 `/api/team/end`. 실행 방식 선택 상자는 프로젝트 범위에서 `runner_lead`/`runner_member` 둘이고 바뀌면 `/api/settings`로 저장. 3개 언어 키 있음. 화면을 눈으로 본 확인은 하지 않음(API와 코드 기준).

지적(작음):
- 원래 projects.json에 `spawn` 항목이 없었는데, 되돌린 뒤에는 `spawn: {runner_member:'headless', runner_lead:'headless'}`가 남음. 기본값과 같아서 동작은 같음. 지우지 않음.
- 이미 ended인 팀원에게 `/api/team/end`(또는 `team end`)를 다시 하면 200과 함께 "closed its Orca terminal"을 또 보고하고 `ended` 시각을 덮어씀. 이미 끝난 팀원이면 아무것도 하지 않고 `already ended`로 답하는 것을 권장.

## 6. team.test.js 10회 반복

`env -u DDASH_PORT node test/team.test.js`를 차례로 10번 (시험용 팀원·서버가 도는 동안이라 부하가 조금 있는 상태):

```
run1..run10  exit=0  75/75 passed  (25~26s)
```

750번 실행 중 실패 0. 이번에는 불안정한 테스트를 찾지 못함. 다만 타이밍에 기대는 곳이 남아 있어 부하가 크면 실패할 수 있는 후보:
- `waitFor` (test/team.test.js:498): 가짜 claude/창의 출력 파일을 최대 5초(50ms × 100) 기다림. spawn 계열 테스트 10여 곳이 씀. 느린 CI에서 가장 먼저 흔들릴 곳. 15초 정도로 늘리기 권장.
- `withServer`: 포트를 7400~7899에서 무작위로 고르고 5초 안에 뜨기를 기다림. 다른 프로세스가 그 포트를 쓰면 실패(충돌 확인 없음). 포트 0으로 띄우고 실제 포트를 받거나, 충돌 시 재시도 권장.
- test/team.test.js:1040 의 150ms 고정 대기.
