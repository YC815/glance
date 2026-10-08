import assert from "node:assert/strict";
import { test } from "node:test";
import { deltaMrt } from "../src/mrt.ts";
import { solarAltitude } from "../src/solar.ts";
import { heatStress, utci } from "../src/utci.ts";

// 對照值：pythermalcomfort 4.6.1 的 utci(..., round_output=False)
const UTCI_CASES: [number, number, number, number, number][] = [
  [25, 25, 1.0, 50, 24.61212626034633],
  [33, 63, 2, 60, 41.38209265112095],
  [28, 28, 0.5, 85, 31.49429563719167],
  [15, 20, 5, 70, 8.587583524408586],
  [40, 75, 1, 30, 49.38928162408156],
  [30, 45, 3, 75, 34.356552650358076],
  [-5, -10, 8, 90, -30.117319567393363],
  [22, 55, 12, 40, 19.340178349359288],
];

test("UTCI 與 pythermalcomfort 一致", () => {
  for (const [tdb, tr, v, rh, expected] of UTCI_CASES) {
    assert.ok(Math.abs(utci(tdb, tr, v, rh) - expected) < 1e-9, `${tdb},${tr},${v},${rh}`);
  }
});

test("風速低於 0.5 m/s 時夾到 0.5，不回 NaN", () => {
  assert.equal(utci(28, 28, 0, 85), utci(28, 28, 0.5, 85));
});

test("熱壓力分級的邊界", () => {
  assert.equal(heatStress(25.9).label, "無熱壓力");
  assert.equal(heatStress(26).label, "中度熱壓力");
  assert.equal(heatStress(32).label, "強熱壓力");
  assert.equal(heatStress(38).label, "非常強熱壓力");
  assert.equal(heatStress(50).level, 3);
});

// 對照值：pythermalcomfort solar_gain(posture="standing", sol_transmittance=1, f_svv=1,
// f_bes=1, asw=0.7, floor_reflectance=0.6).delta_mrt；SolarCal 假設散射 = 0.2 × 直射。
// 容許 1e-6：pythermalcomfort 的度轉弧度常數只取到 0.0174532925。
const SOLAR_CASES: [number, number, number, number][] = [
  [10, 0, 800, 55.22331470439449],
  [37, 45, 600, 43.73977067419376],
  [60, 120, 900, 64.63663178985621],
  [85, 180, 300, 20.491274731661765],
  [15, 90, 500, 28.715087667618295],
];

test("指定方位時 ΔMRT 與 SolarCal 一致", () => {
  for (const [altitude, sharp, dni, expected] of SOLAR_CASES) {
    const diffuse = 0.2 * dni;
    const ghi = dni * Math.sin((altitude * Math.PI) / 180) + diffuse;
    const got = deltaMrt({ altitude, sharp, dni, diffuse, ghi, albedo: 0.6 });
    assert.ok(Math.abs(got - expected) < 1e-6, `${altitude},${sharp}: ${got} vs ${expected}`);
  }
});

test("沒有太陽時 ΔMRT 為 0；各方位平均介於最小與最大之間", () => {
  assert.equal(deltaMrt({ altitude: -10, dni: 0, diffuse: 0, ghi: 0 }), 0);
  const base = { altitude: 30, dni: 700, diffuse: 120, ghi: 470 };
  const all = [0, 30, 60, 90, 120, 150, 180].map((sharp) => deltaMrt({ ...base, sharp }));
  const avg = deltaMrt(base);
  assert.ok(avg > Math.min(...all) && avg < Math.max(...all));
});

test("太陽高度角：台北夏至正午接近天頂、半夜在地平線下", () => {
  // 2026-06-21 12:00 台北（04:00Z）；當地太陽正午約 11:54
  const noon = solarAltitude(new Date("2026-06-21T04:00:00Z"), 25.12, 121.51);
  assert.ok(noon > 87 && noon <= 90, String(noon));
  const midnight = solarAltitude(new Date("2026-06-21T16:00:00Z"), 25.12, 121.51);
  assert.ok(midnight < -40, String(midnight));
  // 秋分附近早上 9 點：時角約 −41.5°，高度角約 42.7°
  const morning = solarAltitude(new Date("2026-09-23T01:00:00Z"), 25.12, 121.51);
  assert.ok(morning > 42 && morning < 43.5, String(morning));
});
