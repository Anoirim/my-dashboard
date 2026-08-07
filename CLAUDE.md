# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 성격

개인용 웹 대시보드. 빌드 시스템·패키지 매니저·테스트 프레임워크가 **없다**. `package.json`, `vercel.json` 모두 없으며 Vercel의 zero-config가 `api/` 디렉터리를 서버리스 함수로 자동 인식한다.

- `index.html` — HTML/CSS/JS 전부를 담은 단일 파일 (약 965줄). Chart.js만 CDN 로드
- `api/kis.js` — KIS(한국투자증권) OpenAPI 프록시. CommonJS 핸들러 1개

## 개발 / 배포

- **배포**: `git push` → Vercel 자동 배포(1-2분) → 브라우저 Ctrl+Shift+R. 빌드 단계 없음
- **로컬 확인**: `index.html`을 브라우저로 직접 열면 UI·타이머·지출·해외주식은 동작하지만, `/api/kis` 프록시가 없어 **국내 주식·보유종목 조회는 실패**한다. File System Access 자동저장도 `file://`에서 차단된다(index.html:356)
- **프록시까지 로컬 테스트**하려면 `npx vercel dev` + 환경변수 필요. 그 외에는 배포본에서 확인하는 것이 정상 워크플로우
- **운영 주소**: Vercel 배포본만 완전 동작. GitHub Pages는 프록시가 없어 사용하지 않음

## 아키텍처

### index.html — 전역 함수 + 인라인 핸들러 구조

모듈·프레임워크 없이 `<script>` 하나에 모든 로직이 있다. 기존 코드와 스타일을 맞출 것:

- DOM 접근은 `$(id)` 헬퍼(index.html:281), 이벤트는 HTML의 `onclick="fnName()"` 인라인 바인딩
- 각 기능 블록은 `/* ===== 기능명 ===== */` 주석으로 구분. 상태는 전역 `let`, 렌더는 `renderXxx()`가 `innerHTML`을 통째로 재생성
- 스크립트 상단에서 각 기능의 `render*()`를 즉시 1회 호출해 초기화하고, `initFileSync()`만 맨 마지막에 실행(index.html:961)

### 영속화: localStorage 단일 소스 + 파일 미러

모든 데이터는 localStorage에 있고, 백업/복원과 자동기록은 **localStorage 전체를 덤프/복원**한다(`collectAll()`, `backupData()`). 따라서 새 상태를 저장할 때 localStorage를 쓰기만 하면 백업 대상에 자동 포함된다.

**중요**: 상태를 변경하는 모든 저장 함수는 마지막에 `autoSaveFile()`을 호출해야 File System Access 파일 미러가 동기화된다(`saveScheds`, `saveEye`, `saveExpData` 참고). 새 저장 경로를 추가하면서 이 호출을 빠뜨리면 자동기록만 조용히 어긋난다.

파일 핸들은 IndexedDB(`dashDB`/`h`/`dataFile`)에 저장해 재방문 시 복원하며, 권한 상태에 따라 `off`/`need`/`on` 3단계로 UI가 갈린다(`setFileState`).

주요 키: `scheds`, `eye_YYYY-MM-DD`(날짜별 자동 초기화), `expData`(`{ "YYYY-MM": {cards, fixed} }`), `curMonth`, `finnhubKey`.

월 지출은 `expData`에 월 단위로 저장되며, 없는 달을 열면 직전 달에서 카드·정기지출을 자동 이월하되 청구액은 0으로 초기화한다(`loadMonth`).

### api/kis.js — action 기반 단일 엔드포인트

`?action=` 쿼리로 분기하는 핸들러 하나다(kis.js:216 이하).

- `price`(기본, `?symbol=`) → `getFull()`: 현재가+종목명+일봉+재무/ETF를 **토큰 1개로 한 번에** 반환. 프론트의 수동 조회용
- `quote` → 경량 현재가. 5초 실시간 폴링용
- `daily` / `finance` / `debug` → 개별 조회 및 원본 필드 진단
- `balance` → 계좌 전체 잔고 통합. 종목코드 불필요

토큰은 **앱키별로** 2단 캐시(프로세스 메모리 `tokenCaches` + Vercel KV). KIS 토큰은 24h 유효하므로 매 호출 발급하면 안 된다. KV 미설정 시에도 메모리 캐시로 동작한다.

계좌는 `KIS_ACCT{1..4}_NO/APPKEY/APPSECRET/NAME` 환경변수로 최대 4개까지 자동 인식한다(`acctConfigs`). **KIS는 계좌마다 API 키가 다르므로** 계좌별 키가 필수이고, 시세 조회용 `KIS_APPKEY`와는 별개다. 잔고 조회는 KIS 초당 호출 제한 때문에 계좌 간 600ms 지연 + 제한 감지 시 1초 후 1회 재시도가 들어 있다(`getBalance`). 여기에 계좌를 더 추가하거나 병렬화하면 rate limit에 걸린다.

`KIS_ENV=mock`이면 모의투자 서버(BASE URL과 잔고 `tr_id`가 함께 바뀜).

### 중복 주의 지점

같은 개념이 두 곳에 다른 방식으로 구현되어 있으므로 한쪽만 고치지 말 것:

- **본전가·목표가 공식** — `calcTrade()`(계산기)와 `renderHoldings()`(보유종목)에 각각 `avg*(1+fee)/(1-fee-tax)` 형태로 존재
- **ETF 판별** — 프록시는 `per===0 && pbr===0`으로(kis.js:146), 프론트 보유종목은 종목명 키워드 배열 `ETF_KW`로(index.html:902) 판정한다

## 관련 문서

`대시보드-프로젝트-정리.md`에 기능 목록, Vercel 환경변수 전체, 미구현 아이디어가 정리되어 있다. 기능 변경 시 이 문서도 함께 갱신할지 확인할 것.
