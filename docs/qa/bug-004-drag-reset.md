# BUG-004: 카드에서 드래그(텍스트 선택)하면 선택이 풀리고 스크롤이 처음으로 돌아감

- 심각도: 중간 (카드 내용을 복사할 수 없음, 긴 Details를 읽을 수 없음)
- 대상: scripts/dashboard.html (설치본 http://127.0.0.1:7357 에서 재현, 7357 서버는 읽기만 함)
- 재현 스크립트/결과: docs/teams/skill-ddashboard/qa/notes/bug-004-repro.mjs, bug-004-repro-output.json
  (headless Chrome + CDP, `node bug-004-repro.mjs http://127.0.0.1:7357/`)

## 재현 결과 (실제 Chrome)

| 시험 | 전 | 3.5초 뒤(폴링 1회) |
|---|---|---|
| T1 카드 요약 `<li>`를 선택 | "맥락이 22.6만이던 qa 세션을…" | `""` (선택 사라짐), 선택했던 노드가 문서에서 빠짐(`sameNode:false`), `#cards` 렌더 1회 |
| T3 열린 Details 본문 `.details-body` 스크롤 | scrollTop 100 | scrollTop 0 (노드가 새로 만들어짐) |
| T3 창 스크롤 / 사이드바 스크롤 | 600 / 200 | 600 / 200 (이 시험에선 유지) |

카드 목록에 변화가 없어도 3초마다 위 증상이 생김. (T2 CDP 마우스 드래그는 headless에서 선택이 만들어지지 않아 판정 불가. T1로 같은 원인 확인.)

## 원인

1. `setInterval(..., 3000)` (dashboard.html 맨 끝)이 3초마다 `load()`를 부름. 건너뛰는 조건은
   `spawnFor`, `groupDel`, textarea/select/input 포커스뿐이고 **텍스트 선택 중이거나 마우스 버튼을 누르고 있는 경우는 확인하지 않음**.
2. `load()` → `renderSide()` / `renderMain()`이 데이터가 바뀌었는지와 상관없이
   `#cards`, `#side`, `#filters`, `#mode`의 `innerHTML`을 통째로 바꿈.
   → 선택 범위의 시작/끝 노드가 DOM에서 빠지므로 선택이 사라지고, 드래그 중이면 기준점이 없어짐.
   → `.details-body`(max-height 420px, 자체 스크롤)가 새 노드로 바뀌어 scrollTop이 0이 됨. 사용자가 느끼는 "스크롤이 처음으로 돌아감"은 주로 이것.
   → 새 카드가 위에 붙으면(목록은 최신순) 통째 교체라 브라우저의 scroll anchoring도 기준 노드를 잃어 창 위치가 밀릴 수 있음.

## 수정안 (권장 순서, 1+2만으로 보고된 증상은 사라짐)

1. **선택/드래그 중에는 폴링 렌더를 미룸**
   ```js
   let pointerDown = false;
   document.addEventListener('pointerdown', () => { pointerDown = true; });
   document.addEventListener('pointerup', () => { pointerDown = false; if (pendingLoad) { pendingLoad = false; load(); } });
   const selecting = () => { const s = getSelection(); return s && !s.isCollapsed && ['cards', 'side'].some((id) => document.getElementById(id).contains(s.anchorNode)); };
   // interval: if (pointerDown || selecting()) { pendingLoad = true; return; }
   ```
   선택이 풀리면(`selectionchange`에서 isCollapsed) 미뤄둔 load를 실행. 드래그 중에는 fetch도 해도 되지만 DOM은 만지지 않음.
2. **내용이 같으면 DOM을 바꾸지 않음** — 작은 헬퍼 하나로 4곳(#cards, #side, #filters, #mode)에 적용:
   ```js
   function setHtml(el, html) { if (el._html !== html) { el._html = html; el.innerHTML = html; } }
   ```
   시간 표시(`time()`)가 절대 시각이라 변화 없는 폴링에선 HTML이 같음 → 대부분의 폴링이 DOM을 건드리지 않게 됨.
   주의: 사용자가 `<details>`를 직접 열고 닫으면 DOM과 `_html`이 달라지지만, `openDetails`가 HTML에 반영되므로 다음 변경 때 맞춰짐(문제 없음).
3. **실제로 바뀔 때도 스크롤 보존** — 렌더 전에 `.details-body` scrollTop을 `data-details` id별로 저장, 렌더 후 복원.
   창 스크롤은 화면 맨 위에 보이는 카드 id와 그 offset을 기억했다가 렌더 후 같은 카드가 같은 위치에 오도록 `scrollBy`.
   (`<article>`에 `data-id="${c.id}"`를 추가해야 함.)
4. (선택, 나중) 카드 id 기준 diff 렌더: 바뀐 `<article>`만 교체, 새 카드만 삽입. 1~3으로 충분하면 생략 가능.

## 검증 방법 (구현 후 QA)

- `bug-004-repro.mjs`를 수정본을 띄운 격리 서버(DDASH_PORT=7361, DDASH_BOARD_DIR=임시 폴더)에 대고 실행:
  T1 after == before, `sameNode:true`, T3 details scrollTop 100 유지.
- 선택 중에 새 카드를 POST → 선택이 유지되고, 선택을 풀면(클릭) 3초 안에 새 카드가 보이는지.
- 회귀: 답장 입력 중 렌더 안 함, Details 열림 상태 유지, 필터/검색 동작.
