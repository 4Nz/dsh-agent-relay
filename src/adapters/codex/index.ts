import { basename, isAbsolute } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { CodexBindings } from "../../storage/codex-sessions.js";
import { createHash, randomUUID } from "node:crypto";
import { AdapterError } from "../types.js";
import type {
  AgentAdapter,
  SendResult,
  SessionCursor,
  SessionInfo,
  Snapshot,
  MessageProgress,
  StartVisibleSessionResult,
} from "../types.js";
import {
  codexEndpoint,
  CodexRpcError,
  CodexTransportError,
  type CodexClient,
} from "./rpc.js";
import {
  connectCodexReader,
  connectCodexDaemon,
  type CodexReaderOptions,
} from "./reader.js";
import {
  connectCodexVisibleStarter,
  type CodexVisibleStarterClient,
  type CodexVisibleStarterOptions,
} from "./stdio.js";

export interface CodexAdapterOptions extends CodexReaderOptions {
  connect?: () => Promise<CodexClient>;
  connectVisibleStarter?: (
    options?: Pick<CodexVisibleStarterOptions, "onNotification" | "onClose">,
  ) => Promise<CodexClient & { closed?: Promise<void> }>;
  bindings?: CodexBindings;
  bootstrapTimeoutMs?: number;
}

const BOOTSTRAP_PROMPT = "会话初始化确认：请仅回复 OK，不要调用任何工具。";
function deriveSessionTitle(content: string, explicit?: string): string | null {
  const clean = (raw: string, max: number) =>
    raw.replace(/\s+/g, " ").trim().slice(0, max).trim();
  if (typeof explicit === "string" && explicit.trim()) {
    const title = clean(explicit, 80);
    return title || null;
  }
  const stripped = content
    .replace(/\n*\[接力来源\][\s\S]*$/, "")
    .replace(/\n*\[接力任务[^\]]*\][\s\S]*$/, "")
    .trim();
  const firstLine = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return null;
  const title = clean(firstLine, 60);
  return title || null;
}

// 协议边界只接受已验证的必要字段，未知字段忽略，必要字段变化则明确失败。
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad();
  return value as RecordValue;
}
function bad(): never {
  throw new AdapterError("parse_error", "Codex 协议响应格式无法解析");
}
function string(value: unknown): string {
  if (typeof value !== "string") bad();
  return value;
}
function millis(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) bad();
  return value * 1000;
}
function optionalString(value: unknown): string | null {
  return value == null ? null : string(value);
}
function info(
  value: unknown,
  writable = false,
  queryOnly = false,
): SessionInfo {
  const t = object(value);
  const status = string(object(t.status).type);
  return {
    id: string(t.id),
    title: optionalString(t.name),
    cwd: optionalString(t.cwd),
    last_activity_at: millis(t.updatedAt),
    // daemon 不是桌面执行实例，idle/notLoaded 都不能证明原会话空闲。
    runtime: queryOnly
      ? "unknown"
      : status === "active"
        ? "busy"
        : writable && status === "idle"
          ? "idle"
          : "unknown",
    // 兼容旧发送策略的保守占用值，不是实际进程或实时执行状态的证据。
    held: true,
    // 桌面/其他会话经 thread/queue/add 排队投递，可发送；专用会话沿用 turn/start 需 idle/notLoaded。
    send_allowed:
      !queryOnly &&
      (writable ? status === "idle" || status === "notLoaded" : true),
    send_reason: queryOnly
      ? "当前连接仅支持历史查询和订阅；发送消息需要可用的 Codex daemon"
      : writable
        ? status === "active"
          ? "会话处理中"
          : status === "idle" || status === "notLoaded"
            ? ""
            : "无法确认后台会话状态"
        : "",
  };
}
function page(value: unknown): { data: unknown[]; nextCursor: string | null } {
  const p = object(value);
  if (!Array.isArray(p.data)) bad();
  return { data: p.data, nextCursor: optionalString(p.nextCursor) };
}
function checkId(id: string) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new AdapterError("invalid_input", "Codex 会话 ID 格式无效");
}
const closedSnapshot = (): Snapshot => ({
  closed: true,
  title: null,
  cwd: null,
  cursor: null,
  last_activity_at: null,
  runtime: "unknown",
  held: false,
  runtime_error: null,
  check_error: null,
  finished_turn: null,
  last_reply: null,
});

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): AgentAdapter {
  const endpoint = codexEndpoint(options);
  const bound = (id: string) => options.bindings?.has(id, endpoint) ?? false;
  const metadata = (value: unknown, queryOnly = false) =>
    info(value, bound(string(object(value).id)), queryOnly);
  const connect = options.connect ?? (() => connectCodexReader(options));
  let writeConnection: Promise<CodexClient> | undefined;
  let disposed = false;
  const sending = new Set<string>();
  const activeStarters = new Set<CodexClient>();
  const openVisibleStarter = (
    hooks?: Pick<CodexVisibleStarterOptions, "onNotification" | "onClose">,
  ): Promise<CodexClient & { closed?: Promise<void> }> => {
    if (options.connectVisibleStarter) return options.connectVisibleStarter(hooks);
    if (options.connect) return options.connect();
    return connectCodexVisibleStarter({ ...options, ...hooks }) as Promise<CodexVisibleStarterClient>;
  };
  async function writer(): Promise<CodexClient> {
    if (disposed) throw new AdapterError("unavailable", "Codex Adapter 已停止");
    if (!writeConnection) {
      const attempt = options.connect
        ? options.connect()
        : connectCodexDaemon({
            ...options,
            writable: true,
            onClose: () => {
              if (writeConnection === attempt) writeConnection = undefined;
            },
          });
      writeConnection = attempt;
      void attempt.catch(() => {
        if (writeConnection === attempt) writeConnection = undefined;
      });
    }
    return writeConnection;
  }
  async function writableState(
    client: CodexClient,
    id: string,
  ): Promise<string | null> {
    for await (const session of sessions(client, true))
      if (session.id === id) return "外部会话已归档";
    const current = object(
      object(await client.request("thread/read", { threadId: id })).thread,
    );
    if (string(current.id) !== id) bad();
    const status = string(object(current.status).type);
    if (status === "active") return "会话处理中";
    if (status === "idle") return null;
    if (status !== "notLoaded") return "无法确认后台会话状态";
    // 只恢复由 Relay 创建且登记到此端点的专用会话，不恢复任意历史会话。
    const resumed = object(
      object(
        await client.request("thread/resume", {
          threadId: id,
          excludeTurns: true,
        }),
      ).thread,
    );
    if (string(resumed.id) !== id) bad();
    const live = string(object(resumed.status).type);
    return live === "idle"
      ? null
      : live === "active"
        ? "会话处理中"
        : "无法确认后台会话空闲";
  }
  async function using<T>(
    operation: (client: CodexClient) => Promise<T>,
  ): Promise<T> {
    let client: CodexClient | undefined;
    try {
      client = await connect();
      return await operation(client);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      // 不把协议错误的正文写进错误信息，避免意外携带会话内容。
      throw new AdapterError(
        "unavailable",
        error instanceof CodexRpcError
          ? `Codex 查询失败（协议错误 ${error.code}）`
          : "Codex 连接或查询失败",
      );
    } finally {
      client?.close();
    }
  }
  async function* sessions(client: CodexClient, archived: boolean) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const p = page(
        await client.request("thread/list", {
          archived,
          cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          modelProviders: [],
          sourceKinds: [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
          ],
        }),
      );
      for (const item of p.data)
        yield metadata(item, client.transport === "stdio");
      if (!p.nextCursor) return;
      if (seen.has(p.nextCursor)) bad();
      seen.add(p.nextCursor);
      cursor = p.nextCursor;
    }
    throw new AdapterError("unavailable", "Codex 会话分页超过查询上限");
  }
  return {
    agent: "codex",
    capabilities: () => ({
      listSessions: true,
      snapshot: true,
      sendMessage: !!options.bindings,
      runPrompt: false,
      ...(options.bindings ? { createSession: true } : {}),
    }),
    async dispose() {
      disposed = true;
      for (const starter of activeStarters) {
        try {
          starter.close();
        } catch {
          /* 已断开的连接无需重试。 */
        }
      }
      activeStarters.clear();
      const pending = writeConnection;
      writeConnection = undefined;
      if (pending) {
        try {
          (await pending).close();
        } catch {
          /* 已断开的连接无需重试。 */
        }
      }
    },
    async createSession({ cwd }) {
      if (!options.bindings)
        throw new AdapterError("invalid_input", "Codex 未启用专用会话创建");
      if (typeof cwd !== "string" || !isAbsolute(cwd))
        throw new AdapterError("invalid_input", "工作目录必须为绝对路径");
      let directory: string;
      try {
        directory = await realpath(cwd);
        if (!(await stat(directory)).isDirectory()) throw new Error();
      } catch {
        throw new AdapterError("invalid_input", "工作目录不存在或不可访问");
      }
      const client = await writer();
      let created: unknown;
      try {
        created = object(
          await client.request("thread/start", { cwd: directory }),
        ).thread;
      } catch {
        throw new AdapterError(
          "unavailable",
          "Codex 专用会话创建未确认，请先检查会话列表，不自动重试",
        );
      }
      const id = string(object(created).id);
      checkId(id);
      options.bindings.register({
        session_id: id,
        endpoint,
        created_at: Date.now(),
      });
      return metadata(created);
    },
    async startVisibleSession({
      cwd,
      content,
      title,
      delivery = "auto",
    }): Promise<StartVisibleSessionResult> {
      if (disposed)
        return { status: "rejected", reason: "Codex Adapter 已停止" };
      if (typeof cwd !== "string" || !isAbsolute(cwd))
        throw new AdapterError("invalid_input", "工作目录必须为绝对路径");
      if (typeof content !== "string" || !content.trim())
        throw new AdapterError("invalid_input", "消息不能为空");
      if (delivery !== "auto" && delivery !== "queue")
        throw new AdapterError("invalid_input", "delivery 仅支持 auto 或 queue");
      let directory: string;
      try {
        directory = await realpath(cwd);
        if (!(await stat(directory)).isDirectory()) throw new Error();
      } catch {
        throw new AdapterError("invalid_input", "工作目录不存在或不可访问");
      }
      let daemonForQueue: CodexClient | undefined;
      if (delivery === "queue") {
        // 先确认本机 daemon 可达，避免建出空白会话后才发现无法入队。
        try {
          daemonForQueue = await writer();
        } catch {
          return {
            status: "rejected",
            reason: "Codex 本机 daemon 未在线，无法使用桌面无锁排队模式",
          };
        }
      }
      const sessionTitle = deriveSessionTitle(content, title);
      let targetThreadId: string | null = null;
      let targetTurnId: string | null = null;
      let seenActive = false;
      let titleApplied = false;
      let closingStarter = false;
      const completedTurns = new Set<string>();
      let resolveBootstrap: (() => void) | undefined;
      let starter: (CodexClient & { closed?: Promise<void> }) | undefined;
      async function applyTitleOnce(client: CodexClient, tid: string) {
        if (!sessionTitle || titleApplied) return;
        try {
          await client.request("thread/name/set", { threadId: tid, name: sessionTitle });
          titleApplied = true;
        } catch {
          /* 设置标题为尽力操作，不影响会话创建与任务执行。 */
        }
      }
      function releaseStarter() {
        if (closingStarter || !starter) return;
        closingStarter = true;
        const current = starter;
        void (async () => {
          if (targetThreadId) await applyTitleOnce(current, targetThreadId);
          current.close();
        })().catch(() => {
          try { current.close(); } catch { /* 忽略重复关闭 */ }
        });
      }
      try {
        starter = await openVisibleStarter({
          onNotification: (method, params) => {
            const payload =
              params && typeof params === "object" && !Array.isArray(params)
                ? (params as RecordValue)
                : null;
            const tid = typeof payload?.threadId === "string" ? payload.threadId : null;
            if (method === "turn/completed") {
              if (!tid || (targetThreadId && tid !== targetThreadId)) return;
              const turnObj =
                payload?.turn && typeof payload.turn === "object" && !Array.isArray(payload.turn)
                  ? (payload.turn as RecordValue)
                  : null;
              const doneId = typeof turnObj?.id === "string" ? turnObj.id : null;
              if (doneId) completedTurns.add(doneId);
              if (delivery === "queue") {
                if (!targetTurnId || !doneId || doneId === targetTurnId) resolveBootstrap?.();
              } else if (targetTurnId && (!doneId || doneId === targetTurnId)) {
                releaseStarter();
              }
              return;
            }
            if (method === "thread/status/changed") {
              if (!tid || !targetThreadId || tid !== targetThreadId) return;
              const statusObj =
                payload?.status && typeof payload.status === "object" && !Array.isArray(payload.status)
                  ? (payload.status as RecordValue)
                  : null;
              const statusType = typeof statusObj?.type === "string" ? statusObj.type : null;
              if (statusType === "active") {
                seenActive = true;
              } else if (seenActive && targetTurnId && (statusType === "idle" || statusType === "systemError")) {
                if (delivery === "queue") resolveBootstrap?.();
                else releaseStarter();
              }
            }
          },
          onClose: () => {
            if (starter) activeStarters.delete(starter);
            resolveBootstrap?.();
          },
        });
      } catch {
        return {
          status: "rejected",
          reason: "无法启动本机 Codex CLI，无法创建桌面可见会话",
        };
      }
      activeStarters.add(starter);

      let id: string;
      try {
        // 使用短生命周期 stdio app-server 创建桌面可见会话（source: vscode），首轮结束后退出进程释放 active writer 锁。
        const created = object(
          await starter.request("thread/start", { cwd: directory, sandbox: "workspace-write" }),
        ).thread;
        id = string(object(created).id);
        checkId(id);
        targetThreadId = id;
      } catch (error) {
        starter.close();
        activeStarters.delete(starter);
        if (error instanceof CodexTransportError && !error.dispatched) {
          return {
            status: "rejected",
            reason: "无法连接本机 Codex 启动进程，无法创建桌面可见会话",
          };
        }
        return {
          status: "unknown",
          error: "Codex 桌面会话创建结果未知，请先在 Codex Desktop 核对，不自动回退或重发",
        };
      }

      if (delivery === "queue") {
        // 两阶段无锁模式：简短初始化首轮落盘 + 设标题 + 立即退出释放锁 → 经 daemon thread/queue/add 入队真实任务。
        let bootstrapDone = false;
        const bootstrapFinished = new Promise<void>((resolve) => {
          resolveBootstrap = () => {
            bootstrapDone = true;
            resolve();
          };
        });
        try {
          const boot = object(
            await starter.request("turn/start", {
              threadId: id,
              input: [{ type: "text", text: BOOTSTRAP_PROMPT }],
            }),
          );
          const bootTurnId = string(object(boot.turn).id);
          if (!bootTurnId.trim()) bad();
          targetTurnId = bootTurnId;
          if (!completedTurns.has(bootTurnId)) {
            const timeoutMs = options.bootstrapTimeoutMs ?? 25_000;
            await Promise.race([
              bootstrapFinished,
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, timeoutMs);
                timer.unref?.();
              }),
            ]);
          } else {
            bootstrapDone = true;
          }
          await applyTitleOnce(starter, id);
        } catch {
          starter.close();
          activeStarters.delete(starter);
          return {
            status: "failed",
            error: `Codex 桌面会话（${id}）初始化阶段失败，未提交任务`,
          };
        }
        starter.close();
        activeStarters.delete(starter);
        if (starter.closed) {
          await Promise.race([
            starter.closed,
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2_000);
              timer.unref?.();
            }),
          ]);
        }
        if (!bootstrapDone) {
          return {
            status: "failed",
            error: `Codex 桌面会话（${id}）初始化等待超时，未入队真实任务，请在 Codex Desktop 核对`,
          };
        }
        try {
          const queued = object(
            await daemonForQueue!.request("thread/queue/add", {
              threadId: id,
              input: [{ type: "text", text: content }],
              clientUserMessageId: randomUUID(),
            }),
          );
          const queueId = string(object(queued.queuedSubmission).id);
          if (!queueId.trim()) bad();
          return {
            status: "started",
            session_id: id,
            external_ref: queueId,
            project_name: basename(directory) || null,
            delivery: "queue",
            title: sessionTitle,
          };
        } catch (error) {
          if (error instanceof CodexTransportError) writeConnection = undefined;
          const rejected =
            error instanceof CodexRpcError &&
            [-32600, -32601, -32602, -32001].includes(error.code);
          return rejected
            ? {
                status: "failed",
                error: `Codex 无锁桌面会话（${id}）已创建，但任务入队被拒绝`,
              }
            : {
                status: "unknown",
                error: `Codex 无锁桌面会话（${id}）任务入队结果未知，请先核对目标队列，不要重复提交`,
              };
        }
      }

      try {
        const result = object(
          await starter.request("turn/start", {
            threadId: id,
            input: [{ type: "text", text: content }],
          }),
        );
        const turnId = string(object(result.turn).id);
        if (!turnId.trim()) bad();
        targetTurnId = turnId;
        await applyTitleOnce(starter, id);
        if (completedTurns.has(turnId)) releaseStarter();
        return {
          status: "started",
          session_id: id,
          external_ref: turnId,
          project_name: basename(directory) || null,
          delivery: "auto",
          title: sessionTitle,
        };
      } catch (error) {
        starter.close();
        activeStarters.delete(starter);
        const rejected =
          error instanceof CodexRpcError &&
          [-32600, -32601, -32602, -32001].includes(error.code);
        return rejected
          ? {
              status: "failed",
              error: `Codex 桌面会话（${id}）已创建，但首轮提交被拒绝`,
            }
          : {
              status: "unknown",
              error: `Codex 桌面会话（${id}）首轮提交结果未知，请先核对目标轮次，不要重复提交`,
            };
      }
    },
    async sendMessage(sessionId, text, sendOptions): Promise<SendResult> {
      if (!options.bindings)
        return { status: "rejected", reason: "Codex 第一版不支持发送消息" };
      checkId(sessionId);
      if (typeof text !== "string" || !text.trim())
        return { status: "rejected", reason: "消息不能为空" };
      if (sendOptions?.visibleOnly && bound(sessionId))
        return { status: "rejected", reason: "目标是 Relay 专用后台会话，请提供 Codex 桌面或 CLI 会话 ID" };
      if (sending.has(sessionId))
        return { status: "rejected", reason: "此会话正在发送消息" };
      sending.add(sessionId);
      let starting = false;
      try {
        const client = await writer();
        if (bound(sessionId)) {
          // 专用后台会话：沿用 turn/start，需先确认空闲可写。
          const reason = await writableState(client, sessionId);
          if (reason) return { status: "rejected", reason };
          starting = true;
          const result = object(
            await client.request("turn/start", {
              threadId: sessionId,
              input: [{ type: "text", text }],
            }),
          );
          const turnId = string(object(result.turn).id);
          if (!turnId.trim()) bad();
          return { status: "sent", external_ref: turnId };
        }
        // 桌面/其他会话：thread/queue/add 排队投递，绕过桌面 active writer 独占，agent 醒来后消费。
        starting = true;
        const result = object(
          await client.request("thread/queue/add", {
            threadId: sessionId,
            input: [{ type: "text", text }],
            clientUserMessageId: randomUUID(),
          }),
        );
        const queueId = string(object(result.queuedSubmission).id);
        if (!queueId.trim()) bad();
        return { status: "sent", external_ref: queueId };
      } catch (error) {
        if (error instanceof CodexTransportError) writeConnection = undefined;
        // 请求已经发出却缺少可靠回执（包括畸形响应），不能当作未发送。
        const rejected =
          error instanceof CodexRpcError &&
          [-32600, -32601, -32602, -32001].includes(error.code);
        const unknown =
          starting &&
          !rejected &&
          (!(error instanceof CodexTransportError) || error.dispatched);
        return unknown
          ? {
              status: "unknown",
              error: "Codex 接收结果未知，请核对目标轮次；不要重复发送",
            }
          : {
              status: "failed",
              error:
                "Codex 连接、会话恢复或发送被拒绝，请检查后台实例和原权限配置",
            };
      } finally {
        sending.delete(sessionId);
      }
    },
    async runPrompt() {
      return {
        status: "rejected",
        reason: "Codex 开新会话执行安装为后续版本预留",
      };
    },
    async listSessions({ limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new AdapterError(
          "invalid_input",
          "会话数量必须为 1～1000 的整数",
        );
      return using(async (client) => {
        const result = new Map<string, SessionInfo>();
        for await (const session of sessions(client, false)) {
          result.set(session.id, session);
          if (result.size >= limit) break;
        }
        return [...result.values()];
      });
    },
    async incremental(sessionId, baseline = null) {
      const snap = await this.snapshot(sessionId, baseline, {
        incremental: true,
      });
      return {
        title: snap.check_error ? undefined : snap.title,
        events: snap.events ?? [],
        cursor: snap.cursor,
        has_more: false,
        closed: snap.closed,
      };
    },
    async messageProgress(sessionId, message) {
      checkId(sessionId);
      return using(async client => {
        const matches: RecordValue[] = [];
        let exactMatch: RecordValue | null = null;
        let next: string | null = null, incomplete = false, uncertain = false;
        const seen = new Set<string>();
        const note = "只读持久化历史；轮次结束不等于业务完成，未观察到或 interrupted 不证明任务未执行。";
        // 排队回执不是 turn ID；按落库时间和原正文核对，多个匹配时不猜测。新建可见会话的首轮 external_ref 即 turn ID，可精确匹配。
        for (let n = 0; n < 20; n++) {
          let turns: { data: unknown[]; nextCursor: string | null };
          try {
            turns = page(await client.request("thread/turns/list", {
              threadId: sessionId, limit: 50, cursor: next, sortDirection: "desc", itemsView: "full",
            }));
          } catch (error) {
            if (
              n === 0 &&
              error instanceof CodexRpcError &&
              error.code === -32600 &&
              error.message.startsWith(`thread ${sessionId} is not materialized yet;`)
            ) {
              return { status: "not_observed", turn_id: null, reply: null, truncated: false, note };
            }
            throw error;
          }
          let before = false;
          for (const raw of turns.data) {
            const candidate = object(raw);
            if (!Array.isArray(candidate.items)) bad();
            if (message.external_ref && candidate.id === message.external_ref) {
              exactMatch = candidate;
              break;
            }
            const started = candidate.startedAt == null ? null : millis(candidate.startedAt);
            // CLI 时间为秒精度，允许当前秒；正文相同时仍做歧义检查。
            if (started !== null && started < Math.floor(message.created_at / 1000) * 1000) { before = true; continue; }
            const prompts = candidate.items.map(object).filter(item => item.type === "userMessage");
            const matching = prompts.filter(item => Array.isArray(item.content) && item.content.map(object)
              .filter(block => block.type === "text").map(block => string(block.text)).join("\n").trim() === message.content.trim());
            if (matching.some(item => typeof item.startedAtMs === "number" && item.startedAtMs >= message.created_at)) {
              if (prompts.length !== 1) uncertain = true;
              matches.push(candidate);
            } else if (matching.some(item => item.startedAtMs == null)) {
              // 只有秒精度的轮次时间，无法排除同秒旧消息。
              uncertain = true;
            }
          }
          if (exactMatch || before || !turns.nextCursor) break;
          if (seen.has(turns.nextCursor)) bad();
          seen.add(turns.nextCursor); next = turns.nextCursor;
          if (n === 19) incomplete = true;
        }
        if (!exactMatch && (incomplete || uncertain || matches.length > 1)) return {
          status: "unknown", turn_id: null, reply: null, truncated: false,
          note: incomplete ? "查询达到上限，无法唯一关联本次任务" : "匹配存在歧义或缺少时间证据，无法唯一关联本次任务",
        };
        const selected = exactMatch ?? matches[0];
        if (!selected) return { status: "not_observed", turn_id: null, reply: null, truncated: false, note };
        const messages = (selected.items as unknown[]).map(object).filter(item => item.type === "agentMessage");
        const finals = messages.filter(item => item.phase === "final_answer");
        const chosen = (finals.length ? finals : messages).at(-1);
        const reply = chosen ? string(chosen.text) : null;
        const status: MessageProgress["status"] = selected.status === "completed" ? "completed"
          : selected.status === "failed" ? "failed" : selected.status === "inProgress" ? "observed" : "unknown";
        return { status, turn_id: string(selected.id), reply: reply?.slice(0, 16000) ?? null,
          truncated: (reply?.length ?? 0) > 16000, note };
      });
    },
    async snapshot(sessionId, baseline = null, readOptions = {}) {
      checkId(sessionId);
      if (
        baseline !== null &&
        (typeof baseline !== "object" ||
          (baseline.target_turn_id !== undefined &&
            (typeof baseline.target_turn_id !== "string" ||
              !baseline.target_turn_id.trim())) ||
          (baseline.turn_status !== undefined &&
            typeof baseline.turn_status !== "string") ||
          typeof baseline.uuid !== "string" ||
          !baseline.uuid.startsWith("codex:") ||
          !Number.isFinite(baseline.timestamp) ||
          baseline.timestamp < 0)
      )
        throw new AdapterError("invalid_input", "Codex 快照基线格式无效");
      return using(async (client) => {
        // read 本身不暴露归档标志，因此通过完整归档分页确认，不依赖不稳定的文件路径。
        for await (const session of sessions(client, true))
          if (session.id === sessionId) return closedSnapshot();
        let metadata: SessionInfo;
        try {
          metadata = info(
            object(
              await client.request("thread/read", {
                threadId: sessionId,
                includeTurns: false,
              }),
            ).thread,
            bound(sessionId),
            client.transport === "stdio",
          );
        } catch (error) {
          // 只有明确的不存在错误且活动列表也找不到时，才认定删除。
          if (
            !(error instanceof CodexRpcError) ||
            error.code !== -32600 ||
            !/^(thread not found|thread not loaded|no rollout found for thread id)/i.test(
              error.message,
            )
          )
            throw error;
          for await (const session of sessions(client, false))
            if (session.id === sessionId) throw error;
          return closedSnapshot();
        }
        if (metadata.id !== sessionId) bad();
        const statusContext: NonNullable<Snapshot["status_context"]> = {
          runtime_source: client.transport === "stdio" ? "codex_history_reader" : "codex_daemon",
          turn_status_source: "persisted_history",
          turn_status_scope: "historical",
          note: "轮次状态来自持久化历史，不代表当前执行状态；interrupted、runtime=unknown 和 held 不能单独证明卡住或需要用户。新增内容需结合正文判断；活动时间变化只说明会话有更新。事件游标时间不是消息产生时间。",
        };
        const target = baseline?.target_turn_id;
        const increment: NonNullable<Snapshot["events"]> = [];
        let latest: RecordValue | null = null;
        let completedTurn: RecordValue | null = null;
        let next: string | null = null;
        const seen = new Set<string>();
        for (let n = 0; n < 1000; n++) {
          let turns: { data: unknown[]; nextCursor: string | null };
          try {
            turns = page(
              await client.request("thread/turns/list", {
                threadId: sessionId,
                limit: target || baseline || readOptions.incremental ? 50 : 1,
                cursor: next,
                sortDirection: "desc",
                itemsView: "full",
              }),
            );
          } catch (error) {
            // daemon 在首条消息前尚未物化历史；仅对已登记且确认为 idle 的空会话接受这一精确错误。
            if (
              bound(sessionId) &&
              metadata.runtime === "idle" &&
              !target &&
              error instanceof CodexRpcError &&
              error.code === -32600 &&
              error.message.startsWith(
                `thread ${sessionId} is not materialized yet;`,
              )
            )
              turns = { data: [], nextCursor: null };
            else throw error;
          }
          let reachedBaseline = false;
          for (const value of turns.data) {
            const candidate = object(value),
              id = string(candidate.id),
              status = string(candidate.status);
            if (target && id !== target) continue;
            latest ??= candidate;
            const sameTurn = baseline?.uuid.startsWith(`codex:${id}:`) ?? false;
            const started =
              candidate.startedAt == null ? null : millis(candidate.startedAt);
            const ended =
              candidate.completedAt == null
                ? null
                : millis(candidate.completedAt);
            // 独立历史实例会把桌面正在执行的轮次读成 interrupted，不能仅接受 inProgress 基线。
            const after =
              !baseline ||
              (!sameTurn &&
                started !== null &&
                started >= baseline.timestamp) ||
              (sameTurn &&
                (baseline.turn_status === "inProgress" ||
                  (baseline.turn_status === "interrupted" &&
                    ended !== null &&
                    ended >= baseline.timestamp)));
            const digest = createHash("sha256")
              .update(JSON.stringify([status, candidate.items]))
              .digest("hex")
              .slice(0, 24);
            const eventCursor = {
              uuid: `codex:${id}:${digest}`,
              timestamp: ended ?? started ?? metadata.last_activity_at!,
              turn_status: status,
            };
            if (
              (!sameTurn || baseline?.uuid !== eventCursor.uuid) &&
              (after || sameTurn)
            ) {
              if (!Array.isArray(candidate.items)) bad();
              const turnEvents: typeof increment = [];
              for (const [itemIndex, raw] of candidate.items.entries()) {
                const item = object(raw);
                if (
                  item.type === "agentMessage" &&
                  typeof item.text === "string"
                )
                  turnEvents.push({
                    id: `${id}:${String(item.id ?? itemIndex)}:${createHash("sha256").update(item.text).digest("hex")}`,
                    kind: "assistant",
                    text: item.text,
                    cursor: eventCursor,
                  });
              }
              turnEvents.push({
                id: `turn:${id}:${status}`,
                kind: "turn",
                text: JSON.stringify({ turn_id: id, status, status_context: statusContext }),
                cursor: eventCursor,
              });
              increment.unshift(...turnEvents);
            }
            const terminal =
              status === "completed" ||
              status === "failed" ||
              (target && status === "interrupted");
            // 新一轮开始不应掩盖订阅后已结束的上一轮；当前忙碌仅阻止把最新轮次误判为空闲。
            if (
              (target || after) &&
              terminal &&
              (target || metadata.runtime !== "busy" || candidate !== latest)
            ) {
              completedTurn ??= candidate;
            }
            if (target || (!baseline && !readOptions.incremental) || sameTurn) {
              reachedBaseline = true;
              break;
            }
          }
          if (reachedBaseline || !turns.nextCursor) break;
          if (seen.has(turns.nextCursor)) bad();
          seen.add(turns.nextCursor);
          next = turns.nextCursor;
          if (n === 999)
            throw new AdapterError("unavailable", "目标轮次分页超过查询上限");
        }
        let cursor: SessionCursor | null = null;
        let finished: Snapshot["finished_turn"] = null;
        let reply: string | null = null;
        let activity = metadata.last_activity_at!;
        if (latest) {
          const id = string(latest.id),
            status = string(latest.status);
          if (!Array.isArray(latest.items)) bad();
          const started =
            latest.startedAt == null ? null : millis(latest.startedAt);
          const completed =
            latest.completedAt == null ? null : millis(latest.completedAt);
          activity = Math.max(activity, completed ?? started ?? 0);
          const messages = latest.items
            .map(object)
            .filter((item) => item.type === "agentMessage");
          for (const item of messages) reply = string(item.text).slice(0, 1000);
          // 轮次 ID 与内容摘要都进入游标，刷新同一轮的状态/回复也能观察到变化。
          const digest = createHash("sha256")
            .update(JSON.stringify([status, latest.items]))
            .digest("hex")
            .slice(0, 24);
          cursor = {
            uuid: `codex:${id}:${digest}`,
            timestamp: activity,
            turn_status: status,
          };
        }
        if (completedTurn) {
          if (!Array.isArray(completedTurn.items)) bad();
          const messages = completedTurn.items
            .map(object)
            .filter((item) => item.type === "agentMessage");
          const finals = messages.filter(
            (item) => item.phase === "final_answer",
          );
          const chosen = (finals.length ? finals : messages).at(-1);
          reply = chosen ? string(chosen.text).slice(0, 1000) : null;
          finished = {
            result:
              completedTurn.status === "completed" ? "completed" : "failed",
            external_ref: string(completedTurn.id),
          };
        }
        return {
          ...metadata,
          closed: false,
          cursor,
          last_activity_at: activity,
          status_context: statusContext,
          runtime_error: null,
          runtime_note:
            metadata.runtime === "unknown"
              ? client.transport === "stdio"
                ? "当前读取持久化历史，无法确认桌面会话的实时运行状态"
                : bound(sessionId)
                  ? "专用后台会话尚未加载，发送前将重新核对状态"
                  : "daemon 无法确认桌面会话的实时运行状态"
              : null,
          check_error: null,
          finished_turn: finished,
          last_reply: reply,
          events: increment,
        };
      });
    },
  };
}
