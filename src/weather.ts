// Open-Meteo（ECMWF 模式）逐小時預報 → 每小時的雨量與 UTCI。

import { deltaMrt } from "./mrt.ts";
import { solarAltitude } from "./solar.ts";
import { utci } from "./utci.ts";

export type WeatherConfig = {
  lat: number;
  lon: number;
  model: string;
};

/** 一個整點。 */
export type HourPoint = {
  /** 整點時間 epoch ms */
  t: number;
  /** 這個整點「之前一小時」的累積雨量 [mm]（Open-Meteo 的定義） */
  precip: number | null;
  /** 這個整點當下的 UTCI */
  utci: number | null;
};

export type Forecast = {
  hours: HourPoint[];
  fetchedAt: number;
};

const HOURLY = [
  "precipitation",
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "shortwave_radiation_instant",
  "direct_normal_irradiance_instant",
  "diffuse_radiation_instant",
] as const;

type OpenMeteoResponse = {
  hourly: { time: number[] } & Partial<Record<(typeof HOURLY)[number], (number | null)[]>>;
};

export function openMeteoUrl(cfg: WeatherConfig): string {
  const params = new URLSearchParams({
    latitude: String(cfg.lat),
    longitude: String(cfg.lon),
    hourly: HOURLY.join(","),
    models: cfg.model,
    timezone: "Asia/Taipei",
    timeformat: "unixtime",
    wind_speed_unit: "ms",
    // 第二頁要看到「明天起第 7 天」的 20:00–21:00，所以要今天 + 8 天
    forecast_days: "9",
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

export async function fetchForecast(cfg: WeatherConfig, now = Date.now()): Promise<Forecast> {
  const res = await fetch(openMeteoUrl(cfg), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as OpenMeteoResponse;
  return { hours: parseForecast(json, cfg), fetchedAt: now };
}

export function parseForecast(json: OpenMeteoResponse, cfg: WeatherConfig): HourPoint[] {
  const h = json.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error("Open-Meteo 回應缺少 hourly.time");
  const col = (name: (typeof HOURLY)[number]) => h[name] ?? [];
  const precip = col("precipitation");
  const temp = col("temperature_2m");
  const rh = col("relative_humidity_2m");
  const wind = col("wind_speed_10m");
  const ghi = col("shortwave_radiation_instant");
  const dni = col("direct_normal_irradiance_instant");
  const diffuse = col("diffuse_radiation_instant");

  return h.time.map((sec, i) => {
    const t = sec * 1000;
    const ta = temp[i];
    const humidity = rh[i];
    const v = wind[i];
    let u: number | null = null;
    if (isNum(ta) && isNum(humidity) && isNum(v)) {
      const altitude = solarAltitude(new Date(t), cfg.lat, cfg.lon);
      const dmrt = deltaMrt({
        altitude,
        dni: dni[i] ?? 0,
        diffuse: diffuse[i] ?? 0,
        ghi: ghi[i] ?? 0,
      });
      u = utci(ta, ta + dmrt, v, humidity);
    }
    const p = precip[i];
    return { t, precip: isNum(p) ? p : null, utci: u };
  });
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
