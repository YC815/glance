// 「該交了」（due-now）的唯讀統計 API：GET /api/glance，Bearer 金鑰。

export type HomeworkConfig = { baseUrl: string; key: string };

export type Homework = {
  /** 今天截止、還沒交（截止時間還沒過）的份數 */
  today: number;
  /** 三天內（今天、明天、後天）截止、還沒交的份數，含今天 */
  within3Days: number;
};

export async function fetchHomework(cfg: HomeworkConfig): Promise<Homework> {
  const res = await fetch(new URL("/api/glance", cfg.baseUrl), {
    headers: { authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`due-now ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseHomework(await res.json());
}

export function parseHomework(json: unknown): Homework {
  const j = json as { dueToday?: unknown; dueIn3Days?: unknown };
  if (!Number.isInteger(j?.dueToday) || !Number.isInteger(j?.dueIn3Days)) {
    throw new Error("due-now 回應格式不對");
  }
  return { today: j.dueToday as number, within3Days: j.dueIn3Days as number };
}
