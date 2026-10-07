# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 성격

개인용 웹 대시보드. 빌드 시스템·패키지 매니저·테스트 프레임워크가 **없다**. `package.json`, `vercel.json` 모두 없으며 Vercel의 zero-config가 `api/` 디렉터리를 서버리스 함수로 자동 인식한다.

- `index.html` — HTML/CSS/JS 전부를 담은 단일 파일 (약 3,200줄). Chart.js만 CDN(cdnjs) 로드
- `api/kis.js` — KIS(한국투자증권) OpenAPI 프록시 + 한국은행 ECOS·Google 뉴스 RSS 중계. CommonJS 핸들러 1개 (약 600줄)

줄 수가 계속 늘고 있으므로 위치는 줄 번호가 아니라 **함수명·블록 주석으로 찾을 것**.

## 개발 / 배포

- **배포**: `main`에 push → Vercel 자동 배포(1-2분) → 브라우저 Ctrl+Shift+R. 빌드 단계 없음
  - 클라우드 세션에서는 작업 브랜치에 push한 뒤, 사용자가 "승인"하면 PR을 만들어 `main`에 rebase 머지하는 방식으로 배포한다
- **로컬 확인**: `index.html`을 브라우저로 직접 열면 UI·타이머·지출·해외주식은 동작하지만, `/api/kis` 프록시가 없어 **국내 주식·계좌 조회는 실패**한다. File System Access 자동저장도 `file://`에서 차단된다(`setFileState` 근처의 `location.protocol==="file:"` 분기)
- **Chart.js 의존**: CDN 로드가 실패하면 첫 `new Chart`/`Chart.getChart` 호출에서 스크립트 전체가 멈춰 이후 기능이 초기화되지 않는다. 오프라인·차단 환경에서 화면을 검증할 때는 `window.Chart`를 스텁으로 넣고(`Chart.getChart`, `Chart.register` 포함) 렌더 함수(`renderHoldings([...])` 등)에 샘플 데이터를 직접 넣어 확인한다. 실제 그래프 모양까지 보려면 `npm pack chart.js@4.4.1`로 받은 `dist/chart.umd.js`를 Playwright `page.route('**/chart.umd.min.js', …)`로 대신 응답한다
- **프록시까지 로컬 테스트**하려면 `npx vercel dev` + 환경변수 필요. 그 외에는 배포본에서 확인하는 것이 정상 워크플로우
- **운영 주소**: Vercel 배포본만 완전 동작. GitHub Pages는 프록시가 없어 사용하지 않음

## 아키텍처

### index.html — 전역 함수 + 인라인 핸들러 구조

모듈·프레임워크 없이 `<script>` 하나에 모든 로직이 있다. 기존 코드와 스타일을 맞출 것:

- DOM 접근은 `$(id)` 헬퍼(`/* ===== 공통 ===== */`), 이벤트는 HTML의 `onclick="fnName()"` 인라인 바인딩
- 각 기능 블록은 `/* ===== 기능명 ===== */` 주석으로 구분. 상태는 전역 `let`, 렌더는 `renderXxx()`가 `innerHTML`을 통째로 재생성
- 스크립트 상단부터 각 기능의 `render*()`를 즉시 1회 호출해 초기화하고, 맨 끝에서 `switchDept()` → `initFileSync()` 순으로 실행
- **초기화 순서 주의**: 블록은 위에서부터 실행되므로, 앞 블록의 초기 렌더에서 뒤 블록의 `let`/`const`(예: 안약의 `eyeCur`, 공용 `esc`)를 건드리면 TDZ 오류로 스크립트가 멈춘다. 다른 블록을 다시 그려야 하면 사용자 동작 시점의 함수(예: `schedChanged()`)에서 부른다

### 화면 구성 — 부서 탭

카드마다 `data-dept`가 있고 `switchDept()`가 해당 부서 카드만 보여준다(선택은 `curDept` 키로 저장, 기본 `fin`).

| 탭 (`data-dept`) | 카드 |
|---|---|
| 총무부 (`general`) | 타이머, 하원 일정, 스케줄러, 안약 복용(달력), 식품 재고, 근무 일정 |
| 투자연구소 (`research`) | 시장 일정, 손절 후 재매수 계산, 주식 분석 |
| 재무부 (`fin`) | 내 계좌 현황(체결 조회·실현손익·보유종목·자산 추이), 목표 현금 만들기, 입출금·배당 기록 |
| 관리부 (`mgmt`) | 월 지출 관리 |

예전 `health`(보건실) 탭은 총무부로 흡수됐고 `switchDept`가 `health`를 `general`로 돌린다.

### 영속화: localStorage 단일 소스 + 파일 미러

모든 데이터는 localStorage에 있고, 백업/복원과 자동기록은 **localStorage 전체를 덤프/복원**한다(`collectAll()`, `backupData()`). 따라서 새 상태를 저장할 때 localStorage를 쓰기만 하면 백업 대상에 자동 포함된다.

**중요 1**: 상태를 변경하는 모든 저장 함수는 마지막에 `autoSaveFile()`을 호출해야 File System Access 파일 미러가 동기화된다(`saveScheds`, `saveEye`, `saveExpData` 참고). 새 저장 경로를 추가하면서 이 호출을 빠뜨리면 자동기록만 조용히 어긋난다.

**중요 2**: 새 localStorage 항목을 메모리 전역으로 들고 있다면 `reloadAll()`에도 재적재·재렌더를 추가해야 복원 직후 화면에 반영된다.

파일 핸들은 IndexedDB(`dashDB`/`h`/`dataFile`)에 저장해 재방문 시 복원하며, 권한 상태에 따라 `off`/`need`/`on` 3단계로 UI가 갈린다(`setFileState`).

주요 키:

| 키 | 내용 |
|---|---|
| `scheds` | 스케줄러 `[{date, time, text, done}]`. `date`(YYYY-MM-DD)가 있으면 안약 달력에도 병기. 날짜 기능 이전 항목은 `date` 없음 |
| `eye_YYYY-MM-DD` | 날짜별 안약 복용 `[bool×4]` (오전 코솝·알파간, 오후 코솝·알파간) |
| `expData`, `curMonth` | 월 지출 `{ "YYYY-MM": {cards, fixed, oneoff?, cash?, cashHand?} }`(`oneoff`=카드외 비정기 `[{day,name,amt,inc}]`, `cash`=그달 통장 잔액, `cashHand`=그달 현금, 모두 이월 안 함. 예전 단일 보유금액은 `cash`라 통장으로 읽힌다), 보던 달. `saveExpData`는 `cash`가 지워지지 않게 기존 월 객체에 합친다 |
| `foods`, `fdLog` | 식품 재고, 소비/폐기 기록 |
| `workOverrides` | 근무 일정 날짜별 예외 |
| `pickupTime`, `pickupSkips`, `pickupAlarm` | 하원 시각, 하원 없는 날, 알림 on/off |
| `holdTargets` | 보유종목별 목표 입력(가격/%·수량) |
| `realizedHist` | 일별 실현손익 보존본(KIS가 3개월 지난 행의 세금을 0으로 주기 때문) |
| `cashFlows` | 입출금·배당 기록 |
| `equitySnap` | 자산 추이 오늘 스냅샷 |
| `curDept` | 선택한 부서 탭 |
| `dashToken`, `finnhubKey` | 프록시 접근 토큰, Finnhub API 키 |

월 지출은 없는 달을 열면 직전 달에서 카드·정기지출을 자동 이월하되 청구액은 0으로 초기화한다(`loadMonth`). 카드외 비정기(`oneoff`)와 보유금액(`cash`·`cashHand`)은 이월하지 않는다. 하단 요약은 [정기지출(카드정기 + 카드외 정기)] [기타(비정기) = 카드 비정기 + 카드외 비정기] [총지출] 3박스이며 정기 + 비정기 = 총지출이다. 정기 박스와 정기지출 목록 위 합계(`fixedTotalTop`)는 같은 기준(체크된 카드의 카드정기 + 카드외 정기)이다. 계산에서 뺀 카드로 결제하는 정기지출은 합계에 넣지 않고 세부 줄(`fixedBreakdown`)에 "계산 제외 카드 결제분"으로만 알린다. 카드 비정기는 카드별로 `cardSplit`이 (반영액 − 그 카드 정기지출)을 구하며, 반영액 = max(청구액, 그 카드 정기지출)이라 청구액을 아직 안 넣은 새 달에도 음수가 되지 않고 정기지출이 총지출에서 빠지지 않는다. 상단 카드 총액은 입력한 청구액 그대로 보여준다. 총지출 합계 아래 보유금액 입력(통장 `expCash` + 현금 `expCashHand`, `setExpCash(key,v)`/`renderExpCash`)은 두 값의 합을 총지출과 비교해 여유·부족을 보여주고, 둘 다 입력했으면 통장만으로 비교한 결과도 함께 보여준다(여유면 "통장만 n원 여유", 부족이면 "n원 통장 채우기 필요"). 입력칸은 자릿수 쉼표를 보여주려고 `type="text"`이며 `fmtExpCash`가 입력 중 쉼표·커서를 맞추고 `cashNum`으로 숫자만 읽는다. 월별 지출 추이(`renderExpChart`)는 정기·기타 누적 막대이고, 막대 꼭대기가 곧 총지출이라 선 없이 인라인 플러그인으로 막대 위에 합계(보이는 데이터셋 합)를 쓴다.

날짜가 바뀌는 것은 `/* ===== 날짜 바뀜 감지 ===== */`의 `applyNewDay()`가 1분 간격 + 탭 복귀 시 처리한다. 날짜에 따라 달라지는 화면을 추가하면 여기서도 다시 그려야 한다.

### 보유종목 표 (`renderHoldings`)

- 가격 칸은 한 칸에 4단: 매입가 / 현재가 (증감/손익률) / 본전가 / 목표가. 평가금액 칸은 2단: 매입금 / 평가금액 (평가손익)
- 금액 자릿수를 행 사이에 세로로 맞추기 위해 `.pricecell` CSS grid(금액 열 + 괄호 열)를 쓰고, 괄호 열 폭을 표 전체에서 가장 긴 값에 맞춰 `--dw`(가격)·`--dw2`(평가금액) 변수(ch 단위)로 고정한다. 머리글·합계도 같은 격자를 써야 정렬이 유지된다
- ch는 칸 자신의 글꼴로 재므로 `.pricecell`은 보통 굵기로 두고 통합 행·머리글·합계의 금액만 굵게 한다
- 같은 종목을 2개 이상 계좌에 보유하면 통합 행(`mergeHoldings`)을 붙인다. 합계에서는 통합 행을 제외한다
- 합계 줄의 가격 칸 값은 목표가 × 수량 합계("목표 평가")이고, 전체 수익률은 "합계" 글자 옆에 표시한다
- 1분 자동 갱신: "자동 갱신(1분)"(`trAuto`)이 켜져 있고 장중(KST 평일 09:00~15:30)일 때 `refreshToday()`가 잔고·오늘 체결·실현손익을 다시 받아 `showHoldings()`로 표 전체를 다시 그린다. 불러오기(`loadTrades`) 후 장중이면 자동으로 켜진다
- 수수료율은 계좌명으로 정한다(`acctFee`: "우대" 0.0016%, 그 외 0.015%). 목표수익률은 입력칸 `hTarget`
- 추가 매수 칸: 현재가로 n주를 더 살 때의 새 매입가·본전가·필요 금액(`addBuyHtml`). 가정용이라 저장하지 않고 메모리 `addBuyQty`(키 `htKey`)에만 두어 자동 갱신 재렌더에도 유지된다. 입력칸 옆 "≈현재가 n주"(`addBuyNeed`)는 새 매입가가 현재가와 1천원(`ADD_BUY_GAP`) 미만이 되는 최소 수량이다. 현재가로 사면 매입가는 현재가에 수렴할 뿐 같아지지 않으므로 이 기준을 쓴다. 필요 금액이 그 계좌 예수금(`acctCash`: `lastBal.summary`의 `cashD2||cash`)보다 많으면 적색, 잔고를 아직 못 받았으면 색을 바꾸지 않는다

### api/kis.js — action 기반 단일 엔드포인트

`?action=` 쿼리로 분기하는 핸들러 하나다(`module.exports = async function handler`).

- `price`(기본, `?symbol=`) → `getFull()`: 현재가+종목명+일봉+재무/ETF를 **토큰 1개로 한 번에** 반환. 주식 분석 조회용
- `quote` → 경량 현재가. 실시간 폴링용
- `daily` / `finance` / `debug` → 개별 조회 및 원본 필드 진단
- `balance` → 계좌 전체 잔고 통합. 종목코드 불필요
- `trades` → 기간 체결내역(`from`/`to`, 기본 3개월). 오래된 기간은 tr_id가 다르다(`tradeTrId`)
- `realized` → 기간별 일별 실현손익(기본 6개월)
- `index` → 지수 일봉(`code`, 기본 `0001` 코스피)
- `macro` → 한국은행 ECOS 금리·환율(`ECOS_KEY` 필요, KIS 토큰 불필요)
- `news` → Google 뉴스 RSS 검색(`q`, `limit` 최대 30)

종목코드는 영문이 섞인 6자리(`/^[0-9A-Z]{6}$/`, 예: `0117V0`)까지 허용한다.

**접근 토큰**: Vercel에 `DASH_TOKEN`을 설정하면 `x-dash-token` 헤더가 같은 요청만 통과한다(`authFailed`, 미설정이면 전부 통과). 프론트는 `dashToken`을 저장해 `kisFetch()`가 헤더로 붙인다. 쿼리스트링으로 받지 않는다.

토큰은 **앱키별로** 2단 캐시(프로세스 메모리 `tokenCaches` + Vercel KV). KIS 토큰은 24h 유효하므로 매 호출 발급하면 안 된다. KV 미설정 시에도 메모리 캐시로 동작한다.

계좌는 `KIS_ACCT{1..4}_NO/APPKEY/APPSECRET/NAME` 환경변수로 최대 4개까지 자동 인식한다(`acctConfigs`). **KIS는 계좌마다 API 키가 다르므로** 계좌별 키가 필수이고, 시세 조회용 `KIS_APPKEY`와는 별개다. 잔고·체결·실현손익 조회는 KIS 초당 호출 제한 때문에 계좌 간 600ms 지연이 들어 있고, 잔고는 제한 감지 시 1초 후 1회 재시도한다(`getBalance`). 여기에 계좌를 더 추가하거나 병렬화하면 rate limit에 걸린다.

`KIS_ENV=mock`이면 모의투자 서버(BASE URL과 계좌 계열 `tr_id`가 함께 바뀜).

### 중복 주의 지점

같은 개념이 여러 곳에 다른 방식으로 구현되어 있으므로 한쪽만 고치지 말 것:

- **본전가·목표가 공식** — `avg*(1+fee)/(1-fee-tax)` 형태가 `calcSwitch()`(손절 후 재매수), `renderHoldings()`(보유종목), `htTargetPrice()`·`holdGainHtml()`(목표 입력·예상이익), `addBuyHtml()`(추가 매수)에 각각 있다
- **월 총지출 공식** — 카드 반영액(체크분, `cardSums`) + 카드 외 정기지출 + 카드외 비정기. `renderExpAll()`(화면 합계)과 `monthTotals()`(추이 그래프)에 따로 있다. 카드 부분은 둘 다 `cardSums()`를 공유한다
- **ETF 판별** — 프록시는 `per===0 && pbr===0`으로(`getFull`), 프론트는 종목명 키워드 배열 `ETF_KW`로(`isEtfName`) 판정한다

## 관련 문서

`대시보드-프로젝트-정리.md`에 기능 목록, Vercel 환경변수 전체, 미구현 아이디어가 정리되어 있다. 기능 변경 시 이 문서도 함께 갱신할지 확인할 것.
