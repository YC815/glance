# 看一眼（glance）

舊手機橫放在桌上，常駐顯示天氣＋作業＋行事曆，往右滑看騎車的負荷。網頁全螢幕，不做 App。

- 第一頁（常駐）：現在有沒有在下雨、一句摘要、UTCI（點了看今天每小時的折線圖）、未來 24 小時雨量、未交作業、今天明天的行程。
- 第二頁（左右滑）：未來一週每天 05–20 點的雨量格子＋當天 UTCI 最高值。
- 第三頁：騎車。今天出門前的狀態（TSB）、體能（CTL）、疲勞（ATL），最近 90 天的 PMC，功率曲線（近 6 週 vs 一年），一小時以上騎乘的心率漂移。
- 設計稿：<https://claude.ai/artifact/2BwkBreVHZJHns8tNHkWKy>（第一頁 A2、第二頁 W1）

## 架構

後端一支 API（`GET /api/glance`）把各來源整理好一次回傳，手機只負責顯示；另一支 `POST /api/ftp` 給騎車頁改 FTP。
Node 22.18 以上直接跑 TypeScript（型別剝除），**不用 build**；執行期只有一個相依：解析 iCal 的 `ical.js`（Mozilla，本身零相依）。

| 來源 | 做法 | 伺服器快取 |
|---|---|---|
| 天氣 | Open-Meteo，ECMWF 模式（預設 `ecmwf_ifs025`），逐小時雨量、氣溫、濕度、風速、日射量 | 15 分鐘；第二頁點「未來一週」可立刻重抓 |
| UTCI | 自己算：`src/utci.ts`（照抄 pythermalcomfort 的多項式），平均輻射溫度用日射量估（`src/mrt.ts`，ASHRAE SolarCal） | 跟天氣一起 |
| 作業 | Due Now 開發者 API：抓未完成作業清單，自己數「今天」「三天內」 | 5 分鐘；點看板上的作業數字可立刻重抓 |
| 行事曆 | Google 日曆的「iCal 格式私人網址」，伺服器端解析、展開重複行程，今天＋明天 | 5 分鐘 |
| 騎車 | Strava API：列出騎乘、抓逐秒功率／心率串流，自己算 NP、TSS、CTL／ATL／TSB、功率曲線、心率漂移；算好的存在 `DATA_DIR/rides.json` | 15 分鐘；點「騎車」可立刻重抓 |

某個來源抓失敗時，繼續回上一筆成功的資料，並在 `sources` 裡附上錯誤與最後更新時間。
手機每分鐘來拿一次（伺服器有快取，不會多打外部服務）；拿不到就顯示最後一筆並標「X 分鐘前更新」。

```
src/
  server.ts    HTTP 伺服器：/api/glance、/healthz、public/ 靜態檔
  glance.ts    組合三個來源 → 回應
  view.ts      把逐小時預報排成兩頁要顯示的東西（摘要句、長條、今天每小時 UTCI、一週格子）
  weather.ts   Open-Meteo 抓取與解析，每小時算 UTCI
  utci.ts      UTCI 與熱壓力分級
  mrt.ts       日射量 → 平均輻射溫度
  solar.ts     太陽高度角
  calendar.ts  Google 日曆（私人 iCal 網址）
  homework.ts  Due Now
  strava.ts    Strava：換 token、列騎乘、抓串流、速率限制
  training.ts  騎車頁的計算（NP、TSS、PMC、功率曲線、心率漂移）
  store.ts     騎車資料的 JSON 檔
  cache.ts     每個來源的快取與失敗沿用
scripts/
  strava-auth.ts  第一次授權 Strava，拿 refresh token
public/        前端（不打包的純 JS）、service worker、manifest
test/          node:test
```

### 幾個判斷

- **一格一小時**：標成 H 點的那格是 H:00–H+1:00 的雨量（Open-Meteo 的雨量是「前一小時累積」，所以取 H+1 整點的值）。
- **有沒有在下雨**：現在這一小時那格 ≥ 0.5 mm 算有。大字依雨量分級寫「現在下小雨／在下雨／下大雨／雨很大」。
- **摘要句**：沒在下 →「凌晨 3 點開始下，早上 8 點最大」（最大取那一段連續下雨裡最大的一小時）；正在下 →「雨會下到 X 點」；24 小時都不下 →「接下來 24 小時不會下雨」。白天講到隔天早上會加「明天」。
- **UTCI**：現在的值用前後兩個整點內插；第二頁取每天 05–20 點的最高值。風速低於 0.5 m/s 夾到 0.5（原模型會回 NaN）。
- **平均輻射溫度**：MRT = 氣溫 + 太陽造成的 ΔMRT。散射、直射分開用 Open-Meteo 的值，人站在戶外、方位取平均、地面反射率 0.2。沒算長波輻射，晴朗夜晚會略高估。
- **行事曆**：今天的全部列出，已經結束的透明度 40%；放不下時先拿掉今天已結束的，再從明天最後面砍、補「還有 N 個」。
- **作業的兩個數字**：只算沒勾完成、平台也還沒繳交、截止時間還沒過的。「今天」= 截止在現在到明天 00:00；「三天內」= 今天、明天、後天三個日曆天，含今天。日界用台北時間。
- **今天每小時 UTCI**：點第一頁的 UTCI，跳出今天 00–23 點每小時 UTCI 的折線圖（每小時一個點，顏色是那小時的熱壓力分級；背景色帶標分級界線，現在以前畫淡、虛線是現在）。手指在圖上點或拖可以看某個整點的值；點視窗外面或 × 關掉，開著 2 分鐘沒動也會自己關。
- **手動同步作業**：點任一個作業數字，兩個圓圈會蓋上半透明的轉圈動畫，伺服器跳過快取直接問 Due Now（`/api/glance?refresh=homework`，2 秒內連點只算一次）。在 Due Now 勾完成後點一下，數字就會更新。
- **手動重抓天氣**：在第二頁點「未來一週」，字的右邊轉圈，伺服器跳過快取直接問 Open-Meteo（`/api/glance?refresh=weather`）。
- **第二、三頁**：停在第二或第三頁 2 分鐘沒動就自動滑回常駐頁。

### 騎車頁的判斷

為什麼走 Strava：Garmin 沒有給個人用的 API，非官方登入 2026 年 3 月整個壞過；intervals.icu 說 Garmin 改了條款、很快會擋 API 讀 Garmin 的資料。Strava 的 API 是官方的，自己一個人用（要有 Strava 訂閱）。HRV、靜止心率 Strava 沒有，這頁先不放。

- **只算有功率計的騎乘**（Strava 的 `device_watts`）：Ride、VirtualRide、GravelRide、MountainBikeRide，電輔車不算。沒功率計的那趟 TSS 當 0。
- **串流攤成每秒**：取樣間隔 ≤ 10 秒沿用前一個值（智慧記錄），更長的當成停下來。NP、TSS、心率漂移把停下來的段落拿掉；功率曲線補 0（不能跨過休息算平均）。
- **TSS** = 秒數 × NP² ÷ (FTP² × 36)。**FTP 手填**（點騎車頁右上角的「FTP」），從填的那天起生效，之前的騎乘照舊用當時的；比第一筆還早的騎乘用第一筆。每趟只存 NP 和秒數，改 FTP 不用重抓串流。
- **CTL／ATL**：從一年前的 0 開始，每天 `CTL += (TSS − CTL) / 42`、`ATL += (TSS − ATL) / 7`，日界用台北時間。
- **TSB（狀態）**：今天出門前的狀態＝昨天結束時的 CTL − ATL，今天騎的不算。分五區（名稱和門檻照 intervals.icu）：+25 以上「過渡期」（休太久，體能在掉）、+5～+25「精力充沛」、−10～+5「灰色地帶」、−30～−10「最優」（有效訓練）、−30 以下「高風險」。PMC 圖下面那條就是每天的 TSB，底色就是這五區，區名寫在右邊。
- **CTL 每週變化**：今天結束時的 CTL 減 7 天前。
- **功率曲線**：5 秒到 2 小時各秒數的最大平均功率，近 6 週（跟 CTL 同樣 42 天）對一年。
- **心率漂移**：一小時以上、心率有九成以上時間有讀數的騎乘，前後半段各算平均功率 ÷ 平均心率，後半段掉了幾 %。5% 以內代表有氧底子夠。爬坡、間歇課的數字會比較亂，參考就好。
- **補歷史**：剛接上時要抓一年份的串流。每 15 分鐘最多用 80 次讀取（Strava 上限 100），每次同步只花 8 秒補串流、其餘 5 分鐘後在背景接著補，新的先補。
- **Strava 的規定**：資料只給自己看、不能用在 AI；Garmin 錶錄的要標示 Garmin，頁面右下角有寫。

## 本機開發

```bash
npm install          # 只有 typescript 與 @types/node（型別檢查用）
npm run dev          # http://localhost:3000
npm test
npm run typecheck
```

沒設 `GLANCE_TOKEN` 時不檢查金鑰；沒設作業、行事曆或 Strava 的變數，那一塊顯示「–」。

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `GLANCE_TOKEN` | 部署時必填 | 看板的存取金鑰（自己產一串亂數，例如 `openssl rand -base64 32`） |
| `PORT` | | 預設 3000 |
| `WEATHER_LAT` / `WEATHER_LON` | | 預設 25.12 / 121.51（唭哩岸捷運站附近） |
| `OPEN_METEO_MODEL` | | 預設 `ecmwf_ifs025` |
| `DUE_NOW_URL` | | 預設 `https://now.tschool.cc` |
| `DUE_NOW_TOKEN` | 要顯示作業時 | Due Now 的開發者 API token（`dn_…`），到 Due Now 設定 → 開發者 API 產生，權限選 read 就夠。90 天沒用會失效，看板常駐就不會 |
| `CALENDAR_ICS_URLS` | 要顯示行事曆時 | 行事曆的「iCal 格式私人網址」，好幾個用逗號分隔。**這串網址就是密碼**，只放在伺服器的環境變數 |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | 要顯示騎車時 | 自己的 Strava API App（見下面） |
| `STRAVA_REFRESH_TOKEN` | 要顯示騎車時 | `scripts/strava-auth.ts` 拿到的。之後 Strava 換發的新 token 存在 `rides.json`，這個變數只有第一次用；重新授權後換掉它，伺服器會改用新的 |
| `DATA_DIR` | 要顯示騎車時 | 預設 `data`。騎車資料（`rides.json`）放這裡，**要指到會保留的磁碟**：Railway 掛一個 volume（例如掛在 `/data`），這裡填 `/data`。不然每次重新部署就要重補一年份、FTP 也要重填 |

### 設定 Google 日曆（一次）

1. Google 日曆 → 右上齒輪「設定」→ 左邊點要顯示的行事曆 →「整合日曆」。
2. 複製「iCal 格式的私人網址」（`https://calendar.google.com/calendar/ical/…/private-…/basic.ics`）。
3. 貼進伺服器的 `CALENDAR_ICS_URLS`（Railway：glance 服務 → Variables）。不要放進前端、不要 commit、不要貼到聊天或 issue。
4. 外洩了就回到同一頁按「重設」，舊網址立刻失效，再把新網址換進去。

為什麼不用 Calendar API：學校 Workspace 帳號多半不准分享給外部的服務帳戶；OAuth 用戶端在「測試中」狀態 refresh token 7 天就失效。
私人 iCal 網址也不能給前端直接抓：Google 沒開 CORS，而且等於把行事曆的鑰匙公開。

重複行程、改期、單次取消、排除日期都會照 .ics 正確展開。

## 部署

任何能跑 Node 22.18+ 的地方都行（例如 Railway：開一個服務接這個 repo，啟動指令 `npm start`，設好環境變數）。
要 HTTPS，否則 Screen Wake Lock 與 service worker 不會動。

## 手機設定

1. 打開網址，畫面會跳出「輸入看板金鑰」：貼上 `GLANCE_TOKEN`（或整串 `https://你的網址/#k=GLANCE_TOKEN` 也行），存在這支手機上，只要做一次。
   用 `#k=…` 網址開也會自動記住。
2. 全螢幕：
   - Android Chrome：點一下畫面就進全螢幕；或選單「加到主畫面／安裝應用程式」，從主畫面開就沒有網址列。
   - iPhone：Safari 分享 →「加入主畫面」，從主畫面開。**主畫面的 App 跟 Safari 的儲存空間是分開的**，所以第一次從主畫面開時要再貼一次金鑰（就是第 1 步那個框）。
3. 螢幕不休眠靠 Screen Wake Lock（Android Chrome 84+、iOS Safari 16.4+）。更舊的手機請在系統設定把自動鎖定關掉。
4. 防烙印：每 3 分鐘整個畫面挪幾個 px（最多 4px）。

### 設定 Strava（一次）

1. Strava 設定 → [My API Application](https://www.strava.com/settings/api) 建一個 App。Authorization Callback Domain 填 `localhost`。
2. 在自己電腦的專案資料夾裡跑（Mac、Windows 都一樣；Node 要 22.18 以上）：
   ```bash
   node scripts/strava-auth.ts <Client ID> <Client Secret>
   ```
   兩個值換成 My API Application 頁面上的，不用加引號。打開它印出的網址按授權（「查看所有活動資料」要勾）。瀏覽器會跳到打不開的 `http://localhost/?…code=…`，把整串網址貼回終端機。
3. 把印出來的 refresh token 和 client ID／secret 貼進伺服器的 `STRAVA_REFRESH_TOKEN`、`STRAVA_CLIENT_ID`、`STRAVA_CLIENT_SECRET`。
4. Railway：glance 服務掛一個 volume，`DATA_DIR` 設成它的掛載路徑。
5. 打開看板滑到第三頁，點右上角「FTP 未填」填 FTP。剛接上時右上角會寫「補資料中，還有 N 趟」，大概半小時到一小時補完。
