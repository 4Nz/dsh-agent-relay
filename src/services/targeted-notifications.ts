import type { RelayStore, Notification, Result } from "../storage/index.js";
import type { TargetedNotification } from "../storage/targeted-notifications.js";
import { DshTargetError, type createDshSessions, type DshTarget } from "./dsh-sessions.js";
import type { DeliveryTransport, DeliveryResult } from "./notifications.js";

type Input = Pick<TargetedNotification, "agent" | "external_session_id" | "request_id" | "summary"> & DshTarget & {result: string; external_ref?: string | null};
export function createTargetedNotifications({ store, sessions, transport, now }: {
  store: RelayStore["targetedNotifications"];
  sessions: ReturnType<typeof createDshSessions>;
  transport: DeliveryTransport & {idle(session: string): Promise<boolean>};
  now: () => number;
}) {
  function notice(n: TargetedNotification): Notification {
    return {id: n.request_id, subscription_id: "", source: "push", result: n.result,
      summary: n.summary, external_ref: n.external_ref, delivery_key: n.delivery_key,
      delivery_status: n.state, delivery_attempts: n.attempts, max_delivery_attempts: 3,
      next_attempt_at: n.retry_at, delivered_at: null, delivery_error: n.error, created_at: n.created_at};
  }
  return {
    async accept(input: Input) {
      const previous = store.get(input.request_id);
      if (previous && (previous.agent !== input.agent || previous.external_session_id !== input.external_session_id))
        throw new DshTargetError("request_conflict", "request_id 已绑定其他来源，请确认原请求");
      const session = await sessions.resolve(input);
      if (previous && (previous.dsh_session_id !== session || previous.summary !== input.summary ||
        previous.result !== input.result || previous.external_ref !== (input.external_ref ?? null)))
        throw new DshTargetError("request_conflict", "本次目标或消息与原请求不一致，请确认；重试必须保留原目标和内容，新的发送使用新的 request_id");
      if (!previous) store.insert({...input, result: input.result as Result, dsh_session_id: session, external_ref: input.external_ref ?? null}, now());
      return {accepted: true, duplicate: !!previous, subscription_id: null, dsh_session_id: session, targeted: true};
    },
    async drain() {
      for (const n of store.pending(now())) {
        try {
          if (n.state === "unknown") {
            const confirmed = await transport.confirm(n.dsh_session_id, notice(n));
            if (confirmed === "delivered") store.finish(n.request_id, "delivered", null);
            else if (confirmed === "not_delivered") store.finish(n.request_id, n.attempts < 3 ? "pending" : "failed", now() + 60000);
            continue;
          }
          // 已排队目标归档/删除或查询失败时保留原目标，不自动迁移。
          if (await sessions.status(n.dsh_session_id) !== "available" || !await transport.idle(n.dsh_session_id)) continue;
          if (!store.claim(n.request_id)) continue;
          let result: DeliveryResult;
          try { result = await transport.deliver(n.dsh_session_id, notice(n)); }
          catch { result = {status: "unknown", error: "投递结果未知，等待核对"}; }
          const retry = result.status === "failed" && n.attempts + 1 < 3;
          store.finish(n.request_id, retry ? "pending" : result.status,
            retry ? now() + 60000 * 2 ** n.attempts : null, result.error ?? null);
        } catch {
          // 查询失败不推断完成；仍由后续对账处理这条消息。
        }
      }
    },
  };
}
