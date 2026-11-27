// Antigravity Sidecar 桥接客户端：由 Antigravity 按 sidecar.json 启动，继承宿主注入的
// ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN / ANTIGRAVITY_AGENTAPI_EXE，
// 向本机 DSH Agent Relay 长轮询接收会话状态查询与 agentapi send-message 投递请求。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveAgyBridgeTokenPath } from "../adapters/agy/paths.js";
import type { AgyBridgeCommand } from "../services/agy-bridge.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunAgentApiResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function defaultRunAgentApi(
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<RunAgentApiResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 1024 * 1024) stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function startAgyBridgeClient({
  env = process.env,
  fetchImpl = fetch,
  runAgentApi = defaultRunAgentApi,
  log = (text: string) => process.stderr.write(`[dsh-agent-relay sidecar] ${text}\n`),
  resultRetryDelaysMs = [500, 1500],
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runAgentApi?: typeof defaultRunAgentApi;
  log?: (text: string) => void;
  resultRetryDelaysMs?: number[];
} = {}) {
  const relayBase = `http://127.0.0.1:${env.DSH_AGENT_RELAY_PORT ?? 37421}/api/agent-relay/agy-bridge`;
  const pid = Number(env.AGENT_RELAY_AGY_PID ?? process.pid);
  let stopped = false;

  function readToken(): string | null {
    try {
      return readFileSync(resolveAgyBridgeTokenPath({ env }), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  async function callRelay(path: string, body: unknown, signal?: AbortSignal) {
    const token = readToken();
    if (!token) throw new Error("未找到 Antigravity 桥接凭证，请在 DSH 前置安装接入中修复");
    const response = await fetchImpl(`${relayBase}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(`DSH Relay 返回 ${response.status}：${(await response.text()).slice(0, 200)}`),
        { status: response.status },
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async function reportResult(body: Record<string, unknown>) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= resultRetryDelaysMs.length; attempt++) {
      try {
        return await callRelay("result", body, AbortSignal.timeout(10_000));
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number })?.status;
        if (stopped || (typeof status === "number" && status >= 400 && status < 500) || attempt === resultRetryDelaysMs.length) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, resultRetryDelaysMs[attempt]!));
      }
    }
    throw lastError;
  }

  async function callLs(method: string, body: Record<string, unknown>) {
    const address = env.ANTIGRAVITY_LS_ADDRESS?.trim();
    const csrf = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
    if (!address || !csrf) {
      throw new Error("当前运行环境缺少 ANTIGRAVITY_LS_ADDRESS 或 ANTIGRAVITY_CSRF_TOKEN");
    }
    const response = await fetchImpl(`http://${address}/product.v1.ConversationService/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        "x-antigravity-csrf-token": csrf,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    if (response.status === 404 || /not[_\s-]?found/i.test(raw)) {
      return { notFound: true as const, data: null };
    }
    if (!response.ok) {
      throw new Error(`ConversationService/${method} HTTP ${response.status}`);
    }
    return { notFound: false as const, data: JSON.parse(raw) as Record<string, any> };
  }

  async function executeCommand(command: AgyBridgeCommand): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    try {
      if (command.action === "get_conversation") {
        const id = String(command.payload.conversation_id ?? "");
        if (!SESSION_ID.test(id)) return { ok: false, error: "会话 ID 格式无效" };
        const res = await callLs("GetConversation", { conversationId: id });
        if (res.notFound || !res.data) return { ok: true, value: { found: false } };
        const conv = res.data.conversation ?? res.data;
        return {
          ok: true,
          value: {
            found: true,
            id: conv.id ?? id,
            title: typeof conv.annotations?.title === "string" && conv.annotations.title.trim() ? conv.annotations.title : null,
            summary: typeof conv.state?.summary === "string" ? conv.state.summary : null,
            archived: conv.annotations?.archived === true,
            runState: typeof conv.state?.runState === "string" ? conv.state.runState : null,
            updateTime: typeof conv.state?.updateTime === "string" ? conv.state.updateTime : null,
            projectId: typeof conv.metadata?.projectId === "string" ? conv.metadata.projectId : null,
          },
        };
      }

      if (command.action === "send_message") {
        const id = String(command.payload.conversation_id ?? "");
        const content = String(command.payload.content ?? "");
        if (!SESSION_ID.test(id) || !content.trim()) {
          return { ok: true, value: { status: "rejected", reason: "目标会话 ID 或消息内容无效" } };
        }
        const meta = await callLs("GetConversation", { conversationId: id });
        if (meta.notFound || !meta.data) {
          return { ok: true, value: { status: "rejected", reason: "外部会话不存在" } };
        }
        const conv = meta.data.conversation ?? meta.data;
        if (conv.annotations?.archived === true) {
          return { ok: true, value: { status: "rejected", reason: "外部会话已归档" } };
        }
        const exe = env.ANTIGRAVITY_AGENTAPI_EXE?.trim() || "agentapi";
        const args = /(?:language_server|agy)(?:\.exe)?$/i.test(exe)
          ? ["agentapi", "send-message", id, content]
          : ["send-message", id, content];
        const result = await runAgentApi(exe, args, env, 15_000);
        if (result.timedOut) {
          return { ok: true, value: { status: "unknown", error: "agentapi send-message 执行超时，结果未知" } };
        }
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim().slice(0, 300);
          return { ok: true, value: { status: "failed", error: detail || `agentapi 退出码 ${result.code}` } };
        }
        return { ok: true, value: { status: "sent" } };
      }

      return { ok: false, error: `未知操作：${String(command.action)}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function loop() {
    let failures = 0;
    while (!stopped) {
      try {
        const polled = await callRelay(
          "poll",
          {
            pid,
            app_data_dir: env.ANTIGRAVITY_APP_DATA_DIR ?? null,
            version: env.ANTIGRAVITY_LS_VERSION ?? null,
          },
          AbortSignal.timeout(60_000),
        );
        failures = 0;
        const commands = Array.isArray(polled.commands) ? (polled.commands as AgyBridgeCommand[]) : [];
        for (const cmd of commands) {
          if (!cmd || typeof cmd.request_id !== "string") continue;
          const outcome = await executeCommand(cmd);
          await reportResult({
            request_id: cmd.request_id,
            ok: outcome.ok,
            value: outcome.value,
            error: outcome.error ?? null,
          });
        }
      } catch (error) {
        if (stopped) break;
        if (failures++ === 0) {
          log(error instanceof Error ? error.message : String(error));
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2_000 * failures)));
      }
    }
  }

  const running = loop();
  return {
    running,
    stop() {
      stopped = true;
    },
  };
}
