# qa handoff 005

## 한 일
- exp-a(b34efd0, 카드 key) 검증: docs/qa/verify-005-exp-a.md (커밋 55387f4). 기본 동작은 통과, 지적 6건(F1 규칙 재주입 없음, F2 이력이 부분 문자열 전역 검색, 그 밖에 낮음 4건).
- 격리 서버: exp-a worktree의 server.js를 임시 DDASH_BOARD_DIR과 포트 7991/7994로 실행했음. 7357의 설치본은 건드리지 않음. 앞으로는 팀장이 정한 7358을 씀.
- exp-c는 qa-c가 맡음. QA는 손대지 않음.

## 열린 항목
- (verify-004) 이미 ended인 Orca 팀원에게 end하면 closed라고 다시 보고함(낮음).
- 테스트 타이밍 후보: waitFor 5초, withServer 무작위 포트.
