# 팀원 작업 지시: 토큰 미터 (ddashboard 0.3.0 1단계)

너는 ddashboard 팀의 팀원(백엔드+화면)이다. 팀장이 이 지시를 줬다. 작업 폴더는 현재 디렉터리(worktree, 브랜치 feature/token-meter)다. 다른 폴더는 수정하지 마.

## 배경
ddashboard는 Claude Code 플러그인이다. 훅이 카드를 기록하고 로컬 서버가 대시보드를 보여 준다. 구조는 README.md와 scripts/ 를 보면 된다(scripts/lib.js, scripts/cards.js, scripts/server.js, scripts/hooks/stop-card.js, scripts/dashboard.html).
0.3.0에서 팀 모드를 설계하기 전에, 세션별 토큰 사용량을 모델 호출 없이 측정해 대시보드에 보여 주려 한다.

## 할 일
1. **턴 사용량 기록 (scripts/hooks/stop-card.js, scripts/lib.js)**
   - transcript 끝부분에서 마지막 사람 입력 이후의 assistant 메시지 사용량을 합산한다. 같은 message.id가 여러 줄로 나뉘어 있으니 id당 한 번만 센다.
   - 항목: input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens.
   - context = 이번 턴 마지막 assistant 메시지의 input + cache_read + cache_creation.
   - 깨운 원인(reason): 이번 턴을 시작한 user 메시지가 `[Dashboard reply]`를 포함하면 "reply", `<task-notification>`으로 시작하면 "background", Stop 훅이 답글을 넘겨 이어진 턴이면 "reply", 그 밖의 사람 입력이면 "human".
   - `BOARD_DIR/usage/YYYY-MM.jsonl`에 {ts, session_id, project, input, cache_read, cache_write, output, context, reason} 한 줄 추가.
   - sessions.json의 세션에 누적치 usage {input, cache_read, cache_write, output, turns}와 last_context 저장.
   - 대시보드에 연결된 세션에서만 동작(기존 규칙 그대로). 카드가 없는 턴도 사용량은 기록한다.
2. **서버 (scripts/server.js)**: /api/state 응답에 usage_total(연결된 모든 세션 누적 합)과 오늘 합계 usage_today를 추가. usage 파일은 cards.js처럼 늘어난 부분만 읽는다.
3. **화면 (scripts/dashboard.html)**
   - 사이드바 세션 줄에 맥락 크기(예: "ctx 120k")와 누적 토큰을 짧게 표시. 맥락이 DDASH_CONTEXT_WARN(기본 150000)을 넘으면 경고 색.
   - 사이드바 아래에 오늘 팀 합계(입력, 캐시 읽기, 출력) 표시.
   - 마우스를 올리면 자세한 값(툴팁).
4. **README.md, README.ko.md**: 화면 설명과 설정 표에 위 내용과 DDASH_CONTEXT_WARN 추가.
5. **검증**: 가짜 transcript로 훅 시뮬레이션(사용량 합산, id 중복 제거, reason 분류, 카드 없는 턴), `claude plugin validate .` 통과. 기존 상태 전환이 깨지지 않을 것.

## 규칙
- 커밋은 feature/token-meter에, 메시지는 영어로. push와 머지는 하지 마.
- 이 세션은 대시보드에 연결된다. 카드는 한국어로 쓰고, 끝나면 status "review" 카드를 올려라. 카드에 "key": "token-meter"를 넣어라.
- 마지막 응답에는 무엇을 바꿨고 어떻게 검증했는지 짧게 적어라.
