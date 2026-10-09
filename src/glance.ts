// /api/glance 的回應：三個來源各自快取，每次請求用「現在」重新排出要顯示的東西，
// 所以就算天氣 15 分鐘才抓一次，24 小時長條圖也會跟著整點往前走。

import { CachedSource, type Source } from "./cache.ts";
import { fetchCalendar, type CalendarView } from "./calendar.ts";
import type { Config } from "./config.ts";
import { fetchHomework, type Homework } from "./homework.ts";
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
  sources: { weather: SourceStatus; homework: SourceStatus; calendar: SourceStatus };
};

/** 給前端的行程：結束時間用來把已經過去的畫淡。 */
export type ClientEvent = { time: string; title: string; end: number };

export function createGlance(cfg: Config) {
  const weather = new CachedSource<Forecast>(15 * MINUTE, async () => {
    const forecast = await fetchForecast(cfg.weather);
    console.log(`[glance] ${weatherLogLine(buildWeatherView(forecast.hours, forecast.fetchedAt), forecast.fetchedAt)}`);
    return forecast;
  });
  const homework = cfg.homework
    ? // 平常 5 分鐘；在 Due Now 勾完成後可以點看板上的數字強制重抓（refreshHomework）
      new CachedSource<Homework>(5 * MINUTE, () => fetchHomework(cfg.homework!))
    : null;
  const calendar = cfg.calendar
    ? new CachedSource<CalendarView>(5 * MINUTE, () => fetchCalendar(cfg.calendar!))
    : null;

  return async function glance(
    now = Date.now(),
    opts: { refreshHomework?: boolean } = {},
  ): Promise<GlancePayload> {
    const [w, h, c] = await Promise.all([
      weather.get(now),
      homework?.get(now, opts.refreshHomework) ?? null,
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
