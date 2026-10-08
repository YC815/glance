// 一支 API（/api/glance）＋ public/ 的靜態檔。沒有框架，零相依。

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { authorized } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createGlance } from "./glance.ts";

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
const glance = createGlance(cfg);

if (!cfg.token) console.warn("[glance] 沒有設定 GLANCE_TOKEN，任何人都能讀 /api/glance");
if (!cfg.homework) console.warn("[glance] 沒有設定 DUE_NOW_TOKEN，不顯示作業");
if (!cfg.calendar) console.warn("[glance] 沒有設定 GOOGLE_SERVICE_ACCOUNT_JSON／GOOGLE_CALENDAR_IDS，不顯示行事曆");

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
    // ?refresh=homework：使用者點了作業數字，跳過快取直接問 Due Now
    const payload = await glance(Date.now(), {
      refreshHomework: url.searchParams.get("refresh") === "homework",
    });
    return send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8", {
      "cache-control": "no-store",
    });
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

/** 「雨量有值 24/24 小時，合計 3.2 mm，最大 1.5 mm」：日誌裡分得出是不下雨還是沒資料 */
function rainStats(bars: { mm: number | null }[]): string {
  const values = bars.map((b) => b.mm).filter((v): v is number => v !== null);
  const sum = values.reduce((a, b) => a + b, 0);
  const max = values.length ? Math.max(...values) : 0;
  return `雨量有值 ${values.length}/${bars.length} 小時，合計 ${sum.toFixed(1)} mm，最大 ${max.toFixed(1)} mm`;
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
      `[glance] 預熱：天氣 ${w ? `ok（${w.headline}，UTCI ${w.utci?.value ?? "-"}，${rainStats(w.rain24)}）` : `失敗：${p.sources.weather.error}`}；` +
        `作業 ${p.homework ? `ok（今天 ${p.homework.today}，三天內 ${p.homework.within3Days}）` : (p.sources.homework.error ?? "未設定")}；` +
        `行事曆 ${p.calendar ? `ok（今天 ${p.calendar.today.length}，明天 ${p.calendar.tomorrow.length}）` : (p.sources.calendar.error ?? "未設定")}`,
    );
  });
});
