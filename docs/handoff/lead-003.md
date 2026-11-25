# 팀장 인수인계 #003 (2026-11-26)

이전 팀장 세션: `ae1a1cd5-078c-4065-9821-d86e4b0086ce`. 교대 사유: 맥락 15.1만 > 15만.
M-1c 원칙대로 **이 문서는 현재 상태만** 담습니다. 이전 인수인계 문서는 읽지 마세요. 고정 규칙은 아래 1절에 있습니다(M-1c가 끝나면 `docs/teams/skill-ddashboard/lead-rules.md`로 옮깁니다). 설계는 `docs/plan-0.3.0.md`의 M절(M-1b, M-1c, M-2, M-3)만 읽으세요.

## 1. 고정 규칙 (요약)

- 사용자는 **마스터**입니다. 터미널 답변은 한두 줄로 하고, 내용은 한국어 카드에 씁니다. 의견을 물을 때는 추천안을 함께 냅니다. 새 기능은 plan에 판정과 추천안을 먼저 쓰고, 승인을 받은 뒤 구현합니다.
- 대기 명령은 반드시 Bash의 run_in_background로 띄웁니다. 끝나면 출력 읽기(cat)와 재실행을 같은 응답에서 병렬로 합니다.
- Git Flow를 따르고 머지 커밋은 만들지 않습니다(rebase, main은 ff). 커밋, 코드, README는 영어로 쓰고, README.ko.md는 함께 고칩니다. **Claude 공동 작성자 표기와 "Generated with Claude Code"는 절대 넣지 않습니다.**
- 배포 등 외부로 나가는 일은 마스터 승인 후에 합니다. 마스터는 배포 전에 직접 테스트합니다.
- **맥락을 아끼세요.** 코드 리뷰와 디버깅은 서브에이전트(general-purpose)나 팀원에게 맡기고 결론만 받습니다. 큰 출력은 필요한 줄만 거릅니다. #003은 직접 디버깅하다가 맥락을 빨리 썼습니다.

## 2. 상태

- **브랜치:** `feature/team-mode`, push됨(마지막 9aa9a21). develop PR은 아직 없습니다.
- **설치본:** `~/.claude/plugins/cache/ddashboard/ddashboard/0.2.0`에 scripts/, skills/dashboard/SKILL.md, README를 덮어씁니다. 그 뒤 그 scripts에서 서버를 재시작합니다: `node -e "const c=require('./control');(async()=>{c.stop();console.log(await c.start())})()"`
- **설정 백업:** `~/.ddashboard/projects.json.bak-m1b`, `sessions.json.bak-m1b`(M-1b 이전 전). 원래 0.2.0 설치본: `~/.ddashboard/backup-0.2.0-202611260013`
- **테스트:** `node test/team.test.js` → 51/51
- **이번에 끝낸 것:** 교대 자동 종료 검증(정상), '+ member' 중복 제출 방지, 팀장이 하위 폴더에 있을 때 Orca 실행과 팀원 cwd 버그 수정(팀원은 worktree 루트에서 시작), 팀원 권한 기본값 `auto`, **M-1b(저장소당 팀 여러 개, `docs/teams/<팀>/<그룹>/`)** 구현·리뷰·설치. join은 마스터 결정으로 0.3.0에서 뺐습니다.

## 3. 팀원

| sid | 역할 | 상태 | 할 일 |
|---|---|---|---|
| 7aeb8889 | handoff (Opus, Orca) | 작업 중 | **M-1c** 구현. 끝나면 [Team report]가 옵니다 |
| 00a0f258 | backend (Opus, Orca) | 대기 | M-1b 완료. 맥락 27만이라 재사용하지 않습니다. 종료 여부를 마스터에게 물었고, 아직 답이 없습니다 |

## 4. 다음 할 일 (순서대로)

1. **마스터 답 확인:** M-1b 화면 확인 결과, backend 종료 여부, '해제된 팀원은 재합류하지 않음' 동작이 맞는지.
2. **M-1c 보고가 오면:** 서브에이전트로 리뷰 → 수정 요청 → 테스트 → push, 설치, 재시작 → 카드. 그 뒤 고정 규칙(1절)을 `docs/teams/skill-ddashboard/lead-rules.md`로 옮깁니다.
3. **M-2 실험:** 과제 문서는 `docs/research/experiment-001-task.md`(시작 커밋 표기 1dd2ad4 → M-1c 이후 HEAD로 바꿀 것). 이제 M-1b로 팀을 여러 개 둘 수 있으므로 C 방식은 별도 팀(새 팀장)으로 돌립니다. A와 B는 팀 밖 세션으로 직접 보고합니다. 구성을 카드로 확인받은 뒤 시작합니다.
4. **M-3:** 브라우저 QA(en/ko/zh, solo/team, 여러 팀, 그룹, 정리 버튼, + member), 마스터 직접 테스트, 0.3.0 버전 정리와 CHANGELOG, 배포(승인 후). peer_talk와 qa_direct는 화면에서 숨깁니다.
5. **M-3 후보(발견한 문제):** Orca 터미널을 닫아 팀원을 끄면 기록이 idle로 남습니다. `team.js end <sid>` 명령을 추가할 것. 팀장 세션의 고정 비용(약 4만: MCP, 스킬)을 줄이는 방법도 조사할 것.

## 5. 마스터 결정 (이번 교대 중)

- join(보고 묶어 받기)은 0.3.0에서 뺍니다.
- 그룹 폴더는 `docs/teams/<팀>/<그룹>/`에 둡니다.
- M-1c: 인수인계 상한 6천 토큰, 교대 상한 = 시작 맥락 + 작업 예산 10만(맥락 창의 80% 이하), 시작 맥락이 맥락 창의 50%를 넘으면 경고. 모두 승인됨.
- 팀원은 auto 권한 모드로 실행합니다.

## 6. 측정 (`docs/research/lead-handoff-001.md`에 추가할 것)

| 팀장 | 마스터 입력 | 맥락(처음 → 마지막) | 캐시 읽기 | 출력 |
|---|---|---|---|---|
| #003 | 약 18 | 약 4.9만 → 15.1만 | 약 700만 이상 | 약 3만 |
