import { AdapterError } from "../types.js";
import type { WorkBuddyToken, WorkBuddyTokenProvider } from "./token.js";

export interface GatewayResult<T> {
  status: number;
  value: T | null;
  body: string;
}

export interface WorkBuddyGateway {
  health(): Promise<GatewayResult<unknown>>;
  listSessions(): Promise<GatewayResult<unknown>>;
  live(): Promise<GatewayResult<unknown>>;
  status(): Promise<GatewayResult<unknown>>;
  history(sessionId: string): Promise<GatewayResult<unknown>>;
  replay(sessionId: string): Promise<GatewayResult<unknown>>;
  reply(sessionId: string, text: string): Promise<GatewayResult<unknown>>;
}

export interface WorkBuddyGatewayOptions {
  token: WorkBuddyTokenProvider;
  fetch?: typeof globalThis.fetch;
}

export function createWorkBuddyGateway(
  options: WorkBuddyGatewayOptions,
): WorkBuddyGateway {
  const fetch_ = options.fetch ?? globalThis.fetch;

  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<GatewayResult<T>> {
    let token: WorkBuddyToken;
    try {
      token = await options.token.read();
    } catch (error) {
      await options.token.requestRefresh(message(error)).catch(() => undefined);
      throw error;
    }
    const url = `http://127.0.0.1:${token.port}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.password}`,
    };
    const init: RequestInit = { method, headers, redirect: "error" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch_(url, init);
    } catch (error) {
      await options.token.requestRefresh(`连接失败：${message(error)}`).catch(() => undefined);
      throw new AdapterError("unavailable", `无法连接 WorkBuddy 网关：${message(error)}`);
    }
    const bodyText = await response.text();
    let value: T | null = null;
    try {
      value = JSON.parse(bodyText) as T;
    } catch {
      // 统一把非 JSON 响应保留为 body，调用方再映射错误。
    }
    if (response.status === 401) {
      await options.token.requestRefresh("网关返回 401").catch(() => undefined);
    }
    return { status: response.status, value, body: bodyText };
  }

  const encoded = (id: string) => encodeURIComponent(id);
  return {
    health: () => request("/api/v1/health"),
    listSessions: () => request("/api/v1/sessions?cwd=*"),
    live: () => request("/api/v1/sessions/live"),
    status: () => request("/api/v1/status"),
    history: (id) => request(`/api/v1/sessions/${encoded(id)}/history`),
    replay: (id) => request(`/api/v1/sessions/${encoded(id)}/replay`),
    reply: (id, text) =>
      request(`/api/v1/sessions/${encoded(id)}/reply`, "POST", { text }),
  };
}

export function gatewayError(result: GatewayResult<unknown>, operation: string) {
  if (result.status === 404)
    return new AdapterError("unavailable", `${operation}：WorkBuddy 会话不存在`);
  if (result.status === 401)
    return new AdapterError("unavailable", `${operation}：WorkBuddy token 已失效`);
  return new AdapterError(
    "unavailable",
    `${operation}：HTTP ${result.status}${result.body ? ` ${result.body.slice(0, 200)}` : ""}`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
