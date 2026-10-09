// /api/glance 的回應：各來源各自快取，每次請求用「現在」重新排出要顯示的東西，
// 所以就算天氣 15 分鐘才抓一次，24 小時長條圖也會跟著整點往前走。

import { CachedSource, type Source } from "./cache.ts";
import { fetchCalendar, type CalendarView } from "./calendar.ts";
import type { Config } from "./config.ts";
import { fetchHomework, type Homework } from "./homework.ts";
import { RideStore } from "./store.ts";
import { Strava, type SyncResult } from "./strava.ts";
import { startOfTaipeiDay } from "./time.ts";
import { buildTrainingView, type TrainingView } from "./training.ts";
import { buildWeatherView, type WeatherView } from "./view.ts";
import { fetchForecast, type Forecast } from "./weather.ts";
import { weatherLogLine } from "./weather-log.ts";

const MINUTE = 60_000;

export type SourceStatus = { configured: boolean; updatedAt: number | null; error: string | null };

export type GlancePayload = {
  generatedAt: number;
  weather: WeatherView | null;
  homework: Homework | null;
  calendar: { today: ClientEvent[]; tomorrow: ClientEvent[] } | null;
  training: TrainingView | null;
  sources: { weather: SourceStatus; homework: SourceStatus; calendar: SourceStatus; training: SourceStatus };
};

/** 給前端的行程：結束時間用來把已經過去的畫淡。 */
export type ClientEvent = { time: string; title: string; end: number };

/** 使用者手動要求跳過快取重抓的來源：點作業數字、點「未來一週」、點「騎車」 */
export type RefreshTarget = "homework" | "weather" | "training";
const REFRESH_TARGETS: string[] = ["homework", "weather", "training"];

export function parseRefresh(param: string | null): RefreshTarget[] {
  return (param ?? "").split(",").filter((s): s is RefreshTarget => REFRESH_TARGETS.includes(s));
}

/** 手填 FTP 的合理範圍（瓦） */
export const FTP_MIN = 50;
export const FTP_MAX = 600;

export function createGlance(cfg: Config) {
  const weather = new CachedSource<Forecast>(15 * MINUTE, async () => {
    const forecast = await fetchForecast(cfg.weather);
    console.log(`[glance] ${weatherLogLine(buildWeatherView(forecast.hours, forecast.fetchedAt), forecast.fetchedAt)}`);
    return forecast;
  });
  const homework = cfg.homework
    ? // 平常 5 分鐘；在 Due Now 勾完成後可以點看板上的數字強制重抓
      new CachedSource<Homework>(5 * MINUTE, () => fetchHomework(cfg.homework!))
    : null;
  const calendar = cfg.calendar
    ? new CachedSource<CalendarView>(5 * MINUTE, () => fetchCalendar(cfg.calendar!))
    : null;
  const store = new RideStore(cfg.dataDir);
  const strava = cfg.strava ? new Strava(cfg.strava, store) : null;
  const training: CachedSource<SyncResult> | null = strava
    ? new CachedSource<SyncResult>(15 * MINUTE, async () => {
        const r = await strava.sync();
        console.log(`[glance] Strava：新騎乘 ${r.added} 趟、算了 ${r.computed} 趟${r.pending ? `、還有 ${r.pending} 趟稍後補` : ""}`);
        // 剛接上要補一年份：一次只補幾秒（不讓看板等太久），剩下的在背景接著補，不等下一次 15 分鐘
        if (r.pending) setTimeout(() => void training!.get(Date.now(), true), 5 * MINUTE).unref();
        return r;
      })
    : null;

  /** 從今天起改用這個 FTP（之前的騎乘照舊用當時的）。同一天改好幾次只留最後一次。 */
  async function setFtp(watts: number, now = Date.now()): Promise<void> {
    const data = await store.load();
    const from = startOfTaipeiDay(now);
    data.ftp = data.ftp.filter((e) => e.from < from);
    data.ftp.push({ from, watts });
    await store.save();
  }

  async function glance(
    now = Date.now(),
    opts: { refresh?: RefreshTarget[] } = {},
  ): Promise<GlancePayload> {
    const force = (target: RefreshTarget) => opts.refresh?.includes(target) ?? false;
    const [w, h, c, t] = await Promise.all([
      weather.get(now, force("weather")),
      homework?.get(now, force("homework")) ?? null,
      calendar?.get(now) ?? null,
      training?.get(now, force("training")) ?? null,
    ]);
    const cal = c?.value ?? null;
    // 存檔裡的騎乘每次照「現在」重排：FTP 改了、過了午夜，不用等下一次同步。
    // 這次同步失敗也照樣顯示存檔裡的（sources.training 會帶錯誤）
    const rides = training ? await store.load().catch(() => null) : null;
    return {
      generatedAt: now,
      weather: w.value ? buildWeatherView(w.value.hours, now) : null,
      homework: h?.value ?? null,
      calendar: cal && {
        today: cal.today.map(toClient),
        tomorrow: cal.tomorrow.map(toClient),
      },
      training: rides && buildTrainingView(Object.values(rides.rides), rides.ftp, now),
      sources: { weather: status(w), homework: status(h), calendar: status(c), training: status(t) },
    };
  }

  return { glance, setFtp };
}

function toClient(e: CalendarView["today"][number]): ClientEvent {
  return { time: e.time, title: e.title, end: e.end };
}

function status(s: Source<unknown> | null): SourceStatus {
  if (!s) return { configured: false, updatedAt: null, error: null };
  return { configured: true, updatedAt: s.updatedAt, error: s.error };
}
