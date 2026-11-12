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
      getBySubscription?(id: string): unknown;
      record(input: { notification: { id: string; subscription_id: string; source: "push"; result: Result; summary: string; external_ref?: string | null }; now: number }): { outcome: "created" | "duplicate" | "inactive"; notification: unknown };
    };
  };
  createSubscription: (input: {
    id: string;
    type: "push";
    agent: "claude" | "codex";
    external_session_id: string;
    dsh_session_id: null;
  }) => Promise<{ ok: true; subscription: Subscription } | { ok: false; message: string }>;
  createSession: (subscription: Subscription) => Promise<string>;
  drain: () => Promise<unknown>;
  now?: () => number;
  newId?: () => string;
}

export function createPushHandler({
  credentials,
  store,
  createSession,
  createSubscription,
  drain,
  now = Date.now,
  newId = randomUUID,
}: PushHandlerOptions) {
  const sessionLocks = new Map<string, Promise<string>>();

  async function ensureSession(subscription: Subscription): Promise<string> {
    const current = store.subscriptions.get(subscription.id);
    if (current?.dsh_session_id) return current.dsh_session_id;
    const existing = sessionLocks.get(subscription.id);
    if (existing) return existing;
    const pending = (async () => {
      const latest = store.subscriptions.get(subscription.id);
      if (latest?.dsh_session_id) return latest.dsh_session_id;
      const sessionId = await createSession(latest ?? subscription);
      if (store.subscriptions.update({
        id: subscription.id,
        expected_status: "active",
        patch: { dsh_session_id: sessionId, updated_at: now() },
      })) return sessionId;
      const updated = store.subscriptions.get(subscription.id);
      if (updated?.dsh_session_id) return updated.dsh_session_id;
      throw new Error("接收会话创建冲突");
    })();
    sessionLocks.set(subscription.id, pending);
    try {
      return await pending;
    } finally {
      if (sessionLocks.get(subscription.id) === pending) sessionLocks.delete(subscription.id);
    }
  }

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
    const direct = input.subscription_id === undefined;
    if (
      (!direct && (typeof input.subscription_id !== "string" || !input.subscription_id.trim())) ||
      typeof input.result !== "string" ||
      !RESULTS.has(input.result as Result) ||
      typeof input.summary !== "string" ||
      !input.summary.trim() ||
      input.summary.length > 4000
    )
      return new Response("通知字段无效", { status: 400 });
    if (input.external_ref !== undefined && input.external_ref !== null && typeof input.external_ref !== "string")
      return new Response("external_ref 无效", { status: 400 });
    if (direct && (
      typeof input.request_id !== "string" || !input.request_id.trim() || input.request_id.length > 500 ||
      (input.agent !== "claude" && input.agent !== "codex") ||
      typeof input.external_session_id !== "string" || !input.external_session_id.trim()
    )) return new Response("直接 push 缺少 request_id、agent 或 external_session_id", { status: 400 });
    const subscriptionId = direct ? `push:${input.request_id as string}` : input.subscription_id as string;
    let subscription = store.subscriptions.get(subscriptionId);
    if (!subscription && direct) {
      try {
        const created = await createSubscription({
          id: subscriptionId,
          type: "push",
          agent: input.agent as "claude" | "codex",
          external_session_id: input.external_session_id as string,
          dsh_session_id: null,
        });
        if (!created.ok) return new Response(created.message, { status: 422 });
        subscription = created.subscription;
      } catch {
        // 并发请求可能由另一条请求先创建同一个 request_id；重新读取即可复用。
        subscription = store.subscriptions.get(subscriptionId);
        if (!subscription) return new Response("无法创建 push 订阅", { status: 500 });
      }
    }
    if (!subscription || subscription.type !== "push")
      return new Response("push 订阅不存在", { status: 404 });
    if (direct && (
      subscription.agent !== input.agent ||
      subscription.external_session_id !== input.external_session_id
    )) return new Response("request_id 已绑定其他外部会话", { status: 409 });
    if (subscription.status !== "active") {
      if (store.notifications.getBySubscription?.(subscription.id)) {
        return Response.json({
          accepted: true,
          duplicate: true,
          subscription_id: subscription.id,
          dsh_session_id: subscription.dsh_session_id,
        }, { status: 202 });
      }
      return new Response("push 订阅未运行", { status: 409 });
    }
    let sessionId: string;
    try {
      sessionId = await ensureSession(subscription);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "接收会话创建失败", { status: 409 });
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
    // serve 内部捕获全部异常；这里的 catch 仅作为最后兜底，避免任何 unhandled rejection。
    serve(request, response, handler).catch(() => {
      try {
        if (!response.destroyed && !response.writableEnded)
          response.writeHead(500).end("内部错误");
      } catch {
        /* 连接已关闭，交给 Node 清理。 */
      }
    });
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

// 固定本地 origin，不依赖用户 Host 构造请求 URL，避免 Host 头伪造影响解析。
const REQUEST_ORIGIN = "http://127.0.0.1";

function writeResponse(
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  headers?: Headers,
) {
  if (response.destroyed || response.writableEnded) return;
  const flat: Record<string, string> = {};
  if (headers) for (const [key, value] of headers.entries()) flat[key.toLowerCase()] = value;
  if (!("content-type" in flat)) flat["content-type"] = "text/plain; charset=utf-8";
  response.writeHead(status, flat);
  response.end(body);
}

// 拒绝型响应显式关闭连接，避免未读的请求体（尤其 GET/chunked body）在
// keep-alive 下遗留脏连接，被后续请求复用导致协议错乱。
const CLOSE = new Headers({ connection: "close" });

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
) {
  try {
    // 读取请求体与构造 WHATWG Request 之前先校验路径和方法，错误分别 404/405。
    if (request.url !== "/api/agent-relay/notifications") {
      writeResponse(response, 404, "Not Found", CLOSE);
      request.resume();
      return;
    }
    if (request.method !== "POST") {
      writeResponse(response, 405, "方法不支持", CLOSE);
      request.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const data = Buffer.from(chunk as Buffer);
      size += data.length;
      if (size > 1_000_000) {
        writeResponse(response, 413, "请求过大", CLOSE);
        request.destroy();
        return;
      }
      chunks.push(data);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(key, value);
    const result = await handler(new Request(`${REQUEST_ORIGIN}${request.url}`, {
      method: request.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    }));
    writeResponse(
      response,
      result.status,
      Buffer.from(await result.arrayBuffer()),
      result.headers,
    );
  } catch {
    // handler、凭证读取、请求流中断等异常统一在此处理；未返回响应时给通用 500，
    // 不向调用者暴露堆栈或凭证内容。已断开的请求只清理资源，不再写响应。
    if (!response.destroyed && !response.writableEnded) {
      try {
        writeResponse(response, 500, "内部错误");
      } catch {
        /* 忽略。 */
      }
    }
  }
}
