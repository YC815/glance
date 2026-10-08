// 太陽高度角（NOAA 簡化公式，誤差約 0.1°，對估算平均輻射溫度綽綽有餘）。

const RAD = Math.PI / 180;

/** 太陽高度角 [deg]，地平線以下為負值。 */
export function solarAltitude(date: Date, lat: number, lon: number): number {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0; // J2000 起算的日數

  const meanLong = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const eclipticLong =
    (meanLong + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLong));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLong),
    Math.cos(eclipticLong),
  );

  // 格林威治平恆星時 → 當地時角
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const hourAngle = (gmst + lon) * RAD - rightAscension;

  const sinAlt =
    Math.sin(lat * RAD) * Math.sin(declination) +
    Math.cos(lat * RAD) * Math.cos(declination) * Math.cos(hourAngle);
  return Math.asin(sinAlt) / RAD;
}
