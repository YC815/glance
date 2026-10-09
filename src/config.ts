// 環境變數。作業與行事曆沒設定就不顯示那一塊，天氣一定有。

import type { CalendarConfig } from "./calendar.ts";
import type { HomeworkConfig } from "./homework.ts";
import type { WeatherConfig } from "./weather.ts";

export type Config = {
  port: number;
  /** 看板的存取金鑰；沒設就不檢查（只建議本機開發這樣用） */
  token: string | null;
  weather: WeatherConfig;
  homework: HomeworkConfig | null;
  calendar: CalendarConfig | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const homework = env.DUE_NOW_TOKEN
    ? { baseUrl: env.DUE_NOW_URL || "https://now.tschool.cc", token: env.DUE_NOW_TOKEN }
    : null;

  // 逗號分隔，可以放好幾個行事曆的私人 iCal 網址
  const icsUrls = (env.CALENDAR_ICS_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const calendar: CalendarConfig | null = icsUrls.length > 0 ? { icsUrls } : null;

  return {
    port: Number(env.PORT) || 3000,
    token: env.GLANCE_TOKEN || null,
    weather: {
      // 唭哩岸捷運站附近
      lat: Number(env.WEATHER_LAT) || 25.12,
      lon: Number(env.WEATHER_LON) || 121.51,
      model: env.OPEN_METEO_MODEL || "ecmwf_ifs025",
    },
    homework,
    calendar,
  };
}
