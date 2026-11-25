# ddashboard 팀 모드 테스트 케이스

기준: feature/team-mode @ 18dd48f (M-1b 여러 팀, M-1c 교대). 대상: `scripts/` 훅·`team.js`·`server.js`·`dashboard.html`·`i18n.js`.

자동화 표기:
- **자동(T#)** — `test/team.test.js`에 이미 있음 (#는 `test(...)` 순번, 이름 앞부분 병기)
- **자동(QA)** — `test/qa-*.test.js`
- **자동화 가능** — 가짜 orca/claude(`DDASH_ORCA_BIN`, `DDASH_CLAUDE_BIN`)와 임시 `DDASH_BOARD_DIR`로 만들 수 있으나 아직 없음
- **수동** — 실제 Orca/claude/브라우저가 필요

공통 전제(따로 적지 않으면): 임시 보드 디렉터리, 대시보드 서버 실행 중, 프로젝트 등록됨, `T` = `node ~/.ddashboard/bin/team.js`.

## 1. solo / team 전환

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| ST-01 | solo 프로젝트(0.2.0 형식, mode 필드 없음) | 세션이 카드를 남김 | 카드가 그대로 대시보드에 감. 규칙 문구가 0.2.0과 같음 | 자동(T5, T10, T16) |
| ST-02 | solo | 세션 A에서 `/ddashboard:dashboard team Alpha` | `teams.Alpha.lead = A`, worktree = A의 cwd, `lead-rules.md` 템플릿 생성 | 자동(T12, T29) |
| ST-03 | 팀 Alpha 있음 | 다른 세션에서 같은 이름 `alpha`(대소문자만 다름) | 거부 | 자동(T51) |
| ST-04 | A가 이미 Alpha의 팀장 | A에서 `team Beta` | 거부 (한 세션은 한 팀만 이끎) | 자동화 가능 |
| ST-05 | 팀 1개 | 팀장에서 `/ddashboard:dashboard solo` | 팀 제거, 팀원 해제(다음 카드부터 직접 게시), 팀 0개면 프로젝트 solo | 자동(T48, T52) |
| ST-06 | 팀 모드 | 모드가 바뀐 뒤 각 세션의 다음 턴 | 새 규칙이 한 번만 주입됨 (`rules_ver`) | 자동(T10, T53) |
| ST-07 | 팀 모드 | 태그 없는 새 세션 시작 | `outside team`, 카드는 대시보드로 직접 | 자동(T24) + 수동(사이드바 태그) |
| ST-08 | 팀 모드 | `/ddashboard:dashboard off` | 프로젝트 비활성, 팀 설정은 다음 on 때 유지 | 자동화 가능 |
| ST-09 | 팀장 세션 종료(handoff 없이) | 팀원이 카드를 남김 | 카드가 `lead_missing`으로 대시보드에 감, 사이드바 `lead missing` | 자동(T7, T15) |

## 2. 한 저장소의 여러 팀

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| MT-01 | 팀 Alpha(L1), Beta(L2) | 각 팀원이 카드 | 각자 자기 팀장 inbox로만 | 자동(T45) |
| MT-02 | 두 팀 | L1에서 `T L1 list` / `send <L2의 팀원>` | L1 팀원만 보임, 남의 팀원은 "no member" | 자동(T45) |
| MT-03 | 두 팀 모두 `front` 그룹 | 각 팀이 그룹 사용, prune | 폴더 `docs/teams/<team>/front/` 분리, 정리는 자기 팀만 | 자동(T46) |
| MT-04 | 두 팀 | Alpha 교대 | Beta 무변화 | 자동(T47) |
| MT-05 | 두 팀 | 사이드바 `remove`로 Alpha 제거 | Beta 유지, 프로젝트는 team 유지 | 자동(T48) + 수동(버튼) |
| MT-06 | 0.2.x 설정(`docs/groups/<g>/`) | 설정 첫 읽기 | `docs/teams/<team>/<g>/`로 이동(tracked면 git mv), mode_ver 증가 | 자동(T49, T53, T54) |
| MT-07 | 두 팀이 다른 worktree | 각 팀이 spawn | 팀원은 그 팀의 worktree에서 시작 | 자동화 가능 |

## 3. 그룹

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| GR-01 | 팀 | `T L group create front` | 폴더 + `brief.md` 템플릿 | 자동(T39) |
| GR-02 | 그룹 front | `group rename front ui` (tracked/untracked) | 폴더 이동(tracked면 git mv), 팀원 group 갱신 | 자동(T39, T40) |
| GR-03 | 그룹 | `group delete front` / `--purge` | `_archived/`로 이동 / 삭제, 팀원 unassigned | 자동(T39) |
| GR-04 | 그룹 brief 있음 | `spawn --group front` | SessionStart에서 brief + 최신 handoff가 작업보다 먼저 주입 | 자동(T43) |
| GR-05 | brief가 약 4000토큰 초과 | spawn | 잘라서 주입, 팀장에게 알림 | 자동(T43) |
| GR-06 | 없는 그룹 | `spawn --group nope` | 오류 코드 1 | 자동(T43) |
| GR-07 | 팀원 2명 동시 종료 | 둘 다 `next-handoff` | 번호가 겹치지 않음 | 자동(T50) |
| GR-08 | handoff 5개, 오래된 notes | prune | 최신 3개, 30일 notes만 남음 | 자동(T42) |
| GR-09 | brief 이후 HEAD가 20커밋 앞섬 | 팀장 턴 종료 | 팀장에게 한 번만 경고, brief 갱신 시 초기화 | 자동(T41) |

## 4. spawn (orca / headless)

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| SP-01 | Orca 꺼짐(`DDASH_ORCA=0`) | `T L spawn --role be --model sonnet "x"` | `claude -p` 백그라운드, 태그 `[ddash role=be lead=L ...]`, 기본 권한, 로그 경로 출력, sessions에 사전 등록(`working`, `pending`) | 자동(T25) |
| SP-02 | Orca 동작 | spawn | `orca terminal create` 호출, runner `orca`, 제목 `role · group`, 같은 사전 등록 | 자동(T30) |
| SP-03 | Orca 동작 | `--headless` | Orca 있어도 headless | 자동(T31) |
| SP-04 | Orca 꺼짐 | `--orca` | 오류 코드 1 | 자동(T31) |
| SP-05 | Orca 동작, 터미널 생성 실패 | spawn | headless로 대체, 이유 출력 | 자동(T31) |
| SP-06 | 하위 폴더 cwd | Orca spawn | worktree 루트로 매핑 | 자동화 가능 |
| SP-07 | 여러 줄 작업, 따옴표·한글 | orca-launch | 프롬프트가 옵션보다 앞, cmd.exe 경로면 줄바꿈 → 공백 | 자동(T34) |
| SP-08 | 실제 Orca | spawn 후 터미널 확인 | 보이는 대화형 claude, SessionStart에서 `claude_pid` 기록 | 수동 |
| SP-09 | `--stay` | spawn | 팀원이 끝나지 않고 대기 명령 유지 | 수동 |

## 5. send

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| SN-01 | headless 팀원 대기 중 | `T L send be "x"` | inbox로, "wakes up now" | 자동(T26) |
| SN-02 | headless 팀원 종료(pid 죽음) | send | 같은 옵션으로 `--resume`, `ended` 제거 | 자동(T26) |
| SN-03 | Orca 팀원, 터미널 열림, 대기/작업 중 | send | inbox로 | 자동(T33) |
| SN-04 | Orca 팀원, 터미널 열림, 프롬프트에서 idle | send | 터미널에 한 줄로 입력 + Enter, `working` | 자동(T33) |
| SN-05 | Orca 팀원, 터미널 닫힘 | send | 새 Orca 터미널로 재개(없으면 headless) | 자동(T33) |
| SN-06 | 역할 이름이 둘 이상 | `send be` | 모호성 처리(첫 번째/오류) 확인 | 자동화 가능 |
| SN-07 | 8000자 넘는 지시 | send | 8000자로 자름 | 자동화 가능 |
| SN-08 | Orca 팀원 idle | `send be "/exit"` | 현재: 글자로 붙여 넣어져 실행 안 됨(BUG-001 관련 관찰). 정식 종료 경로 필요 | 수동 |

## 6. handoff (교대, 6천 토큰 상한, 상대 교대 지점)

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| HO-01 | 팀장 L1, 팀원 M1, inbox 메시지 | 새 세션 첫 프롬프트에 `[ddash lead-handoff from=L1 doc=...]` | 새 팀장이 팀 승계(이름·worktree·그룹 유지), 팀원·메시지 이동, L1 `ended`(handoff), 대기 명령·claude 종료 | 자동(T13, T23) |
| HO-02 | 교대된 L1 | L1에서 프롬프트 / Stop | 프롬프트 거부, Stop에서 한 번 종료 안내 | 자동(T17, T22) |
| HO-03 | 문서 6000토큰 이하 | `T L1 handoff doc` | 첫 프롬프트 출력, `lead-rules.md` 안내 | 자동(T27, T28) |
| HO-04 | 문서 6000토큰 초과(한글 포함) | handoff | 거부, 줄이라는 안내. 한글은 높게 계산 | 자동(T21, T28) |
| HO-05 | `DDASH_HANDOFF_MAX_TOKENS=3000` | handoff | 상한이 바뀜 | 자동화 가능 |
| HO-06 | 시작 컨텍스트 B, 예산 100k | 컨텍스트가 B+100k 넘음 | Stop 훅이 한 번만 교대 지시, 사이드바 `handoff due` | 자동(T18, T37) |
| HO-07 | 교대 지점 계산 | `leadLimit` | min(B+예산, 창의 80%), 최소 B+20k | 자동(T20) |
| HO-08 | 새 팀장 시작이 이미 한도 위 | 첫 턴 | 바로 교대 지시하지 않음(루프 없음) | 자동(T19) |
| HO-09 | 시작 > 창의 절반 | `/api/state` | `large start` 태그 | 자동(T37) 일부 / 자동화 가능 |
| HO-10 | Orca 동작 | `handoff doc --spawn` | `lead <team>` 제목의 Orca 터미널에 새 팀장. `--headless`/`--orca` 강제, 실패 시 headless | 자동(T32) |
| HO-11 | 1M 컨텍스트 모델 | 큰 컨텍스트 관측 | 창이 1M으로 바뀜 | 자동화 가능 |
| HO-12 | 실제 교대 | 사용자 시나리오 끝까지 | 옛 팀장 터미널 종료, 대시보드에 새 팀장, 카드 이어짐 | 수동 |

## 7. 대시보드 카드 / 답장 / 정리 버튼

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| DB-01 | 팀원 카드 | 대시보드 | 기본 숨김, `Member reports: shown`에서 보임, "Report to <lead>", 답장 칸 없음 | 수동 (`?reports=1` API는 자동화 가능) |
| DB-02 | 팀장 카드 | 답장 입력 후 Ctrl+Enter | 팀장 inbox에 들어가 대기 명령이 깨어남, 카드 `Replied` | 자동(T16) + 수동 |
| DB-03 | 끝난 세션의 카드 | 답장 시도 | "This session has ended" | 수동 |
| DB-04 | 카드 | Archive / Unarchive | 최근 목록에서 숨김/복귀, `Archived (n)` | 자동화 가능 |
| DB-05 | ended 세션들 | `Clear n ended` | ended만 사이드바에서 제거, 카드 유지, 빈 inbox 삭제 | 자동(T35, T36) |
| DB-06 | idle, 대기 명령 없음, 60분+ | `unresponsive` 태그, `Mark ended` | ended(`end_reason: marked`) | 자동(T35, T36, T37) |
| DB-07 | 최근에 본 세션 / working | `Mark ended` API | 409 거부 | 자동(T35) |
| DB-08 | 다른 Origin | POST API | 403 | 자동(T36) |
| DB-09 | 카드 검색 | 검색어 입력 | 최근/보관 범위별 결과 | 자동화 가능 |
| DB-10 | **팀원 Orca 터미널 닫힘, claude 죽음** | `T list`, 사이드바 | ended/gone으로 보여야 함. 현재 idle(버그) | 자동(QA: `test/qa-dead-member.test.js`, BUG-001) |
| DB-11 | 팀원이 작업 중 죽음 | `Mark ended` | 허용되어야 함. 현재 409(버그) | 자동(QA, BUG-001) |

## 8. '+ member', '+ group', '+ team'

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| UI-01 | 팀 헤더 | `+ member`, 역할·모델·stay·작업 입력, Spawn | `POST /api/team/spawn` → 팀원 시작, 팀장에게 "spawned by the user" 알림 | 자동(T36) + 수동(폼) |
| UI-02 | 그룹 헤더 | 그룹의 `+ member` | group 지정, 알림에 `(group g)` | 자동(T44) |
| UI-03 | 팀장 아닌 세션 / 끝난 팀장 | spawn API | 409 | 자동(T36) |
| UI-04 | 역할 또는 작업 비움 | Spawn | 400 / 폼 오류 | 자동화 가능 |
| UI-05 | `+ group` / rename / delete | 사이드바 | 폴더·설정 반영 | 자동(T44) API / 수동 UI |
| UI-06 | `+ team` | 이름 입력 | 다른 팀 유지하고 추가 | 수동 |

## 9. 언어 (en / ko / zh-CN)

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| L-01 | — | i18n 키 검사 | 모든 언어에 모든 키, 페이지가 쓰는 키 존재 | 자동(T55) |
| L-02 | 언어 설정 없음 | 규칙 주입 | 규칙 문구 변화 없음 | 자동(T56) |
| L-03 | `ko`로 변경 | 다음 턴 | 카드 언어 규칙이 한 번 재주입 | 자동(T56) |
| L-04 | — | `POST /api/settings {lang:'zh-CN'}` / 잘못된 값 | 저장 / 400 | 자동(T57) |
| L-05 | ko / zh-CN | 대시보드 전체 화면 | 잘림·겹침 없음, 플레이스홀더 `{n}` 채워짐 | 수동 |

## 10. 생존·정리 (BUG-001에서 나온 추가 케이스)

| ID | 전제 | 단계 | 기대 결과 | 자동화 |
|---|---|---|---|---|
| LV-01 | Orca 팀원 idle, claude_pid 죽음, 터미널 닫힘 | `T list` | idle 아님 | 자동(QA-B001-1) FAIL |
| LV-02 | 같은 조건, state working | `T list` | working 아님 | 자동(QA-B001-2) FAIL |
| LV-03 | 같은 조건 | `/api/state` | view ≠ idle | 자동(QA-B001-3) FAIL |
| LV-04 | working으로 죽음, 2시간 지남 | `markEnded` | 허용 | 자동(QA-B001-4) FAIL |
| LV-05 | 살아 있는 claude, 열린 터미널 | `T list` | idle 유지 | 자동(QA-B001-C1) |
| LV-06 | pid·handle 없는 옛 기록 | `T list` | 죽었다고 추측하지 않음 | 자동(QA-B001-C2) |
| LV-07 | headless pid 종료 | `T list` | finished | 자동(QA-B001-C3) |
| LV-08 | 대기 명령(wait.lock pid)만 살아 있고 claude 죽음 | `T list`, `/api/state` | 결정 필요: 대기 명령 정리 + ended 권장 | 자동화 가능 |
| LV-09 | claude_pid가 다른 프로세스에 재사용됨 | 판정 | 살아 있다고 오판하지 않음(isClaudeProcess 또는 시작 시각) | 자동화 가능 |
