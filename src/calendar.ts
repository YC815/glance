// Google 日曆：讀「iCal 格式的私人網址」（設定 → 整合日曆），伺服器端抓、解析、展開重複行程。
//
// 為什麼不用 Calendar API：學校 Workspace 帳號多半不准把行事曆分享給外部的服務帳戶，
// OAuth 用戶端在「測試中」狀態 refresh token 又 7 天就失效。私人 iCal 網址開得出來就能用、不會過期。
// 這串網址等於整個行事曆的唯讀鑰匙：只放在伺服器的環境變數，錯誤訊息與日誌都不能帶到它。

import ICAL from "ical.js";
import { DAY_MS, TZ_OFFSET_MS, hhmm, startOfTaipeiDay } from "./time.ts";

export type CalendarConfig = { icsUrls: string[] };

export type CalEvent = {
  /** 「09:30」「整天」或「延續」（昨天開始、今天還沒結束） */
  time: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
};

export type CalendarView = { today: CalEvent[]; tomorrow: CalEvent[] };

/** 展開後的一次行程（還沒分今天明天）。 */
export type Occurrence = Omit<CalEvent, "time">;

/** 重複行程最多展開幾次，防止很久以前開始的每日行程跑太久 */
const MAX_ITERATIONS = 20_000;

// Google 匯出的 .ics 會附 VTIMEZONE；萬一沒附，至少 Asia/Taipei 要認得（固定 +08:00，沒有日光節約）。
const TAIPEI_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Taipei",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0800",
  "TZOFFSETTO:+0800",
  "TZNAME:CST",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

export async function fetchCalendar(cfg: CalendarConfig, now = Date.now()): Promise<CalendarView> {
  const texts = await Promise.all(
    cfg.icsUrls.map(async (url, i) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      // 不能把網址放進錯誤訊息：它就是密碼
      if (!res.ok) throw new Error(`iCal #${i + 1} 回應 ${res.status}`);
      return res.text();
    }),
  );
  const today = startOfTaipeiDay(now);
  const occurrences = texts.flatMap((text) => expandIcs(text, today, today + 2 * DAY_MS));
  return groupEvents(occurrences, now);
}

/** ICAL.Time → epoch ms。全天與「浮動時間」（沒標時區）都當台北時間。 */
function toMs(t: ICAL.Time): number {
  if (t.isDate) return Date.UTC(t.year, t.month - 1, t.day) - TZ_OFFSET_MS;
  if (!t.zone || t.zone.tzid === "floating") {
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - TZ_OFFSET_MS;
  }
  return t.toJSDate().getTime();
}

function occurrence(title: string, start: ICAL.Time, end: ICAL.Time | null): Occurrence {
  const allDay = start.isDate;
  const s = toMs(start);
  let e = end ? toMs(end) : s;
  // 沒有 DTEND：全天的算一天，計時的算一個時間點
  if (e <= s && allDay) e = s + DAY_MS;
  return { title, start: s, end: e, allDay };
}

const isCancelled = (c: ICAL.Component) =>
  String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

/** 解析一份 .ics，回傳跟 [from, to) 重疊的每一次行程（重複行程已展開、例外已套用）。 */
export function expandIcs(text: string, from: number, to: number): Occurrence[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const vtz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
  if (!ICAL.TimezoneService.has("Asia/Taipei")) {
    ICAL.TimezoneService.register(new ICAL.Component(ICAL.parse(TAIPEI_VTIMEZONE)));
  }

  // 同一個 UID：沒有 RECURRENCE-ID 的是本體，有的是某一次被改過的例外
  const masters = new Map<string, ICAL.Component>();
  const exceptions = new Map<string, ICAL.Component[]>();
  for (const c of root.getAllSubcomponents("vevent")) {
    const uid = String(c.getFirstPropertyValue("uid") ?? "");
    if (c.hasProperty("recurrence-id")) {
      exceptions.set(uid, [...(exceptions.get(uid) ?? []), c]);
    } else {
      masters.set(uid || `__${masters.size}`, c);
    }
  }

  const out: Occurrence[] = [];
  const overlaps = (o: Occurrence) => o.start < to && (o.end > from || (o.end === o.start && o.start >= from));

  for (const [uid, comp] of masters) {
    if (isCancelled(comp)) continue;
    const event = new ICAL.Event(comp, { exceptions: exceptions.get(uid) ?? [], strictExceptions: false });
    const title = event.summary?.trim() || "（沒有標題）";

    if (!event.isRecurring()) {
      const o = occurrence(title, event.startDate, event.endDate);
      if (overlaps(o)) out.push(o);
      continue;
    }

    const it = event.iterator();
    for (let i = 0, next = it.next(); next && i < MAX_ITERATIONS; i++, next = it.next()) {
      if (toMs(next) >= to) break;
      const d = event.getOccurrenceDetails(next);
      if (isCancelled(d.item.component)) continue;
      const o = occurrence(d.item.summary?.trim() || title, d.startDate, d.endDate);
      if (overlaps(o)) out.push(o);
    }
  }

  // 被移到視窗內、但本體已經不在 .ics 裡的孤兒例外（少見）
  for (const [uid, list] of exceptions) {
    if (masters.has(uid)) continue;
    for (const c of list) {
      if (isCancelled(c)) continue;
      const e = new ICAL.Event(c);
      const o = occurrence(e.summary?.trim() || "（沒有標題）", e.startDate, e.endDate);
      if (overlaps(o)) out.push(o);
    }
  }
  return out;
}

/** 分成今天、明天。跨日的全天活動兩天都列；計時活動放在開始那天（昨天開始、今天還沒結束的放今天）。 */
export function groupEvents(items: Occurrence[], now: number): CalendarView {
  const today = startOfTaipeiDay(now);
  const tomorrow = today + DAY_MS;
  const out: CalendarView = { today: [], tomorrow: [] };

  for (const e of items) {
    const overlaps = (from: number) => e.start < from + DAY_MS && e.end > from;
    if (e.allDay) {
      if (overlaps(today)) out.today.push({ ...e, time: "整天" });
      if (overlaps(tomorrow)) out.tomorrow.push({ ...e, time: "整天" });
    } else if (e.start >= tomorrow && e.start < tomorrow + DAY_MS) {
      out.tomorrow.push({ ...e, time: hhmm(e.start) });
    } else if (e.start >= today && e.start < tomorrow) {
      out.today.push({ ...e, time: hhmm(e.start) });
    } else if (e.start < today && e.end > today) {
      out.today.push({ ...e, time: "延續" });
    }
  }
  // 全天的排前面，其餘照開始時間
  const order = (a: CalEvent, b: CalEvent) =>
    Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title);
  out.today.sort(order);
  out.tomorrow.sort(order);
  return out;
}
