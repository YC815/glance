import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_MS, HOUR_MS } from "../src/time.ts";
import { buildWeatherView, hourPhrase, rainLevel, rainText, type Bar } from "../src/view.ts";
import type { HourPoint } from "../src/weather.ts";

/** 台北時間字串 → epoch ms */
const tp = (s: string) => Date.parse(`${s}+08:00`);

/** 從 now 的整點起，第 i 格的雨量是 rain[i]。 */
function bars(now: number, rain: number[]): Bar[] {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS;
  return rain.map((mm, i) => ({ t: start + i * HOUR_MS, mm, level: rainLevel(mm), label: "" }));
}

const pad = (xs: number[]) => [...xs, ...Array(24 - xs.length).fill(0)];

test("雨量分級的邊界", () => {
  assert.deepEqual([0.49, 0.5, 2.49, 2.5, 7.5, 14.9, 15, null].map(rainLevel), [0, 1, 1, 2, 3, 3, 4, 0]);
});

test("時段說法", () => {
  const now = tp("2026-10-08T21:00:00");
  assert.equal(hourPhrase(tp("2026-10-09T03:00:00"), now), "凌晨 3 點");
  assert.equal(hourPhrase(tp("2026-10-09T08:00:00"), now), "早上 8 點");
  assert.equal(hourPhrase(tp("2026-10-09T00:00:00"), now), "半夜 12 點");
  assert.equal(hourPhrase(tp("2026-10-08T22:00:00"), now), "晚上 10 點");
  const afternoon = tp("2026-10-08T14:20:00");
  assert.equal(hourPhrase(tp("2026-10-08T15:00:00"), afternoon), "下午 3 點");
  assert.equal(hourPhrase(tp("2026-10-08T12:00:00"), afternoon), "中午 12 點");
  // 白天講隔天早上要加「明天」，凌晨不用
  assert.equal(hourPhrase(tp("2026-10-09T09:00:00"), afternoon), "明天早上 9 點");
  assert.equal(hourPhrase(tp("2026-10-09T04:00:00"), afternoon), "凌晨 4 點");
});

test("沒在下：設計稿的例子「凌晨 3 點開始下，早上 8 點最大」", () => {
  const now = tp("2026-10-08T21:10:00");
  // 21 22 23 00 01 02 03 04 05 06 07 08 09
  const r = bars(now, pad([0, 0, 0, 0, 0, 0, 0.8, 2.1, 4.6, 9.2, 12, 13.5, 6.8, 0.2]));
  assert.deepEqual(rainText(r, now), {
    headline: "現在沒下雨",
    summary: "凌晨 3 點開始下，早上 8 點最大",
  });
});

test("開始那小時就是最大時只講開始", () => {
  const now = tp("2026-10-08T13:00:00");
  const r = bars(now, pad([0, 0, 5, 1]));
  assert.equal(rainText(r, now).summary, "下午 3 點開始下");
});

test("一整天都不下", () => {
  const now = tp("2026-10-08T13:00:00");
  assert.equal(rainText(bars(now, pad([0.3])), now).summary, "接下來 24 小時不會下雨");
});

test("正在下：雨會下到 X 點", () => {
  const now = tp("2026-10-08T16:40:00");
  // 16 17 18 → 19 點那格沒雨
  const r = bars(now, pad([3, 1.2, 0.6, 0.1]));
  assert.deepEqual(rainText(r, now), { headline: "現在在下雨", summary: "雨會下到晚上 7 點" });
  const allDay = bars(now, Array(24).fill(1));
  assert.deepEqual(rainText(allDay, now), {
    headline: "現在下小雨",
    summary: "未來 24 小時都會下",
  });
});

test("同一句話已經講過明天，第二段不再重複", () => {
  const now = tp("2026-10-08T10:00:00");
  const rain = Array(24).fill(0);
  rain[22] = 1; // 明天 08:00
  rain[23] = 4; // 明天 09:00
  assert.equal(rainText(bars(now, rain), now).summary, "明天早上 8 點開始下，早上 9 點最大");
});

/** 從今天 00:00 起 9 天的假預報；precipAt(t) 給整點 t 的「前一小時雨量」。 */
function forecast(start: number, precipAt: (t: number) => number, utciAt: (t: number) => number) {
  const hours: HourPoint[] = [];
  for (let t = start; t < start + 9 * DAY_MS; t += HOUR_MS) {
    hours.push({ t, precip: precipAt(t), utci: utciAt(t) });
  }
  return hours;
}

test("24 小時長條：第一格是現在這小時，標籤每 6 小時一個", () => {
  const today = tp("2026-10-08T00:00:00");
  const now = tp("2026-10-08T21:35:00");
  // 只有 22:00 整點有雨（= 21 點那格）
  const hours = forecast(
    today,
    (t) => (t === tp("2026-10-08T22:00:00") ? 3 : 0),
    () => 25,
  );
  const v = buildWeatherView(hours, now);
  assert.equal(v.rain24.length, 24);
  assert.equal(v.rain24[0].t, tp("2026-10-08T21:00:00"));
  assert.equal(v.rain24[0].level, 2);
  assert.equal(v.rain24[1].level, 0);
  assert.deepEqual(
    v.rain24.map((b) => b.label).filter(Boolean),
    ["21", "03", "09", "15"],
  );
  assert.equal(v.headline, "現在在下雨");
});

test("現在的 UTCI 在兩個整點之間內插", () => {
  const today = tp("2026-10-08T00:00:00");
  const hours = forecast(today, () => 0, (t) => (t - today) / HOUR_MS); // 第 h 小時 = h 度
  const v = buildWeatherView(hours, tp("2026-10-08T14:30:00"));
  assert.deepEqual(v.utci, { value: 15, level: 0, label: "無熱壓力" }); // 14.5 四捨五入
});

test("一週：明天起 7 天、每天 05–20 共 16 格、第 4 天起變淡、UTCI 取 05–20 的最高", () => {
  const today = tp("2026-10-08T00:00:00"); // 週四
  const now = tp("2026-10-08T21:00:00");
  const hours = forecast(
    today,
    // 明天 05 點那格（06:00 整點）有大雨
    (t) => (t === tp("2026-10-09T06:00:00") ? 20 : 0),
    // UTCI 在每天 21:00 最高（不該被算進去），14:00 次高
    (t) => {
      const h = new Date(t + 8 * HOUR_MS).getUTCHours();
      return h === 21 ? 45 : h === 14 ? 33 : 20;
    },
  );
  const { week } = buildWeatherView(hours, now);
  assert.equal(week.length, 7);
  assert.deepEqual(
    week.map((d) => `${d.name} ${d.date}`),
    ["週五 10/9", "週六 10/10", "週日 10/11", "週一 10/12", "週二 10/13", "週三 10/14", "週四 10/15"],
  );
  assert.deepEqual(week.map((d) => d.dim), [false, false, false, true, true, true, true]);
  assert.equal(week[0].cells.length, 16);
  assert.equal(week[0].cells[0], 4);
  assert.equal(week[0].cells[1], 0);
  assert.deepEqual(week[0].utci, { value: 33, level: 2, label: "強熱壓力" });
});

test("預報缺資料時不爆，也不會說成「不會下雨」", () => {
  const v = buildWeatherView([], tp("2026-10-08T21:00:00"));
  assert.equal(v.utci, null);
  assert.equal(v.headline, "沒有雨量資料");
  assert.equal(v.week[0].utci, null);
});
