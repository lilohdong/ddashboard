# qa handoff


## 한 일
- 8756f6d(11·13단계) QA 완료, 전부 PASS: docs/qa/verify-011-031.md (증거·스크립트: notes/verify-011-031/)
- 실데이터 복사본 마이그레이션(schema 2, 카드 181/답글 81/세션 19/프로젝트 1 동일), 재시작 멱등, retention 범위, 대시보드 라이트/다크, POST Origin/413/오류 코드, test/run.js 18/18.

## 열린 항목
- F1(낮음): Origin 헤더 없는 POST가 허용됨(router.js sameOrigin의 !origin).
- F2(낮음): POST /api/settings {} 가 lang을 지움(200).
- F3(사소): JSON 배열 본문이 400이 아니라 handler 오류로 끝남.
- 이전 항목: handoff-008의 F1/F2, 고아 wait 정리 범위, 이미 ended인 Orca 팀원 end 메시지.
