# 팀장 인수인계 #001 (2026-11-25)

이전 팀장 세션: `d0504315-19ba-41a2-b07f-656b621ac05f` (맥락 약 50만 토큰에서 교대)
이 문서만 읽고 팀장 업무를 이어 받는다. 저장소 전체를 탐색하지 말 것.

## 1. 프로젝트

- **ddashboard**: Claude Code 플러그인. 세션 결과를 로컬 대시보드 카드로 모으고, 카드 답글을 세션에 전달. 카드 기록·답글 대기는 훅과 로컬 스크립트가 처리(모델 토큰 0).
- 저장소: https://github.com/lilohdong/ddashboard (공개, MIT). 로컬 팀장 worktree: `C:/Users/rhkdr/orca/workspaces/claude-team-dashboard/skill-ddashboard` (브랜치 `lilohdong/skill-ddashboard`, develop 추적).
- 구조: `scripts/lib.js`(경로·세션·안내문), `scripts/cards.js`(카드 인덱스·검색·보관), `scripts/server.js`(API), `scripts/dashboard.html`(화면), `scripts/hooks/*.js`(SessionStart, UserPromptSubmit, Stop, SessionEnd), `scripts/wait-inbox.js` + 고정 경로 `~/.ddashboard/bin/wait.js`.
- 이 PC 설치본: 0.2.0 (`C:/Users/rhkdr/.claude/plugins/cache/ddashboard/ddashboard/0.2.0`), 0.2.1 수정 파일(cards.js, dashboard.html)을 덮어써 둔 상태. 대시보드 http://127.0.0.1:7357.

## 2. 마스터(사용자)와 일하는 규칙

- 사용자는 **마스터**, 팀장은 마스터의 유일한 창구.
- **터미널 답변은 한두 줄, 내용은 카드로.** 카드는 한국어. 긴 내용은 `details`, 계획 문서 등은 파일로 쓰고 경로를 카드에.
- 대시보드 답글은 대기 명령(`node "C:/Users/rhkdr/.ddashboard/bin/wait.js" <세션ID>`)으로 받는다. **반드시 Bash 도구의 백그라운드 실행(run_in_background)으로** 띄울 것. 셸의 `&`로 띄우면 하네스가 추적하지 않아 깨어나지 못한다(이전 팀장이 여러 번 실수함).
- 배포·공개 등 외부로 나가는 일은 마스터 승인 후. 마스터는 배포 전 **직접 테스트**를 원함.
- 의견을 물을 때는 추천안을 같이 제시.

## 3. Git 규칙 (절대)

- Git Flow: `main`, `develop`, `feature/*`, `release/*`, `hotfix/*`. main/develop에 직접 커밋 금지.
- **머지 커밋 금지**: PR은 "Rebase and merge", main은 develop에서 fast-forward.
- 커밋 작성자는 사용자 git 설정(noreply 주소 `57087472+lilohdong@users.noreply.github.com`). **Co-Authored-By: Claude, "Generated with Claude Code" 등 Claude 표기 절대 금지.**
- 커밋 메시지·코드·주석·README는 영어. README.ko.md는 한국어 번역본(둘 다 같이 수정).

## 4. 진행 상태

- **배포:** 0.2.0 (검색·보관·details·replaces·고정 대기 경로·Replied 표시).
- **0.3.0 대기 중인 브랜치:**
  - `feature/token-meter` (커밋 3개, 미병합): 턴별 토큰·맥락 크기·깨운 원인 기록, 사이드바 표시. 헤드리스 팀원이 작업함.
  - `hotfix/needs-you` (PR #3, 대상 develop, 미병합): 보관된 카드·종료된 세션의 needs you 제거. 커밋에 버전 0.2.1이 들어 있으니 0.3.0 통합 때 버전 정리 필요.
- **마스터 결정:** 0.2.1은 따로 배포하지 않고 0.3.0에 합쳐 배포.

## 5. 0.3.0 계획 (전문: `docs/plan-0.3.0.md`)

- **모드:** solo(기본, 모든 세션 직접 보고) / team(팀장만 대시보드, 팀원 보고·마스터 답글은 팀장에게). 전환은 **명령어 + 대시보드 화면 둘 다**(확정). 개발론은 강제하지 않고 team 기본값 + 가이드 문서.
- **팀원:** 역할(기획/프론트/백/QA), 등록은 지시문 태그 `[ddash role=.. lead=..]`. 통신은 ddashboard 인박스(Orca 의존 금지, Orca는 선택 어댑터). 팀원은 **헤드리스 `claude -p`** 실행 가능(검증됨).
- **비용 장치:** 프로젝트 브리프(프롬프트 캐시 공유), 보고 묶어 받기, 보고는 짧게·근거는 파일, 팀장 맥락 상한·교대, 작업 key(같은 key 새 카드가 이전 카드 대체), 카드 언어 설정, 응답 없는 세션 표시.
- **실험:** 혼자 / 직접 보고 / 팀장 경유 3방식 비교로 기본값 결정.
- **단계:** 1단계 측정(완료, 미병합) → 2단계 역할·통신·모드 → 3단계 비용 장치 → 4단계 실험 → 0.3.0 배포.

## 6. 측정 자료 (연구용)

- 헤드리스 팀원(토큰 미터 작업): 모델 턴 51, 캐시 읽기 464만, 출력 4.1만, 최대 맥락 11.8만, 약 $2.54(Opus 5.5), 권한 거부 0.
- 발견: 헤드리스 팀원이 대기 명령을 띄우면 종료하지 않고 대기함. 인박스 답글로 깨어나 정상 종료 확인 → "대기형 상주 팀원" 가능.
- 이전 팀장 세션(교대 직전): 모델 턴 302, 캐시 읽기 9,232만, 출력 30.7만, 현재 맥락 50.7만(최근 20턴 평균 50만).
- 교대 분석: `docs/research/lead-handoff-001.md`.

## 7. 다음 할 일

1. 교대 후 첫 카드: "팀장 교대 완료" + 이 문서를 읽고 파악한 요약(마스터가 인수인계 품질을 평가할 수 있게).
2. 2단계(역할·통신·모드) 상세 설계를 `docs/plan-0.3.0.md`에 추가하고 마스터 검토 받기.
3. 교대 후 턴당 맥락 크기를 기록해 연구 문서에 추가(교대 효과 측정).
