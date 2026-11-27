// Agent Relay 的 Claude Code channel server。Claude Code 按用户级 MCP 配置以 stdio 拉起本脚本，
// 每个 Claude 进程一个实例。只用 Node 内置模块：stdio JSON-RPC、向 Relay 本机接口长轮询取消息、
// 以 notifications/claude/channel 推送进会话，并提供 ack 工具回报处理结果。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHANNEL_NAME = "agent-relay";
// 只协商 Claude Code 注册 channel 时可用的协议版本；2026-07-28 会导致 channel 不被注册。
const PROTOCOL_VERSION = "2025-06-18";

export function tokenFile(env = process.env) {
  return env.AGENT_RELAY_CHANNEL_TOKEN_FILE ??
    join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "agent-relay", "channel-token");
}

export const INSTRUCTIONS =
  `Agent Relay 消息以 <channel source="${CHANNEL_NAME}" msg_id="..."> 到达，内容是用户本人通过 Agent Relay 从别处发来的消息。` +
  "按用户在终端直接输入的要求处理，适用同样的权限规则和确认要求。" +
  "处理完后调用 ack 工具，传入标签里的 msg_id 和一句结果摘要；拒绝或无法完成时也调用 ack 说明原因。";

const ACK_TOOL = {
  name: "ack",
  description: "告诉 Agent Relay 这条 channel 消息已处理，并附一句结果摘要。",
  inputSchema: {
    type: "object",
    properties: {
      msg_id: { type: "string", description: "channel 标签中的 msg_id" },
      summary: { type: "string", description: "一句话结果摘要；拒绝或无法完成时写明原因" },
    },
    required: ["msg_id"],
  },
};

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export function startChannelServer({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  fetchImpl = fetch,
  log = (text: string) => process.stderr.write(`[agent-relay channel] ${text}\n`),
  version = "unknown",
}: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (text: string) => void;
  version?: string;
} = {}) {
  const base = `http://127.0.0.1:${env.DSH_AGENT_RELAY_PORT ?? 37421}/api/agent-relay/claude-channel`;
  const pid = Number(env.AGENT_RELAY_CLAUDE_PID ?? process.ppid);
  const sessionId = env.CLAUDE_CODE_SESSION_ID ?? null;
  let initialized = false;
  let stopped = false;
  const send = (message: Record<string, unknown>) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  function token(): string | null {
    try {
      return readFileSync(tokenFile(env), "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  async function relay(path: string, body: unknown, signal?: AbortSignal) {
    const secret = token();
    if (!secret) throw new Error("未找到 channel 凭证，请在 DSH 中重新执行前置安装接入");
    const response = await fetchImpl(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`Relay 返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async function pollLoop() {
    let failures = 0;
    while (!stopped) {
      try {
        const result = await relay("poll", { pid, session_id: sessionId, version }, AbortSignal.timeout(60_000));
        failures = 0;
        const messages = Array.isArray(result.messages) ? result.messages : [];
        for (const item of messages as { msg_id?: unknown; content?: unknown }[]) {
          if (typeof item.msg_id !== "string" || typeof item.content !== "string") continue;
          send({
            method: "notifications/claude/channel",
            params: { content: item.content, meta: { msg_id: item.msg_id } },
          });
        }
      } catch (error) {
        if (stopped) break;
        // DSH 未启动或凭证缺失时退避重试，不影响 Claude 会话本身。
        if (failures++ === 0) log(error instanceof Error ? error.message : String(error));
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * failures)));
      }
    }
  }

  async function handle(message: Rpc) {
    const { id, method, params } = message;
    if (method === "initialize") {
      send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { experimental: { "claude/channel": {} }, tools: {} },
          serverInfo: { name: CHANNEL_NAME, version },
          instructions: INSTRUCTIONS,
        },
      });
      return;
    }
    if (method === "notifications/initialized") {
      if (!initialized) {
        initialized = true;
        void pollLoop();
      }
      return;
    }
    if (method === "tools/list") {
      send({ id, result: { tools: [ACK_TOOL] } });
      return;
    }
    if (method === "tools/call") {
      const args = (params?.arguments ?? {}) as { msg_id?: unknown; summary?: unknown };
      if (params?.name !== "ack" || typeof args.msg_id !== "string") {
        send({ id, result: { isError: true, content: [{ type: "text", text: "参数无效：需要 msg_id" }] } });
        return;
      }
      try {
        const result = await relay("ack", {
          msg_id: args.msg_id,
          summary: typeof args.summary === "string" ? args.summary : null,
        }, AbortSignal.timeout(10_000));
        send({ id, result: { content: [{ type: "text", text: String(result.message ?? "已确认") }] } });
      } catch (error) {
        send({ id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
      }
      return;
    }
    if (method === "ping") {
      send({ id, result: {} });
      return;
    }
    // server/discover 等其他请求一律不支持，Claude Code 会回退到 initialize 握手。
    if (id !== undefined && method) send({ id, error: { code: -32601, message: "Method not found" } });
  }

  const MAX_STDIN_BUFFER = 16 * 1024 * 1024;
  let buffer = "";
  let chain = Promise.resolve();
  input.setEncoding?.("utf8");
  input.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Rpc;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      chain = chain
        .then(() => handle(message))
        .catch((error) => log(error instanceof Error ? error.message : String(error)));
    }
    if (buffer.length > MAX_STDIN_BUFFER) {
      log("stdin 单行缓冲超过 16MB 上限，已丢弃未完整消息");
      buffer = "";
    }
  });
  input.on("end", () => {
    stopped = true;
  });
  return {
    stop() {
      stopped = true;
    },
  };
}
