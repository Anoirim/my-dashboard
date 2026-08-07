// KIS(한국투자증권) OpenAPI 프록시 - Vercel 서버리스 함수
// 환경변수: KIS_APPKEY, KIS_APPSECRET  (모의투자면 KIS_ENV=mock 추가)
// 호출:
//   /api/kis?symbol=005930                 → 현재가/지표
//   /api/kis?action=daily&symbol=005930    → 최근 일봉(과거 시세)
//   /api/kis?action=finance&symbol=005930  → 재무비율(ROE·부채비율 등)

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

async function getDaily(symbol) {
  const token = await getToken();
  const end = new Date();
  const start = new Date(); start.setMonth(start.getMonth() - 5); // 약 5개월
  const url =
    BASE + "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice" +
    "?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" + symbol +
    "&FID_INPUT_DATE_1=" + ymd(start) + "&FID_INPUT_DATE_2=" + ymd(end) +
    "&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0";
  const j = await (await fetch(url, { headers: headers(token, "FHKST03010100") })).json();
  const arr = j.output2 || [];
  const name = (j.output1 && (j.output1.hts_kor_isnm || j.output1.prdt_name)) || null; // 종목명
  const candles = arr
    .filter((x) => x.stck_bsop_date && x.stck_clpr)
    .map((x) => ({ date: x.stck_bsop_date, close: num(x.stck_clpr), vol: num(x.acml_vol) }))
    .sort((a, b) => a.date.localeCompare(b.date)); // 과거→최근
  return { name, candles };
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
async function getBalance() {
  const accts = acctConfigs();
  if (!accts.length) return { error: "계좌가 설정되지 않았습니다 (KIS_ACCT1_NO 등)" };
  const trId = IS_MOCK ? "VTTC8434R" : "TTTC8434R";
  const holdings = [];
  const errors = [];
  for (const a of accts) {
    try {
      const token = await getTokenFor(a.key, a.secret); // 계좌별 키로 토큰
      const q = new URLSearchParams({
        CANO: a.no.slice(0, 8), ACNT_PRDT_CD: a.no.slice(8, 10), AFHR_FLPR_YN: "N", OFL_YN: "",
        INQR_DVSN: "02", UNPR_DVSN: "01", FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "00", CTX_AREA_FK100: "", CTX_AREA_NK100: "",
      }).toString();
      const url = BASE + "/uapi/domestic-stock/v1/trading/inquire-balance?" + q;
      const j = await (await fetch(url, { headers: headers(token, trId, a.key, a.secret) })).json();
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
    } catch (e) { errors.push(a.label + ": " + e.message); }
  }
  return { holdings, errors: errors.length ? errors : null };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!process.env.KIS_APPKEY || !process.env.KIS_APPSECRET)
      return res.status(500).json({ error: "환경변수(KIS_APPKEY/KIS_APPSECRET)가 설정되지 않았습니다." });
    const action = String(req.query.action || "price");

    // 잔고조회는 종목코드 불필요
    if (action === "balance") { res.status(200).json(await getBalance()); return; }

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
    else if (action === "daily") out = await getDaily(symbol);
    else if (action === "finance") out = await getFinance(symbol);
    else if (action === "quote") out = await getPrice(symbol);   // 실시간용(가벼움)
    else out = await getFull(symbol);                            // 기본: 전체(현재가+이름+차트+재무)
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
