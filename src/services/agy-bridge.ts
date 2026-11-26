import { randomUUID } from "node:crypto";

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

interface PendingCall {
  dispatched: boolean;
  resolve: (result: { ok: boolean; value?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
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
  const queue: AgyBridgeCommand[] = [];
  const pending = new Map<string, PendingCall>();
  let disposed = false;

  function online(entry: Entry): boolean {
    return now() - entry.last_seen <= onlineMs;
  }

  function pump() {
    if (disposed || !queue.length) return;
    for (const entry of entries.values()) {
      if (!online(entry)) continue;
      while (entry.waiters.length && queue.length) {
        const waiter = entry.waiters.shift()!;
        const command = queue.shift()!;
        clearTimeout(waiter.timer);
        const call = pending.get(command.request_id);
        if (call) call.dispatched = true;
        waiter.resolve([command]);
      }
      if (!queue.length) break;
    }
  }

  function invoke(
    action: AgyBridgeAction,
    payload: Record<string, unknown>,
    timeoutMs = requestTimeoutMs,
  ): Promise<{ ok: boolean; value?: unknown; error?: string; timedOutAfterDispatch?: boolean }> {
    if (disposed || ![...entries.values()].some(online)) {
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
          const idx = queue.findIndex((item) => item.request_id === requestId);
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
      queue.push({ request_id: requestId, action, payload });
      pump();
    });
  }

  return {
    poll(
      input: { pid: number; app_data_dir: string | null; version: string | null },
      waitMs = 25_000,
    ): Promise<AgyBridgeCommand[]> {
      if (disposed) return Promise.resolve([]);
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

      if (queue.length) {
        const command = queue.shift()!;
        const call = pending.get(command.request_id);
        if (call) call.dispatched = true;
        return Promise.resolve([command]);
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

    async getConversation(conversationId: string): Promise<AgyBridgeConversation | null> {
      const res = await invoke("get_conversation", { conversation_id: conversationId }, 8_000);
      if (!res.ok || !res.value || typeof res.value !== "object") return null;
      return res.value as AgyBridgeConversation;
    },

    async sendMessage(conversationId: string, content: string): Promise<AgyBridgeSendOutcome> {
      const res = await invoke(
        "send_message",
        { conversation_id: conversationId, content },
        requestTimeoutMs,
      );
      if (!res.ok) {
        if (res.timedOutAfterDispatch) {
          return {
            status: "unknown",
            error: res.error ?? "等待 Antigravity Sidecar 投递回执超时，结果未知",
          };
        }
        return {
          status: "rejected",
          reason: res.error ?? "Antigravity 桌面桥接 Sidecar 未在线",
        };
      }
      const value = (res.value ?? {}) as { status?: string; reason?: string; error?: string };
      if (value.status === "sent") return { status: "sent" };
      if (value.status === "rejected") {
        return { status: "rejected", reason: value.reason ?? "Antigravity 拒绝接收消息" };
      }
      if (value.status === "unknown") {
        return { status: "unknown", error: value.error ?? "Antigravity 投递结果未知" };
      }
      return { status: "failed", error: value.error ?? "Antigravity 消息发送失败" };
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
