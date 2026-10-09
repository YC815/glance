// 把逐小時預報整理成兩頁要顯示的東西。全部是純函式，`now` 由呼叫端傳入。
//
// 「一格一小時」：標成 H 點的那格代表 H:00–H+1:00，
// 對應 Open-Meteo 在 H+1 整點的雨量（它的雨量是「前一小時」的累積）。

import { heatStress } from "./utci.ts";
import {
  DAY_MS,
  HOUR_MS,
  floorHour,
  monthDay,
  pad2,
  startOfTaipeiDay,
  taipeiParts,
  weekdayName,
} from "./time.ts";
import type { HourPoint } from "./weather.ts";

/** 少於這個量（mm/小時）當作沒下。 */
export const RAIN_THRESHOLD = 0.5;

export type RainLevel = 0 | 1 | 2 | 3 | 4;

export function rainLevel(mm: number | null): RainLevel {
  if (mm === null || mm < RAIN_THRESHOLD) return 0;
  if (mm < 2.5) return 1;
  if (mm < 7.5) return 2;
  if (mm < 15) return 3;
  return 4;
}

const isRain = (mm: number | null) => rainLevel(mm) > 0;

export type Bar = { t: number; mm: number | null; level: RainLevel; label: string };

export type Utci = { value: number; level: 0 | 1 | 2 | 3; label: string };

export type WeekRow = {
  name: string;
  date: string;
  cells: RainLevel[];
  /** 05–20 點裡雨最大的一小時 [mm]；整天都沒資料是 null */
  rainMax: number | null;
  utci: Utci | null;
  dim: boolean;
};

export type WeatherView = {
  headline: string;
  summary: string;
  utci: Utci | null;
  rain24: Bar[];
  week: WeekRow[];
};

export function buildWeatherView(hours: HourPoint[], now: number): WeatherView {
  const byT = new Map(hours.map((h) => [h.t, h]));
  const rain24 = buildRain24(byT, now);
  const { headline, summary } = rainText(rain24, now);
  return {
    headline,
    summary,
    utci: currentUtci(byT, now),
    rain24,
    week: buildWeek(byT, now),
  };
}

/** H 點那一格的雨量（= H+1 整點的值）。 */
function rainOfHour(byT: Map<number, HourPoint>, hourStart: number): number | null {
  return byT.get(hourStart + HOUR_MS)?.precip ?? null;
}

export function buildRain24(byT: Map<number, HourPoint>, now: number): Bar[] {
  const start = floorHour(now);
  return Array.from({ length: 24 }, (_, i) => {
    const t = start + i * HOUR_MS;
    const mm = rainOfHour(byT, t);
    return {
      t,
      mm,
      level: rainLevel(mm),
      label: i % 6 === 0 ? pad2(taipeiParts(t).hour) : "",
    };
  });
}

function toUtci(value: number): Utci {
  const rounded = Math.round(value);
  return { value: rounded, ...heatStress(rounded) };
}

/** 現在的 UTCI：前後兩個整點線性內插。 */
export function currentUtci(byT: Map<number, HourPoint>, now: number): Utci | null {
  const t0 = floorHour(now);
  const a = byT.get(t0)?.utci ?? null;
  const b = byT.get(t0 + HOUR_MS)?.utci ?? null;
  if (a === null && b === null) return null;
  if (a === null || b === null) return toUtci((a ?? b) as number);
  return toUtci(a + ((b - a) * (now - t0)) / HOUR_MS);
}

export const WEEK_FIRST_HOUR = 5;
export const WEEK_LAST_HOUR = 20;

export function buildWeek(byT: Map<number, HourPoint>, now: number): WeekRow[] {
  const today = startOfTaipeiDay(now);
  return Array.from({ length: 7 }, (_, i) => {
    const day = today + (i + 1) * DAY_MS;
    const cells: RainLevel[] = [];
    let max: number | null = null;
    let rainMax: number | null = null;
    for (let h = WEEK_FIRST_HOUR; h <= WEEK_LAST_HOUR; h++) {
      const t = day + h * HOUR_MS;
      const mm = rainOfHour(byT, t);
      cells.push(rainLevel(mm));
      if (mm !== null && (rainMax === null || mm > rainMax)) rainMax = mm;
      const u = byT.get(t)?.utci ?? null;
      if (u !== null && (max === null || u > max)) max = u;
    }
    return {
      name: weekdayName(day),
      date: monthDay(day),
      cells,
      rainMax,
      utci: max === null ? null : toUtci(max),
      // 第 4 天以後（明天算第 1 天）預報不準，畫淡一點
      dim: i >= 3,
    };
  });
}

const HEADLINES: Record<RainLevel, string> = {
  0: "現在沒下雨",
  1: "現在下小雨",
  2: "現在在下雨",
  3: "現在下大雨",
  4: "現在雨很大",
};

/** 大字標題與一句摘要。 */
export function rainText(bars: Bar[], now: number): { headline: string; summary: string } {
  // 雨量欄位整段都沒值時不能說「不會下雨」：分不出是真的不下，還是資料沒進來
  if (bars.every((b) => b.mm === null)) {
    return { headline: "沒有雨量資料", summary: "預報沒有給雨量，晚點再看" };
  }
  const headline = HEADLINES[bars[0]?.level ?? 0];

  if (isRain(bars[0]?.mm ?? null)) {
    const stop = bars.findIndex((b) => !isRain(b.mm));
    if (stop === -1) return { headline, summary: "未來 24 小時都會下" };
    return { headline, summary: `雨會下到${hourPhrase(bars[stop].t, now)}` };
  }

  const start = bars.findIndex((b) => isRain(b.mm));
  if (start === -1) return { headline, summary: "接下來 24 小時不會下雨" };

  let end = start;
  while (end + 1 < bars.length && isRain(bars[end + 1].mm)) end++;
  let peak = start;
  for (let i = start; i <= end; i++) if ((bars[i].mm ?? 0) > (bars[peak].mm ?? 0)) peak = i;

  const startText = `${hourPhrase(bars[start].t, now)}開始下`;
  if (peak === start) return { headline, summary: startText };
  return {
    headline,
    summary: `${startText}，${hourPhrase(bars[peak].t, now, bars[start].t)}最大`,
  };
}

/**
 * 「凌晨 3 點」「下午 2 點」，必要時加「明天」。
 *
 * 只有在白天看到「明天早上 8 點」這種會跟今天搞混的時候才加：
 * 晚上 6 點以後講的早上都是明天、凌晨本來就是隔天，不必加。
 * 同一句話裡前面已經講過同一天，就不重複。
 */
export function hourPhrase(t: number, now: number, sameSentenceAs?: number): string {
  const { hour } = taipeiParts(t);
  const isNextDay = startOfTaipeiDay(t) > startOfTaipeiDay(now);
  const alreadySaid =
    sameSentenceAs !== undefined && startOfTaipeiDay(sameSentenceAs) === startOfTaipeiDay(t);
  const prefix =
    isNextDay && !alreadySaid && taipeiParts(now).hour < 18 && hour >= 6 ? "明天" : "";
  return `${prefix}${period(hour)} ${clock(hour)} 點`;
}

function period(hour: number): string {
  if (hour === 0) return "半夜";
  if (hour < 6) return "凌晨";
  if (hour < 12) return "早上";
  if (hour === 12) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

function clock(hour: number): number {
  if (hour === 0) return 12;
  return hour > 12 ? hour - 12 : hour;
}
