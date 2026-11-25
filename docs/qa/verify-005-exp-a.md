# VERIFY-005: 실험 001 방식 A (카드 작업 key) 검증

- 대상: 브랜치 exp/a, 커밋 b34efd0, worktree `C:/Users/rhkdr/orca/workspaces/claude-team-dashboard/exp-a`
- 방법: 코드 읽기, 그 worktree에서 테스트 실행, 그 worktree의 `server.js`를 **임시 보드(DDASH_BOARD_DIR)와 임시 포트(7991/7994)**로 띄워 API와 Orca 내장 브라우저로 화면 확인
- 하지 않은 것: push, 설치본(`~/.claude/plugins/cache`) 변경, 실제 보드(`~/.ddashboard`) 쓰기, exp-a 세션 조작. 임시 서버, 보드, 브라우저 탭은 끝난 뒤 지움

## 결과 요약

| 항목 | 결과 |
|---|---|
| 테스트 | team.test.js 84/84, qa-dead-member 7/7 (exp-a worktree) |
| 같은 프로젝트·같은 key에서는 최신 카드만 남음 (다른 세션 포함) | **통과** |
| 다른 프로젝트의 같은 key는 영향 없음 | **통과** |
| 팀원 보고(via_lead)와 project_key 없는 옛 카드는 대체에 참여하지 않음 | **통과** |
| 화면: `#key · 이전 N개` 태그, en/ko/zh 문구 | **통과** (ko로 실제 화면 확인, 세 언어 키는 테스트로 확인) |
| 태그 클릭 → 전체 이력 검색 | 동작함. 다만 이력이 정확하지 않음 (F2) |
| 지적 | 6건: 중간 2, 낮음 4 (아래) |

## 실행 근거

임시 보드에 카드 11장을 직접 넣음 (분 = 지금으로부터 몇 분 전):

| id | key | project_key | 비고 |
|---|---|---|---|
| a1 / a2 / a3 | login-fix | pk1 | 30분 / 20분(다른 세션 S2) / 10분 |
| b1 | login-fix | pk2 | 다른 프로젝트 |
| c1 | fix | pk1 | key가 login-fix의 일부 문자열 |
| d1 | login-fix | pk1 | via_lead (팀원 보고) |
| e1, e2 | old | 없음 | 옛 카드 |
| f1 / f2 / f3 | unarch | pk1 | 50 / 45 / 44분 |

```
/api/state         : f3(prev 2) e1 e2 b1 c1 a3(prev 2)   archived_count 4  (a1 a2 f1 f2 대체됨)
/api/state?reports : f3(prev 2) e1 e2 b1 c1 d1 a3(prev 2)
search login-fix   : a3 d1 a2[A] b1 a1[A]
search fix         : a3 d1 c1 a2[A] b1 a1[A]
f1 보관 해제 뒤     : f1(prev 2) f3(prev 2)
```

화면(Orca 내장 브라우저, ko): 카드 제목 앞에 `#login-fix · 이전 2개`, `#fix`, `#old` 태그가 보임. a3의 태그를 누르면 검색창에 `login-fix`가 들어가고 "전체 카드에서 'login-fix' 검색 결과: 5"가 나옴. 결과는 a3, d1(팀장에게 보고), a2(보관됨), b1, a1(보관됨) 순서임.

## 지적

| # | 심각도 | 내용 | 제안 |
|---|---|---|---|
| F1 | 중간 | **이미 실행 중인 세션은 key를 모름.** 규칙 문구(`rulesText`)만 바뀌고 `rules_ver`/`mode_ver`는 올라가지 않음. 지금 도는 팀장과 solo 세션은 모드나 언어가 바뀌기 전까지 key 안내를 받지 못함. 실험에서 A 방식의 "사용률"이 낮게 측정될 수 있음 | 설치할 때 규칙 버전을 올려 한 번 다시 주입(예: 규칙 문구 버전 상수를 `rules_ver` 비교에 포함) |
| F2 | 중간 | **이력 검색이 정확하지 않음.** 태그를 누르면 key로 **부분 문자열 전체 검색**을 함. ① 다른 프로젝트의 같은 key(b1)가 섞임 ② 짧은 key(`fix`)는 다른 key의 카드(login-fix)와 제목·details에 그 글자가 있는 카드까지 섞임. 대체 규칙은 프로젝트별인데 이력은 전역이라 서로 맞지 않음 | `/api/search`에 `key=<k>&project_key=<pk>` 정확 일치 필터를 추가하고, 태그 클릭은 그 필터를 씀 |
| F3 | 낮음 | 여러 팀(M-1b)이 같은 저장소에 있으면 key 범위가 프로젝트라서, 팀 A 팀장의 `login`이 팀 B 팀장의 `login` 카드를 대체함 | 의도라면 README에 밝히기. 아니면 범위를 프로젝트 + 팀으로 (팀 이름을 카드에 저장) |
| F4 | 낮음 | 대문자나 공백이 든 key(`Login-Fix`, `login fix`)는 **조용히 버려짐.** 모델이 대문자로 쓰면 대체가 일어나지 않고 알림도 없음 | 소문자로 바꾸고 공백을 `-`로 바꾼 뒤 검사 (또는 버릴 때 다음 턴에 한 줄 알림) |
| F5 | 낮음 | 보관을 해제한 옛 카드(f1)도 `이전 2개`로 표시됨. `key_prev`가 카드의 위치와 관계없이 "그룹 수 - 1"이라서, 가장 오래된 카드에도 이전 카드가 2개 있다고 나옴 | 그 카드보다 이전 카드 수로 계산하거나, 최신 카드에만 `key_prev` 붙이기 |
| F6 | 낮음 | 판단 확인: lead_missing 팀원 카드는 보드에 올라가지만 key는 버려짐(`route.role === 'member'`). 팀장이 사라진 동안 팀원이 같은 작업 카드를 여러 번 내면 쌓임. 보관 해제가 대체보다 우선하는 것은 맞는 판단으로 보임(사용자 조작 우선) | lead_missing이면 key를 유지할지 결정 필요 (지금도 동작은 일관됨) |

참고: 위 결과의 d1은 via_lead 카드에 key를 직접 넣은 시험용 데이터임. 실제로는 stop-card가 팀원 카드의 key를 지우므로 d1처럼 key로 섞이지는 않음. 다만 제목·details에 그 글자가 있으면 F2 때문에 섞임.
