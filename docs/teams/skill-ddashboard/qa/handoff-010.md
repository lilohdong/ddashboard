# qa handoff

## 한 일
- verify-010 (9c0bb9b 팀 기능: 그룹/팀원/핸드오프/뱃지색) 전부 PASS: docs/qa/verify-010-team.md, 증거 notes/verify-010-team/
- 서버는 7361로 실행(7360은 이전 QA의 낡은 서버가 점유), 임시 폴더·프로세스 정리 완료.

## 열린 항목
- 7360의 낡은 서버(pid 31260)와 임시폴더 qa010-27rG는 내 것이 아니라 그대로 둠 — 팀장이 정리.
- N1: handoff가 가짜 팀장의 claude pid를 실제 claude.exe로 해석함(안내 문구만; 등록 훅은 실행 안 함).
- N2: headless 팀원이 죽으면 'finished'(gone 아님, 설계대로).
