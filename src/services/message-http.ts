import type { RelayService } from "./relay.js";
import type { Message } from "../storage/types.js";

export const MESSAGE_PATH = "/api/agent-relay/messages";
export const MESSAGE_STATUS_PATH = "/api/agent-relay/messages/status";
export const MESSAGE_PROGRESS_PATH = "/api/agent-relay/messages/progress";
export const SESSION_RESOLVE_PATH = "/api/agent-relay/sessions/resolve";
export const SESSION_START_PATH = "/api/agent-relay/sessions/start";

// 外部 Skill 的薄入口：共用本机通知凭证，开放可见会话发送、新建桌面可见会话、单请求状态和名称查找。
export function createMessageRoutes({ relay, credentials }: {
  relay: RelayService;
  credentials: { verify(token: string): boolean };
}): Record<string, (request: Request) => Promise<Response>> {
  function handler(mode: "send" | "status" | "resolve" | "progress" | "start") {
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
      if (mode === "resolve") {
        const result = await relay.call("resolve_session", { agent: input.agent, session_name: input.session_name });
        return result.ok ? Response.json(result.value) : Response.json({ error: result.error.message }, { status: result.error.code === "invalid_input" ? 400 : 503 });
      }
      if (typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 500)
        return new Response("需要稳定的 request_id", { status: 400 });
      if (mode === "progress") {
        const result = await relay.call("message_progress", { request_id: input.request_id });
        if (!result.ok) return Response.json({ error: result.error.message }, { status: result.error.code === "invalid_input" ? 400 : 503 });
        return result.value ? Response.json(result.value) : new Response("未找到原发送请求，不会自动发送或新建", { status: 404 });
      }
      if (mode === "start") {
        const result = await relay.call("start_visible_session", {
          request_id: input.request_id,
          agent: input.agent,
          cwd: input.cwd,
          content: input.content,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
        });
        if (!result.ok) return Response.json({ error: result.error.message }, { status: result.error.code === "invalid_input" ? 400 : 503 });
        const { message, duplicate, session_id, project_name, delivery, title } = result.value as {
          message: Message;
          duplicate?: boolean;
          session_id?: string | null;
          project_name?: string | null;
          delivery?: string | null;
          title?: string | null;
        };
        return Response.json({
          accepted: true,
          duplicate: duplicate === true,
          message_id: message.id,
          status: message.status,
          session_id: session_id ?? null,
          project_name: project_name ?? null,
          delivery: delivery ?? "auto",
          title: title ?? null,
          external_ref: message.external_ref,
          error: message.error,
        }, { status: 202 });
      }
      // 白名单构造，外部请求不能开启关注或调用其他 Relay 操作。
      const result = await relay.call(mode === "status" ? "message_status" : "send", mode === "status"
        ? { request_id: input.request_id }
        : { request_id: input.request_id, agent: input.agent, external_session_id: input.external_session_id, content: input.content, visible_only: true });
      if (!result.ok) return Response.json({ error: result.error.message }, { status: result.error.code === "invalid_input" ? 400 : 503 });
      const { message, duplicate } = result.value as { message: Message | null; duplicate?: boolean };
      if (!message) return new Response("未找到请求记录；请核对原请求，不要盲目重发", { status: 404 });
      return Response.json({
        accepted: true, duplicate: duplicate === true, message_id: message.id,
        status: message.status, external_ref: message.external_ref, error: message.error,
        acked_at: message.acked_at, ack_summary: message.ack_summary,
      }, { status: mode === "status" ? 200 : 202 });
    };
  }
  return {
    [MESSAGE_PATH]: handler("send"),
    [MESSAGE_STATUS_PATH]: handler("status"),
    [MESSAGE_PROGRESS_PATH]: handler("progress"),
    [SESSION_RESOLVE_PATH]: handler("resolve"),
    [SESSION_START_PATH]: handler("start"),
  };
}
