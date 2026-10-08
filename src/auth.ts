import { createHash, timingSafeEqual } from "node:crypto";

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** 檢查 Authorization: Bearer <金鑰>。沒設定金鑰時一律放行。 */
export function authorized(header: string | undefined, token: string | null): boolean {
  if (!token) return true;
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  // 先雜湊成等長再比，避免長度不同時 timingSafeEqual 丟錯、也不洩漏長度
  return !!m && timingSafeEqual(sha256(m[1]), sha256(token));
}
