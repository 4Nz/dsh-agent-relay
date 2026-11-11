import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Subscription, Result } from "../storage/types.js";

const RESULTS = new Set<Result>([
  "completed",
  "failed",
  "idle_timeout",
  "expired",
  "session_closed",
  "unreachable",
]);

export interface PushHandlerOptions {
  credentials: { verify(token: string): boolean };
  store: {
    subscriptions: {
      get(id: string): Subscription | null;
      update(input: { id: string; expected_status: "active"; patch: { dsh_session_id: string; updated_at: number } }): boolean;
    };
    notifications: {
      record(input: { notification: { id: string; subscription_id: string; source: "push"; result: Result; summary: string; external_ref?: string | null }; now: number }): { outcome: "created" | "duplicate" | "inactive"; notification: unknown };
    };
  };
  createSession: (subscription: Subscription) => Promise<string>;
  drain: () => Promise<unknown>;
  now?: () => number;
  newId?: () => string;
}

export function createPushHandler({
  credentials,
  store,
  createSession,
  drain,
  now = Date.now,
  newId = randomUUID,
}: PushHandlerOptions) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("方法不支持", { status: 405 });
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return new Response("需要 application/json", { status: 415 });
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!credentials.verify(token)) return new Response("凭证无效", { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("JSON 无效", { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return new Response("请求体无效", { status: 400 });
    const input = body as Record<string, unknown>;
    if (
      typeof input.subscription_id !== "string" ||
      !input.subscription_id.trim() ||
      typeof input.result !== "string" ||
      !RESULTS.has(input.result as Result) ||
      typeof input.summary !== "string" ||
      !input.summary.trim() ||
      input.summary.length > 4000
    )
      return new Response("通知字段无效", { status: 400 });
    if (input.external_ref !== undefined && input.external_ref !== null && typeof input.external_ref !== "string")
      return new Response("external_ref 无效", { status: 400 });
    const subscription = store.subscriptions.get(input.subscription_id);
    if (!subscription || subscription.type !== "push")
      return new Response("push 订阅不存在", { status: 404 });
    if (subscription.status !== "active")
      return new Response("push 订阅未运行", { status: 409 });
    let sessionId = subscription.dsh_session_id;
    if (!sessionId) {
      sessionId = await createSession(subscription);
      if (!store.subscriptions.update({
        id: subscription.id,
        expected_status: "active",
        patch: { dsh_session_id: sessionId, updated_at: now() },
      })) return new Response("接收会话创建冲突", { status: 409 });
    }
    const result = store.notifications.record({
      notification: {
        id: newId(),
        subscription_id: subscription.id,
        source: "push",
        result: input.result as Result,
        summary: input.summary,
        external_ref: (input.external_ref as string | null | undefined) ?? null,
      },
      now: now(),
    });
    await drain();
    return Response.json({
      accepted: true,
      duplicate: result.outcome === "duplicate",
      subscription_id: subscription.id,
      dsh_session_id: sessionId,
    }, { status: 202 });
  };
}

export function createPushServer({
  handler,
  host = "127.0.0.1",
  port = Number(process.env.DSH_AGENT_RELAY_PORT ?? 37421),
}: {
  handler: (request: Request) => Promise<Response>;
  host?: string;
  port?: number;
}) {
  const server = createServer((request, response) => {
    void serve(request, response, handler);
  });
  return {
    server,
    start: () => new Promise<{ host: string; port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        const address = server.address();
        resolve({ host, port: typeof address === "object" && address ? address.port : port });
      });
    }),
    stop: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
) {
  if (request.url !== "/api/agent-relay/notifications") {
    response.writeHead(404).end("Not Found");
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk as Buffer);
    size += data.length;
    if (size > 1_000_000) {
      response.writeHead(413).end("请求过大");
      return;
    }
    chunks.push(data);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers))
    if (typeof value === "string") headers.set(key, value);
  const result = await handler(new Request(`http://${request.headers.host ?? "localhost"}${request.url}`, {
    method: request.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  }));
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
}
