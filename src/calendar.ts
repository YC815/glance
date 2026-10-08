// Google Calendar：用服務帳戶讀今天與明天的行程。
//
// 為什麼用服務帳戶而不是 OAuth：OAuth 用戶端在「測試中」狀態時 refresh token 7 天就失效，
// 常駐看板會三不五時斷掉。服務帳戶只要把行事曆分享給它的 email（「查看所有活動詳細資料」）就能讀，
// 金鑰不會過期。JWT 用 node:crypto 自己簽，不必拉 googleapis 整包進來。

import { createSign } from "node:crypto";
import { DAY_MS, hhmm, startOfTaipeiDay } from "./time.ts";

export type CalendarConfig = {
  clientEmail: string;
  privateKey: string;
  calendarIds: string[];
};

export type CalEvent = {
  /** 「09:30」或「整天」 */
  time: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
};

export type CalendarView = { today: CalEvent[]; tomorrow: CalEvent[] };

/** 從服務帳戶金鑰 JSON 字串讀出需要的欄位。 */
export function parseServiceAccount(json: string): { clientEmail: string; privateKey: string } {
  const key = JSON.parse(json) as { client_email?: string; private_key?: string };
  if (!key.client_email || !key.private_key) {
    throw new Error("服務帳戶金鑰缺少 client_email 或 private_key");
  }
  return { clientEmail: key.client_email, privateKey: key.private_key };
}

const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let tokenCache: { token: string; expiresAt: number; email: string } | null = null;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(clientEmail: string, privateKey: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(privateKey))}`;
}

async function accessToken(cfg: CalendarConfig): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.email === cfg.clientEmail && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signJwt(cfg.clientEmail, cfg.privateKey, Math.floor(now / 1000)),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
    email: cfg.clientEmail,
  };
  return json.access_token;
}

type GoogleEvent = {
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

export async function fetchCalendar(cfg: CalendarConfig, now = Date.now()): Promise<CalendarView> {
  const token = await accessToken(cfg);
  const today = startOfTaipeiDay(now);
  const params = new URLSearchParams({
    timeMin: new Date(today).toISOString(),
    timeMax: new Date(today + 2 * DAY_MS).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });
  const lists = await Promise.all(
    cfg.calendarIds.map(async (id) => {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?${params}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`Google Calendar ${id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return ((await res.json()) as { items?: GoogleEvent[] }).items ?? [];
    }),
  );
  return groupEvents(lists.flat(), now);
}

/** 全天活動的日期（YYYY-MM-DD）是台北的日子。 */
function taipeiDate(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

export function normalizeEvent(e: GoogleEvent): Omit<CalEvent, "time"> | null {
  if (e.status === "cancelled") return null;
  const title = e.summary?.trim() || "（沒有標題）";
  if (e.start?.dateTime && e.end?.dateTime) {
    return { title, start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime), allDay: false };
  }
  if (e.start?.date && e.end?.date) {
    return { title, start: taipeiDate(e.start.date), end: taipeiDate(e.end.date), allDay: true };
  }
  return null;
}

/** 分成今天、明天。跨日的全天活動兩天都列；計時活動放在開始那天（昨天開始、今天還沒結束的放今天）。 */
export function groupEvents(items: GoogleEvent[], now: number): CalendarView {
  const today = startOfTaipeiDay(now);
  const tomorrow = today + DAY_MS;
  const out: CalendarView = { today: [], tomorrow: [] };

  for (const raw of items) {
    const e = normalizeEvent(raw);
    if (!e) continue;
    const overlaps = (from: number) => e.start < from + DAY_MS && e.end > from;
    if (e.allDay) {
      if (overlaps(today)) out.today.push({ ...e, time: "整天" });
      if (overlaps(tomorrow)) out.tomorrow.push({ ...e, time: "整天" });
    } else if (e.start >= tomorrow && e.start < tomorrow + DAY_MS) {
      out.tomorrow.push({ ...e, time: hhmm(e.start) });
    } else if (overlaps(today)) {
      out.today.push({ ...e, time: e.start < today ? "延續" : hhmm(e.start) });
    }
  }
  // 全天的排前面，其餘照開始時間
  const order = (a: CalEvent, b: CalEvent) =>
    Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title);
  out.today.sort(order);
  out.tomorrow.sort(order);
  return out;
}
