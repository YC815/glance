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
if (!cfg.homework) console.warn("[glance] 沒有設定 DUE_NOW_GLANCE_KEY，不顯示作業");
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
    const payload = await glance();
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

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[glance]", err);
    if (!res.headersSent) send(res, 500, "error", "text/plain");
    else res.end();
  });
}).listen(cfg.port, () => {
  console.log(`[glance] http://localhost:${cfg.port}`);
});
