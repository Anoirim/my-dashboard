// KIS(한국투자증권) OpenAPI 프록시 - Vercel 서버리스 함수
// 환경변수 필요: KIS_APPKEY, KIS_APPSECRET  (실전투자 기준)
// 호출 예: /api/kis?symbol=005930

const BASE = "https://openapi.koreainvestment.com:9443"; // 실전 (모의투자는 https://openapivts.koreainvestment.com:29443)

// 접근토큰 캐시 (같은 인스턴스가 살아있는 동안 재사용 → KIS 재발급 제한 회피)
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

async function getPrice(symbol) {
  const token = await getToken();
  const url =
    BASE +
    "/uapi/domestic-stock/v1/quotations/inquire-price" +
    "?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=" +
    symbol;
  const r = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
      appkey: process.env.KIS_APPKEY,
      appsecret: process.env.KIS_APPSECRET,
      tr_id: "FHKST01010100",
      custtype: "P",
    },
  });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (!process.env.KIS_APPKEY || !process.env.KIS_APPSECRET)
      return res.status(500).json({ error: "환경변수(KIS_APPKEY/KIS_APPSECRET)가 설정되지 않았습니다." });

    const symbol = String(req.query.symbol || "").trim();
    if (!/^\d{6}$/.test(symbol))
      return res.status(400).json({ error: "6자리 종목코드를 입력하세요 (예: 005930)" });

    const j = await getPrice(symbol);
    const o = j.output || {};
    if (!o.stck_prpr) return res.status(200).json({ error: "데이터 없음", raw: j.msg1 || j });

    const num = (v) => (v === undefined || v === "" ? null : Number(v));
    res.status(200).json({
      name: o.hts_kor_isnm || symbol,
      price: num(o.stck_prpr),      // 현재가
      diff: num(o.prdy_vrss),       // 전일대비
      rate: num(o.prdy_ctrt),       // 등락률(%)
      open: num(o.stck_oprc),       // 시가
      high: num(o.stck_hgpr),       // 고가
      low: num(o.stck_lwpr),        // 저가
      prevClose: num(o.stck_sdpr),  // 전일종가(기준가)
      per: num(o.per),
      pbr: num(o.pbr),
      eps: num(o.eps),
      w52high: num(o.w52_hgpr),     // 52주 최고
      w52low: num(o.w52_lwpr),      // 52주 최저
      volume: num(o.acml_vol),      // 누적거래량
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
