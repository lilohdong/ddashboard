# qa handoff 008

## 한 일
- 0.3.0 리팩터(45d6fe8) QA: 접힘, stopped, key 교체, 보관, 대시보드(라이트/다크), GET /api/state mtime, 죽은 멤버 gone, 잘못된 hook 입력 모두 PASS: docs/qa/verify-009-030.md
- 증거와 스크립트(drive.mjs, ui.mjs): notes/verify-009-030/

## 열린 항목
- F1(낮음): 빈/비JSON stdin의 hook이 활성 프로젝트에서 'unknown' 세션을 등록하고 규칙 텍스트를 출력함(로그 없음).
- F2(사소): stopped 배지 색이 wip와 같은 회색.
- 이전 항목: 고아 wait 정리 범위(handoff-007), 이미 ended인 Orca 팀원 end 메시지(verify-004).
- 교훈: git archive 복사본엔 .git이 없어 core.test.js 1건이 실패함(코드 문제 아님). bash에서 만든 /tmp 경로는 node에 cygpath -m으로 넘김.
