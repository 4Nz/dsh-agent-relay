import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { WorkBuddyTokenProvider } from "./token.js";

type ObjectValue = Record<string, unknown>;
export type AcpPromptResult =
  | { status: "responded"; requestId: string; stopReason: string }
  | { status: "rejected"; reason: string }
  | { status: "failed" | "unknown"; error: string };

export interface WorkBuddyAcp {
  prompt(sessionId: string, text: string, options?: { cwd: string }): Promise<AcpPromptResult>;
}

export interface WorkBuddyAcpOptions {
  token: WorkBuddyTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  // 只提供脱敏阶段；不包含正文、凭据或服务端错误文本。
  diagnostic?: (event: { stage: string; code?: number }) => void;
}

class RpcError extends Error {
  constructor(readonly code: number, readonly writerOccupied = false) { super("ACP 返回协议错误"); }
}

const record = (value: unknown): value is ObjectValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const unwrap = (value: unknown) => record(value) && "data" in value ? value.data : value;
const MAX_BYTES = 8 * 1024 * 1024;
const STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

// 实验传输：每次发送独立握手，不复用可能漂移的连接，也不重发 prompt。
export function createWorkBuddyAcp(options: WorkBuddyAcpOptions): WorkBuddyAcp {
  const fetch_ = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new TypeError("ACP 超时必须为 1～120000 毫秒");

  return {
    async prompt(sessionId, text, target) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(sessionId) || !text.trim())
        return { status: "rejected", reason: "ACP 目标或消息无效" };
      let attempted = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let connectionId: string | undefined;
      const diagnostic = (stage: string, code?: number) => {
        try { options.diagnostic?.({ stage, ...(code === undefined ? {} : { code }) }); } catch { /* 诊断不能改变发送语义。 */ }
      };
      try {
        const token = await options.token.read();
        if (target) {
          const entries = await options.token.interactiveSessions();
          const normalize = (cwd: string) => process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
          const matched = entries.some(entry => {
            try {
              const url = new URL(entry.url ?? "");
              return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) &&
                Number(url.port) === token.port && token.pid !== null && entry.pid === token.pid &&
                !!entry.cwd && !!target.cwd && normalize(entry.cwd) === normalize(target.cwd);
            } catch { return false; }
          });
          if (!matched) {
            diagnostic("project_mismatch");
            return { status: "rejected", reason: "无法确认 ACP 端点属于目标项目；会话列表可见不代表支持跨项目发送" };
          }
        }
        const origin = `http://127.0.0.1:${token.port}`;
        async function post(path: string, body: unknown): Promise<Response> {
          const response = await fetch_(origin + path, {
            method: "POST", redirect: "error", signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token.password}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(connectionId ? { "acp-connection-id": connectionId } : {}),
            },
            body: JSON.stringify(body),
          });
          if (response.status === 401)
            await options.token.requestRefresh("ACP 鉴权失效").catch(() => undefined);
          if (!response.ok) {
            diagnostic("http_error", response.status);
            await response.body?.cancel();
            throw new Error("ACP HTTP 请求失败");
          }
          return response;
        }
        async function handleServerRequest(message: ObjectValue) {
          // 不授予文件、终端或权限能力；请求参数和服务端正文不进入错误输出。
          const response = await post("/api/v1/acp", {
            jsonrpc: "2.0", id: message.id,
            ...(message.method === "session/request_permission"
              ? { result: { outcome: { outcome: "cancelled" } } }
              : { error: { code: -32601, message: "客户端未提供此能力" } }),
          });
          await response.body?.cancel();
        }
        async function rpc(method: string, params: unknown) {
          const id = randomUUID();
          if (method === "session/prompt") { attempted = true; diagnostic("prompt_started"); }
          const response = await post("/api/v1/acp", { jsonrpc: "2.0", id, method, params });
          let matched: ObjectValue | undefined;
          await consume(response, async (value) => {
            if (!record(value) || value.jsonrpc !== "2.0") return false;
            if (typeof value.method === "string") {
              if (typeof value.id === "string" || typeof value.id === "number")
                await handleServerRequest(value);
              return false;
            }
            if (value.id !== id) return false;
            if (record(value.error) && typeof value.error.code === "number")
              throw new RpcError(value.error.code, value.error.message === "writer_occupied" ||
                (record(value.error.data) && value.error.data.code === "writer_occupied"));
            if (!record(value.result) || "error" in value) throw new Error("ACP 结果格式无效");
            matched = value.result;
            return true;
          });
          if (!matched) throw new Error("ACP 未返回匹配的结果");
          return { id, result: matched };
        }

        let connected: unknown;
        await consume(await post("/api/v1/acp/connect", {}), async value => {
          connected = unwrap(value); return true;
        });
        if (!record(connected) || typeof connected.connectionId !== "string" || !connected.connectionId)
          throw new Error("ACP 连接响应无效");
        connectionId = connected.connectionId;
        diagnostic("connected");
        // sessionToken 的用途尚未验证，不记录、不持久化，也不猜测重连用法。
        const initialized = await rpc("initialize", {
          protocolVersion: 1, clientCapabilities: {},
          clientInfo: { name: "dsh-agent-relay-experiment", version: "1" },
        });
        if (initialized.result.protocolVersion !== 1 || !record(initialized.result.agentCapabilities))
          throw new Error("ACP 握手版本或能力无效");
        diagnostic("initialized");
        const current = await options.token.read();
        if (current.port !== token.port || current.password !== token.password || current.pid !== token.pid)
          throw new Error("ACP 握手后网关已变化");
        const response = await rpc("session/prompt", {
          sessionId, prompt: [{ type: "text", text }],
        });
        const stopReason = response.result.stopReason;
        if (typeof stopReason !== "string" || !STOP_REASONS.has(stopReason))
          throw new Error("ACP prompt 结果未确认");
        diagnostic("prompt_result");
        return { status: "responded", requestId: response.id, stopReason };
      } catch (error) {
        diagnostic(attempted ? "after_prompt_error" : "before_prompt_error", error instanceof RpcError ? error.code : undefined);
        // JSON-RPC 明确表示方法/参数无效时可确定拒绝；不猜测扩展错误的副作用。
        if (error instanceof RpcError && (error.writerOccupied || [-32601, -32602].includes(error.code)))
          return { status: "rejected", reason: error.writerOccupied ? "WorkBuddy 写入方被占用" : "ACP 明确拒绝方法或参数" };
        return attempted
          ? { status: "unknown", error: "ACP 已尝试发送，投递结果未确认；不得自动重发" }
          : { status: "failed", error: "ACP 连接或握手失败，尚未发送消息" };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}

// 流式读取并限制总字节数；注释/心跳不构成结果，只有完整 data 事件参与匹配。
async function consume(response: Response, onValue: (value: unknown) => Promise<boolean>) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ACP 响应没有正文");
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("ACP 响应超出上限");
      buffer += decoder.decode(value, { stream: true });
      if (!sse) continue;
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.slice(end, end + 2) === "\r\n" ? 2 : 1));
        if (line === "") {
          if (data.length && await onValue(JSON.parse(data.join("\n")))) return;
          data = [];
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    buffer += decoder.decode();
    if (!sse && buffer.trim()) await onValue(JSON.parse(buffer));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
