# qa handoff 007

## 한 일
- Track D(c5f4e43) QA: 격리 서버(7358)에서 old(698663d) vs new 라이트/다크 스크린샷, repro-b, +멤버 폼, 그룹 삭제/추가, 모드/러너 select, 보관/복원 모두 PASS: docs/qa/verify-008-track-d.md
- 증거와 스크립트: docs/teams/skill-ddashboard/qa/notes/verify-008/

## 열린 항목
- 서버 시작 때 "stopped an orphan wait command"가 내 보드와 무관한 fixture pid(SOMEONE-ELSE, X3)에 대해 찍힘. BUG-005 정리가 머신 전체를 보는지 확인 필요.
- (verify-004) 이미 ended인 Orca 팀원에게 end하면 closed라고 다시 보고함(낮음).
- 교훈: 격리 서버 시작 전 포트 점유(Get-NetTCPConnection)를 확인하고, 종료는 PID로만.
