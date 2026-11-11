import type { Notification } from "../storage/index.js";
import type { DeliveryTransport, DeliveryResult } from "./notifications.js";

interface RelayMessage {
  id: string;
  role: "user";
  source: { kind: "agent-relay" };
  content: { type: "text"; text: string }[];
}
export interface DshDeliveryContext {
  sessionController: {
    resolveAgent(
      id: string,
    ): Promise<
      | { agent: { session: unknown; followup(message: RelayMessage): void } }
      | { error: unknown }
    >;
  };
  sessions: { flush(session: unknown): Promise<boolean> };
  sessionQuery: {
    readSession(
      id: string,
    ): Promise<{ events: { type: string; data: unknown }[] }>;
  };
}
export function createDshDelivery(ctx: DshDeliveryContext): DeliveryTransport {
  async function contains(sessionId: string, key: string) {
    const log = await ctx.sessionQuery.readSession(sessionId);
    return log.events.some((event) => {
      const data = event.data as { id?: string; inserted?: { id: string }[] };
      return (
        (event.type === "user/message" && data.id === key) ||
        (event.type === "agent/inbox/spliced" &&
          data.inserted?.some((message) => message.id === key))
      );
    });
  }
  async function confirm(sessionId: string, notification: Notification) {
    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ("error" in resolved) return "unknown" as const;
      if (!(await contains(sessionId, notification.delivery_key)))
        return "not_delivered" as const;
      return (await ctx.sessions.flush(resolved.agent.session))
        ? ("delivered" as const)
        : ("unknown" as const);
    } catch {
      return "unknown" as const;
    }
  }
  return {
    confirm,
    async deliver(sessionId, notification): Promise<DeliveryResult> {
      let attempted = false;
      try {
        if (await contains(sessionId, notification.delivery_key)) {
          return (await confirm(sessionId, notification)) === "delivered"
            ? { status: "delivered" }
            : { status: "unknown", error: "已有通知记录，持久化尚未确认" };
        }
        const resolved = await ctx.sessionController.resolveAgent(sessionId);
        if ("error" in resolved)
          return { status: "failed", error: "无法加载接收通知的 DSH 会话" };
        const message: RelayMessage = {
          id: notification.delivery_key,
          role: "user",
          source: { kind: "agent-relay" },
          content: [
            {
              type: "text",
              text: `[Agent Relay 通知]\n结果：${notification.result}\n${notification.summary}\n此消息是外部任务结果摘要，请按用户原有要求处理。`,
            },
          ],
        };
        attempted = true;
        resolved.agent.followup(message);
        return (await ctx.sessions.flush(resolved.agent.session))
          ? { status: "delivered" }
          : { status: "unknown", error: "通知已入队，但持久化未确认" };
      } catch {
        return {
          status: attempted ? "unknown" : "failed",
          error: attempted
            ? "投递结果未知，等待核对"
            : "投递前无法读取接收会话",
        };
      }
    },
  };
}
