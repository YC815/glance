import assert from "node:assert/strict";
import { test } from "node:test";
import { authorized } from "../src/auth.ts";
import { CachedSource } from "../src/cache.ts";
import { parseRefresh } from "../src/glance.ts";
import { countHomework } from "../src/homework.ts";
import { openMeteoUrl, parseForecast } from "../src/weather.ts";

const tp = (s: string) => Date.parse(`${s}+08:00`);
const cfg = { lat: 25.12, lon: 121.51, model: "ecmwf_ifs025" };

test("Open-Meteo 網址帶 ECMWF、逐小時欄位、unixtime、m/s", () => {
  const url = new URL(openMeteoUrl(cfg));
  assert.equal(url.searchParams.get("models"), "ecmwf_ifs025");
  assert.equal(url.searchParams.get("timeformat"), "unixtime");
  assert.equal(url.searchParams.get("wind_speed_unit"), "ms");
  assert.match(url.searchParams.get("hourly")!, /precipitation.*shortwave_radiation_instant/);
});

test("解析 Open-Meteo：中午有太陽時 UTCI 比氣溫高，晚上接近氣溫；缺值給 null", () => {
  const noon = tp("2026-07-15T12:00:00") / 1000;
  const night = tp("2026-07-15T23:00:00") / 1000;
  const hours = parseForecast(
    {
      hourly: {
        time: [noon, night, night + 3600],
        precipitation: [0, 1.2, null],
        temperature_2m: [33, 28, null],
        relative_humidity_2m: [60, 80, 80],
        wind_speed_10m: [2, 1, 1],
        shortwave_radiation_instant: [900, 0, 0],
        direct_normal_irradiance_instant: [750, 0, 0],
        diffuse_radiation_instant: [180, 0, 0],
      },
    },
    cfg,
  );
  assert.equal(hours[0].t, noon * 1000);
  assert.ok(hours[0].utci! > 38, String(hours[0].utci));
  assert.ok(Math.abs(hours[1].utci! - 30.5) < 2, String(hours[1].utci));
  assert.equal(hours[1].precip, 1.2);
  assert.equal(hours[2].precip, null);
  assert.equal(hours[2].utci, null);
});

test("作業：只數沒過截止的；今天＝到明天 00:00，三天內＝今明後三個日曆天含今天", () => {
  const now = tp("2026-10-08T21:00:00");
  const a = (deadline: string, extra = {}) => ({ deadline: new Date(tp(deadline)).toISOString(), done: false, submitted: false, ...extra });
  const json = {
    assignments: [
      a("2026-10-08T20:00:00"), // 已經過了，不算
      a("2026-10-08T23:59:00"), // 今天
      a("2026-10-09T00:00:00"), // 明天 00:00 剛好是今天的結尾，算今天
      a("2026-10-09T08:00:00"), // 明天
      a("2026-10-10T23:59:00"), // 後天
      a("2026-10-11T00:00:00"), // 大後天 00:00，算三天內的最後一刻
      a("2026-10-11T00:01:00"), // 超過
      a("9999-12-31T00:00:00"), // Due Now 的「沒有截止日」
      a("2026-10-08T22:00:00", { done: true }), // 保險：勾了完成的不算
    ],
  };
  assert.deepEqual(countHomework(json, now), { today: 2, within3Days: 5 });
  // 部署機器在 UTC：台北凌晨 1 點，「今天」還是台北的今天
  const lateNight = tp("2026-10-09T01:00:00");
  assert.deepEqual(countHomework({ assignments: [a("2026-10-09T23:00:00"), a("2026-10-10T07:00:00")] }, lateNight), { today: 1, within3Days: 2 });
  assert.deepEqual(countHomework({ assignments: [] }, now), { today: 0, within3Days: 0 });
  assert.throws(() => countHomework({ error: { code: "unauthorized" } }, now));
  assert.throws(() => countHomework(null, now));
});

test("金鑰檢查", () => {
  assert.equal(authorized(undefined, null), true);
  assert.equal(authorized("Bearer abc", "abc"), true);
  assert.equal(authorized("bearer abc", "abc"), true);
  assert.equal(authorized("Bearer abd", "abc"), false);
  assert.equal(authorized("abc", "abc"), false);
  assert.equal(authorized(undefined, "abc"), false);
});

test("快取：過期才重抓、失敗沿用上一筆並記錯誤、失敗後一分鐘內不重試", async () => {
  let calls = 0;
  let fail = false;
  const src = new CachedSource(5 * 60_000, async () => {
    calls++;
    if (fail) throw new Error("掛了");
    return calls;
  });
  const t0 = 1_000_000;
  assert.deepEqual(await src.get(t0), { value: 1, updatedAt: t0, error: null });
  await src.get(t0 + 60_000);
  assert.equal(calls, 1);

  fail = true;
  const s = await src.get(t0 + 6 * 60_000);
  assert.deepEqual(s, { value: 1, updatedAt: t0, error: "掛了" });
  await src.get(t0 + 6.5 * 60_000);
  assert.equal(calls, 2);

  fail = false;
  assert.equal((await src.get(t0 + 8 * 60_000)).value, 3);
});

test("快取：同時多個請求只抓一次", async () => {
  let calls = 0;
  const src = new CachedSource(60_000, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return "ok";
  });
  await Promise.all([src.get(0), src.get(0), src.get(0)]);
  assert.equal(calls, 1);
});

test("快取：強制重抓會跳過 TTL，但 2 秒內連點只抓一次", async () => {
  let calls = 0;
  const src = new CachedSource(5 * 60_000, async () => ++calls);
  const t0 = 1_000_000;
  await src.get(t0);
  await src.get(t0 + 10_000, true);
  assert.equal(calls, 2);
  await src.get(t0 + 11_000, true);
  assert.equal(calls, 2);
  await src.get(t0 + 12_000, true);
  assert.equal(calls, 3);
  await src.get(t0 + 20_000);
  assert.equal(calls, 3);
});

test("手動重抓的參數：只認 homework、weather，可用逗號一起", () => {
  assert.deepEqual(parseRefresh(null), []);
  assert.deepEqual(parseRefresh("weather"), ["weather"]);
  assert.deepEqual(parseRefresh("homework,weather"), ["homework", "weather"]);
  assert.deepEqual(parseRefresh("calendar,../x,weather"), ["weather"]);
});
