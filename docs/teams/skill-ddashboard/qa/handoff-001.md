# qa handoff 001

## 한 일
- docs/qa/test-cases.md: 팀 모드 테스트 케이스 10개 영역(ST/MT/GR/SP/SN/HO/DB/UI/L/LV), 기존 test/team.test.js 순번(T#)과 매핑.
- docs/qa/bug-001-dead-member-idle.md: 죽은 Orca 팀원이 idle로 보이는 버그. 원인 = ended 자동 기록은 SessionEnd 훅뿐이고, team.js list(:317)·server /api/state(:127)는 claude_pid/orca.writable 생존 확인을 안 함. markEnded는 working이면 거부.
- test/qa-dead-member.test.js: 버그 4건 FAIL, 대조 3건 PASS (가짜 orca, 가짜 claude pid).
- 커밋 97b6132 (docs/qa/, test/qa-* 만).

## 열린 항목
- 수정 미적용(제안만, bug-001 문서 "수정안").
- test-cases.md의 "자동화 가능" 항목은 아직 테스트 없음 (ST-04, SN-06/07, HO-05, LV-08/09 등).
- 별건 관찰: send로 보낸 "/exit"가 글자로 붙여 넣어져 실행 안 됨 (SN-08).
