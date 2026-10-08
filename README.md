# 看一眼（glance）

舊手機橫放在桌上，常駐顯示天氣＋作業＋行事曆。網頁全螢幕，不做 App。

- 第一頁（常駐）：現在有沒有在下雨、一句摘要、UTCI、未來 24 小時雨量、未交作業、今天明天的行程。
- 第二頁（左右滑）：未來一週每天 05–20 點的雨量格子＋當天 UTCI 最高值。
- 設計稿：<https://claude.ai/artifact/2BwkBreVHZJHns8tNHkWKy>（第一頁 A2、第二頁 W1）

## 架構

後端一支 API（`GET /api/glance`）把三個來源整理好一次回傳，手機只負責顯示。
Node 22.18 以上直接跑 TypeScript（型別剝除），**沒有任何執行期相依、不用 build**。

| 來源 | 做法 | 伺服器快取 |
|---|---|---|
| 天氣 | Open-Meteo，ECMWF 模式（預設 `ecmwf_ifs025`），逐小時雨量、氣溫、濕度、風速、日射量 | 15 分鐘 |
| UTCI | 自己算：`src/utci.ts`（照抄 pythermalcomfort 的多項式），平均輻射溫度用日射量估（`src/mrt.ts`，ASHRAE SolarCal） | 跟天氣一起 |
| 作業 | 「該交了」的唯讀 API `GET /api/glance`（Bearer 金鑰） | 5 分鐘 |
| 行事曆 | Google Calendar API，服務帳戶唯讀，今天＋明天 | 5 分鐘 |

某個來源抓失敗時，繼續回上一筆成功的資料，並在 `sources` 裡附上錯誤與最後更新時間。
手機每分鐘來拿一次（伺服器有快取，不會多打外部服務）；拿不到就顯示最後一筆並標「X 分鐘前更新」。

```
src/
  server.ts    HTTP 伺服器：/api/glance、/healthz、public/ 靜態檔
  glance.ts    組合三個來源 → 回應
  view.ts      把逐小時預報排成兩頁要顯示的東西（摘要句、長條、一週格子）
  weather.ts   Open-Meteo 抓取與解析，每小時算 UTCI
  utci.ts      UTCI 與熱壓力分級
  mrt.ts       日射量 → 平均輻射溫度
  solar.ts     太陽高度角
  calendar.ts  Google Calendar（服務帳戶 JWT）
  homework.ts  該交了
  cache.ts     每個來源的快取與失敗沿用
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
- **第二頁**：停在第二頁 2 分鐘沒動就自動滑回常駐頁。

## 本機開發

```bash
npm install          # 只有 typescript 與 @types/node（型別檢查用）
npm run dev          # http://localhost:3000
npm test
npm run typecheck
```

沒設 `GLANCE_TOKEN` 時不檢查金鑰；沒設作業或行事曆的變數，那一塊顯示「–」。

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `GLANCE_TOKEN` | 部署時必填 | 看板的存取金鑰（自己產一串亂數，例如 `openssl rand -base64 32`） |
| `PORT` | | 預設 3000 |
| `WEATHER_LAT` / `WEATHER_LON` | | 預設 25.12 / 121.51（唭哩岸捷運站附近） |
| `OPEN_METEO_MODEL` | | 預設 `ecmwf_ifs025` |
| `DUE_NOW_URL` | | 預設 `https://now.tschool.cc` |
| `DUE_NOW_GLANCE_KEY` | 要顯示作業時 | 跟「該交了」那邊的 `GLANCE_API_KEY` 同一串 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 要顯示行事曆時 | 服務帳戶金鑰 JSON 整串 |
| `GOOGLE_CALENDAR_IDS` | 要顯示行事曆時 | 逗號分隔；個人主行事曆的 ID 就是你的 Gmail 地址 |

### 設定 Google Calendar（一次）

為什麼不用 OAuth：用戶端在「測試中」狀態時 refresh token 7 天就失效，常駐看板會三不五時斷掉。

1. Google Cloud Console 開一個專案，啟用「Google Calendar API」。
2. 「IAM 與管理 → 服務帳戶」建立一個服務帳戶，在「金鑰」新增 JSON 金鑰並下載。
3. 到 Google 日曆 →（要顯示的行事曆）設定與共用 →「與特定使用者共用」→ 加入服務帳戶的 email，權限選「查看所有活動詳細資料」。
4. 把 JSON 檔內容整串放進 `GOOGLE_SERVICE_ACCOUNT_JSON`，行事曆 ID 放進 `GOOGLE_CALENDAR_IDS`。

學校的 Workspace 帳號可能不允許分享給外部帳號，那就用個人帳號的行事曆。

## 部署

任何能跑 Node 22.18+ 的地方都行（例如 Railway：開一個服務接這個 repo，啟動指令 `npm start`，設好環境變數）。
要 HTTPS，否則 Screen Wake Lock 與 service worker 不會動。

## 手機設定

1. 用 `https://你的網址/#k=GLANCE_TOKEN` 開一次，金鑰會記在這台手機上（網址列的 `#k=…` 會自動消失）。
2. 「加到主畫面」再從主畫面開，就是無網址列的全螢幕。直接在瀏覽器裡用的話，點一下畫面進全螢幕。
3. 螢幕不休眠靠 Screen Wake Lock（Android Chrome 84+、iOS Safari 16.4+）。更舊的手機請在系統設定把自動鎖定關掉。
4. 防烙印：每 3 分鐘整個畫面挪幾個 px（最多 4px）。
