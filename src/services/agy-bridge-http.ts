import type { AgyBridgeService } from "./agy-bridge.js";

export const AGY_BRIDGE_POLL_PATH = "/api/agent-relay/agy-bridge/poll";
export const AGY_BRIDGE_RESULT_PATH = "/api/agent-relay/agy-bridge/result";

export function createAgyBridgeRoutes({
  agyBridge,
  credentials,
  pollWaitMs = 25_000,
}: {
  agyBridge: AgyBridgeService;
  credentials: { verify(token: string): boolean };
  pollWaitMs?: number;
}): Record<string, (request: Request) => Promise<Response>> {
  async function parseBody(request: Request): Promise<Record<string, unknown> | Response> {
    if (request.method !== "POST") return new Response("方法不支持", { status: 405 });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      return new Response("需要 application/json", { status: 415 });
    }
    const token = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!credentials.verify(token)) return new Response("凭证无效", { status: 401 });
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return new Response("JSON 无效", { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return new Response("请求体无效", { status: 400 });
    }
    return value as Record<string, unknown>;
  }

  const optional = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? value.slice(0, max) : null;

  return {
    async [AGY_BRIDGE_POLL_PATH](request) {
      const input = await parseBody(request);
      if (input instanceof Response) return input;
      if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0) {
        return new Response("pid 无效", { status: 400 });
      }
      const commands = await agyBridge.poll(
        {
          pid: input.pid as number,
          app_data_dir: optional(input.app_data_dir, 500),
          version: optional(input.version, 100),
        },
        pollWaitMs,
      );
      return Response.json({ commands });
    },

    async [AGY_BRIDGE_RESULT_PATH](request) {
      const input = await parseBody(request);
      if (input instanceof Response) return input;
      if (typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 200) {
        return new Response("request_id 无效", { status: 400 });
      }
      if (typeof input.ok !== "boolean") {
        return new Response("ok 必须为布尔值", { status: 400 });
      }
      const result = agyBridge.complete({
        request_id: input.request_id,
        ok: input.ok,
        value: input.value,
        error: optional(input.error, 2000),
      });
      return Response.json(result, { status: result.ok ? 200 : 404 });
    },
  };
}
