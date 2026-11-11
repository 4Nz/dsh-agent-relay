import { randomUUID } from "node:crypto";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { SessionCursor, Snapshot } from "../adapters/types.js";
import type {
  RelayStore,
  Json,
  Result,
  Subscription,
} from "../storage/index.js";
import type { Scheduler } from "./scheduler.js";

export function cursor(value: Json): SessionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.uuid === "string" && typeof value.timestamp === "number"
    ? { uuid: value.uuid, timestamp: value.timestamp }
    : null;
}
function observed(value: Json) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "observed" in value
    ? cursor(value.observed)
    : cursor(value);
}
export function createCheckService({
  store,
  adapters,
  scheduler,
  now = Date.now,
}: {
  store: RelayStore;
  adapters: AdapterRegistry;
  scheduler: Pick<Scheduler, "delete">;
  now?: () => number;
}) {
  const running = new Set<string>();
  async function finish(
    sub: Subscription,
    result: Result,
    summary: string,
    external_ref: string | null = null,
  ) {
    const recorded = store.notifications.record({
      notification: {
        id: randomUUID(),
        subscription_id: sub.id,
        source: sub.type,
        result,
        summary:
          `${sub.external_session_title ?? sub.external_session_id}（${sub.agent}/${sub.external_session_id}）：${summary}`.slice(
            0,
            4000,
          ),
        external_ref,
      },
      now: now(),
    });
    if (
      recorded.outcome === "created" &&
      sub.type === "poll" &&
      sub.schedule_task_id &&
      sub.dsh_session_id
    ) {
      try {
        await scheduler.delete({
          sessionId: sub.dsh_session_id,
          id: sub.schedule_task_id,
        });
      } catch {
        /* 启动或后续对账清理。 */
      }
    }
    return {
      status: recorded.outcome === "inactive" ? "inactive" : "notified",
    };
  }
  return {
    async check(id: string): Promise<{ status: string }> {
      if (running.has(id)) return { status: "running" };
      running.add(id);
      try {
        let sub = store.subscriptions.get(id);
        if (!sub) return { status: "not_found" };
        if (sub.status !== "active") return { status: "inactive" };
        if (now() >= sub.hard_expires_at)
          return await finish(sub, "expired", "已达到最长订阅时间");
        if (now() < sub.expires_at) return { status: "not_due" };
        let snap: Snapshot;
        try {
          snap = await adapters
            .get(sub.agent)
            .snapshot(sub.external_session_id, cursor(sub.cursor));
          if (snap.check_error) throw new Error(snap.check_error);
        } catch (error) {
          sub = store.subscriptions.get(id)!;
          if (!sub || sub.status !== "active" || now() < sub.expires_at)
            return { status: "inactive" };
          const failures = sub.consecutive_failures + 1;
          const reason = error instanceof Error ? error.message : String(error);
          store.subscriptions.update({
            id,
            expected_status: "active",
            patch: {
              last_checked_at: now(),
              last_check_status: "error",
              last_check_error: reason.slice(0, 1000),
              consecutive_failures: failures,
              expires_at: Math.min(
                now() + sub.idle_timeout_seconds * 1000,
                sub.hard_expires_at,
              ),
              updated_at: now(),
            },
          });
          if (now() >= sub.hard_expires_at)
            return await finish(sub, "expired", "已达到最长订阅时间");
          return failures >= sub.max_consecutive_failures
            ? await finish(sub, "unreachable", `连续检查失败：${reason}`)
            : { status: "check_failed" };
        }
        // 外部查询期间可能发生停止、暂停或人工查阅，重新检查有效期。
        sub = store.subscriptions.get(id)!;
        if (!sub || sub.status !== "active") return { status: "inactive" };
        if (now() >= sub.hard_expires_at)
          return await finish(sub, "expired", "已达到最长订阅时间");
        if (now() < sub.expires_at) return { status: "not_due" };
        const time = now();
        store.subscriptions.update({
          id,
          expected_status: "active",
          patch: {
            last_checked_at: time,
            last_check_status: "success",
            last_check_error: null,
            consecutive_failures: 0,
            updated_at: time,
          },
        });
        if (snap.closed)
          return await finish(sub, "session_closed", "外部会话已归档或删除");
        const previous = observed(sub.cursor);
        const changed =
          snap.cursor !== null &&
          (previous?.uuid !== snap.cursor.uuid ||
            previous?.timestamp !== snap.cursor.timestamp);
        if (snap.runtime === "busy" || changed) {
          // 保留订阅原始基线供 Adapter 判定轮次，同时单独保存最近观察位置。
          const base = cursor(sub.cursor);
          store.subscriptions.update({
            id,
            expected_status: "active",
            patch: {
              cursor: {
                ...(base ?? {}),
                observed: snap.cursor ? { ...snap.cursor } : null,
              },
              last_activity_at: snap.last_activity_at,
              expires_at: Math.min(
                time + sub.idle_timeout_seconds * 1000,
                sub.hard_expires_at,
              ),
              updated_at: time,
            },
          });
          return { status: "extended" };
        }
        return await finish(
          sub,
          snap.finished_turn?.result ?? "idle_timeout",
          snap.last_reply?.slice(0, 3000) ||
            "到期未发现新消息，无法确认任务完成",
          snap.finished_turn?.external_ref ?? null,
        );
      } finally {
        running.delete(id);
      }
    },
  };
}
export type CheckService = ReturnType<typeof createCheckService>;
