// 第一次接 Strava：授權自己的 Strava API App，拿到 refresh token 貼進 STRAVA_REFRESH_TOKEN。
//
//   STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=… node scripts/strava-auth.ts
//
// Strava App 的 Authorization Callback Domain 要填 localhost。授權完瀏覽器會跳到
// http://localhost/?…&code=… 打不開沒關係，把網址列整串貼回來就好。

import { createInterface } from "node:readline/promises";

const clientId = process.env.STRAVA_CLIENT_ID;
const clientSecret = process.env.STRAVA_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("先設定 STRAVA_CLIENT_ID 與 STRAVA_CLIENT_SECRET（Strava 設定 → My API Application）");
  process.exit(1);
}

const authorize = new URL("https://www.strava.com/oauth/authorize");
authorize.search = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: "http://localhost",
  approval_prompt: "force",
  // read_all：私人的騎乘也要算進 CTL
  scope: "read,activity:read_all",
}).toString();

console.log("1. 用瀏覽器打開這個網址，按「授權」：\n\n" + authorize.href + "\n");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("2. 把跳轉後的整串網址（或 code）貼在這裡：")).trim();
rl.close();

const asUrl = URL.canParse(pasted) ? new URL(pasted) : null;
const code = asUrl ? asUrl.searchParams.get("code") : pasted;
const scope = asUrl?.searchParams.get("scope") ?? "";
if (!code) {
  console.error("網址裡找不到 code");
  process.exit(1);
}
if (asUrl && !scope.includes("activity:read_all")) {
  console.warn("注意：授權時沒有勾「查看所有活動資料」，私人的騎乘會讀不到。");
}

const res = await fetch("https://www.strava.com/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code" }),
});
const j = (await res.json()) as { refresh_token?: string; message?: string; athlete?: { firstname?: string } };
if (!res.ok || !j.refresh_token) {
  console.error(`換 token 失敗（${res.status}）：${j.message ?? "unknown"}`);
  process.exit(1);
}
console.log(`\n3. 成功（${j.athlete?.firstname ?? "?"}）。把這串設成伺服器的 STRAVA_REFRESH_TOKEN：\n\n${j.refresh_token}\n`);
