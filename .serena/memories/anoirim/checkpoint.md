task: my-dashboard 보유종목 표 재구성·추가 매수 시뮬레이션 + 스케줄러↔안약 달력 + 월 지출 개편 (2026-10-08, PR #1~#22 main 머지 완료)
files:
  - index.html: 완료
    - 하원 일정·스케줄러 시간 입력칸 120→150px (#pkTime, #schedTime)
    - 보유종목 표 (renderHoldings): 가격 칸 4단 = 매입가 / 현재가(증감/손익률) / 본전가 / 목표가,
      평가금액 칸 2단 = 매입금 / 평가금액(평가손익). .pricecell grid + --dw/--dw2로 행 간 자릿수 정렬.
      합계 줄: "합계 +수익률", 가격 칸 4단째 "목표 평가"(목표가×수량 합), 총매입금/총평가(총손익)
    - 추가 매수 칸 (addBuyHtml): 현재가로 n주 → 새 매입가·본전가·필요 금액(매수 수수료 포함), 메모리 addBuyQty(저장 안 함).
      입력칸 옆 "≈현재가 n주"(addBuyNeed): 새 매입가가 현재가와 1천원(ADD_BUY_GAP) 미만이 되는 최소 수량, 누르면 입력(fillAddBuy).
      필요 금액 > 그 계좌 예수금(acctCash: lastBal.summary의 cashD2||cash)이면 적색 + 툴팁에 부족액
    - 스케줄러: scheds 항목에 date 추가, 안약 달력에 그날 일정 2개+N 병기, 미래 날짜는 일정만, 복용 링 항상 표시
    - 구글 캘린더 양방향 연동 (PR #21·#22, 상세는 CLAUDE.md "### 스케줄러 + 구글 캘린더"):
      GIS 토큰(sessionStorage gcalTok, scope calendar.events + calendar.calendarlist.readonly)으로 Calendar API 직접 호출.
      날짜 있는 일정은 구글이 원본(gcalEvents), 날짜 없는 일정만 로컬 scheds. 추가·수정·삭제·완료(extendedProperties.private.dashDone).
      여러 캘린더 선택(gcalCalSel)·저장 캘린더(gcalTarget), 보기 전용 캘린더는 "G 보기", 시각은 Asia/Seoul 고정.
      스케줄러 항목에 수정 기능 추가(입력칸 '저장' 모드). 설정 방법은 대시보드-프로젝트-정리.md 5-1
    - 월 지출 (규칙 상세는 CLAUDE.md "### 월 지출 관리"):
      카드외 비정기 목록(expData[월].oneoff, 이월 안 함) 추가 → 기타(비정기) = 카드 비정기 + 카드외 비정기.
      하단 요약 3박스(정기 · 비정기 · 총지출, 정기+비정기=총지출), 정기지출 목록 위 합계도 같은 기준.
      cardSplit: 입력한 청구액 우선(정기 > 청구액이면 정기를 청구액까지만, 차액 cut은 합계 미포함), 청구액 0원일 때만 정기로 추정 → 음수 없음.
      보유금액 통장(cash)+현금(cashHand), 자릿수 쉼표, 합계·통장만 비교("n원 통장 채우기 필요").
      월별 지출 추이는 누적 막대 + 막대 위 합계(총지출 선 제거), monthTotals도 cardSums 공유
  - CLAUDE.md, 대시보드-프로젝트-정리.md: 현재 코드 기준 (줄 번호 대신 함수명·블록 주석)
progress: 완료 (모두 main 반영·Vercel 배포)
next_step: 실제 구글 계정으로 캘린더 연동 확인(클라이언트 ID 발급 후), 실제 계좌·지출 데이터로 배포본 확인
  (검증은 샘플 데이터 + Chart 스텁/npm Chart.js 4.4.1 + Playwright로 모의한 GIS·Calendar API로만 했음)
note:
  - 추가 매수 값은 1분 자동 갱신(trAuto 체크 + 장중) 때만 다시 계산됨. 사용자 확인 결과 반영됨
  - 현재가로 사면 매입가는 현재가에 수렴할 뿐 같아지지 않음 → "1천원 미만" 기준을 사용자와 합의
  - 날짜 기능 이전 스케줄러 일정은 date가 없어 달력에 안 나옴(재등록 필요)
  - 1300px 폭에서 보유종목 표가 약 150px 넘쳐 가로 스크롤
  - 클라우드 세션 배포 흐름: 작업 브랜치 push → 사용자 "승인" → PR 생성 → rebase 머지
  - 클라우드 컨테이너에서 cdnjs는 차단(403), Chart.js는 `npm pack chart.js@4.4.1`로 받아 Playwright route로 대체 가능
  - 클라우드 세션에는 Serena MCP 없음
  - 클라우드 컨테이너에서 developers.google.com·accounts.google.com 직접 접속은 차단 → 구글 문서는 WebSearch로만 확인 가능
