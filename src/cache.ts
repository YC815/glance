// 每個資料來源各自快取：過期才重抓；抓失敗就繼續用上一筆成功的，並記下錯誤。
// 同時有好幾個請求進來時只抓一次。

export type Source<T> = {
  value: T | null;
  /** 上一次成功抓到的時間（epoch ms） */
  updatedAt: number | null;
  error: string | null;
};

export class CachedSource<T> {
  private state: Source<T> = { value: null, updatedAt: null, error: null };
  private lastAttempt = 0;
  private inflight: Promise<void> | null = null;

  private readonly ttlMs: number;
  private readonly load: () => Promise<T>;
  /** 失敗後多久可以再試，避免外部服務掛掉時每個請求都去打它 */
  private readonly retryMs: number;

  constructor(ttlMs: number, load: () => Promise<T>, retryMs = 60_000) {
    this.ttlMs = ttlMs;
    this.load = load;
    this.retryMs = retryMs;
  }

  async get(now = Date.now()): Promise<Source<T>> {
    const fresh = this.state.updatedAt !== null && now - this.state.updatedAt < this.ttlMs;
    const backingOff = this.state.error !== null && now - this.lastAttempt < this.retryMs;
    if (!fresh && !backingOff) {
      this.inflight ??= this.refresh(now).finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }
    return this.state;
  }

  private async refresh(now: number): Promise<void> {
    this.lastAttempt = now;
    try {
      const value = await this.load();
      this.state = { value, updatedAt: now, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[glance] 來源更新失敗：", message);
      this.state = { ...this.state, error: message };
    }
  }
}
