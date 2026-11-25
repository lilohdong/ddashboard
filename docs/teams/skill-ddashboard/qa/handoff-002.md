# qa handoff 002

## 한 일
- 28d8c68 실제 Orca 검증: docs/qa/verify-002.md (커밋 b612e0b).
- 통과: Orca 터미널 close → 0.6초 안에 ended:gone. `team end`(Orca/headless), 대시보드 runner 저장과 `/api/team/end`. BUG-001 QA 테스트는 7/7 통과. team.test.js는 10회 반복해 모두 통과.
- 시험용 팀원 qa-t1~t6는 모두 ended이고 남은 프로세스는 없음. projects.json spawn에 runner headless/headless가 명시값으로 남음(기본값과 같음).

## 열린 항목
- BUG-002: --window 창의 cmd가 `NoDefaultCurrentDirectoryInExePath=1` 때문에 스크립트를 찾지 못해 claude가 시작되지 않음. 수정안은 `cmd /k .\<script>`.
- 창 팀원은 end 뒤에도 빈 cmd 창(/k)이 남음.
- BUG-003: end가 claude만 끄고 자식 도구 프로세스는 고아로 남김. 수정안은 taskkill /T.
- 이미 ended인 팀원에게 end를 다시 하면 ended 시각을 덮어씀.
- 테스트 타이밍 후보: waitFor 5초, withServer 무작위 포트.
