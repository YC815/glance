// /api/glance 的回應：三個來源各自快取，每次請求用「現在」重新排出要顯示的東西，
// 所以就算天氣 15 分鐘才抓一次，24 小時長條圖也會跟著整點往前走。

import { CachedSource, type Source } from "./cache.ts";
import { fetchCalendar, type CalendarView } from "./calendar.ts";
import type { Config } from "./config.ts";
import { fetchHomework, type Homework } from "./homework.ts";
import { buildWeatherView, type WeatherView } from "./view.ts";
import { fetchForecast, type Forecast } from "./weather.ts";

const MINUTE = 60_000;

export type SourceStatus = { configured: boolean; updatedAt: number | null; error: string | null };

export type GlancePayload = {
  generatedAt: number;
  weather: WeatherView | null;
  homework: Homework | null;
  calendar: { today: ClientEvent[]; tomorrow: ClientEvent[] } | null;
  sources: { weather: SourceStatus; homework: SourceStatus; calendar: SourceStatus };
};

/** 給前端的行程：結束時間用來把已經過去的畫淡。 */
export type ClientEvent = { time: string; title: string; end: number };

export function createGlance(cfg: Config) {
  const weather = new CachedSource<Forecast>(15 * MINUTE, () => fetchForecast(cfg.weather));
  const homework = cfg.homework
    ? // 在 Due Now 勾完成後要很快反映，不然會焦慮；Due Now 那邊只是兩個 count 查詢，很輕。
      // 用 50 秒而不是 60 秒：手機每分鐘來一次，計時稍有誤差也保證每次都拿到新的。
      new CachedSource<Homework>(50_000, () => fetchHomework(cfg.homework!))
    : null;
  const calendar = cfg.calendar
    ? new CachedSource<CalendarView>(5 * MINUTE, () => fetchCalendar(cfg.calendar!))
    : null;

  return async function glance(now = Date.now()): Promise<GlancePayload> {
    const [w, h, c] = await Promise.all([
      weather.get(now),
      homework?.get(now) ?? null,
      calendar?.get(now) ?? null,
    ]);
    const cal = c?.value ?? null;
    return {
      generatedAt: now,
      weather: w.value ? buildWeatherView(w.value.hours, now) : null,
      homework: h?.value ?? null,
      calendar: cal && {
        today: cal.today.map(toClient),
        tomorrow: cal.tomorrow.map(toClient),
      },
      sources: { weather: status(w), homework: status(h), calendar: status(c) },
    };
  };
}

function toClient(e: CalendarView["today"][number]): ClientEvent {
  return { time: e.time, title: e.title, end: e.end };
}

function status(s: Source<unknown> | null): SourceStatus {
  if (!s) return { configured: false, updatedAt: null, error: null };
  return { configured: true, updatedAt: s.updatedAt, error: s.error };
}
