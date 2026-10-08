// Due Now 開發者 API（https://now.tschool.cc/developers）：
// GET /api/v1/assignments?status=pending，Bearer dn_… token（read 權限就夠）。
// API 回的是「沒勾完成、平台也還沒繳交」的作業清單，兩個數字在這邊自己數。
// 速率限制每人每分鐘 60 次；這邊平常 5 分鐘一次，加上手動點的，遠低於上限。

import { DAY_MS, startOfTaipeiDay } from "./time.ts";

export type HomeworkConfig = { baseUrl: string; token: string };

export type Homework = {
  /** 今天截止、還沒交、截止時間還沒過的份數：deadline ∈ (現在, 明天 00:00] */
  today: number;
  /** 今天、明天、後天這三個日曆天（台北時間）截止、還沒交、截止時間還沒過的份數，含今天：
   *  deadline ∈ (現在, 大後天 00:00] */
  within3Days: number;
};

export async function fetchHomework(cfg: HomeworkConfig, now = Date.now()): Promise<Homework> {
  const url = new URL("/api/v1/assignments?status=pending", cfg.baseUrl);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Due Now ${res.status}: ${await errorCode(res)}`);
  return countHomework(await res.json(), now);
}

/** Due Now 的錯誤格式是 { error: { code, message } }；只留 code，不把整包回應帶進 log。 */
async function errorCode(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { code?: unknown } };
    return typeof j.error?.code === "string" ? j.error.code : "unknown";
  } catch {
    return "unknown";
  }
}

export function countHomework(json: unknown, now: number): Homework {
  const list = (json as { assignments?: unknown })?.assignments;
  if (!Array.isArray(list)) throw new Error("Due Now 回應格式不對");

  const tomorrow = startOfTaipeiDay(now) + DAY_MS;
  const in3Days = tomorrow + 2 * DAY_MS;
  let today = 0;
  let within3Days = 0;
  for (const a of list as { deadline?: unknown; done?: unknown; submitted?: unknown }[]) {
    // 照理 status=pending 不會有這兩種，保險起見再擋一次
    if (a.done === true || a.submitted === true) continue;
    const deadline = typeof a.deadline === "string" ? Date.parse(a.deadline) : NaN;
    if (!Number.isFinite(deadline) || deadline <= now) continue;
    if (deadline <= tomorrow) today++;
    if (deadline <= in3Days) within3Days++;
  }
  return { today, within3Days };
}
