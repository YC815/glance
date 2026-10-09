// 兩支 API（GET /api/glance、POST /api/ftp）＋ public/ 的靜態檔。沒有框架。

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { authorized } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { FTP_MAX, FTP_MIN, createGlance, parseRefresh } from "./glance.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const cfg = loadConfig();
const { glance, setFtp } = createGlance(cfg);

if (!cfg.token) console.warn("[glance] 沒有設定 GLANCE_TOKEN，任何人都能讀 /api/glance");
if (!cfg.homework) console.warn("[glance] 沒有設定 DUE_NOW_TOKEN，不顯示作業");
if (!cfg.calendar) console.warn("[glance] 沒有設定 CALENDAR_ICS_URLS，不顯示行事曆");
if (!cfg.strava) console.warn("[glance] 沒有設定 STRAVA_CLIENT_ID／STRAVA_CLIENT_SECRET／STRAVA_REFRESH_TOKEN，不顯示騎車");

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra = {}) {
  res.writeHead(status, { "content-type": type, ...extra });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");

  if (url.pathname === "/api/glance") {
    if (!authorized(req.headers.authorization, cfg.token)) {
      return send(res, 401, JSON.stringify({ error: "金鑰不對" }), "application/json");
    }
    // ?refresh=homework／weather：使用者點了作業數字或「未來一週」，跳過快取直接重抓
    const payload = await glance(Date.now(), {
      refresh: parseRefresh(url.searchParams.get("refresh")),
    });
    return send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8", {
      "cache-control": "no-store",
    });
  }

  if (url.pathname === "/api/ftp") {
    if (req.method !== "POST") return send(res, 405, "", "text/plain");
    if (!authorized(req.headers.authorization, cfg.token)) {
      return send(res, 401, JSON.stringify({ error: "金鑰不對" }), "application/json");
    }
    // 點騎車頁的 FTP 數字輸入：{ "watts": 230 }
    let watts = NaN;
    try {
      watts = Number((JSON.parse(await readBody(req)) as { watts?: unknown }).watts);
    } catch {
      /* 壞掉的 JSON 當成數字不對 */
    }
    if (!Number.isInteger(watts) || watts < FTP_MIN || watts > FTP_MAX) {
      return send(res, 400, JSON.stringify({ error: `FTP 要是 ${FTP_MIN}–${FTP_MAX} 的整數` }), "application/json");
    }
    await setFtp(watts);
    return send(res, 200, JSON.stringify({ ok: true }), "application/json");
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", "text/plain");

  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 404, "not found", "text/plain");
  try {
    const body = await readFile(file);
    // 殼層檔案每次都問過伺服器（service worker 也是 network-first），改版立刻生效
    return send(res, 200, body, TYPES[extname(file)] ?? "application/octet-stream", {
      "cache-control": "no-cache",
    });
  } catch {
    return send(res, 404, "not found", "text/plain");
  }
}

/** 讀請求內容；只收很小的 JSON，太大直接斷掉。 */
function readBody(req: IncomingMessage, limit = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[glance]", err);
    if (!res.headersSent) send(res, 500, "error", "text/plain");
    else res.end();
  });
}).listen(cfg.port, () => {
  console.log(`[glance] http://localhost:${cfg.port}`);
  // 啟動就先抓一輪：手機第一次打開不用等，日誌也看得出各來源通不通
  glance().then((p) => {
    const w = p.weather;
    console.log(
      `[glance] 預熱：天氣 ${w ? "ok" : `失敗：${p.sources.weather.error}`}；` +
        `作業 ${p.homework ? `ok（今天 ${p.homework.today}，三天內 ${p.homework.within3Days}）` : (p.sources.homework.error ?? "未設定")}；` +
        `行事曆 ${p.calendar ? `ok（今天 ${p.calendar.today.length}，明天 ${p.calendar.tomorrow.length}）` : (p.sources.calendar.error ?? "未設定")}；` +
        `騎車 ${p.sources.training.error ?? (p.training ? `ok（FTP ${p.training.ftp ?? "未填"}，CTL ${p.training.ctl ?? "–"}）` : "未設定")}`,
    );
  });
});
