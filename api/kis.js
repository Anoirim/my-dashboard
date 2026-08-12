// KIS(한국투자증권) OpenAPI 프록시 - Vercel 서버리스 함수
// 환경변수: KIS_APPKEY, KIS_APPSECRET  (모의투자면 KIS_ENV=mock 추가)
// 호출:
//   /api/kis?symbol=005930                 → 현재가/지표
//   /api/kis?action=daily&symbol=005930    → 최근 일봉(과거 시세)
//   /api/kis?action=finance&symbol=005930  → 재무비율(ROE·부채비율 등)
//   /api/kis?action=trades&from=YYYYMMDD&to=YYYYMMDD → 기간 내 체결내역

const IS_MOCK = /^(mock|vts|모의)$/i.test(process.env.KIS_ENV || "");
const BASE = IS_MOCK
  ? "https://openapivts.koreainvestment.com:29443" // 모의투자
  : "https://openapi.koreainvestment.com:9443";    // 실전

let tokenCache = { token: null, exp: 0 };

// --- Vercel KV / Upstash 토큰 저장소 (있으면 사용) ---
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json();
    return j.result || null;
  } catch (e) { return null; }
}
async function kvSet(key, val, exSec) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${key}/${encodeURIComponent(val)}?EX=${exSec}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
  } catch (e) {}
}

// 앱키별 토큰 캐시 (계좌마다 키가 다르므로 키별로 관리)
const tokenCaches = {};
async function getTokenFor(appkey, appsecret) {
  if (!appkey || !appsecret) throw new Error("APPKEY/APPSECRET 누락");
  const c = tokenCaches[appkey];
  if (c && Date.now() < c.exp) return c.token;
  const kvKey = "kis_token_" + appkey.slice(0, 16);
  const saved = await kvGet(kvKey);
  if (saved) { tokenCaches[appkey] = { token: saved, exp: Date.now() + 60 * 60 * 1000 }; return saved; }
  const r = await fetch(BASE + "/oauth2/tokenP", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey, appsecret }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.msg1 || "토큰 발급 실패");
  const lifeSec = j.expires_in ? j.expires_in : 23 * 3600;
  tokenCaches[appkey] = { token: j.access_token, exp: Date.now() + (lifeSec - 60) * 1000 };
  await kvSet(kvKey, j.access_token, lifeSec - 300);
  return j.access_token;
}
// 시세용(계좌 무관): 기본 키 사용
async function getToken() {
  return getTokenFor(process.env.KIS_APPKEY, process.env.KIS_APPSECRET);
}

function headers(token, tr_id, key, secret) {
  return {
    "content-type": "application/json",
    authorization: "Bearer " + token,
    appkey: key || process.env.KIS_APPKEY,
    appsecret: secret || process.env.KIS_APPSECRET,
    tr_id,
    custtype: "P",
  };
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function getPrice(symbol) {
  const token = await getToken();
  const url =
    BASE + "/uapi/domestic-stock/v1/quotations/inquire-price" +
    "?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" + symbol;
  const j = await (await fetch(url, { headers: headers(token, "FHKST01010100") })).json();
  const o = j.output || {};
  if (!o.stck_prpr) return { error: "데이터 없음", raw: j.msg1 || null };
  return {
    name: o.hts_kor_isnm || symbol,
    price: num(o.stck_prpr), diff: num(o.prdy_vrss), rate: num(o.prdy_ctrt),
    open: num(o.stck_oprc), high: num(o.stck_hgpr), low: num(o.stck_lwpr),
    prevClose: num(o.stck_sdpr), per: num(o.per), pbr: num(o.pbr), eps: num(o.eps),
    w52high: num(o.w52_hgpr), w52low: num(o.w52_lwpr),
    volume: num(o.acml_vol), marketCap: num(o.hts_avls), // 시가총액(억)
  };
}

// 일봉은 1회 응답이 약 100건(5개월)으로 잘려서, 긴 기간은 3개월씩 나눠 받아 합친다.
async function getDaily(symbol, from, to) {
  const token = await getToken();
  if (!/^\d{8}$/.test(from || "") || !/^\d{8}$/.test(to || "")) {
    const end = new Date();
    const start = new Date(); start.setMonth(start.getMonth() - 5); // 기본 약 5개월
    from = ymd(start); to = ymd(end);
  }
  let name = null;
  const map = {};
  const periods = splitPeriods(from, to);
  for (let i = 0; i < periods.length; i++) {
    if (i > 0) await sleep(120);
    const url =
      BASE + "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice" +
      "?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" + symbol +
      "&FID_INPUT_DATE_1=" + periods[i][0] + "&FID_INPUT_DATE_2=" + periods[i][1] +
      "&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0";
    const j = await (await fetch(url, { headers: headers(token, "FHKST03010100") })).json();
    if (!name) name = (j.output1 && (j.output1.hts_kor_isnm || j.output1.prdt_name)) || null;
    (j.output2 || []).forEach((x) => {
      if (x.stck_bsop_date && x.stck_clpr)
        map[x.stck_bsop_date] = { date: x.stck_bsop_date, close: num(x.stck_clpr), vol: num(x.acml_vol) };
    });
  }
  const candles = Object.keys(map).sort().map((k) => map[k]); // 과거→최근
  return { name, candles };
}

// 국내 지수 일별 시세 (KOSPI 0001 / KOSDAQ 1001)
// output2 필드명이 공식 문서로 확정되지 않아 후보 키를 순회한다. rawKeys로 실제 키를 진단할 수 있다.
const IDX_F = {
  date: ["stck_bsop_date", "bsop_date", "stck_cntg_hour"],
  close: ["bstp_nmix_prpr", "stck_clpr", "bstp_nmix_prdy_clpr", "prpr"],
};
function pickIdx(o, keys) {
  for (const k of keys) if (o[k] !== undefined && o[k] !== "") return o[k];
  return null;
}
async function getIndex(code, from, to) {
  const token = await getToken();
  if (!/^\d{8}$/.test(from || "") || !/^\d{8}$/.test(to || "")) {
    const end = new Date();
    const start = new Date(); start.setMonth(start.getMonth() - 5);
    from = ymd(start); to = ymd(end);
  }
  const map = {};
  let rawKeys = null;
  const periods = splitPeriods(from, to);
  for (let i = 0; i < periods.length; i++) {
    if (i > 0) await sleep(120);
    const url =
      BASE + "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice" +
      "?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=" + code +
      "&FID_INPUT_DATE_1=" + periods[i][0] + "&FID_INPUT_DATE_2=" + periods[i][1] +
      "&FID_PERIOD_DIV_CODE=D";
    const j = await (await fetch(url, { headers: headers(token, "FHKUP03500100") })).json();
    const rows = j.output2 || [];
    if (!rawKeys && rows.length) rawKeys = Object.keys(rows[0]);
    rows.forEach((x) => {
      const d = pickIdx(x, IDX_F.date), c = num(pickIdx(x, IDX_F.close));
      if (d && c) map[String(d)] = { date: String(d), close: c };
    });
  }
  return { code, candles: Object.keys(map).sort().map((k) => map[k]), rawKeys };
}

// 구글 뉴스 RSS는 비공식 엔드포인트다. 서버에서 막힐 수 있어 status/sample로 원인을 진단한다.
function unesc(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "").trim();
}
async function getNews(q, from, to, limit) {
  const dash = (v) => v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8);
  let query = q;
  if (/^\d{8}$/.test(from || "")) query += " after:" + dash(from);
  if (/^\d{8}$/.test(to || "")) query += " before:" + dash(to);
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=ko&gl=KR&ceid=KR:ko";
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; my-dashboard/1.0)" } });
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((m) => {
    const g = (t) => {
      const x = new RegExp("<" + t + "[^>]*>(.*?)</" + t + ">", "s").exec(m[1]);
      return x ? unesc(x[1]) : "";
    };
    // 구글 뉴스 제목은 "제목 - 매체" 형식이라 매체를 따로 보여주면 중복된다
    const source = g("source");
    let title = g("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)).trim();
    return { title, link: g("link"), pubDate: g("pubDate"), source };
  });
  return { q: query, status: r.status, count: items.length, items, sample: items.length ? null : xml.slice(0, 300) };
}

async function getFinance(symbol) {
  const token = await getToken();
  const url =
    BASE + "/uapi/domestic-stock/v1/finance/financial-ratio" +
    "?FID_DIV_CLS_CODE=0&fid_cond_mrkt_div_code=J&fid_input_iscd=" + symbol;
  const j = await (await fetch(url, { headers: headers(token, "FHKST66430300") })).json();
  const o = (j.output && j.output[0]) || null;
  if (!o) return { error: "재무 데이터 없음" };
  return {
    period: o.stac_yymm || null,       // 결산년월
    roe: num(o.roe_val),               // ROE
    debtRatio: num(o.lblt_rate),       // 부채비율
    salesGrowth: num(o.grs),           // 매출액증가율
    opGrowth: num(o.bsop_prfi_inrt),   // 영업이익증가율
    eps: num(o.eps), bps: num(o.bps),
  };
}

async function getEtf(symbol) {
  const token = await getToken();
  const url =
    BASE + "/uapi/etfetn/v1/quotations/inquire-price" +
    "?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" + symbol;
  const j = await (await fetch(url, { headers: headers(token, "FHPST02400000") })).json();
  const o = j.output || {};
  return { nav: num(o.nav), navRate: num(o.nav_prdy_ctrt) };
}

// 한 번의 호출로 현재가+종목명+일별차트+(주식:재무 / ETF:NAV)를 모두 반환 (토큰 1개 공유)
async function getFull(symbol) {
  const p = await getPrice(symbol);          // 토큰 최초 발급(캐시)
  if (p.error) return p;
  let name = p.name, candles = [];
  try { const dd = await getDaily(symbol); name = dd.name || name; candles = dd.candles; } catch (e) {}
  const isEtf = p.per === 0 && p.pbr === 0;   // ETF는 PER·PBR이 0
  if (isEtf) {
    let nav = null, navRate = null;
    try { const e = await getEtf(symbol); nav = e.nav; navRate = e.navRate; } catch (err) {}
    const disparity = nav && p.price ? ((p.price - nav) / nav) * 100 : null; // 괴리율
    return { ...p, name, candles, isEtf: true, nav, navRate, disparity };
  }
  let roe = null, debtRatio = null;
  try { const f = await getFinance(symbol); if (f && !f.error) { roe = f.roe; debtRatio = f.debtRatio; } } catch (e) {}
  return { ...p, name, candles, isEtf: false, roe, debtRatio };
}

// --- 잔고조회 (계좌별 각자의 API 키 사용) ---
// 환경변수 (계좌마다):
//   KIS_ACCT1_NAME, KIS_ACCT1_NO, KIS_ACCT1_APPKEY, KIS_ACCT1_APPSECRET
//   KIS_ACCT2_NAME, KIS_ACCT2_NO, KIS_ACCT2_APPKEY, KIS_ACCT2_APPSECRET  (최대 4개)
function acctConfigs() {
  const list = [];
  for (let i = 1; i <= 4; i++) {
    const no = process.env["KIS_ACCT" + i + "_NO"];
    if (!no) continue;
    list.push({
      label: process.env["KIS_ACCT" + i + "_NAME"] || ("계좌" + i),
      no: no.replace(/[^0-9]/g, ""),
      key: process.env["KIS_ACCT" + i + "_APPKEY"] || process.env.KIS_APPKEY,
      secret: process.env["KIS_ACCT" + i + "_APPSECRET"] || process.env.KIS_APPSECRET,
    });
  }
  return list.filter((a) => a.no.length >= 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRate = (m) => /초당|거래건수|EGW00201|초과/.test(m || ""); // 초당 호출 제한 응답 판정
async function balanceOnce(a, trId) {
  const token = await getTokenFor(a.key, a.secret); // 계좌별 키로 토큰
  const q = new URLSearchParams({
    CANO: a.no.slice(0, 8), ACNT_PRDT_CD: a.no.slice(8, 10), AFHR_FLPR_YN: "N", OFL_YN: "",
    INQR_DVSN: "02", UNPR_DVSN: "01", FUND_STTL_ICLD_YN: "N",
    FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "00", CTX_AREA_FK100: "", CTX_AREA_NK100: "",
  }).toString();
  const url = BASE + "/uapi/domestic-stock/v1/trading/inquire-balance?" + q;
  return (await fetch(url, { headers: headers(token, trId, a.key, a.secret) })).json();
}
async function getBalance() {
  const accts = acctConfigs();
  if (!accts.length) return { error: "계좌가 설정되지 않았습니다 (KIS_ACCT1_NO 등)" };
  const trId = IS_MOCK ? "VTTC8434R" : "TTTC8434R";
  const holdings = [];
  const errors = [];
  const summary = [];
  let raw2 = null;
  for (let i = 0; i < accts.length; i++) {
    const a = accts[i];
    if (i > 0) await sleep(600); // 계좌 간 간격(초당 제한 회피)
    try {
      let j = await balanceOnce(a, trId);
      // 초당 제한이면 잠시 후 1회 재시도
      if (j.rt_cd !== "0" && isRate(j.msg1)) { await sleep(1000); j = await balanceOnce(a, trId); }
      if (j.rt_cd !== "0") { errors.push(a.label + ": " + (j.msg1 || "조회 실패")); continue; }
      (j.output1 || []).forEach((o) => {
        const qty = num(o.hldg_qty);
        if (!qty) return;
        holdings.push({
          account: a.label, code: o.pdno, name: o.prdt_name, qty,
          avg: num(o.pchs_avg_pric), price: num(o.prpr),
          evalAmt: num(o.evlu_amt), pnl: num(o.evlu_pfls_amt), pnlRate: num(o.evlu_pfls_rt),
        });
      });
      // 예수금·순자산은 output2에 있다(계좌 요약). 총손익 계산에 필요해 함께 반환한다.
      const o2 = Array.isArray(j.output2) ? (j.output2[0] || {}) : (j.output2 || {});
      if (!raw2) raw2 = o2; // 필드명 확인용 원본 1건 보존
      summary.push({
        account: a.label,
        cash: num(o2.dnca_tot_amt),          // 예수금총금액
        cashD2: num(o2.prvs_rcdl_excc_amt),  // 가수도정산금액(D+2)
        stockEval: num(o2.scts_evlu_amt),    // 유가평가금액
        totalEval: num(o2.tot_evlu_amt),     // 총평가금액
        netAsset: num(o2.nass_amt),          // 순자산금액
        purchase: num(o2.pchs_amt_smtl_amt), // 매입금액합계
        evalPnl: num(o2.evlu_pfls_smtl_amt), // 평가손익합계
      });
    } catch (e) { errors.push(a.label + ": " + e.message); }
  }
  const sum = (k) => summary.reduce((s, x) => s + (x[k] || 0), 0);
  return {
    holdings, summary, raw2,
    cash: sum("cash"), netAsset: sum("netAsset"), stockEval: sum("stockEval"),
    cashD2: sum("cashD2"), totalEval: sum("totalEval"),
    purchase: sum("purchase"), evalPnl: sum("evalPnl"),
    errors: errors.length ? errors : null,
  };
}

// --- 주문체결내역 조회 (계좌별 각자의 API 키 사용) ---
// 조회 시작일이 3개월 이전이면 별도 TR을 쓴다. 3개월 경계를 걸치는 기간은 단일 TR로 완전히 커버되지 않을 수 있다.
function tradeTrId(fromYmd) {
  const limit = new Date();
  limit.setMonth(limit.getMonth() - 3);
  const isOld = String(fromYmd) < ymd(limit);
  if (IS_MOCK) return isOld ? "VTSC9215R" : "VTTC0081R";
  return isOld ? "CTSC9215R" : "TTTC0081R";
}
async function tradesOnce(a, trId, from, to, fk, nk) {
  const token = await getTokenFor(a.key, a.secret); // 계좌별 키로 토큰
  const q = new URLSearchParams({
    CANO: a.no.slice(0, 8), ACNT_PRDT_CD: a.no.slice(8, 10),
    INQR_STRT_DT: from, INQR_END_DT: to,
    SLL_BUY_DVSN_CD: "00", PDNO: "", CCLD_DVSN: "01",
    INQR_DVSN: "00", INQR_DVSN_1: "", INQR_DVSN_3: "00",
    // KRX로 고정하면 넥스트레이드(NXT)·SOR 경유 체결분이 통째로 빠진다. ALL이 전체 거래소.
    ORD_GNO_BRNO: "", ODNO: "", EXCG_ID_DVSN_CD: "ALL",
    CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
  }).toString();
  const url = BASE + "/uapi/domestic-stock/v1/trading/inquire-daily-ccld?" + q;
  const h = headers(token, trId, a.key, a.secret);
  if (fk || nk) h.tr_cont = "N"; // 다음 페이지 요청
  const r = await fetch(url, { headers: h });
  return { json: await r.json(), trCont: r.headers.get("tr_cont") || "" };
}
// KIS는 3개월 경계로 TR이 갈려 긴 기간을 한 번에 못 받는다. 3개월 미만 구간으로 잘라 순차 조회한다.
const parseYmd = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const fmtYmd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
function splitPeriods(from, to) {
  const end = parseYmd(to);
  const out = [];
  let cur = parseYmd(from);
  while (cur <= end && out.length < 24) {
    const stop = new Date(cur);
    stop.setUTCMonth(stop.getUTCMonth() + 3);
    stop.setUTCDate(stop.getUTCDate() - 1);
    out.push([fmtYmd(cur), fmtYmd(stop > end ? end : stop)]);
    cur = new Date(stop);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
async function tradesPaged(a, from, to, trades, errors) {
  const trId = tradeTrId(from);
  let fk = "", nk = "";
  for (let page = 0; page < 20; page++) { // 연속조회 무한루프 방지
    if (page > 0) await sleep(200);
    let { json: j, trCont } = await tradesOnce(a, trId, from, to, fk, nk);
    // 초당 제한이면 잠시 후 같은 페이지를 1회 재시도
    if (j.rt_cd !== "0" && isRate(j.msg1)) {
      await sleep(1000);
      ({ json: j, trCont } = await tradesOnce(a, trId, from, to, fk, nk));
    }
    if (j.rt_cd !== "0") { errors.push(a.label + " " + from + ": " + (j.msg1 || "조회 실패")); return; }
    // 체결내역 필드명이 확정되지 않아 임의 변환 없이 원본 키를 그대로 보존한다
    (j.output1 || []).forEach((o) => trades.push({ account: a.label, ...o }));
    if (trCont !== "M" && trCont !== "F") return;
    const o2 = j.output2 || {};
    fk = o2.ctx_area_fk100 || "";
    nk = o2.ctx_area_nk100 || "";
    if (!fk && !nk) return; // 연속키가 없으면 더 받을 수 없음
  }
}
async function getTrades(from, to) {
  const accts = acctConfigs();
  if (!accts.length) return { error: "계좌가 설정되지 않았습니다 (KIS_ACCT1_NO 등)" };
  const periods = splitPeriods(from, to);
  const trades = [];
  const errors = [];
  for (let i = 0; i < accts.length; i++) {
    const a = accts[i];
    if (i > 0) await sleep(600); // 계좌 간 간격(초당 제한 회피)
    for (let p = 0; p < periods.length; p++) {
      if (p > 0) await sleep(250);
      try { await tradesPaged(a, periods[p][0], periods[p][1], trades, errors); }
      catch (e) { errors.push(a.label + ": " + e.message); }
    }
  }
  return { trades, from, to, periods, errors: errors.length ? errors : null };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!process.env.KIS_APPKEY || !process.env.KIS_APPSECRET)
      return res.status(500).json({ error: "환경변수(KIS_APPKEY/KIS_APPSECRET)가 설정되지 않았습니다." });
    const action = String(req.query.action || "price");

    // 잔고조회는 종목코드 불필요
    if (action === "balance") { res.status(200).json(await getBalance()); return; }

    // 뉴스는 외부 소스라 KIS 토큰도 종목코드도 필요 없다
    if (action === "news") {
      const q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ error: "q(검색어)를 입력하세요." });
      const lim = Math.min(parseInt(req.query.limit, 10) || 10, 30);
      res.status(200).json(await getNews(q, String(req.query.from || ""), String(req.query.to || ""), lim));
      return;
    }

    // 지수 조회도 종목코드 불필요 (지수코드 사용)
    if (action === "index") {
      const code = /^\d{4}$/.test(String(req.query.code || "")) ? String(req.query.code) : "0001";
      res.status(200).json(await getIndex(code, String(req.query.from || ""), String(req.query.to || "")));
      return;
    }

    // 체결내역도 종목코드 불필요 (기간만 사용)
    if (action === "trades") {
      const end = new Date();
      const start = new Date(); start.setMonth(start.getMonth() - 3); // 기본 3개월
      const dt = (v, def) => (/^\d{8}$/.test(v) ? v : def);
      const from = dt(String(req.query.from || ""), ymd(start));
      const to = dt(String(req.query.to || ""), ymd(end));
      res.status(200).json(await getTrades(from, to));
      return;
    }

    const symbol = String(req.query.symbol || "").trim();
    if (!/^\d{6}$/.test(symbol))
      return res.status(400).json({ error: "6자리 종목코드를 입력하세요 (예: 005930)" });

    let out;
    if (action === "debug") {
      // 진단: KIS 원본 응답에서 종목명 후보 필드 확인
      const token = await getToken();
      const pUrl = BASE + "/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" + symbol;
      const pj = await (await fetch(pUrl, { headers: headers(token, "FHKST01010100") })).json();
      const end = new Date(); const start = new Date(); start.setMonth(start.getMonth() - 1);
      const dUrl = BASE + "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" + symbol + "&FID_INPUT_DATE_1=" + ymd(start) + "&FID_INPUT_DATE_2=" + ymd(end) + "&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0";
      const dj = await (await fetch(dUrl, { headers: headers(token, "FHKST03010100") })).json();
      out = {
        price_rt_cd: pj.rt_cd, price_msg: pj.msg1,
        price_output_keys: Object.keys(pj.output || {}),
        price_name_candidates: { hts_kor_isnm: (pj.output||{}).hts_kor_isnm, rprs_mrkt_kor_name: (pj.output||{}).rprs_mrkt_kor_name },
        daily_rt_cd: dj.rt_cd, daily_msg: dj.msg1,
        daily_output1: dj.output1 || null,
      };
    }
    else if (action === "daily") out = await getDaily(symbol, String(req.query.from || ""), String(req.query.to || ""));
    else if (action === "finance") out = await getFinance(symbol);
    else if (action === "quote") out = await getPrice(symbol);   // 실시간용(가벼움)
    else out = await getFull(symbol);                            // 기본: 전체(현재가+이름+차트+재무)
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
