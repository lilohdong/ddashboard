# VERIFY-004: QA 확인 항목(check) 처리와 시험용 팀원 정리

- 날짜: 2026-11-26, HEAD dc9e3e7 (설치본 208929a 이후)
- 처리한 대상: QA 세션(f7c85caa)의 카드와 시험용 팀원(qa-t1~t6, qa-o1, qa-w1, qa-h1)의 카드와 사이드바 줄
- 건드리지 않은 것: 실험 세션(exp-a, exp-b ×2, exp-c와 그 implementer), handoff 팀원(7aeb8889)과 팀장의 카드
- 앞으로: QA 시험용 팀원의 보고와 check는 QA가 받아 처리하고, 팀장에게는 최종 요약만 보냄

## 1. check별 판정

| 카드 | check | 확인 | 판정 |
|---|---|---|---|
| 8kb28 (QA, BUG-001 재현) | bug-001 수정안(memberGone, working인 팀원도 markEnded) 채택 여부 | 8b8cb52에서 채택. `test/qa-dead-member.test.js` 7/7, 실제 Orca에서 0.6초 안에 ended (verify-002) | 해결 |
| 〃 | send로 보낸 `/exit`가 글자로만 들어감, 팀원 종료 명령 필요 여부 | `team.js <lead> end`와 대시보드 '종료' 버튼 추가. orca·window·headless 모두 실제로 확인 (verify-002, 003) | 해결 |
| g5xia (QA, verify-002) | terminal.js에 `.\` 붙이기, taskkill /T 적용 여부 | 208929a에서 적용: `terminal.js:59` `cmd /k .\<script>`, `lib.killTree`. 실제 환경에서 window 프로세스 9개, headless 프로세스 6개가 모두 사라짐 (verify-003) | 해결 |
| 〃 | projects.json에 `spawn.runner_lead/runner_member = headless`가 명시값으로 남음 | 기본값과 같아 동작은 같음. 대시보드 선택 상자를 한 번이라도 바꾸면 똑같이 생기는 값임. 나중에 기본값이 바뀌면 이 프로젝트만 headless로 고정되는 차이뿐임 | **고치지 않음** |
| y1irk (QA, verify-003) | Orca 팀원에게 다시 end하면 'closed its Orca terminal'을 또 보고함 | 코드 확인: `endMember`가 ended 여부와 관계없이 `orca.closeTerminal`을 부르고 성공하면 그대로 보고함. 시각은 지켜짐(`isEnded`이면 기록하지 않음). 해는 없지만 보고가 틀림 | **고칠 것 (낮음)** |
| px5m5, up4ov, tmii3, 3fok2, nn59a (시험용 팀원 '대기 테스트') | "status done 카드가 표시되는지" 등 | 5장 모두 `/api/state?reports=1`에 status done, via_lead로 있음. 팀장에게 [Team report]로 전달됨 | 해결 (시험 목적 달성) |

참고: handoff 팀원 카드 qlkhu의 check "QA가 실제 창에서 --window와 end 재검증 필요"는 verify-003에서 끝남. 이 카드는 handoff 팀원의 것이라 손대지 않았음.

## 2. 고칠 것 목록

1. **(낮음) 이미 ended인 팀원에게 다시 end** — `scripts/team.js` `endMember`: 맨 앞에서 `lib.isEnded(m)`이고 살아 있는 것(claude_pid, waitPid, headless pid, window shell)이 없으면 아무것도 부르지 말고 `done: []`(CLI는 "already ended")로 돌려줌. 터미널 확인이 필요하면 `orca.writable(handle)`이 true일 때만 `closeTerminal`. 테스트: ended인 Orca 팀원에게 end하면 가짜 orca에 `terminal close` 호출이 없는지 확인.

고치지 않음: projects.json의 명시값 runner=headless (위 판정 참조).

## 3. 정리

| 작업 | API | 결과 |
|---|---|---|
| ended 시험용 팀원 줄 제거 (qa-w1 46724871, qa-h1 7c116839, qa-o1 a3db4bcc) | `POST /api/sessions/forget {session_id}` (하나씩. `{project, ended:true}`는 exp-c의 implementer까지 지우므로 쓰지 않음) | 3건 forgotten |
| qa-t1~t6 | — | 이미 사이드바에서 빠져 있었음 (앞선 정리) |
| 카드 보관 8장 (QA 3, 시험용 팀원 5) | `POST /api/archive {card_id, archived:true}` | 8건 200. 최근 목록에 남은 QA·시험용 카드 0장, archived_count 11 → 19 |

남은 것: 사이드바의 QA 세션(f7c85caa, 작업 중). 시험용 팀원 프로세스, 창, Orca 터미널은 없음(verify-003 끝에서 확인). `~/.ddashboard/logs/`의 시험용 로그 파일은 기록으로 남김.

## 4. 앞으로의 방식

- QA 시험용 팀원은 `qa-` 역할 이름으로 띄우고, 보고와 check는 QA가 확인해서 끝나면 바로 end하고, 줄은 forget, 카드는 archive함.
- 팀장에게는 검증 하나마다 최종 요약 카드 하나만 보냄(근거는 `docs/qa/verify-NNN.md`).
