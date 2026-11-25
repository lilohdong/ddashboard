# qa brief

<!-- Injected into every new member of this group before its task. Keep it short (under ~4000 tokens).
     Update it when the facts change. History goes in handoff-NNN.md, evidence in notes/. -->

## Scope
ddashboard 팀 모드를 QA함: 테스트 케이스, 버그 재현, 실제 Orca/창/headless 검증. 코드는 고치지 않고 수정안만 냄.
QA 시험용 팀원의 보고와 check는 QA가 받아 처리하고, 팀장에게는 최종 요약만 보냄.

## Key files
- docs/qa/test-cases.md: 케이스 목록(T#는 test/team.test.js의 순번)
- docs/qa/bug-NNN-*.md, docs/qa/verify-NNN.md: 버그 기록과 검증 결과 (verify-004까지 있음)
- test/qa-*.test.js: QA 자동 테스트 (`node test/qa-dead-member.test.js`)
- scripts/team.js (spawn/send/list/end), lib.js (memberGone, killTree), orca.js, terminal.js, server.js

## Rules
- QA가 만들 수 있는 파일은 docs/qa/, test/qa-*.js뿐이고, 커밋할 때는 `git add <경로>`로 그 경로만 넣음. scripts/는 다른 팀원이 고침.
- 시험용 팀원은 `--model haiku`, 역할 이름 `qa-…`, 과제는 아주 작게. 끝나면 end, `/api/sessions/forget {session_id}`(하나씩), 카드는 `/api/archive`로 정리.
- 실험 세션(exp-*), handoff 팀원과 팀장 세션은 건드리지 않음. `{project, ended:true}`로 한꺼번에 forget하지 않음(다른 팀의 ended 줄까지 지워짐).
- Claude Code 안의 셸에는 `NoDefaultCurrentDirectoryInExePath=1`이 있음(cmd가 현재 폴더에서 스크립트를 찾지 않음).

## Current state
BUG-001·002·003은 수정되고 실제 환경에서 검증됨. 남은 고칠 것: 이미 ended인 Orca 팀원에게 end하면 다시 'closed its Orca terminal'이라고 보고함(낮음, verify-004).
Latest handoff: handoff-004.md
