# VERIFY-003: BUG-002·003 수정 실제 환경 재검증

- 대상: 208929a(BUG-002·003 수정), HEAD 2e2ba9e. 설치본(`plugins/cache/.../0.2.0/scripts`)은 저장소와 같음(줄 끝 차이만 있음). 서버 pid 26280(20:53:13Z 재시작)
- 환경: Windows 11, Orca 실행 중. **`NoDefaultCurrentDirectoryInExePath=1`을 그대로 둔** Claude Code 세션에서 `team.js`를 실행
- 시험용 팀원: `--model haiku`의 qa-w1(window), qa-h1(headless), qa-o1(orca). 모두 ended이고 남은 프로세스·창·터미널 없음
- 팀장(e3346acf)과 handoff(7aeb8889) 세션은 건드리지 않음

## 결과 요약

| 항목 | 결과 |
|---|---|
| --window: 변수를 그대로 둔 채 claude 시작 | **통과** (BUG-002 수정됨) |
| --window end: claude, 도구 자식 프로세스, cmd 창 | **통과**. 9개 프로세스가 모두 사라짐 |
| --headless end 뒤 고아 프로세스 | **통과** (BUG-003 수정됨). 6개 프로세스가 모두 사라짐 |
| 이미 ended인 팀원에게 end | **통과**. `ended` 시각 그대로 (window·headless·orca, CLI와 API) |
| 회귀 | `test/team.test.js` 79/79, `test/qa-dead-member.test.js` 7/7 |

## 1. --window (qa-w1, 46724871)

과제: Bash로 `node -e "setTimeout(()=>{},110000)"`를 포그라운드로 실행. end 시점에 도구 자식이 돌고 있도록 함.

창 스크립트를 이제 `.\`로 부름. 8초 안에 claude_pid가 기록되고 도구 명령이 실행 중:

```
15468 cmd.exe  cmd /k .\46724871-….window-1795640012227.cmd
  1324 conhost.exe
  22824 node.exe  orca-launch.js …
    26092 claude.exe "[ddash role=qa-w1 …"
      1812 bash.exe
        28400 bash.exe
          19564 conhost.exe
          14236 bash.exe
            18680 node.exe -e setTimeout(()=>{},110000)
```

```
$ team.js <lead> end qa-w1        (1.06초)
Ended qa-w1 (46724871): closed its terminal window (pid 15468). Its cards stay; send resumes it.
2초 뒤 위 9개 pid 중 살아 있는 것: 없음. sid나 110000이 들어간 프로세스: 없음
list: ended window / sessions.json: ended, stopped, 20:53:52.398Z
```

## 2. --headless (qa-h1, 7c116839)

같은 과제(`setTimeout(…,110001)`).

```
24088 claude (pid = claude_pid)
  9732 bash.exe
    18732 bash.exe
      11232 conhost.exe
      24048 bash.exe
        5572 node.exe -e setTimeout(()=>{},110001)

$ team.js <lead> end qa-h1
Ended qa-h1 (7c116839): stopped Claude and its tool processes (pid 24088). Its cards stay; send resumes it.
2초 뒤 6개 pid 중 살아 있는 것: 없음 (verify-002에서는 node 도구 프로세스가 고아로 남았음)
```

## 3. 이미 ended인 팀원에게 end

| 팀원 | 첫 end 뒤 `ended` | 다시 end (CLI) | 다시 end (`POST /api/team/end`) |
|---|---|---|---|
| qa-w1 (window) | 20:53:52.398Z | 그대로, "(nothing was running)" | 그대로, `200 {"ok":true,"done":[]}` |
| qa-h1 (headless) | 20:54:24.875Z | 그대로, "(nothing was running)" | — |
| qa-o1 (orca) | 20:54:43.336Z | 그대로 | — |

`last_seen`, `end_reason`(stopped)도 바뀌지 않음.

지적(작음): Orca 팀원(qa-o1)에게 다시 end하면 메시지가 또 "closed its Orca terminal (term_b1c0d50e…)"라고 나옴. 이미 닫힌 터미널에 `orca terminal close`를 다시 부르는 것으로 보임. 해는 없지만 오해할 수 있음. 이미 ended면 "already ended"로 답하고 아무것도 부르지 않는 편을 권장(window·headless는 이미 "nothing was running").

## 4. Orca 팀원 end (qa-o1, a3db4bcc)

4초 안에 idle과 카드. end 하자 터미널이 닫히고 claude_pid 4436이 사라짐. sid가 들어간 프로세스도 남지 않음.

## 정리

시험용 팀원 qa-w1, qa-h1, qa-o1은 ended이고 프로세스·창·Orca 터미널이 남지 않음(마지막에 명령줄 검색으로 확인).
