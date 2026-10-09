import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_MS } from "../src/time.ts";
import {
  DURATIONS,
  METRICS_VERSION,
  bestEfforts,
  buildTrainingView,
  decoupling,
  formLevel,
  ftpAt,
  normalizedPower,
  perSecond,
  rideMetrics,
  tss,
  type Ride,
  type RideMetrics,
} from "../src/training.ts";

const tp = (s: string) => Date.parse(`${s}+08:00`);
const fill = (n: number, v: number) => Array(n).fill(v) as number[];

test("攤成每秒：短間隔沿用前值，長間隔當成停下來（補 0 或接起來）", () => {
  const time = [0, 1, 3, 30, 31];
  const w = [100, 200, 300, 400, 500];
  assert.deepEqual(perSecond(time, w, "drop"), [100, 200, 200, 300, 400, 500]);
  assert.deepEqual(perSecond(time, w, "zero"), [100, 200, 200, 300, ...fill(26, 0), 400, 500]);
  assert.deepEqual(perSecond([0, 1], [null, 150], "drop"), [0, 150]);
});

test("NP：穩定功率就等於那個功率；忽高忽低會比平均高", () => {
  assert.equal(Math.round(normalizedPower(fill(600, 200))!), 200);
  const surges = Array.from({ length: 1200 }, (_, i) => (Math.floor(i / 60) % 2 ? 300 : 100));
  assert.ok(normalizedPower(surges)! > 220, String(normalizedPower(surges)));
  assert.equal(normalizedPower(fill(100, 0)), null);
  assert.equal(normalizedPower([]), null);
});

test("最大平均功率：騎不到那麼久給 null", () => {
  const w = [...fill(60, 100), ...fill(5, 500), ...fill(60, 100)];
  const best = bestEfforts(w, [5, 60, 120, 300]);
  assert.deepEqual(best, [500, Math.round((55 * 100 + 5 * 500) / 60), Math.round((115 * 100 + 5 * 500) / 120), null]);
});

test("心率漂移：同樣功率，後半段心率高 5% → 約 4.8%", () => {
  const w = fill(3600, 180);
  const hr = [...fill(1800, 140), ...fill(1800, 147)];
  assert.equal(decoupling(w, hr), 4.8);
  assert.equal(decoupling(fill(3599, 180), fill(3599, 140)), null, "不到一小時不算");
  assert.equal(decoupling(w, [...fill(1800, 140), ...fill(1800, 0)]), null, "心率掉線太多不算");
});

test("一趟的數字：從 Strava 串流算", () => {
  const time = Array.from({ length: 3600 }, (_, i) => i);
  const m = rideMetrics({ time, watts: fill(3600, 200), heartrate: fill(3600, 150) })!;
  assert.equal(m.v, METRICS_VERSION);
  assert.equal(m.seconds, 3600);
  assert.equal(m.np, 200);
  assert.equal(m.drift, 0);
  assert.equal(m.best[DURATIONS.indexOf(3600)], 200);
  assert.equal(m.best[DURATIONS.indexOf(5400)], null);
  assert.equal(rideMetrics({ time, watts: null, heartrate: null }), null);
  assert.equal(rideMetrics({ time, watts: fill(3600, 0), heartrate: null }), null);
});

test("TSS：剛好 FTP 騎一小時＝100", () => {
  const m: RideMetrics = { v: 1, seconds: 3600, np: 250, best: [], drift: null };
  assert.equal(tss(m, 250), 100);
  assert.equal(Math.round(tss({ ...m, seconds: 1800 }, 250)), 50);
});

test("FTP：用當時生效的；比第一筆還早就用第一筆", () => {
  const h = [
    { from: tp("2026-09-01T00:00:00"), watts: 200 },
    { from: tp("2026-10-01T00:00:00"), watts: 230 },
  ];
  assert.equal(ftpAt([], 0), null);
  assert.equal(ftpAt(h, tp("2026-08-01T10:00:00")), 200);
  assert.equal(ftpAt(h, tp("2026-09-30T23:00:00")), 200);
  assert.equal(ftpAt(h, tp("2026-10-01T07:00:00")), 230);
});

test("狀態分級的邊界", () => {
  assert.deepEqual([5, 4.9, -10, -10.1, -30, -30.1].map((t) => formLevel(t).label), [
    "精神好",
    "正常",
    "正常",
    "在累積",
    "在累積",
    "太累了",
  ]);
});

function ride(start: number, metrics: RideMetrics | null | undefined, hasPower = true): Ride {
  return { id: String(start), start, name: "", movingSec: 3600, hasPower, metrics };
}

test("PMC：每天 100 TSS 騎 42 天，CTL 約 64；TSB 用昨天結束時的值", () => {
  const now = tp("2026-10-09T08:00:00");
  const today = tp("2026-10-09T00:00:00");
  const m: RideMetrics = { v: 1, seconds: 3600, np: 250, best: DURATIONS.map(() => null), drift: null };
  // 昨天以前的 42 天，每天早上 7 點騎一小時 FTP
  const rides = Array.from({ length: 42 }, (_, i) => ride(today - (i + 1) * DAY_MS + 7 * 3_600_000, m));
  const v = buildTrainingView(rides, [{ from: 0, watts: 250 }], now);
  const ctl = 100 * (1 - (41 / 42) ** 42);
  const atl = 100 * (1 - (6 / 7) ** 42);
  assert.equal(v.ctl, Math.round(ctl * 10) / 10);
  assert.equal(v.atl, Math.round(atl * 10) / 10);
  assert.equal(v.tsb, Math.round((ctl - atl) * 10) / 10);
  assert.equal(v.form?.label, "太累了", "連騎 42 天每天 100，ATL 遠高於 CTL");
  assert.equal(v.pmc.length, 90);
  // 今天還沒騎：今天結束時的值會往下掉
  assert.ok(v.pmc[89].ctl < v.ctl!);
  assert.equal(v.pmc[89].tsb, v.tsb, "圖上最後一天的 TSB＝上面的大數字");
  assert.equal(v.pmcStart, "7/12");
});

test("沒填 FTP：PMC 全空，功率曲線和心率漂移照樣有", () => {
  const now = tp("2026-10-09T08:00:00");
  const best = DURATIONS.map((d) => (d <= 3600 ? 400 - Math.floor(d / 60) : null));
  const m: RideMetrics = { v: 1, seconds: 3700, np: 210, best, drift: 3.2 };
  const old: RideMetrics = { ...m, best: best.map((w) => (w === null ? null : w + 20)), drift: 7 };
  const v = buildTrainingView(
    [
      ride(tp("2026-10-08T07:00:00"), m),
      ride(tp("2026-06-01T07:00:00"), old),
      ride(tp("2026-10-07T07:00:00"), undefined),
      ride(tp("2026-10-06T07:00:00"), undefined, false),
    ],
    [],
    now,
  );
  assert.equal(v.ftp, null);
  assert.equal(v.ctl, null);
  assert.equal(v.form, null);
  assert.deepEqual(v.pmc, []);
  assert.equal(v.curve.recent[0], 400);
  assert.equal(v.curve.year[0], 420, "一年內最好的是六月那趟");
  assert.equal(v.curve.recent[DURATIONS.indexOf(5400)], null);
  assert.deepEqual(v.drift, [
    { date: "10/8", pct: 3.2 },
    { date: "6/1", pct: 7 },
  ]);
  assert.equal(v.pending, 1, "沒功率計的那趟不用等");
});
