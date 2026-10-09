// Strava API：列出騎乘、抓逐秒串流，算好的數字存進 RideStore。
// 用自己建的 Strava API App（只有自己一個運動員），OAuth refresh token 換 access token（6 小時過期）。
// 第一次授權拿 refresh token 用 scripts/strava-auth.ts。
//
// 速率限制（讀取）：每 15 分鐘 100 次、每天 1000 次，整個 App 共用。
// 平常每 15 分鐘列一次清單（1 次）＋新騎乘的串流；剛接上時要補一年份的串流，
// 每 15 分鐘最多用 READ_BUDGET 次，分幾輪補完。

import { createHash } from "node:crypto";
import type { RideStore } from "./store.ts";
import { DAY_MS } from "./time.ts";
import { METRICS_VERSION, rideMetrics, type Ride } from "./training.ts";

export type StravaConfig = { clientId: string; clientSecret: string; refreshToken: string };

const API = "https://www.strava.com/api/v3";
const TOKEN_URL = "https://www.strava.com/oauth/token";

/** 要算的運動類型：電輔車不算（功率不是自己出的） */
const RIDE_TYPES = new Set(["Ride", "VirtualRide", "GravelRide", "MountainBikeRide"]);
/** 歷史抓多久：CTL 要從夠早開始疊才會準，功率曲線也看一年 */
const HISTORY_DAYS = 365;
/** 每次都重新列最近幾天，補上晚上傳或改過的騎乘 */
const RELIST_DAYS = 7;
/** 每 15 分鐘最多打幾次（留 20 次給手動重抓和誤差） */
const READ_BUDGET = 80;
const WINDOW_MS = 15 * 60_000;
/** 一次同步花在補串流的時間上限：看板的請求會等它，前端 20 秒逾時 */
const STREAMS_TIME_MS = 8_000;

export type SyncResult = { added: number; computed: number; pending: number };

class RateLimited extends Error {}

export class Strava {
  private readonly cfg: StravaConfig;
  private readonly store: RideStore;
  private access: { token: string; expiresAt: number } | null = null;
  private calls: number[] = [];

  constructor(cfg: StravaConfig, store: RideStore) {
    this.cfg = cfg;
    this.store = store;
  }

  /** 列新騎乘、補串流、存檔。清單抓不到算失敗；串流抓到一半撞到上限就下次再補。 */
  async sync(now = Date.now()): Promise<SyncResult> {
    const data = await this.store.load();
    const rides = data.rides;

    const latest = Math.max(0, ...Object.values(rides).map((r) => r.start));
    const after = latest
      ? Math.min(latest, now - RELIST_DAYS * DAY_MS)
      : now - HISTORY_DAYS * DAY_MS;
    let added = 0;
    for (const a of await this.listActivities(after, now)) {
      if (!RIDE_TYPES.has(a.sport_type)) continue;
      const id = String(a.id);
      const old = rides[id];
      if (!old) added++;
      rides[id] = {
        id,
        start: Date.parse(a.start_date),
        name: a.name,
        movingSec: a.moving_time,
        hasPower: a.device_watts === true,
        metrics: old?.metrics,
      };
    }
    for (const [id, r] of Object.entries(rides)) {
      if (r.start < now - (HISTORY_DAYS + 30) * DAY_MS) delete rides[id];
    }

    // 新的先補：剛騎完的那趟最想看到
    const todo = Object.values(rides)
      .filter((r) => r.hasPower && (r.metrics === undefined || (r.metrics && r.metrics.v !== METRICS_VERSION)))
      .sort((a, b) => b.start - a.start);
    let computed = 0;
    const started = Date.now();
    try {
      for (const r of todo) {
        if (Date.now() - started > STREAMS_TIME_MS) break;
        r.metrics = await this.metricsFor(r, now);
        computed++;
      }
    } catch (err) {
      if (!(err instanceof RateLimited)) {
        await this.store.save();
        throw err;
      }
    }
    await this.store.save();
    return { added, computed, pending: todo.length - computed };
  }

  private async metricsFor(r: Ride, now: number): Promise<Ride["metrics"]> {
    const res = await this.get(`/activities/${r.id}/streams?keys=time,watts,heartrate&key_by_type=true`, now);
    if (res === null) return null; // 刪掉或設成私人看不到
    const s = res as Record<string, { data?: (number | null)[] } | undefined>;
    const time = s.time?.data;
    if (!time) return null;
    return rideMetrics({
      time: time as number[],
      watts: s.watts?.data ?? null,
      heartrate: s.heartrate?.data ?? null,
    });
  }

  private async listActivities(after: number, now: number): Promise<SummaryActivity[]> {
    const out: SummaryActivity[] = [];
    for (let page = 1; page <= 20; page++) {
      const list = (await this.get(
        `/athlete/activities?after=${Math.floor(after / 1000)}&per_page=100&page=${page}`,
        now,
        true,
      )) as SummaryActivity[];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  /** 回 JSON；404 回 null。`essential`：清單這種一定要打的，不受自己的預算限制（Strava 的 429 照樣擋）。 */
  private async get(path: string, now: number, essential = false): Promise<unknown> {
    this.calls = this.calls.filter((t) => now - t < WINDOW_MS);
    if (!essential && this.calls.length >= READ_BUDGET) throw new RateLimited();
    this.calls.push(now);
    const token = await this.accessToken(now);
    const res = await fetch(API + path, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      if (essential) throw new Error("Strava 429：超過速率限制");
      throw new RateLimited();
    }
    if (res.status === 401) this.access = null;
    if (!res.ok) throw new Error(`Strava ${res.status}: ${await errorMessage(res)}`);
    return res.json();
  }

  private async accessToken(now: number): Promise<string> {
    if (this.access && this.access.expiresAt - 60_000 > now) return this.access.token;
    const data = await this.store.load();
    // 環境變數換過（重新授權過）就用新的；不然用 Strava 上次換發、存在磁碟上的
    const envId = fingerprint(this.cfg.refreshToken);
    const refreshToken =
      data.refreshToken && data.refreshTokenEnv === envId ? data.refreshToken : this.cfg.refreshToken;
    // Strava 文件用的是表單格式
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Strava 換 token 失敗 ${res.status}: ${await errorMessage(res)}`);
    const j = (await res.json()) as { access_token: string; expires_at: number; refresh_token: string };
    this.access = { token: j.access_token, expiresAt: j.expires_at * 1000 };
    if (j.refresh_token !== data.refreshToken || data.refreshTokenEnv !== envId) {
      data.refreshToken = j.refresh_token;
      data.refreshTokenEnv = envId;
      await this.store.save();
    }
    return j.access_token;
  }
}

type SummaryActivity = {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  moving_time: number;
  device_watts?: boolean;
};

/**
 * Strava 的錯誤格式是 { message, errors: [{ resource, field, code }] }。
 * 留 message 和每個錯誤的 resource／field／code（例如「RefreshToken.refresh_token invalid」），
 * 看得出是哪個值不對；不把整包（可能含 token）帶進 log。
 */
export async function errorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: unknown; errors?: unknown };
    const message = typeof j.message === "string" ? j.message : "unknown";
    const details = Array.isArray(j.errors)
      ? j.errors
          .map((e: { resource?: unknown; field?: unknown; code?: unknown }) =>
            [e.resource, e.field].filter((x) => typeof x === "string").join(".") +
            (typeof e.code === "string" ? ` ${e.code}` : ""),
          )
          .filter(Boolean)
      : [];
    return details.length ? `${message}（${details.join("、")}）` : message;
  } catch {
    return "unknown";
  }
}

/** 只用來判斷環境變數那把 token 有沒有換過，不存原文。 */
function fingerprint(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
