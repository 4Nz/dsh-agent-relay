import type { RelayService } from "./relay.js";
import type { Message } from "../storage/types.js";

export const MESSAGE_PATH = "/api/agent-relay/messages";
export const MESSAGE_STATUS_PATH = "/api/agent-relay/messages/status";

// 外部 Skill 的薄入口：共用本机通知凭证，只开放发送与单请求状态查询。
export function createMessageRoutes({ relay, credentials }: {
  relay: RelayService;
  credentials: { verify(token: string): boolean };
}): Record<string, (request: Request) => Promise<Response>> {
  function handler(query: boolean) {
    return async (request: Request): Promise<Response> => {
      if (request.method !== "POST") return new Response("方法不支持", { status: 405 });
      const token = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
      if (!credentials.verify(token)) return new Response("凭证无效", { status: 401 });
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
        return new Response("需要 application/json", { status: 415 });
      let input: Record<string, unknown>;
      try {
        input = await request.json();
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      } catch { return new Response("JSON 无效", { status: 400 }); }
      if (typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 500)
        return new Response("需要稳定的 request_id", { status: 400 });
      // 白名单构造，外部请求不能开启关注或调用其他 Relay 操作。
      const result = await relay.call(query ? "message_status" : "send", query
        ? { request_id: input.request_id }
        : { request_id: input.request_id, agent: input.agent, external_session_id: input.external_session_id, content: input.content });
      if (!result.ok) return Response.json({ error: result.error.message }, { status: result.error.code === "invalid_input" ? 400 : 503 });
      const { message, duplicate } = result.value as { message: Message | null; duplicate?: boolean };
      if (!message) return new Response("未找到请求记录；请核对原请求，不要盲目重发", { status: 404 });
      return Response.json({
        accepted: true, duplicate: duplicate === true, message_id: message.id,
        status: message.status, external_ref: message.external_ref, error: message.error,
        acked_at: message.acked_at, ack_summary: message.ack_summary,
      }, { status: query ? 200 : 202 });
    };
  }
  return { [MESSAGE_PATH]: handler(false), [MESSAGE_STATUS_PATH]: handler(true) };
}
