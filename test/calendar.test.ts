import assert from "node:assert/strict";
import { test } from "node:test";
import ICAL from "ical.js";
import { expandIcs, groupEvents } from "../src/calendar.ts";
import { DAY_MS } from "../src/time.ts";

const tp = (s: string) => Date.parse(`${s}+08:00`);
const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");

const VTZ = [
  "BEGIN:VTIMEZONE", "TZID:Asia/Taipei",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "DTSTART:19700101T000000", "END:STANDARD",
  "END:VTIMEZONE",
];
const ev = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

// 模擬 Google 匯出的 basic.ics：今天是 10/8（週四）晚上 9 點
const FEED = ics(
  ...VTZ,
  ...ev("UID:club", "SUMMARY:社團課", "DTSTART;TZID=Asia/Taipei:20261008T190000", "DTEND;TZID=Asia/Taipei:20261008T203000"),
  ...ev("UID:first", "SUMMARY:第一節課", "DTSTART:20261009T001000Z", "DTEND:20261009T010000Z"),
  ...ev("UID:fair", "SUMMARY:校慶", "DTSTART;VALUE=DATE:20261008", "DTEND;VALUE=DATE:20261010"),
  ...ev("UID:night", "SUMMARY:跨夜", "DTSTART;TZID=Asia/Taipei:20261007T230000", "DTEND;TZID=Asia/Taipei:20261008T010000"),
  // 每週五 13:30 數學課，10/9 那次被改成 15:00 的數學小考
  ...ev("UID:math", "SUMMARY:數學課", "DTSTART;TZID=Asia/Taipei:20260904T133000", "DTEND;TZID=Asia/Taipei:20260904T142000", "RRULE:FREQ=WEEKLY;BYDAY=FR"),
  ...ev("UID:math", "SUMMARY:數學小考", "RECURRENCE-ID;TZID=Asia/Taipei:20261009T133000", "DTSTART;TZID=Asia/Taipei:20261009T150000", "DTEND;TZID=Asia/Taipei:20261009T160000"),
  // 每天 06:00 晨跑，10/9 那天排除
  ...ev("UID:run", "SUMMARY:晨跑", "DTSTART;TZID=Asia/Taipei:20260101T060000", "DTEND;TZID=Asia/Taipei:20260101T063000", "RRULE:FREQ=DAILY", "EXDATE;TZID=Asia/Taipei:20261009T060000"),
  // 每週四 22:00 讀書會，10/8 那次取消
  ...ev("UID:study", "SUMMARY:讀書會", "DTSTART;TZID=Asia/Taipei:20260903T220000", "DTEND;TZID=Asia/Taipei:20260903T230000", "RRULE:FREQ=WEEKLY;BYDAY=TH"),
  ...ev("UID:study", "SUMMARY:讀書會", "STATUS:CANCELLED", "RECURRENCE-ID;TZID=Asia/Taipei:20261008T220000", "DTSTART;TZID=Asia/Taipei:20261008T220000", "DTEND;TZID=Asia/Taipei:20261008T230000"),
  ...ev("UID:gone", "SUMMARY:取消的活動", "STATUS:CANCELLED", "DTSTART;TZID=Asia/Taipei:20261009T100000", "DTEND;TZID=Asia/Taipei:20261009T110000"),
  ...ev("UID:later", "SUMMARY:下週的事", "DTSTART;TZID=Asia/Taipei:20261012T100000", "DTEND;TZID=Asia/Taipei:20261012T110000"),
  ...ev("UID:past", "SUMMARY:昨天的事", "DTSTART;TZID=Asia/Taipei:20261007T100000", "DTEND;TZID=Asia/Taipei:20261007T110000"),
);

const show = (list: { time: string; title: string }[]) => list.map((e) => `${e.time} ${e.title}`);

test("iCal：展開重複行程、套用改期／排除／取消，分成今天明天", () => {
  const now = tp("2026-10-08T21:00:00");
  const today = tp("2026-10-08T00:00:00");
  const view = groupEvents(expandIcs(FEED, today, today + 2 * DAY_MS), now);
  assert.deepEqual(show(view.today), ["整天 校慶", "延續 跨夜", "06:00 晨跑", "19:00 社團課"]);
  assert.deepEqual(show(view.tomorrow), ["整天 校慶", "08:10 第一節課", "15:00 數學小考"]);
  // 結束時間要對，前端靠它把過去的行程畫淡
  assert.equal(view.today.find((e) => e.title === "社團課")!.end, tp("2026-10-08T20:30:00"));
});

test("iCal：沒附 VTIMEZONE 也把 Asia/Taipei 當 +08:00、沒標時區的當台北時間", () => {
  ICAL.TimezoneService.reset();
  const feed = ics(
    ...ev("UID:a", "SUMMARY:有 TZID", "DTSTART;TZID=Asia/Taipei:20261009T090000", "DTEND;TZID=Asia/Taipei:20261009T100000"),
    ...ev("UID:b", "SUMMARY:浮動時間", "DTSTART:20261009T140000", "DTEND:20261009T150000"),
    ...ev("UID:c", "SUMMARY:沒有結束時間的全天", "DTSTART;VALUE=DATE:20261009"),
  );
  const today = tp("2026-10-08T00:00:00");
  const list = expandIcs(feed, today, today + 2 * DAY_MS);
  const by = (t: string) => list.find((o) => o.title === t)!;
  assert.equal(by("有 TZID").start, tp("2026-10-09T09:00:00"));
  assert.equal(by("浮動時間").start, tp("2026-10-09T14:00:00"));
  assert.equal(by("沒有結束時間的全天").end - by("沒有結束時間的全天").start, DAY_MS);
});
