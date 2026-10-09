// 騎車頁的計算：從一趟騎乘的逐秒功率／心率算出 NP、最大平均功率、心率漂移，
// 再把每天的 TSS 疊成 PMC（CTL／ATL／TSB）。全部是純函式，資料從哪來由 strava.ts 管。
//
// 為什麼每趟只存 NP 和秒數、不存 TSS：TSS 要用「那時候的 FTP」算，FTP 是手填的、會改。
// 存原料，改 FTP 時不必重抓串流。

import { DAY_MS, monthDay, startOfTaipeiDay, taipeiParts } from "./time.ts";

/** 功率曲線取這些秒數的最大平均功率。改了要升 METRICS_VERSION，舊的會重抓串流重算。 */
export const DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];
export const METRICS_VERSION = 1;

/** 兩個取樣點相隔超過這麼多秒，就當成中間停下來了（自動暫停、紅燈關機、休息站）。 */
const MAX_GAP_S = 10;
/** 心率漂移只算這麼長以上的騎乘，太短的前後半段差異沒意義。 */
export const DRIFT_MIN_S = 3600;

const CTL_DAYS = 42;
const ATL_DAYS = 7;
/** 畫 PMC 的天數 */
export const PMC_DAYS = 90;
/** 功率曲線的「最近」：跟 CTL 同樣 6 週 */
const RECENT_DAYS = 42;
const YEAR_DAYS = 365;

export type RideMetrics = {
  v: number;
  /** 實際在動的秒數（停下來的段落拿掉），算 TSS 用 */
  seconds: number;
  /** Normalized Power；功率全是 0 時為 null */
  np: number | null;
  /** DURATIONS 每個秒數的最大平均功率；騎不到那麼久為 null */
  best: (number | null)[];
  /** 心率漂移（%）：後半段每下心跳出的功比前半段少多少。沒心率或不夠長為 null */
  drift: number | null;
};

export type Ride = {
  id: string;
  /** 開始時間 epoch ms */
  start: number;
  name: string;
  movingSec: number;
  /** 有功率計（Strava 的 device_watts）；沒有的不抓串流、不算 TSS */
  hasPower: boolean;
  /** 串流算出來的；undefined＝還沒抓，null＝抓了但沒有可用的功率 */
  metrics?: RideMetrics | null;
};

export type FtpEntry = { from: number; watts: number };

// ---------- 一趟騎乘 ----------

/**
 * 把 Strava 不等間隔的串流攤成每秒一格。間隔 ≤ MAX_GAP_S 秒的沿用前一個值（智慧記錄），
 * 更長的當成停下來：`zero` 補 0（功率曲線用，不能跨過休息算平均），`drop` 直接接起來（NP、漂移用）。
 */
export function perSecond(time: number[], values: (number | null)[], gap: "zero" | "drop"): number[] {
  const out: number[] = [];
  for (let i = 0; i < time.length; i++) {
    const v = values[i] ?? 0;
    const dt = i + 1 < time.length ? time[i + 1] - time[i] : 1;
    if (dt <= 0) continue;
    if (dt <= MAX_GAP_S) {
      for (let k = 0; k < dt; k++) out.push(v);
    } else {
      out.push(v);
      if (gap === "zero") for (let k = 1; k < dt; k++) out.push(0);
    }
  }
  return out;
}

/** Normalized Power：30 秒移動平均的四次方平均再開四次方根。 */
export function normalizedPower(watts: number[]): number | null {
  if (watts.length === 0) return null;
  const win = Math.min(30, watts.length);
  let sum = 0;
  for (let i = 0; i < win; i++) sum += watts[i];
  let acc = 0;
  let n = 0;
  for (let i = win - 1; i < watts.length; i++) {
    if (i >= win) sum += watts[i] - watts[i - win];
    acc += (sum / win) ** 4;
    n++;
  }
  const np = (acc / n) ** 0.25;
  return np > 0 ? np : null;
}

/** 每個秒數的最大平均功率（前綴和滑動視窗）。 */
export function bestEfforts(watts: number[], durations = DURATIONS): (number | null)[] {
  const prefix = new Float64Array(watts.length + 1);
  for (let i = 0; i < watts.length; i++) prefix[i + 1] = prefix[i] + watts[i];
  return durations.map((d) => {
    if (d > watts.length) return null;
    let best = 0;
    for (let i = d; i <= watts.length; i++) best = Math.max(best, prefix[i] - prefix[i - d]);
    return Math.round(best / d);
  });
}

/**
 * 心率漂移（Pw:HR decoupling）：前後半段各算「平均功率 ÷ 平均心率」，
 * 後半段比前半段掉多少百分比。正值＝後段同樣的功要更多心跳。
 */
export function decoupling(watts: number[], hr: number[]): number | null {
  if (watts.length < DRIFT_MIN_S || hr.length !== watts.length) return null;
  const withHr = hr.filter((h) => h > 0).length;
  if (withHr < watts.length * 0.9) return null; // 心率帶掉線太多就不算
  const half = Math.floor(watts.length / 2);
  const ef = (from: number, to: number) => {
    let p = 0;
    let h = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      p += watts[i];
      if (hr[i] > 0) {
        h += hr[i];
        n++;
      }
    }
    return n && h ? p / (to - from) / (h / n) : 0;
  };
  const first = ef(0, half);
  const second = ef(half, watts.length);
  if (!first) return null;
  return round1(((first - second) / first) * 100);
}

export type Streams = { time: number[]; watts: (number | null)[] | null; heartrate: (number | null)[] | null };

export function rideMetrics(s: Streams): RideMetrics | null {
  if (!s.watts || s.time.length !== s.watts.length) return null;
  const moving = perSecond(s.time, s.watts, "drop");
  const np = normalizedPower(moving);
  if (np === null) return null;
  const hr = s.heartrate && s.heartrate.length === s.time.length ? perSecond(s.time, s.heartrate, "drop") : null;
  return {
    v: METRICS_VERSION,
    seconds: moving.length,
    np: Math.round(np),
    best: bestEfforts(perSecond(s.time, s.watts, "zero")),
    drift: hr ? decoupling(moving, hr) : null,
  };
}

/** TSS = 秒數 × NP × IF ÷ (FTP × 3600) × 100，IF = NP ÷ FTP */
export function tss(m: RideMetrics, ftp: number): number {
  if (m.np === null || ftp <= 0) return 0;
  return (m.seconds * m.np * m.np) / (ftp * ftp * 36);
}

/** 那一天適用的 FTP：最近一筆在那天之前（含）生效的；比第一筆還早就用第一筆。 */
export function ftpAt(history: FtpEntry[], t: number): number | null {
  if (history.length === 0) return null;
  let ftp = history[0].watts;
  for (const e of history) if (e.from <= t) ftp = e.watts;
  return ftp;
}

// ---------- 給前端的整理 ----------

export type FormLevel = 0 | 1 | 2 | 3 | 4;

export type TrainingView = {
  ftp: number | null;
  /** 今天出門前的狀態：昨天結束時的 CTL／ATL（今天騎的還不算進去） */
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  /** CTL 這 7 天爬了多少 */
  ramp: number | null;
  form: { level: FormLevel; label: string } | null;
  /** 最近 PMC_DAYS 天。ctl／atl 是那天結束時的值（最後一格含今天騎的）；
   *  tsb 是那天出門前的狀態（前一天的 CTL − ATL），最後一格就等於上面的 tsb */
  pmc: { ctl: number; atl: number; tsb: number }[];
  /** PMC 的日期刻度：每月 1 號和 15 號落在 pmc 第幾格 */
  pmcTicks: { index: number; label: string }[];
  curve: { durations: number[]; recent: (number | null)[]; year: (number | null)[] };
  /** 最近幾趟一小時以上的心率漂移，新的在前 */
  drift: { date: string; pct: number }[];
  /** 有功率、但串流還沒抓完的趟數（剛接上時要補一年份） */
  pending: number;
};

/**
 * TSB（狀態）五區，名稱和門檻照 intervals.icu 的 Form 圖：
 * +25 以上過渡期（休太久，體能在掉）、+5～+25 精力充沛、−10～+5 灰色地帶、
 * −30～−10 最優（有效訓練）、−30 以下高風險。前端 public/app.js 的 FORM_ZONES 要跟這裡一致。
 */
export function formLevel(tsb: number): { level: FormLevel; label: string } {
  if (tsb > 25) return { level: 0, label: "過渡期" };
  if (tsb >= 5) return { level: 1, label: "精力充沛" };
  if (tsb >= -10) return { level: 2, label: "灰色地帶" };
  if (tsb >= -30) return { level: 3, label: "最優" };
  return { level: 4, label: "高風險" };
}

export function buildTrainingView(rides: Ride[], ftpHistory: FtpEntry[], now: number): TrainingView {
  const today = startOfTaipeiDay(now);
  const firstDay = today - YEAR_DAYS * DAY_MS;

  // 每天的 TSS（台北日界）
  const daily = new Map<number, number>();
  let pending = 0;
  for (const r of rides) {
    if (r.hasPower && r.metrics === undefined) pending++;
    const ftp = ftpAt(ftpHistory, r.start);
    if (!r.metrics || ftp === null) continue;
    const day = startOfTaipeiDay(r.start);
    daily.set(day, (daily.get(day) ?? 0) + tss(r.metrics, ftp));
  }

  // 從一年前的 0 開始疊，算到今天
  const ctlByDay: number[] = [];
  const atlByDay: number[] = [];
  let ctl = 0;
  let atl = 0;
  for (let d = firstDay; d <= today; d += DAY_MS) {
    const load = daily.get(d) ?? 0;
    ctl += (load - ctl) / CTL_DAYS;
    atl += (load - atl) / ATL_DAYS;
    ctlByDay.push(ctl);
    atlByDay.push(atl);
  }
  const last = ctlByDay.length - 1;
  const hasFtp = ftpHistory.length > 0;
  const yCtl = ctlByDay[last - 1];
  const yAtl = atlByDay[last - 1];

  const pmc: TrainingView["pmc"] = [];
  for (let i = last - PMC_DAYS + 1; i <= last; i++) {
    pmc.push({ ctl: round1(ctlByDay[i]), atl: round1(atlByDay[i]), tsb: round1(ctlByDay[i - 1] - atlByDay[i - 1]) });
  }

  const recentFrom = today - (RECENT_DAYS - 1) * DAY_MS;
  const recent = DURATIONS.map(() => null as number | null);
  const year = DURATIONS.map(() => null as number | null);
  for (const r of rides) {
    if (!r.metrics || r.start < firstDay) continue;
    r.metrics.best.forEach((w, i) => {
      if (w === null) return;
      if (year[i] === null || w > year[i]!) year[i] = w;
      if (r.start >= recentFrom && (recent[i] === null || w > recent[i]!)) recent[i] = w;
    });
  }

  const drift = rides
    .filter((r) => r.metrics?.drift != null)
    .sort((a, b) => b.start - a.start)
    .slice(0, 6)
    .map((r) => ({ date: monthDay(r.start), pct: r.metrics!.drift! }));

  const tsb = hasFtp ? round1(yCtl - yAtl) : null;
  return {
    ftp: ftpAt(ftpHistory, now),
    ctl: hasFtp ? round1(yCtl) : null,
    atl: hasFtp ? round1(yAtl) : null,
    tsb,
    ramp: hasFtp ? round1(ctlByDay[last] - ctlByDay[last - 7]) : null,
    form: tsb === null ? null : formLevel(tsb),
    pmc: hasFtp ? pmc : [],
    pmcTicks: pmcTicks(today),
    curve: { durations: DURATIONS, recent, year },
    drift,
    pending,
  };
}

function pmcTicks(today: number): TrainingView["pmcTicks"] {
  const ticks: TrainingView["pmcTicks"] = [];
  for (let i = 0; i < PMC_DAYS; i++) {
    const day = today - (PMC_DAYS - 1 - i) * DAY_MS;
    const d = taipeiParts(day).day;
    if (d === 1 || d === 15) ticks.push({ index: i, label: monthDay(day) });
  }
  return ticks;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
