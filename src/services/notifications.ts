import type { RelayStore, Notification } from "../storage/index.js";
export type DeliveryResult = {
  status: "delivered" | "failed" | "unknown";
  error?: string;
};
export interface DeliveryTransport {
  deliver(
    sessionId: string,
    notification: Notification,
  ): Promise<DeliveryResult>;
  confirm(
    sessionId: string,
    notification: Notification,
  ): Promise<"delivered" | "not_delivered" | "unknown">;
}
export function createNotificationService({
  store,
  transport,
  now = Date.now,
}: {
  store: RelayStore;
  transport: DeliveryTransport;
  now?: () => number;
}) {
  let running: Promise<void> | undefined;
  async function run() {
    for (const notification of store.notifications.listUnknown()) {
      const sub = store.subscriptions.get(notification.subscription_id);
      const session = sub?.dsh_session_id;
      if (!session) continue;
      try {
        const confirmation = await transport.confirm(session, notification);
        if (confirmation !== "unknown") {
          // 确认未送达时，已停止/过期订阅不得重新进入重试队列，保持不再调度。
          const stoppedOrExpired =
            sub?.end_reason === "user_stopped" ||
            (sub?.type === "push" && (sub?.hard_expires_at ?? 0) <= now());
          store.notifications.reconcileUnknown({
            id: notification.id,
            confirmation,
            now: now(),
            next_attempt_at:
              confirmation === "not_delivered" && !stoppedOrExpired
                ? now() + 60000
                : null,
          });
        }
      } catch {
        /* 无法核对时保持未知。 */
      }
    }
    // 每轮最多 100 条，剩余通知由下轮驱动处理。
    for (const notification of store.notifications.listDue({
      now: now(),
      limit: 100,
    })) {
      const session = store.subscriptions.get(
        notification.subscription_id,
      )?.dsh_session_id;
      if (!store.notifications.claim({ id: notification.id, now: now() }))
        continue;
      let result: DeliveryResult;
      if (!session)
        result = { status: "failed", error: "缺少接收通知的 DSH 会话" };
      else {
        try {
          result = await transport.deliver(session, notification);
        } catch {
          result = {
            status: "unknown",
            error: "投递异常，需核对是否已进入会话",
          };
        }
      }
      store.notifications.finish({
        id: notification.id,
        status: result.status,
        now: now(),
        error: result.error ?? null,
        next_attempt_at:
          result.status === "failed"
            ? now() + 60000 * 2 ** notification.delivery_attempts
            : null,
      });
    }
  }
  return {
    drain() {
      if (!running)
        running = run().finally(() => {
          running = undefined;
        });
      return running;
    },
  };
}
export type NotificationService = ReturnType<typeof createNotificationService>;
