import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RelayStore } from "../storage/index.js";

export interface CleanupOptions {
  store: Pick<RelayStore, "cleanupHistory">;
  dataDir?: string;
  now?: () => number;
  intervalMs?: number;
  retentionDays?: number;
  onResult?: (result: ReturnType<RelayStore["cleanupHistory"]>) => void;
  onError?: (error: unknown) => void;
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "needs_attention"]);

// 仅清理超过保留期且已处于终态的后台接力记录与可见终端启动目录，保留运行中/未知记录以维持防重与排障。
export function cleanupBackgroundRecords(dataDir: string, cutoff: number): number {
  let removed = 0;
  const jobsRoot = join(dataDir, "background-jobs");
  if (existsSync(jobsRoot)) {
    for (const agentEntry of readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const agentDir = join(jobsRoot, agentEntry.name);
      for (const jobEntry of readdirSync(agentDir, { withFileTypes: true })) {
        if (!jobEntry.isDirectory()) continue;
        const jobDir = join(agentDir, jobEntry.name);
        try {
          const state = JSON.parse(readFileSync(join(jobDir, "state.json"), "utf8")) as {
            status?: unknown;
            finished_at?: unknown;
            updated_at?: unknown;
          };
          if (typeof state.status !== "string" || !TERMINAL_JOB_STATUSES.has(state.status)) continue;
          const timestamp =
            typeof state.finished_at === "number"
              ? state.finished_at
              : typeof state.updated_at === "number"
                ? state.updated_at
                : null;
          if (timestamp !== null && timestamp <= cutoff) {
            rmSync(jobDir, { recursive: true, force: true });
            removed++;
          }
        } catch {
          /* 记录缺失或格式异常时保留现场，不贸然删除。 */
        }
      }
    }
  }
  const launchesRoot = join(dataDir, "visible-launches");
  if (existsSync(launchesRoot)) {
    for (const entry of readdirSync(launchesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const launchDir = join(launchesRoot, entry.name);
      try {
        const record = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8")) as {
          status?: unknown;
        };
        if (record.status !== "opened") continue;
        const info = statSync(join(launchDir, "launch.json"));
        if (info.mtimeMs <= cutoff) {
          rmSync(launchDir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* 保留未知状态目录。 */
      }
    }
  }
  return removed;
}

// 启动时清理一次，之后每天一次。清理是幂等的，进程内定时器即可，重启后重新开始计时。
export function startHistoryCleanup({
  store,
  dataDir,
  now = Date.now,
  intervalMs = 86_400_000,
  retentionDays = 30,
  onResult,
  onError,
}: CleanupOptions): () => void {
  const run = () => {
    try {
      const current = now();
      const result = store.cleanupHistory({ now: current, retention_days: retentionDays });
      if (dataDir) {
        try {
          cleanupBackgroundRecords(dataDir, current - retentionDays * 86_400_000);
        } catch (error) {
          onError?.(error);
        }
      }
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
