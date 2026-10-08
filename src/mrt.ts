// 用日射量估算戶外的平均輻射溫度（MRT）。
//
// 做法是 ASHRAE 55 的 SolarCal（pythermalcomfort 的 models/solar_gain.py）：
// 算出太陽短波輻射讓人體多吸收的能量（ERF），換算成「MRT 要比沒有太陽時高多少」（ΔMRT），
// 再假設沒有太陽時 MRT ≈ 氣溫，所以 MRT = 氣溫 + ΔMRT。
//
// 跟 SolarCal 原版不一樣的地方（原版是給室內窗邊用的）：
// - 散射與直射分開用 Open-Meteo 給的實際值，不用「散射 = 0.2 × 直射」的假設。
// - 人站在室外：天空可視比例、身體曬到的比例、穿透率都是 1。
// - 地面反射率用 0.2（柏油、水泥），不是室內地板的 0.6。
// - 不知道人面向哪裡，投影面積係數取各方位的平均。
// 夜間與陰天的長波輻射（天空比氣溫冷）沒有算進去，所以晴朗夜晚會略為高估。

const ALT_RANGE = [0, 15, 30, 45, 60, 75, 90];
const AZ_RANGE = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180];

// 站姿的投影面積係數 fp，列 = SHARP（太陽相對於人正面的水平角），欄 = 太陽高度角。
const FP_STANDING = [
  [0.35, 0.35, 0.314, 0.258, 0.206, 0.144, 0.082],
  [0.342, 0.342, 0.31, 0.252, 0.2, 0.14, 0.082],
  [0.33, 0.33, 0.3, 0.244, 0.19, 0.132, 0.082],
  [0.31, 0.31, 0.275, 0.228, 0.175, 0.124, 0.082],
  [0.283, 0.283, 0.251, 0.208, 0.16, 0.114, 0.082],
  [0.252, 0.252, 0.228, 0.188, 0.15, 0.108, 0.082],
  [0.23, 0.23, 0.214, 0.18, 0.148, 0.108, 0.082],
  [0.242, 0.242, 0.222, 0.18, 0.153, 0.112, 0.082],
  [0.274, 0.274, 0.245, 0.203, 0.165, 0.116, 0.082],
  [0.304, 0.304, 0.27, 0.22, 0.174, 0.121, 0.082],
  [0.328, 0.328, 0.29, 0.234, 0.183, 0.125, 0.082],
  [0.344, 0.344, 0.304, 0.244, 0.19, 0.128, 0.082],
  [0.347, 0.347, 0.308, 0.246, 0.191, 0.128, 0.082],
];

const F_EFF = 0.725; // 站姿：身體表面參與輻射交換的比例
const HR = 6; // 輻射熱傳係數 [W/m²K]
const LW_ABS = 0.95;

function span(range: number[], x: number): number {
  for (let i = 0; i < range.length - 2; i++) if (x <= range[i + 1]) return i;
  return range.length - 2;
}

/** 某個方位列在給定高度角的 fp（沿高度角線性內插）。 */
function fpAtRow(row: number[], altitude: number): number {
  const i = span(ALT_RANGE, altitude);
  const t = (altitude - ALT_RANGE[i]) / (ALT_RANGE[i + 1] - ALT_RANGE[i]);
  return row[i] + (row[i + 1] - row[i]) * t;
}

function projectedAreaFactor(altitude: number, sharp?: number): number {
  const alt = Math.min(90, Math.max(0, altitude));
  if (sharp === undefined) {
    // 各方位平均（梯形法，兩端各算半格）
    let sum = 0;
    FP_STANDING.forEach((row, i) => {
      const w = i === 0 || i === FP_STANDING.length - 1 ? 0.5 : 1;
      sum += w * fpAtRow(row, alt);
    });
    return sum / (FP_STANDING.length - 1);
  }
  const s = Math.min(180, Math.max(0, sharp));
  const j = span(AZ_RANGE, s);
  const t = (s - AZ_RANGE[j]) / (AZ_RANGE[j + 1] - AZ_RANGE[j]);
  const a = fpAtRow(FP_STANDING[j], alt);
  const b = fpAtRow(FP_STANDING[j + 1], alt);
  return a + (b - a) * t;
}

export type SolarInput = {
  /** 太陽高度角 [deg] */
  altitude: number;
  /** 法向直射輻射 DNI [W/m²] */
  dni: number;
  /** 水平面散射輻射 [W/m²] */
  diffuse: number;
  /** 水平面全天輻射 GHI [W/m²] */
  ghi: number;
  /** 太陽相對於人正面的水平角；省略 = 各方位平均 */
  sharp?: number;
  /** 地面反射率 */
  albedo?: number;
  /** 人體短波吸收率 */
  asw?: number;
};

/** 太陽讓平均輻射溫度升高多少 [K]。 */
export function deltaMrt(input: SolarInput): number {
  const { altitude, sharp, albedo = 0.2, asw = 0.7 } = input;
  const dni = altitude > 0 ? Math.max(0, input.dni) : 0;
  const diffuse = Math.max(0, input.diffuse);
  const ghi = Math.max(0, input.ghi);

  const eDiffuse = F_EFF * 0.5 * diffuse;
  const eDirect = F_EFF * projectedAreaFactor(altitude, sharp) * dni;
  const eReflected = F_EFF * 0.5 * ghi * albedo;
  const erf = (eDiffuse + eDirect + eReflected) * (asw / LW_ABS);
  return erf / (HR * F_EFF);
}
