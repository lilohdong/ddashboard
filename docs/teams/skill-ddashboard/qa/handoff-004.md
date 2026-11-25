# qa handoff 004

## 한 일
- QA check 처리와 정리: docs/qa/verify-004.md. QA 카드 3장과 시험용 팀원 카드 5장의 check를 확인한 뒤 보관했고, ended 시험용 팀원 줄 3개는 forget함.
- brief.md에 QA 범위와 규칙을 적음(시험용 팀원 처리 방식 포함).

## 열린 항목
- 고칠 것(낮음): 이미 ended인 Orca 팀원에게 end하면 다시 closeTerminal을 부르고 그대로 보고함. 수정안은 verify-004 2절.
- 고치지 않기로 함: projects.json의 명시값 runner=headless.
- 테스트 타이밍 후보(verify-002): waitFor 5초, withServer 무작위 포트.
