import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RideStore } from "../src/store.ts";
import { Strava, errorMessage } from "../src/strava.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const now = Date.parse("2026-10-09T08:00:00+08:00");
const seconds = Array.from({ length: 3600 }, (_, i) => i);

/** 假的 Strava：記下打了哪些網址 */
function fakeStrava(activities: object[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body));
      return json({ access_token: "acc", expires_at: now / 1000 + 6 * 3600, refresh_token: `${body.get("refresh_token")}-next` });
    }
    if (url.includes("/athlete/activities")) return json(url.includes("page=1") ? activities : []);
    if (url.includes("/activities/2/streams")) return json({ message: "Record Not Found" }, 404);
    if (url.includes("/streams")) {
      return json({ time: { data: seconds }, watts: { data: seconds.map(() => 200) }, heartrate: { data: seconds.map(() => 140) } });
    }
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
  return calls;
}

const activity = (id: number, sport_type: string, device_watts = true) => ({
  id,
  name: `ride ${id}`,
  sport_type,
  start_date: new Date(now - id * 86_400_000).toISOString(),
  moving_time: 3600,
  device_watts,
});

test("Strava 同步：只收騎車、有功率計的抓串流算數字，換發的 refresh token 存起來", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glance-"));
  const calls = fakeStrava([
    activity(1, "Ride"),
    activity(2, "VirtualRide"),
    activity(3, "Ride", false),
    activity(4, "Walk"),
    activity(5, "EBikeRide"),
  ]);
  const strava = new Strava({ clientId: "1", clientSecret: "s", refreshToken: "env" }, new RideStore(dir));
  const r = await strava.sync(now);
  assert.deepEqual(r, { added: 3, computed: 2, pending: 0 });

  const saved = JSON.parse(await readFile(join(dir, "rides.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.rides).sort(), ["1", "2", "3"]);
  assert.equal(saved.rides["1"].metrics.np, 200);
  assert.equal(saved.rides["1"].metrics.drift, 0);
  assert.equal(saved.rides["2"].metrics, null, "404（刪掉了）記成 null，不再重抓");
  assert.equal(saved.rides["3"].metrics, undefined, "沒功率計不抓串流");
  assert.equal(saved.refreshToken, "env-next");
  assert.equal(calls.filter((u) => u.includes("/streams")).length, 2);
  assert.match(calls.find((u) => u.includes("/athlete/activities"))!, /after=\d+&per_page=100&page=1/);

  // 第二次：用存起來的 refresh token；串流都算過了不再抓；只重列最近 7 天
  const calls2 = fakeStrava([activity(1, "Ride")]);
  const again = new Strava({ clientId: "1", clientSecret: "s", refreshToken: "env" }, new RideStore(dir));
  assert.deepEqual(await again.sync(now), { added: 0, computed: 0, pending: 0 });
  assert.equal(calls2.filter((u) => u.includes("/streams")).length, 0);
  const after = Number(new URL(calls2.find((u) => u.includes("/athlete/activities"))!).searchParams.get("after"));
  assert.equal(after, Math.floor((now - 7 * 86_400_000) / 1000));
  const saved2 = JSON.parse(await readFile(join(dir, "rides.json"), "utf8"));
  assert.equal(saved2.refreshToken, "env-next-next");

  // 重新授權、換了環境變數：改用新的那把
  fakeStrava([]);
  await new Strava({ clientId: "1", clientSecret: "s", refreshToken: "new" }, new RideStore(dir)).sync(now);
  const saved3 = JSON.parse(await readFile(join(dir, "rides.json"), "utf8"));
  assert.equal(saved3.refreshToken, "new-next");
});

test("Strava 錯誤訊息：帶出是哪個欄位不對，不帶值", async () => {
  const res = new Response(
    JSON.stringify({ message: "Bad Request", errors: [{ resource: "RefreshToken", field: "refresh_token", code: "invalid" }] }),
    { status: 400 },
  );
  assert.equal(await errorMessage(res), "Bad Request（RefreshToken.refresh_token invalid）");
  assert.equal(await errorMessage(new Response(JSON.stringify({ message: "Authorization Error" }))), "Authorization Error");
  assert.equal(await errorMessage(new Response("not json")), "unknown");
});
