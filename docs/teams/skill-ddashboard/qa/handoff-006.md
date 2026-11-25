# qa handoff 006

## 한 일
- BUG-004(카드 드래그/선택이 3초마다 풀림, Details 스크롤 0으로) 실제 Chrome(headless+CDP)으로 7357에서 재현, 원인과 수정안 작성: docs/qa/bug-004-drag-reset.md (커밋 d1a912c 외 1).
- 증거: notes/bug-004-repro.mjs(재현 스크립트), notes/bug-004-repro-output.json.

## 열린 항목
- BUG-004 구현 후 검증: 격리 서버(DDASH_PORT=7361, 임시 DDASH_BOARD_DIR)에서 repro.mjs 재실행.
- (verify-004) 이미 ended인 Orca 팀원에게 end하면 closed라고 다시 보고함(낮음).
