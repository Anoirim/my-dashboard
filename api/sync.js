// 기기 사이에 데이터를 맞추기 위한 저장소. 지금은 식품 재고만 쓴다.
// GET  /api/sync?key=foods  → { data, updatedAt }
// POST /api/sync?key=foods  → 본문(JSON 배열)을 그대로 저장
// kis.js의 토큰 캐시와 같은 Upstash를 쓰지만, 이쪽은 만료 없이 보관해야 하므로 저장 함수를 따로 둔다.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// 아무 키나 쓰지 못하게 막는다. 새 동기화 대상을 늘릴 때 여기에 추가한다.
const ALLOWED = ["foods", "fdLog"];
const PREFIX = "dash_";

async function kvGetRaw(key) {
  const r = await fetch(`${KV_URL}/get/${PREFIX}${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const j = await r.json();
  return j.result || null;
}
// 값이 길어 URL 경로에 넣을 수 없으므로 본문으로 보낸다(토큰과 달리 만료를 두지 않는다).
async function kvSetRaw(key, val) {
  const r = await fetch(`${KV_URL}/set/${PREFIX}${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "text/plain" },
    body: val,
  });
  if (!r.ok) throw new Error("KV 저장 실패 " + r.status);
}

// kis.js와 같은 정책: DASH_TOKEN이 없으면 통과시켜 환경변수를 넣기 전에도 동작한다.
function authFailed(req) {
  const want = process.env.DASH_TOKEN || "";
  if (!want) return false;
  const got = String(req.headers["x-dash-token"] || "");
  if (got.length !== want.length) return true;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff !== 0;
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 2e6) reject(new Error("본문이 너무 큽니다.")); });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-dash-token, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (authFailed(req))
      return res.status(401).json({ error: "접근 토큰이 필요합니다.", needToken: true });
    if (!KV_URL || !KV_TOKEN)
      return res.status(503).json({ error: "저장소(KV)가 연결되지 않았습니다. Vercel Storage를 확인하세요." });

    const key = String(req.query.key || "");
    if (!ALLOWED.includes(key))
      return res.status(400).json({ error: "허용되지 않은 key입니다.", allowed: ALLOWED });

    if (req.method === "GET") {
      const raw = await kvGetRaw(key);
      if (!raw) return res.status(200).json({ data: null, updatedAt: null });
      try {
        return res.status(200).json(JSON.parse(raw));
      } catch (e) {
        return res.status(200).json({ data: null, updatedAt: null });
      }
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body); } catch (e) { return res.status(400).json({ error: "본문이 JSON이 아닙니다." }); }
      if (!Array.isArray(data)) return res.status(400).json({ error: "본문은 배열이어야 합니다." });
      const payload = { data, updatedAt: new Date().toISOString() };
      await kvSetRaw(key, JSON.stringify(payload));
      return res.status(200).json({ ok: true, count: data.length, updatedAt: payload.updatedAt });
    }

    return res.status(405).json({ error: "GET 또는 POST만 됩니다." });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
