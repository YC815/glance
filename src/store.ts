// 騎車頁要記住的東西存成一個 JSON 檔：每趟騎乘算好的數字、手填的 FTP、Strava 換發的 refresh token。
// 天氣、作業那些重開就重抓沒差，這些不行：CTL 要一年的歷史，重抓會撞到 Strava 的速率限制；
// refresh token 換發後舊的就失效。部署時 DATA_DIR 要指到會保留的磁碟（Railway volume）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FtpEntry, Ride } from "./training.ts";

export type RideData = {
  /** Strava 最新換發的 refresh token；沒有就用環境變數那把 */
  refreshToken: string | null;
  /** 上面那把是從哪一把環境變數換來的（雜湊）；環境變數換了就改用新的 */
  refreshTokenEnv: string | null;
  ftp: FtpEntry[];
  rides: Record<string, Ride>;
};

const EMPTY: RideData = { refreshToken: null, refreshTokenEnv: null, ftp: [], rides: {} };

export class RideStore {
  private readonly file: string;
  private data: RideData | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.file = join(dir, "rides.json");
  }

  async load(): Promise<RideData> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<RideData>;
      this.data = { ...EMPTY, ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = structuredClone(EMPTY);
    }
    return this.data;
  }

  /** 先寫暫存檔再改名，寫到一半當掉也不會留下壞掉的檔案。依序寫，不會互相蓋掉。 */
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data ?? EMPTY);
    // 上一次寫失敗不該卡住之後每一次
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
