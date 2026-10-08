// UTCI（通用熱氣候指數）。多項式與飽和水氣壓公式照抄 pythermalcomfort 4.6.1 的 models/utci.py
// （Bröde et al. 2012 的六階近似），用 test/utci.test.ts 對照 Python 算出來的值。
//
// 輸入超出模型適用範圍時 pythermalcomfort 回 NaN；看板寧可顯示一個近似值，所以改成夾在範圍內：
// 風速 0.5–17 m/s、平均輻射溫度 = 氣溫 −30 ～ +70。

/** 飽和水氣壓 [hPa]。 */
function saturationVaporPressure(tdb: number): number {
  const g = [
    -2836.5744, -6028.076559, 19.54263612, -0.02737830188, 0.000016261698, 7.0229056e-10,
    -1.8680009e-13,
  ];
  const tk = tdb + 273.15;
  let es = 2.7150305 * Math.log(tk);
  g.forEach((c, i) => {
    es += c * Math.pow(tk, i - 2);
  });
  return Math.exp(es) * 0.01;
}

/**
 * @param tdb 氣溫 [°C]
 * @param tr 平均輻射溫度 [°C]
 * @param v 離地 10 公尺風速 [m/s]
 * @param rh 相對濕度 [%]
 */
export function utci(tdb: number, tr: number, v: number, rh: number): number {
  v = Math.min(17, Math.max(0.5, v));
  tr = Math.min(tdb + 70, Math.max(tdb - 30, tr));
  const pa = (saturationVaporPressure(tdb) * (rh / 100)) / 10; // kPa
  return polynomial(tdb, v, tr - tdb, pa);
}

export type HeatStress = { level: 0 | 1 | 2 | 3; label: string };

/** 熱壓力分級（UTCI 官方分級，只取熱的那一側；看板不需要冷壓力）。 */
export function heatStress(value: number): HeatStress {
  if (value >= 38) return { level: 3, label: "非常強熱壓力" };
  if (value >= 32) return { level: 2, label: "強熱壓力" };
  if (value >= 26) return { level: 1, label: "中度熱壓力" };
  return { level: 0, label: "無熱壓力" };
}

function polynomial(tdb: number, v: number, dtr: number, pa: number): number {
  return (
    tdb
    + 0.607562052
    + -0.0227712343 * tdb
    + 8.06470249e-4 * tdb * tdb
    + -1.54271372e-4 * tdb * tdb * tdb
    + -3.24651735e-6 * tdb * tdb * tdb * tdb
    + 7.32602852e-8 * tdb * tdb * tdb * tdb * tdb
    + 1.35959073e-9 * tdb * tdb * tdb * tdb * tdb * tdb
    + -2.25836520 * v
    + 0.0880326035 * tdb * v
    + 0.00216844454 * tdb * tdb * v
    + -1.53347087e-5 * tdb * tdb * tdb * v
    + -5.72983704e-7 * tdb * tdb * tdb * tdb * v
    + -2.55090145e-9 * tdb * tdb * tdb * tdb * tdb * v
    + -0.751269505 * v * v
    + -0.00408350271 * tdb * v * v
    + -5.21670675e-5 * tdb * tdb * v * v
    + 1.94544667e-6 * tdb * tdb * tdb * v * v
    + 1.14099531e-8 * tdb * tdb * tdb * tdb * v * v
    + 0.158137256 * v * v * v
    + -6.57263143e-5 * tdb * v * v * v
    + 2.22697524e-7 * tdb * tdb * v * v * v
    + -4.16117031e-8 * tdb * tdb * tdb * v * v * v
    + -0.0127762753 * v * v * v * v
    + 9.66891875e-6 * tdb * v * v * v * v
    + 2.52785852e-9 * tdb * tdb * v * v * v * v
    + 4.56306672e-4 * v * v * v * v * v
    + -1.74202546e-7 * tdb * v * v * v * v * v
    + -5.91491269e-6 * v * v * v * v * v * v
    + 0.398374029 * dtr
    + 1.83945314e-4 * tdb * dtr
    + -1.73754510e-4 * tdb * tdb * dtr
    + -7.60781159e-7 * tdb * tdb * tdb * dtr
    + 3.77830287e-8 * tdb * tdb * tdb * tdb * dtr
    + 5.43079673e-10 * tdb * tdb * tdb * tdb * tdb * dtr
    + -0.0200518269 * v * dtr
    + 8.92859837e-4 * tdb * v * dtr
    + 3.45433048e-6 * tdb * tdb * v * dtr
    + -3.77925774e-7 * tdb * tdb * tdb * v * dtr
    + -1.69699377e-9 * tdb * tdb * tdb * tdb * v * dtr
    + 1.69992415e-4 * v * v * dtr
    + -4.99204314e-5 * tdb * v * v * dtr
    + 2.47417178e-7 * tdb * tdb * v * v * dtr
    + 1.07596466e-8 * tdb * tdb * tdb * v * v * dtr
    + 8.49242932e-5 * v * v * v * dtr
    + 1.35191328e-6 * tdb * v * v * v * dtr
    + -6.21531254e-9 * tdb * tdb * v * v * v * dtr
    + -4.99410301e-6 * v * v * v * v * dtr
    + -1.89489258e-8 * tdb * v * v * v * v * dtr
    + 8.15300114e-8 * v * v * v * v * v * dtr
    + 7.55043090e-4 * dtr * dtr
    + -5.65095215e-5 * tdb * dtr * dtr
    + -4.52166564e-7 * tdb * tdb * dtr * dtr
    + 2.46688878e-8 * tdb * tdb * tdb * dtr * dtr
    + 2.42674348e-10 * tdb * tdb * tdb * tdb * dtr * dtr
    + 1.54547250e-4 * v * dtr * dtr
    + 5.24110970e-6 * tdb * v * dtr * dtr
    + -8.75874982e-8 * tdb * tdb * v * dtr * dtr
    + -1.50743064e-9 * tdb * tdb * tdb * v * dtr * dtr
    + -1.56236307e-5 * v * v * dtr * dtr
    + -1.33895614e-7 * tdb * v * v * dtr * dtr
    + 2.49709824e-9 * tdb * tdb * v * v * dtr * dtr
    + 6.51711721e-7 * v * v * v * dtr * dtr
    + 1.94960053e-9 * tdb * v * v * v * dtr * dtr
    + -1.00361113e-8 * v * v * v * v * dtr * dtr
    + -1.21206673e-5 * dtr * dtr * dtr
    + -2.18203660e-7 * tdb * dtr * dtr * dtr
    + 7.51269482e-9 * tdb * tdb * dtr * dtr * dtr
    + 9.79063848e-11
    * tdb
    * tdb
    * tdb
    * dtr
    * dtr
    * dtr
    + 1.25006734e-6 * v * dtr * dtr * dtr
    + -1.81584736e-9 * tdb * v * dtr * dtr * dtr
    + -3.52197671e-10
    * tdb
    * tdb
    * v
    * dtr
    * dtr
    * dtr
    + -3.36514630e-8 * v * v * dtr * dtr * dtr
    + 1.35908359e-10
    * tdb
    * v
    * v
    * dtr
    * dtr
    * dtr
    + 4.17032620e-10
    * v
    * v
    * v
    * dtr
    * dtr
    * dtr
    + -1.30369025e-9
    * dtr
    * dtr
    * dtr
    * dtr
    + 4.13908461e-10
    * tdb
    * dtr
    * dtr
    * dtr
    * dtr
    + 9.22652254e-12
    * tdb
    * tdb
    * dtr
    * dtr
    * dtr
    * dtr
    + -5.08220384e-9
    * v
    * dtr
    * dtr
    * dtr
    * dtr
    + -2.24730961e-11
    * tdb
    * v
    * dtr
    * dtr
    * dtr
    * dtr
    + 1.17139133e-10
    * v
    * v
    * dtr
    * dtr
    * dtr
    * dtr
    + 6.62154879e-10
    * dtr
    * dtr
    * dtr
    * dtr
    * dtr
    + 4.03863260e-13
    * tdb
    * dtr
    * dtr
    * dtr
    * dtr
    * dtr
    + 1.95087203e-12
    * v
    * dtr
    * dtr
    * dtr
    * dtr
    * dtr
    + -4.73602469e-12
    * dtr
    * dtr
    * dtr
    * dtr
    * dtr
    * dtr
    + 5.12733497 * pa
    + -0.312788561 * tdb * pa
    + -0.0196701861 * tdb * tdb * pa
    + 9.99690870e-4 * tdb * tdb * tdb * pa
    + 9.51738512e-6 * tdb * tdb * tdb * tdb * pa
    + -4.66426341e-7 * tdb * tdb * tdb * tdb * tdb * pa
    + 0.548050612 * v * pa
    + -0.00330552823 * tdb * v * pa
    + -0.00164119440 * tdb * tdb * v * pa
    + -5.16670694e-6 * tdb * tdb * tdb * v * pa
    + 9.52692432e-7 * tdb * tdb * tdb * tdb * v * pa
    + -0.0429223622 * v * v * pa
    + 0.00500845667 * tdb * v * v * pa
    + 1.00601257e-6 * tdb * tdb * v * v * pa
    + -1.81748644e-6 * tdb * tdb * tdb * v * v * pa
    + -1.25813502e-3 * v * v * v * pa
    + -1.79330391e-4 * tdb * v * v * v * pa
    + 2.34994441e-6 * tdb * tdb * v * v * v * pa
    + 1.29735808e-4 * v * v * v * v * pa
    + 1.29064870e-6 * tdb * v * v * v * v * pa
    + -2.28558686e-6 * v * v * v * v * v * pa
    + -0.0369476348 * dtr * pa
    + 0.00162325322 * tdb * dtr * pa
    + -3.14279680e-5 * tdb * tdb * dtr * pa
    + 2.59835559e-6 * tdb * tdb * tdb * dtr * pa
    + -4.77136523e-8 * tdb * tdb * tdb * tdb * dtr * pa
    + 8.64203390e-3 * v * dtr * pa
    + -6.87405181e-4 * tdb * v * dtr * pa
    + -9.13863872e-6 * tdb * tdb * v * dtr * pa
    + 5.15916806e-7 * tdb * tdb * tdb * v * dtr * pa
    + -3.59217476e-5 * v * v * dtr * pa
    + 3.28696511e-5 * tdb * v * v * dtr * pa
    + -7.10542454e-7 * tdb * tdb * v * v * dtr * pa
    + -1.24382300e-5 * v * v * v * dtr * pa
    + -7.38584400e-9 * tdb * v * v * v * dtr * pa
    + 2.20609296e-7 * v * v * v * v * dtr * pa
    + -7.32469180e-4 * dtr * dtr * pa
    + -1.87381964e-5 * tdb * dtr * dtr * pa
    + 4.80925239e-6 * tdb * tdb * dtr * dtr * pa
    + -8.75492040e-8 * tdb * tdb * tdb * dtr * dtr * pa
    + 2.77862930e-5 * v * dtr * dtr * pa
    + -5.06004592e-6 * tdb * v * dtr * dtr * pa
    + 1.14325367e-7 * tdb * tdb * v * dtr * dtr * pa
    + 2.53016723e-6 * v * v * dtr * dtr * pa
    + -1.72857035e-8 * tdb * v * v * dtr * dtr * pa
    + -3.95079398e-8 * v * v * v * dtr * dtr * pa
    + -3.59413173e-7 * dtr * dtr * dtr * pa
    + 7.04388046e-7 * tdb * dtr * dtr * dtr * pa
    + -1.89309167e-8
    * tdb
    * tdb
    * dtr
    * dtr
    * dtr
    * pa
    + -4.79768731e-7 * v * dtr * dtr * dtr * pa
    + 7.96079978e-9
    * tdb
    * v
    * dtr
    * dtr
    * dtr
    * pa
    + 1.62897058e-9
    * v
    * v
    * dtr
    * dtr
    * dtr
    * pa
    + 3.94367674e-8
    * dtr
    * dtr
    * dtr
    * dtr
    * pa
    + -1.18566247e-9
    * tdb
    * dtr
    * dtr
    * dtr
    * dtr
    * pa
    + 3.34678041e-10
    * v
    * dtr
    * dtr
    * dtr
    * dtr
    * pa
    + -1.15606447e-10
    * dtr
    * dtr
    * dtr
    * dtr
    * dtr
    * pa
    + -2.80626406 * pa * pa
    + 0.548712484 * tdb * pa * pa
    + -0.00399428410 * tdb * tdb * pa * pa
    + -9.54009191e-4 * tdb * tdb * tdb * pa * pa
    + 1.93090978e-5 * tdb * tdb * tdb * tdb * pa * pa
    + -0.308806365 * v * pa * pa
    + 0.0116952364 * tdb * v * pa * pa
    + 4.95271903e-4 * tdb * tdb * v * pa * pa
    + -1.90710882e-5 * tdb * tdb * tdb * v * pa * pa
    + 0.00210787756 * v * v * pa * pa
    + -6.98445738e-4 * tdb * v * v * pa * pa
    + 2.30109073e-5 * tdb * tdb * v * v * pa * pa
    + 4.17856590e-4 * v * v * v * pa * pa
    + -1.27043871e-5 * tdb * v * v * v * pa * pa
    + -3.04620472e-6 * v * v * v * v * pa * pa
    + 0.0514507424 * dtr * pa * pa
    + -0.00432510997 * tdb * dtr * pa * pa
    + 8.99281156e-5 * tdb * tdb * dtr * pa * pa
    + -7.14663943e-7 * tdb * tdb * tdb * dtr * pa * pa
    + -2.66016305e-4 * v * dtr * pa * pa
    + 2.63789586e-4 * tdb * v * dtr * pa * pa
    + -7.01199003e-6 * tdb * tdb * v * dtr * pa * pa
    + -1.06823306e-4 * v * v * dtr * pa * pa
    + 3.61341136e-6 * tdb * v * v * dtr * pa * pa
    + 2.29748967e-7 * v * v * v * dtr * pa * pa
    + 3.04788893e-4 * dtr * dtr * pa * pa
    + -6.42070836e-5 * tdb * dtr * dtr * pa * pa
    + 1.16257971e-6 * tdb * tdb * dtr * dtr * pa * pa
    + 7.68023384e-6 * v * dtr * dtr * pa * pa
    + -5.47446896e-7 * tdb * v * dtr * dtr * pa * pa
    + -3.59937910e-8 * v * v * dtr * dtr * pa * pa
    + -4.36497725e-6 * dtr * dtr * dtr * pa * pa
    + 1.68737969e-7
    * tdb
    * dtr
    * dtr
    * dtr
    * pa
    * pa
    + 2.67489271e-8
    * v
    * dtr
    * dtr
    * dtr
    * pa
    * pa
    + 3.23926897e-9
    * dtr
    * dtr
    * dtr
    * dtr
    * pa
    * pa
    + -0.0353874123 * pa * pa * pa
    + -0.221201190 * tdb * pa * pa * pa
    + 0.0155126038 * tdb * tdb * pa * pa * pa
    + -2.63917279e-4 * tdb * tdb * tdb * pa * pa * pa
    + 0.0453433455 * v * pa * pa * pa
    + -0.00432943862 * tdb * v * pa * pa * pa
    + 1.45389826e-4 * tdb * tdb * v * pa * pa * pa
    + 2.17508610e-4 * v * v * pa * pa * pa
    + -6.66724702e-5 * tdb * v * v * pa * pa * pa
    + 3.33217140e-5 * v * v * v * pa * pa * pa
    + -0.00226921615 * dtr * pa * pa * pa
    + 3.80261982e-4 * tdb * dtr * pa * pa * pa
    + -5.45314314e-9 * tdb * tdb * dtr * pa * pa * pa
    + -7.96355448e-4 * v * dtr * pa * pa * pa
    + 2.53458034e-5 * tdb * v * dtr * pa * pa * pa
    + -6.31223658e-6 * v * v * dtr * pa * pa * pa
    + 3.02122035e-4 * dtr * dtr * pa * pa * pa
    + -4.77403547e-6 * tdb * dtr * dtr * pa * pa * pa
    + 1.73825715e-6 * v * dtr * dtr * pa * pa * pa
    + -4.09087898e-7
    * dtr
    * dtr
    * dtr
    * pa
    * pa
    * pa
    + 0.614155345 * pa * pa * pa * pa
    + -0.0616755931 * tdb * pa * pa * pa * pa
    + 0.00133374846 * tdb * tdb * pa * pa * pa * pa
    + 0.00355375387 * v * pa * pa * pa * pa
    + -5.13027851e-4 * tdb * v * pa * pa * pa * pa
    + 1.02449757e-4 * v * v * pa * pa * pa * pa
    + -0.00148526421 * dtr * pa * pa * pa * pa
    + -4.11469183e-5 * tdb * dtr * pa * pa * pa * pa
    + -6.80434415e-6 * v * dtr * pa * pa * pa * pa
    + -9.77675906e-6 * dtr * dtr * pa * pa * pa * pa
    + 0.0882773108 * pa * pa * pa * pa * pa
    + -0.00301859306 * tdb * pa * pa * pa * pa * pa
    + 0.00104452989 * v * pa * pa * pa * pa * pa
    + 2.47090539e-4 * dtr * pa * pa * pa * pa * pa
    + 0.00148348065 * pa * pa * pa * pa * pa * pa
  );
}
