import type { RelayStore, Message } from "../storage/index.js";

// Claude Code channel 投递：channel server 随每个 Claude 进程启动，长轮询向 Relay 取消息。
// 登记以 claude 进程 pid 为键：会话内 /clear 会换会话 ID，而 channel server 不知情，
// 投递前用 `claude agents --json` 按 pid 解析该进程当前的会话 ID 和忙闲状态；
// pid 对不上时退回按 channel server 启动时的会话 ID 匹配。

export interface ClaudeAgentEntry {
  pid: number | null;
  sessionId: string;
  status: string | null;
}
export type ListClaudeAgents = () => Promise<ClaudeAgentEntry[] | string>;

export interface ChannelRegistration {
  pid: number;
  // channel server 启动时的会话 ID，仅作初始值、兜底匹配和展示。
  initial_session_id: string | null;
  version: string | null;
  registered_at: number;
  last_seen: number;
}
export interface ChannelPush {
  msg_id: string;
  content: string;
}
export type AcceptResult =
  | { status: "queued" }
  | { status: "rejected"; reason: string };

export const NOT_ENABLED =
  "该会话未启用 Agent Relay channel，请退出后用 claude 重新进入（需先完成前置安装接入）";

interface Waiter {
  resolve: (messages: ChannelPush[]) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Entry extends ChannelRegistration {
  waiters: Waiter[];
}

export function createClaudeChannelService({
  store,
  listAgents,
  now = Date.now,
  onlineMs = 60_000,
  ackTimeoutMs = 30 * 60_000,
  queueTimeoutMs = 24 * 3600_000,
  onError = () => {},
}: {
  store: Pick<RelayStore, "messages">;
  listAgents: ListClaudeAgents;
  now?: () => number;
  // 超过该时间没有轮询的登记视为离线。
  onlineMs?: number;
  // 推送后等待 ack 的最长时间，超时记 unknown，不重发。
  ackTimeoutMs?: number;
  // 排队等待会话空闲的最长时间，超时记 failed。
  queueTimeoutMs?: number;
  onError?: (error: unknown) => void;
}) {
  const entries = new Map<number, Entry>();
  // 连通测试的探测消息不入库，只在内存中等待 ack。
  const probes = new Map<string, (summary: string | null) => void>();
  let ticking: Promise<void> | null = null;
  let again = false;
  let disposed = false;

  function online(entry: Entry) {
    return now() - entry.last_seen <= onlineMs;
  }
  // 交给正在等待的长轮询；没有等待中的轮询时返回 false，消息保持原状态。
  function deliver(entry: Entry, push: ChannelPush) {
    const waiter = entry.waiters.shift();
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    waiter.resolve([push]);
    return true;
  }
  // Claude 进程与在线登记的对应：先按 pid，再按启动时的会话 ID。
  function entryOf(agent: ClaudeAgentEntry): Entry | null {
    const byPid = agent.pid !== null ? entries.get(agent.pid) : undefined;
    if (byPid && online(byPid)) return byPid;
    for (const entry of entries.values())
      if (online(entry) && entry.initial_session_id === agent.sessionId) return entry;
    return null;
  }

  async function runTick() {
    const at = now();
    // ack 超时：结果不明，保留 unknown，不重发。
    for (const message of store.messages.awaitingAck(Math.max(0, at - ackTimeoutMs)))
      store.messages.ackTimeout(message.id, "推送后超时未收到 Claude 确认，结果未知");
    // 排队超时：一直未等到会话空闲或 channel 在线。
    for (const message of store.messages.queuedBefore(Math.max(0, at - queueTimeoutMs)))
      store.messages.transition({
        id: message.id,
        expected_status: "queued",
        status: "failed",
        error: "等待会话空闲超时，消息未送达",
      });
    if (![...entries.values()].some((e) => online(e) && e.waiters.length)) return;
    const agents = await listAgents();
    if (typeof agents === "string") {
      onError(new Error(`无法查询 Claude 会话状态：${agents}`));
      return;
    }
    for (const agent of agents) {
      if (agent.status !== "idle") continue;
      const entry = entryOf(agent);
      if (!entry || !entry.waiters.length) continue;
      // 每个会话一次只推一条，等 ack 或超时后再推下一条。
      if (store.messages.inFlight("claude", agent.sessionId).length) continue;
      const next = store.messages.queued("claude", agent.sessionId)[0];
      if (!next) continue;
      const ok = store.messages.transition({
        id: next.id,
        expected_status: "queued",
        status: "sent",
        sent_at: now(),
        external_ref: `channel:${next.id}`,
      });
      if (ok) deliver(entry, { msg_id: next.id, content: next.content });
    }
  }

  // 串行执行；执行期间再次触发时在结束后补跑一轮。
  function tick(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      try {
        do {
          again = false;
          await runTick();
        } while (again && !disposed);
      } catch (error) {
        onError(error);
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }

  return {
    // channel server 的长轮询：同时作为登记和心跳。有消息时立即返回，否则等到超时返回空数组。
    poll(
      input: { pid: number; session_id: string | null; version: string | null },
      waitMs = 25_000,
    ): Promise<ChannelPush[]> {
      if (disposed) return Promise.resolve([]);
      let entry = entries.get(input.pid);
      if (!entry) {
        entry = { pid: input.pid, initial_session_id: input.session_id, version: input.version, registered_at: now(), last_seen: now(), waiters: [] };
        entries.set(input.pid, entry);
      }
      entry.last_seen = now();
      entry.version = input.version;
      const target = entry;
      const result = new Promise<ChannelPush[]>((resolve) => {
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
      void tick();
      return result;
    },
    // Claude 调用 ack 工具。探测消息只结束连通测试；普通消息记录 acked_at 后尝试推送下一条。
    ack(input: { msg_id: string; summary: string | null }): { ok: boolean; message: string } {
      const probe = probes.get(input.msg_id);
      if (probe) {
        probes.delete(input.msg_id);
        probe(input.summary);
        return { ok: true, message: "已确认" };
      }
      const message: Message | null = store.messages.get(input.msg_id);
      if (!message || message.agent !== "claude" || message.external_ref !== `channel:${message.id}`)
        return { ok: false, message: "消息不存在或不是 channel 投递" };
      const changed = store.messages.ack({
        id: message.id,
        acked_at: now(),
        summary: input.summary?.slice(0, 2000) ?? null,
      });
      void tick();
      return { ok: true, message: changed ? "已确认" : "此前已确认" };
    },
    // 转发服务调用：被终端持有的 Claude 会话有在线 channel 时允许入队，否则拒绝并说明原因。
    async accept(sessionId: string): Promise<AcceptResult> {
      const agents = await listAgents();
      if (typeof agents === "string")
        return { status: "rejected", reason: `无法确认会话状态：${agents}` };
      const agent = agents.find((a) => a.sessionId === sessionId);
      if (!agent || !entryOf(agent)) return { status: "rejected", reason: NOT_ENABLED };
      return { status: "queued" };
    },
    tick,
    // 在线登记；用于自检展示和连通测试。
    registrations(): ChannelRegistration[] {
      return [...entries.values()]
        .filter(online)
        .map(({ pid, initial_session_id, version, registered_at, last_seen }) => ({ pid, initial_session_id, version, registered_at, last_seen }));
    },
    // 连通测试：等待符合条件的 channel 登记（如测试开始后新启动的 Claude），推送探测消息并等 ack。
    async probe(
      match: (registration: ChannelRegistration) => boolean,
      content: (msgId: string) => string,
      { registerTimeoutMs = 60_000, ackTimeoutMs: wait = 90_000 } = {},
    ): Promise<{ status: "acked"; summary: string | null } | { status: "not_registered" } | { status: "no_ack" }> {
      const deadline = Date.now() + registerTimeoutMs;
      let entry: Entry | undefined;
      while (Date.now() < deadline && !disposed) {
        entry = [...entries.values()].find((e) => online(e) && match(e) && e.waiters.length);
        if (entry) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!entry) return { status: "not_registered" };
      const msgId = `probe-${entry.pid}-${now()}`;
      const acked = new Promise<string | null>((resolve) => probes.set(msgId, resolve));
      deliver(entry, { msg_id: msgId, content: content(msgId) });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), wait)));
      const result = await Promise.race([acked, timeout]);
      clearTimeout(timer);
      probes.delete(msgId);
      return result === "timeout" ? { status: "no_ack" } : { status: "acked", summary: result };
    },
    // 定时检查：推送排队消息、处理超时。返回停止函数。
    start(intervalMs = 5_000) {
      const timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    // 插件停止：结束所有挂起的长轮询，避免 HTTP 服务关闭时等待。
    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        for (const waiter of entry.waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve([]);
        }
        entry.waiters = [];
      }
    },
  };
}
export type ClaudeChannelService = ReturnType<typeof createClaudeChannelService>;
