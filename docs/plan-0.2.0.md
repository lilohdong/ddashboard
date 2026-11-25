# ddashboard 0.2.0 구현 계획

팀장 세션은 리뷰와 통합을 맡고, 서브 세션 2개가 아래 API 약속에 맞춰 동시에 개발합니다. 두 서브는 서로 다른 파일을 건드려서 충돌하지 않습니다.

## 서브 A — 서버 (`feature/archive-api`, `origin/develop`에서 분기)

수정 파일: `scripts/lib.js`, `scripts/server.js`, `scripts/hooks/*.js`, `scripts/wait-inbox.js`. `scripts/dashboard.html`은 건드리지 않습니다.

1. **월별 카드 파일:** 카드를 `cards/YYYY-MM.jsonl`에 추가만 합니다. 0.1.0의 `cards.jsonl`은 읽기 전용으로 계속 읽습니다.
2. **늘어난 부분만 읽기:** `server.js`가 파일별 크기를 기억해서 새로 추가된 바이트만 읽습니다. 줄이 쓰이는 도중에 잘린 경우도 처리합니다.
3. **API:** 아래 약속대로 만듭니다.
4. **대기 명령 경로 고정:** `BOARD_DIR/bin/wait.js`를 만들어 현재 플러그인의 `wait-inbox.js`를 불러오게 하고, `rulesText`는 이 고정 경로를 안내합니다. 플러그인을 업데이트해도 "항상 허용"이 유지됩니다.
5. **카드 `details` 필드:** 카드 JSON에 선택 항목 `"details"`(마크다운, 최대 4000자)를 받아 저장합니다.
6. **카드 교체:** 카드 JSON에 `"replaces": "last"`가 있으면, 같은 세션의 직전 카드를 자동으로 보관 처리합니다. 계획을 수정한 카드가 예전 계획 카드를 대신하는 경우에 씁니다.
7. **터미널 한두 줄 규칙:** `rulesText`에 다음을 추가합니다. "연결된 동안 터미널 답변은 한두 줄로 하고, 내용은 카드에 쓴다(긴 내용은 `details`). 이전 카드를 고친 카드는 `replaces: "last"`를 넣는다."
8. **확인:** 기존 상태 전환이 그대로 동작하는지 훅 시뮬레이션으로 확인합니다. 커밋은 작업 브랜치에, 메시지는 영어로 씁니다.

## 서브 B — 화면 (`feature/archive-ui`, `origin/develop`에서 분기)

수정 파일: `scripts/dashboard.html`만. 서버는 동시에 만들어지는 중이라 가짜 데이터로 화면을 확인합니다.

1. **검색창:** 헤더에 둡니다. `/` 키로 포커스, 입력 후 300ms 뒤 검색, `Esc`로 지우기. 결과는 카드로 보여 주고, 보관된 카드에는 `Archived` 배지와 `Unarchive` 버튼을 붙입니다.
2. **Archive 버튼:** 각 카드에 두고, 누르면 목록에서 바로 빠집니다.
3. **보관함:** 사이드바 아래에 `Archived (N)` 링크를 두고, 누르면 보관함 보기(`archived=only`)로 바뀝니다.
4. **needs you 판단:** `cards` 대신 `last_by_session`을 씁니다.
5. **필터 적용:** 사이드바 범위(프로젝트/세션)와 상태 필터를 검색 결과에도 적용합니다.
6. **details 표시:** 카드의 `details`를 접힌 `Details` 영역으로 보여 줍니다. 일반 텍스트로, 줄바꿈 유지, HTML 이스케이프.
7. 커밋은 작업 브랜치에, 메시지는 영어로 씁니다.

## API 약속

- `GET /api/state` → `{ sessions, replies, cards, last_by_session, archived_count }`
  - `cards`: 최근 `DDASH_RECENT_DAYS`일(기본 14일) 안이고 보관되지 않은 카드, 최대 300장
  - `last_by_session`: `{ <세션 ID>: { status, title, ts } }` — 세션별 마지막 카드 (보관 여부와 무관)
  - 카드에 `details`(문자열)가 있을 수 있음
- `GET /api/search?q=<검색어>&archived=include|only&limit=100` → `{ cards: [... 각 카드에 archived: true|false] }`. 최신순. 제목, 요약, 확인할 것, details, 프로젝트, 세션 이름, 브랜치에서 대소문자 무시하고 찾음
- `POST /api/archive` `{ card_id, archived: true|false }` → `{ ok: true }`. 같은 출처 요청만 받음
- 보관 상태 = 직접 보관(`archived.json`), `replaces`로 교체됨, 또는 `DDASH_RECENT_DAYS`일 경과

## 완료 기준

- `claude plugin validate .` 통과
- 상태 전환 시뮬레이션 통과, 0.1.0 데이터 그대로 표시
- 카드 1만 장에서도 `/api/state`가 빠를 것
- 각 서브는 끝나면 카드를 올릴 것
