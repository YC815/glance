// 天氣每次重抓都在日誌印一行，事後看得出預報有沒有正常進來、當時預報說什麼。

import { hhmm } from "./time.ts";
import type { WeatherView } from "./view.ts";

const mm = (v: number) => v.toFixed(1);

/**
 * 例：
 * 天氣更新 23:05｜現在沒下雨｜接下來 24 小時不會下雨｜UTCI 20｜24h 雨量有值 24/24，合計 0.0 mm，最大 0.0 mm｜
 * 一週（05–20 點最大雨量／UTCI 最高）週五 0.0/27 週六 1.2/29 …
 */
export function weatherLogLine(v: WeatherView, now: number): string {
  const values = v.rain24.map((b) => b.mm).filter((x): x is number => x !== null);
  const sum = values.reduce((a, b) => a + b, 0);
  const max = values.length ? Math.max(...values) : 0;
  const week = v.week
    .map((d) => `${d.name} ${d.rainMax === null ? "-" : mm(d.rainMax)}/${d.utci?.value ?? "-"}`)
    .join(" ");
  return [
    `天氣更新 ${hhmm(now)}`,
    v.headline,
    v.summary,
    `UTCI ${v.utci?.value ?? "-"}`,
    `24h 雨量有值 ${values.length}/${v.rain24.length}，合計 ${mm(sum)} mm，最大 ${mm(max)} mm`,
    `一週（05–20 點最大雨量 mm／UTCI 最高）${week}`,
  ].join("｜");
}
