import type { RelayStore } from "../storage/index.js";

export const NOTIFICATION_STATUS_PATH = "/api/agent-relay/notifications/status";

// 仅读取持久化投递事实；不 drain、不触发宿主查询、不修改关注或路由。
export function createNotificationStatusRoutes({ store, credentials }: {
  store: RelayStore;
  credentials: { verify(token: string): boolean };
}) {
  return { [NOTIFICATION_STATUS_PATH]: async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response("方法不支持", {status: 405});
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!credentials.verify(token)) return new Response("凭证无效", {status: 401});
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return new Response("需要 application/json", {status: 415});
    let input;
    try { input = await request.json(); } catch { return new Response("JSON 无效", {status: 400}); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "request_id") ||
      typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 1000)
      return new Response("查询仅接受原 request_id", {status: 400});
    const id = input.request_id;
    const targeted = store.targetedNotifications.get(id);
    if (targeted) return Response.json({request_id: id, targeted: true, agent: targeted.agent,
      external_session_id: targeted.external_session_id, dsh_session_id: targeted.dsh_session_id,
      delivery_status: targeted.state, attempts: targeted.attempts, retry_at: targeted.retry_at,
      created_at: targeted.created_at});
    const event = store.bridge.event(`push:${id}`);
    if (event) {
      const route = store.bridge.routeById(event.bridge_id);
      const batch = event.batch_id ? store.bridge.batch(event.batch_id) : null;
      return Response.json({request_id: id, targeted: false, agent: route?.agent ?? null,
        external_session_id: route?.external_session_id ?? null,
        dsh_session_id: batch?.dsh_session_id ?? route?.dsh_session_id ?? null,
        delivery_status: event.processed_at !== null ? "processed" : route?.muted ? "muted" : batch?.state ?? (event.batch_id ? "unknown" : "pending"),
        batch_id: event.batch_id, attempts: batch?.attempts ?? 0, retry_at: batch?.retry_at ?? null,
        processed_at: event.processed_at, created_at: event.created_at});
    }
    // 兼容会话桥梁之前按 request_id 创建的一次性 push。
    const subscription = store.subscriptions.get(`push:${id}`);
    const notice = subscription ? store.notifications.getBySubscription(subscription.id) : null;
    if (notice) return Response.json({request_id: id, targeted: false, agent: subscription!.agent,
      external_session_id: subscription!.external_session_id, dsh_session_id: subscription!.dsh_session_id,
      delivery_status: notice.delivery_status, attempts: notice.delivery_attempts,
      retry_at: notice.next_attempt_at, created_at: notice.created_at});
    return Response.json({error: "未找到原通知记录；可能尚未受理、记录已清理或旧通知没有 request_id，不代表已完成"}, {status: 404});
  }};
}
