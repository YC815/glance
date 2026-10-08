// 台北時間的小工具。台灣自 1979 年後沒有日光節約時間，固定 UTC+8，
// 所以直接位移，不必依賴主機時區（部署機器多半是 TZ=UTC）。

export const TZ_OFFSET_MS = 8 * 3_600_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/** 把時間轉成「台北牆上時鐘」的欄位。 */
export function taipeiParts(ms: number) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** 台北當天 00:00 的 epoch ms。 */
export function startOfTaipeiDay(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

/** 整點（往下取）。台北與 UTC 差整數小時，所以直接對 UTC 取整即可。 */
export function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function weekdayName(ms: number): string {
  return WEEKDAYS[taipeiParts(ms).weekday];
}

/** 「10/11」 */
export function monthDay(ms: number): string {
  const p = taipeiParts(ms);
  return `${p.month}/${p.day}`;
}

/** 「09:05」 */
export function hhmm(ms: number): string {
  const p = taipeiParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
