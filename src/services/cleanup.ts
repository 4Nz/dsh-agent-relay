import type { RelayStore } from "../storage/index.js";

export interface CleanupOptions {
  store: Pick<RelayStore, "cleanupHistory">;
  now?: () => number;
  intervalMs?: number;
  retentionDays?: number;
  onResult?: (result: ReturnType<RelayStore["cleanupHistory"]>) => void;
  onError?: (error: unknown) => void;
}

// 启动时清理一次，之后每天一次。清理是幂等的，进程内定时器即可，重启后重新开始计时。
export function startHistoryCleanup({
  store,
  now = Date.now,
  intervalMs = 86_400_000,
  retentionDays = 30,
  onResult,
  onError,
}: CleanupOptions): () => void {
  const run = () => {
    try {
      const result = store.cleanupHistory({ now: now(), retention_days: retentionDays });
      onResult?.(result);
    } catch (error) {
      onError?.(error);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
