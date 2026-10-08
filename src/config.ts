// 環境變數。作業與行事曆沒設定就不顯示那一塊，天氣一定有。

import { parseServiceAccount, type CalendarConfig } from "./calendar.ts";
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
  const homework =
    env.DUE_NOW_GLANCE_KEY
      ? { baseUrl: env.DUE_NOW_URL || "https://now.tschool.cc", key: env.DUE_NOW_GLANCE_KEY }
      : null;

  let calendar: CalendarConfig | null = null;
  const calendarIds = (env.GOOGLE_CALENDAR_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON && calendarIds.length > 0) {
    calendar = { ...parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON), calendarIds };
  }

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
