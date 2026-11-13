import type { ClaudeChannelService } from "./claude-channel.js";

export const CHANNEL_POLL_PATH = "/api/agent-relay/claude-channel/poll";
export const CHANNEL_ACK_PATH = "/api/agent-relay/claude-channel/ack";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude channel server 调用的本机接口；使用 channel 专用凭证，与外部通知凭证分开。
export function createChannelRoutes({
  channel,
  credentials,
  pollWaitMs = 25_000,
}: {
  channel: ClaudeChannelService;
  credentials: { verify(token: string): boolean };
  pollWaitMs?: number;
}): Record<string, (request: Request) => Promise<Response>> {
  async function body(request: Request): Promise<Record<string, unknown> | Response> {
    if (request.method !== "POST") return new Response("方法不支持", { status: 405 });
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return new Response("需要 application/json", { status: 415 });
    const token = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!credentials.verify(token)) return new Response("凭证无效", { status: 401 });
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return new Response("JSON 无效", { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      return new Response("请求体无效", { status: 400 });
    return value as Record<string, unknown>;
  }
  const optional = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? value.slice(0, max) : null;

  return {
    async [CHANNEL_POLL_PATH](request) {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0)
        return new Response("pid 无效", { status: 400 });
      const sessionId = input.session_id;
      if (sessionId !== null && sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)))
        return new Response("session_id 无效", { status: 400 });
      const messages = await channel.poll(
        {
          pid: input.pid as number,
          session_id: (sessionId as string | null | undefined) ?? null,
          version: optional(input.version, 100),
        },
        pollWaitMs,
      );
      return Response.json({ messages });
    },
    async [CHANNEL_ACK_PATH](request) {
      const input = await body(request);
      if (input instanceof Response) return input;
      if (typeof input.msg_id !== "string" || !input.msg_id.trim() || input.msg_id.length > 200)
        return new Response("msg_id 无效", { status: 400 });
      const result = channel.ack({ msg_id: input.msg_id, summary: optional(input.summary, 2000) });
      return Response.json(result, { status: result.ok ? 200 : 404 });
    },
  };
}
