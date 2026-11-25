# 팀장 인수인계 #004 (2026-11-26)

이전 팀장: `e3346acf-08dc-4c77-a4a4-4588e678c869`. 교대 사유: M-1c 교대 지점(시작 3.55만 + 10만) 도달.
고정 규칙은 `docs/teams/skill-ddashboard/lead-rules.md`에 있습니다. 반드시 먼저 읽으세요. 설계는 `docs/plan-0.3.0.md`의 M절만 읽습니다.

## 1. 상태

- **브랜치:** `feature/team-mode`, push 완료(이 문서 커밋까지).
- **설치본:** 2e2ba9e까지 설치했습니다. 그 뒤 b872bdd(이미 ended인 팀원에게 end하면 아무것도 하지 않음)는 아직 설치하지 않았습니다. M-2 채택분과 함께 설치합니다.
- **테스트:** `node test/team.test.js` 79/79, `node test/qa-dead-member.test.js` 7/7
- **이번에 끝낸 것:** M-1c(상대 교대 지점, 6천 토큰 상한, lead-rules.md), M-1d(실행 방식 설정 runner_lead/runner_member: headless|orca|window, 기본 headless, 대시보드 선택 상자), BUG-001(죽은 팀원 ended 표시, `T end`, 대시보드 '종료' 버튼), BUG-002·003(Windows 창 실행, 프로세스 트리 종료). QA가 실제 Orca에서 검증을 마쳤습니다(docs/qa/verify-002~004.md).

## 2. M-2 실험 결과 (마스터 판단 대기)

`docs/research/experiment-001.md`에 정리했습니다. 요약: A(혼자 Opus)와 C(팀장 + Sonnet)는 정확했고, B(2세션 분담)는 경계에서 버그 1건이 나왔습니다. C가 가장 빨랐고(5.4분) 캐시 읽기도 가장 적었습니다. 비용 차이는 약 25% 이내입니다.
**추천:** A를 채택하고, C의 추가 테스트(수동 보관 해제, lead_missing에서 key 버리기, i18n)를 더합니다. 마스터에게 이 추천을 카드로 올렸고, 아직 답이 없습니다.

승인되면: exp/a를 feature/team-mode 위로 rebase(또는 cherry-pick) → C 테스트 추가(팀원이나 서브에이전트) → 테스트 → push, 설치, 재시작 → exp/b, exp/c 브랜치와 worktree exp-a/b/c 삭제(`orca worktree rm`) → 실험 세션 종료.

## 3. 세션

| sid | 역할 | 상태 | 비고 |
|---|---|---|---|
| 7aeb8889 | handoff 팀원 (Opus, Orca) | 대기 | 맥락이 큽니다. 새 큰 작업에는 새 팀원을 쓰세요 |
| f7c85caa | qa 팀원 (그룹 qa, Orca) | 대기 | **QA 결과 전담**(마스터 지시). 시험용 팀원과 check 처리, 정리까지 맡고 팀장에게는 요약만 보냅니다 |
| b53964ef | 실험 A (팀 밖, Orca 'exp A') | 끝남 | 채택 결정 뒤 종료 |
| cec9394b, e75ecde6 | 실험 B1, B2 (팀 밖) | 끝남 | 종료 대상 |
| ac640681 | 실험 C 팀장(팀 exp-c) + 팀원 d4329088 | 끝남 | 종료하고 팀 exp-c 해제 |

팀 밖 세션(A, B, C 팀장)은 `T end`로 끌 수 없습니다. Orca 터미널을 닫으세요(`orca terminal list`에서 'exp ...' 제목). C 팀은 그 팀장 세션에서 solo로 해제하거나, 대시보드에서 정리합니다.

## 4. 다음 할 일

1. 마스터 답 확인(M-2 채택안)
2. M-2 마무리(2절)
3. `docs/research/lead-handoff-001.md`에 측정 추가: #003(마스터 입력 약 18, 맥락 4.9만→15.1만, 캐시 읽기 약 700만 이상, 출력 약 3만), #004(마스터 입력 약 14, 맥락 3.55만→약 14만)
4. M-3: 브라우저 QA(en/ko/zh, solo/team, 여러 팀, 그룹, 정리, + member, 실행 방식 선택, 종료 버튼)는 QA 팀원에게 맡깁니다 → 마스터 직접 테스트 → 0.3.0 버전, CHANGELOG, README → 배포(승인 후). 화면에서 peer_talk, qa_direct를 숨깁니다.
5. M-3 후보: 팀장 세션 고정 비용(약 3.5만: MCP, 스킬) 줄이기 조사

## 5. 이번 교대 중 마스터 결정

- 새 세션 실행 방식의 기본값은 headless이고, 대시보드 설정에서 바꿉니다. 팀장 교대는 `--orca`로 해서 마스터에게 보이게 합니다.
- QA 결과는 QA 팀원이 전담합니다.
- 해제된 팀원은 재합류하지 않습니다(현재 동작 유지). backend 팀원은 종료했습니다.
- M-2 구성(A, B 2세션, C 별도 팀)을 승인했습니다.
