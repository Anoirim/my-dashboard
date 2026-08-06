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

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(BASE + "/oauth2/tokenP", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.KIS_APPKEY,
      appsecret: process.env.KIS_APPSECRET,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.msg1 || "토큰 발급 실패");
  const ttl = (j.expires_in ? j.expires_in - 60 : 23 * 3600) * 1000;
  tokenCache = { token: j.access_token, exp: Date.now() + ttl };
  return tokenCache.token;
}

function headers(token, tr_id) {
  return {
    "content-type": "application/json",
    authorization: "Bearer " + token,
    appkey: process.env.KIS_APPKEY,
    appsecret: process.env.KIS_APPSECRET,
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
  const candles = arr
    .filter((x) => x.stck_bsop_date && x.stck_clpr)
    .map((x) => ({ date: x.stck_bsop_date, close: num(x.stck_clpr), vol: num(x.acml_vol) }))
    .sort((a, b) => a.date.localeCompare(b.date)); // 과거→최근
  return { candles };
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!process.env.KIS_APPKEY || !process.env.KIS_APPSECRET)
      return res.status(500).json({ error: "환경변수(KIS_APPKEY/KIS_APPSECRET)가 설정되지 않았습니다." });
    const symbol = String(req.query.symbol || "").trim();
    if (!/^\d{6}$/.test(symbol))
      return res.status(400).json({ error: "6자리 종목코드를 입력하세요 (예: 005930)" });

    const action = String(req.query.action || "price");
    let out;
    if (action === "daily") out = await getDaily(symbol);
    else if (action === "finance") out = await getFinance(symbol);
    else out = await getPrice(symbol);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
