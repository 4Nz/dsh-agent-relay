import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";

export interface AgyBridgeRegistration {
  pid: number;
  app_data_dir: string | null;
  version: string | null;
  registered_at: number;
  last_seen: number;
}

export type AgyBridgeAction = "get_conversation" | "list_conversations" | "send_message";

export interface AgyBridgeCommand {
  request_id: string;
  action: AgyBridgeAction;
  payload: Record<string, unknown>;
}

export interface AgyBridgeConversation {
  found: boolean;
  id?: string;
  title?: string | null;
  summary?: string | null;
  archived?: boolean;
  runState?: string | null;
  updateTime?: string | null;
  projectId?: string | null;
}

export type AgyBridgeSendOutcome =
  | { status: "sent" }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };

interface Waiter {
  resolve: (commands: AgyBridgeCommand[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Entry extends AgyBridgeRegistration {
  waiters: Waiter[];
}

interface QueuedCommand {
  command: AgyBridgeCommand;
  targetPid?: number;
}

interface PendingCall {
  dispatched: boolean;
  resolve: (result: { ok: boolean; value?: unknown; error?: string; timedOutAfterDispatch?: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}

function normalizeAppDataDir(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const resolved = resolvePath(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

export function createAgyBridgeService({
  now = Date.now,
  onlineMs = 60_000,
  requestTimeoutMs = 20_000,
}: {
  now?: () => number;
  onlineMs?: number;
  requestTimeoutMs?: number;
} = {}) {
  const entries = new Map<number, Entry>();
  const queue: QueuedCommand[] = [];
  const pending = new Map<string, PendingCall>();
  let disposed = false;

  function online(entry: Entry): boolean {
    return now() - entry.last_seen <= onlineMs;
  }

  function pruneStaleEntries() {
    const at = now();
    for (const [pid, entry] of entries) {
      if (at - entry.last_seen > onlineMs * 10 && entry.waiters.length === 0) {
        entries.delete(pid);
      }
    }
  }

  function takeCommandFor(pid: number): AgyBridgeCommand | null {
    const idx = queue.findIndex((item) => item.targetPid === undefined || item.targetPid === pid);
    if (idx < 0) return null;
    const [item] = queue.splice(idx, 1);
    return item!.command;
  }

  function pump() {
    if (disposed || !queue.length) return;
    for (const entry of entries.values()) {
      if (!online(entry)) continue;
      while (entry.waiters.length && queue.length) {
        const command = takeCommandFor(entry.pid);
        if (!command) break;
        const waiter = entry.waiters.shift()!;
        clearTimeout(waiter.timer);
        const call = pending.get(command.request_id);
        if (call) call.dispatched = true;
        waiter.resolve([command]);
      }
      if (!queue.length) break;
    }
  }

  function orderedOnlinePids(preferredAppDataDir?: string | null): number[] {
    const active = [...entries.values()]
      .filter(online)
      .sort((a, b) => b.last_seen - a.last_seen);
    const preferred = normalizeAppDataDir(preferredAppDataDir);
    if (!preferred) return active.map((entry) => entry.pid);
    const matched: number[] = [];
    const fallback: number[] = [];
    for (const entry of active) {
      if (normalizeAppDataDir(entry.app_data_dir) === preferred) matched.push(entry.pid);
      else fallback.push(entry.pid);
    }
    return [...matched, ...fallback];
  }

  function invoke(
    action: AgyBridgeAction,
    payload: Record<string, unknown>,
    timeoutMs = requestTimeoutMs,
    targetPid?: number,
  ): Promise<{ ok: boolean; value?: unknown; error?: string; timedOutAfterDispatch?: boolean }> {
    const hasTarget =
      targetPid !== undefined
        ? Boolean(entries.get(targetPid) && online(entries.get(targetPid)!))
        : [...entries.values()].some(online);
    if (disposed || !hasTarget) {
      return Promise.resolve({ ok: false, error: "Antigravity 桌面桥接 Sidecar 未在线" });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const call: PendingCall = {
        dispatched: false,
        resolve: (res) => {
          clearTimeout(call.timer);
          pending.delete(requestId);
          resolve(res);
        },
        timer: setTimeout(() => {
          pending.delete(requestId);
          const idx = queue.findIndex((item) => item.command.request_id === requestId);
          if (idx >= 0) queue.splice(idx, 1);
          resolve({
            ok: false,
            error: call.dispatched
              ? "等待 Antigravity Sidecar 响应超时，结果未知"
              : "等待 Antigravity Sidecar 接收请求超时",
            timedOutAfterDispatch: call.dispatched,
          });
        }, timeoutMs),
      };
      pending.set(requestId, call);
      queue.push({ command: { request_id: requestId, action, payload }, targetPid });
      pump();
    });
  }

  return {
    poll(
      input: { pid: number; app_data_dir: string | null; version: string | null },
      waitMs = 25_000,
    ): Promise<AgyBridgeCommand[]> {
      if (disposed) return Promise.resolve([]);
      pruneStaleEntries();
      let entry = entries.get(input.pid);
      if (!entry) {
        entry = {
          pid: input.pid,
          app_data_dir: input.app_data_dir,
          version: input.version,
          registered_at: now(),
          last_seen: now(),
          waiters: [],
        };
        entries.set(input.pid, entry);
      }
      entry.last_seen = now();
      entry.app_data_dir = input.app_data_dir;
      entry.version = input.version;

      const immediate = takeCommandFor(entry.pid);
      if (immediate) {
        const call = pending.get(immediate.request_id);
        if (call) call.dispatched = true;
        return Promise.resolve([immediate]);
      }

      const target = entry;
      return new Promise<AgyBridgeCommand[]>((resolve) => {
        const waiter: Waiter = {
          resolve,
          timer: setTimeout(() => {
            target.waiters = target.waiters.filter((w) => w !== waiter);
            target.last_seen = now();
            resolve([]);
          }, waitMs),
        };
        target.waiters.push(waiter);
      });
    },

    complete(input: {
      request_id: string;
      ok: boolean;
      value?: unknown;
      error?: string | null;
    }): { ok: boolean; message: string } {
      const call = pending.get(input.request_id);
      if (!call) return { ok: false, message: "请求不存在或已超时" };
      call.resolve({
        ok: input.ok,
        value: input.value,
        error: input.error ?? undefined,
      });
      return { ok: true, message: "已接收结果" };
    },

    isOnline(): boolean {
      return !disposed && [...entries.values()].some(online);
    },

    registrations(): AgyBridgeRegistration[] {
      return [...entries.values()]
        .filter(online)
        .map(({ pid, app_data_dir, version, registered_at, last_seen }) => ({
          pid,
          app_data_dir,
          version,
          registered_at,
          last_seen,
        }));
    },

    async getConversation(
      conversationId: string,
      options?: { preferredAppDataDir?: string | null },
    ): Promise<AgyBridgeConversation | null> {
      const pids = orderedOnlinePids(options?.preferredAppDataDir);
      if (!pids.length) return null;
      let sawNotFound = false;
      for (const pid of pids) {
        const res = await invoke("get_conversation", { conversation_id: conversationId }, 8_000, pid);
        if (!res.ok || !res.value || typeof res.value !== "object") continue;
        const conv = res.value as AgyBridgeConversation;
        if (conv.found) return conv;
        sawNotFound = true;
      }
      return sawNotFound ? { found: false } : null;
    },

    async sendMessage(
      conversationId: string,
      content: string,
      options?: { preferredAppDataDir?: string | null },
    ): Promise<AgyBridgeSendOutcome> {
      const pids = orderedOnlinePids(options?.preferredAppDataDir);
      if (!pids.length) {
        return { status: "rejected", reason: "Antigravity 桌面桥接 Sidecar 未在线" };
      }
      let lastError: string | undefined;
      for (let i = 0; i < pids.length; i++) {
        const pid = pids[i]!;
        const hasMore = i < pids.length - 1;
        const res = await invoke(
          "send_message",
          { conversation_id: conversationId, content },
          requestTimeoutMs,
          pid,
        );
        if (!res.ok) {
          if (res.timedOutAfterDispatch) {
            return {
              status: "unknown",
              error: res.error ?? "等待 Antigravity Sidecar 投递回执超时，结果未知",
            };
          }
          lastError = res.error;
          if (hasMore) continue;
          return {
            status: "rejected",
            reason: res.error ?? "Antigravity 桌面桥接 Sidecar 未在线",
          };
        }
        const value = (res.value ?? {}) as { status?: string; reason?: string; error?: string };
        if (value.status === "sent") return { status: "sent" };
        if (value.status === "rejected") {
          // 仅在尚未调用 agentapi 的前置会话查找返回不存在时，允许尝试其他在线 Sidecar。
          if (value.reason === "外部会话不存在" && hasMore) continue;
          return { status: "rejected", reason: value.reason ?? "Antigravity 拒绝接收消息" };
        }
        if (value.status === "unknown") {
          return { status: "unknown", error: value.error ?? "Antigravity 投递结果未知" };
        }
        return { status: "failed", error: value.error ?? "Antigravity 消息发送失败" };
      }
      return {
        status: "rejected",
        reason: lastError ?? "Antigravity 桌面桥接 Sidecar 未在线",
      };
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        for (const waiter of entry.waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve([]);
        }
        entry.waiters = [];
      }
      for (const [id, call] of pending.entries()) {
        clearTimeout(call.timer);
        pending.delete(id);
        call.resolve({ ok: false, error: "插件正在停止" });
      }
      queue.length = 0;
    },
  };
}

export type AgyBridgeService = ReturnType<typeof createAgyBridgeService>;
