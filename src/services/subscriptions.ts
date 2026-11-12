import { randomUUID } from "node:crypto";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { Snapshot } from "../adapters/types.js";
import type { RelayStore } from "../storage/index.js";
import type { Agent, Subscription, SubscriptionType } from "../storage/types.js";
import type { Scheduler } from "./scheduler.js";

export interface SubscribeInput {
  id?: string;
  type: SubscriptionType;
  agent: Agent;
  external_session_id: string;
  // poll 必填；push 不填时，投递时再新建 DSH 会话（T2.5），在此之前不建定时检查。
  dsh_session_id?: string | null;
  owner?: string;
  idle_timeout_seconds?: number;
  max_lifetime_seconds?: number;
  check_interval_seconds?: number;
}
export interface PushSubscriptionInput {
  id: string;
  agent: Agent;
  external_session_id: string;
  owner?: string;
}
export type SubscribeResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; code: "session_closed" | "unsupported" | "invalid_input"; message: string };
export type ChangeResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; code: "not_found" | "conflict"; message: string };
export interface ReconcileReport {
  created: number;
  deleted: number;
  errors: string[];
}
export interface SubscriptionServiceOptions {
  store: RelayStore;
  adapters: AdapterRegistry;
  scheduler: Scheduler;
  now?: () => number;
  newId?: () => string;
}

const DEFAULT_IDLE_SECONDS = 3600;
// 定时提醒正文中的标记，用于对账时识别本插件建立的定时任务。
const MARKER = /\[agent-relay:([^\]\s]+)\]/;
const marker = (id: string) => `[agent-relay:${id}]`;

export function createSubscriptionService({
  store,
  adapters,
  scheduler,
  now = Date.now,
  newId = randomUUID,
}: SubscriptionServiceOptions) {
  const subs = store.subscriptions;

  function reminder(sub: Pick<Subscription, "id" | "external_session_title" | "external_session_id">) {
    const label = sub.external_session_title ?? sub.external_session_id;
    return {
      title: `Agent Relay 检查：${label}`.slice(0, 120),
      prompt: `${marker(sub.id)} 调用 relay_check 工具检查外部会话，参数 subscription_id=${sub.id}。只执行这一次检查，不做其他操作。`,
    };
  }
  async function schedule(sub: Subscription) {
    if (!sub.dsh_session_id) return null;
    return scheduler.create({
      sessionId: sub.dsh_session_id,
      ...reminder(sub),
      everySeconds: sub.check_interval_seconds ?? sub.idle_timeout_seconds,
    });
  }
  async function unschedule(sub: Subscription) {
    if (!sub.schedule_task_id || !sub.dsh_session_id) return;
    await scheduler.delete({ sessionId: sub.dsh_session_id, id: sub.schedule_task_id });
  }
  // 停止定时检查失败不影响订阅状态，留给下次对账清理。
  async function unscheduleQuietly(sub: Subscription) {
    try {
      await unschedule(sub);
    } catch {
      // 对账时重试。
    }
  }
  async function change(
    id: string,
    from: Subscription["status"],
    patch: Parameters<typeof subs.update>[0]["patch"],
  ): Promise<ChangeResult> {
    const current = subs.get(id);
    if (!current) return { ok: false, code: "not_found", message: "订阅不存在" };
    if (current.status !== from)
      return { ok: false, code: "conflict", message: `订阅当前为 ${current.status}` };
    if (!subs.update({ id, expected_status: from, patch: { ...patch, updated_at: now() } }))
      return { ok: false, code: "conflict", message: "订阅状态已被修改" };
    return { ok: true, subscription: subs.get(id)! };
  }
  function* unfinished() {
    for (const status of ["active", "paused"] as const) {
      let cursor = null;
      do {
        const page = subs.list({ status, limit: 100, cursor });
        yield* page.items;
        cursor = page.next_cursor;
      } while (cursor);
    }
  }

  // 外部会话已归档或删除：为每条未结束订阅登记 session_closed 通知。
  // poll 随登记结束；push 按通知规则在送达后结束（T2.5）。
async function closeSession(agent: Agent, externalSessionId: string) {
    let closed = 0;
    for (const sub of [...unfinished()]) {
      if (sub.agent !== agent || sub.external_session_id !== externalSessionId) continue;
      const result = store.notifications.record({
        notification: {
          id: newId(),
          subscription_id: sub.id,
          source: sub.type,
          result: "session_closed",
          summary: `外部会话 ${sub.external_session_title ?? sub.external_session_id} 已归档或删除`,
        },
        now: now(),
      });
      if (result.outcome !== "created") continue;
      closed++;
      if (sub.type === "poll") await unscheduleQuietly(sub);
    }
    return closed;
  }

  return {
    // 外部 Agent 直接 push 时，通知请求本身就是任务完成的证据，不能要求
    // Relay 先重新读取外部会话；否则外部任务已结束但历史不可读时会被错误拒绝。
    createPush(input: PushSubscriptionInput): SubscribeResult {
      const time = now();
      const created = subs.create({
        id: input.id,
        owner: input.owner ?? "local",
        type: "push",
        agent: input.agent,
        external_session_id: input.external_session_id,
        external_session_title: null,
        external_cwd: null,
        dsh_session_id: null,
        cursor: null,
        last_activity_at: null,
        created_at: time,
        updated_at: time,
      });
      return { ok: true, subscription: subs.get(created.id)! };
    },
    async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
      const adapter = adapters.get(input.agent);
      if (!adapter.capabilities().snapshot)
        return { ok: false, code: "unsupported", message: `${input.agent} 不支持查阅会话` };
      if (input.type === "poll" && !input.dsh_session_id)
        return { ok: false, code: "invalid_input", message: "主动订阅必须指定接收通知的 DSH 会话" };
      // 先取一次快照作为基线，避免把订阅前已结束的轮次当成新结果。
      const base: Snapshot = await adapter.snapshot(input.external_session_id);
      if (base.closed)
        return { ok: false, code: "session_closed", message: "外部会话不存在或已归档" };
      const time = now();
      const idle = input.idle_timeout_seconds ?? DEFAULT_IDLE_SECONDS;
      const draft = {
        id: input.id ?? newId(),
        owner: input.owner ?? "local",
        type: input.type,
        agent: input.agent,
        external_session_id: input.external_session_id,
        external_session_title: base.title,
        external_cwd: base.cwd,
        dsh_session_id: input.dsh_session_id ?? null,
        idle_timeout_seconds: idle,
        ...(input.max_lifetime_seconds ? { max_lifetime_seconds: input.max_lifetime_seconds } : {}),
        ...(input.type === "poll"
          ? { check_interval_seconds: input.check_interval_seconds ?? idle }
          : {}),
        cursor: base.cursor ? { uuid: base.cursor.uuid, timestamp: base.cursor.timestamp } : null,
        last_activity_at: base.last_activity_at,
        created_at: time,
        updated_at: time,
      };
      const created = subs.create(draft);
      // 先写订阅再建定时任务：建任务失败时订阅仍在，由对账补建。
      try {
        const taskId = await schedule(created);
        if (taskId)
          subs.update({
            id: created.id,
            expected_status: "active",
            patch: { schedule_task_id: taskId, updated_at: now() },
          });
      } catch {
        // 对账时补建。
      }
      return { ok: true, subscription: subs.get(created.id)! };
    },
    // 暂停期间不计有效期，定时任务保留，检查执行器跳过暂停的订阅。
    pause: (id: string) => change(id, "active", { status: "paused" }),
    async resume(id: string): Promise<ChangeResult> {
      const result = await change(id, "paused", { status: "active" });
      if (result.ok) subs.extend({ id, now: now() });
      return result.ok ? { ok: true, subscription: subs.get(id)! } : result;
    },
    async update(id: string, input: {
      idle_timeout_seconds?: number;
      check_interval_seconds?: number;
      expires_at?: number;
    }): Promise<ChangeResult> {
      const current = subs.get(id);
      if (!current) return { ok: false, code: "not_found", message: "订阅不存在" };
      if (current.status === "ended") return { ok: false, code: "conflict", message: "订阅已结束" };
      const patch: Record<string, number> = {};
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 60))
          throw new TypeError(`${key} 必须为不小于 60 的整数`);
        if (value !== undefined) patch[key] = value;
      }
      if (!Object.keys(patch).length)
        throw new TypeError("至少指定一个订阅配置");
      if (patch.expires_at !== undefined && patch.expires_at > current.hard_expires_at)
        throw new TypeError("expires_at 不能超过最长存活时间");
      if (patch.idle_timeout_seconds !== undefined && patch.expires_at === undefined)
        patch.expires_at = Math.min(now() + patch.idle_timeout_seconds * 1000, current.hard_expires_at);
      const intervalChanged = patch.check_interval_seconds !== undefined &&
        patch.check_interval_seconds !== current.check_interval_seconds;
      if (intervalChanged) await unscheduleQuietly(current);
      if (!subs.update({ id, expected_status: current.status, patch: { ...patch, updated_at: now() } }))
        return { ok: false, code: "conflict", message: "订阅状态已被修改" };
      let updated = subs.get(id)!;
      if (intervalChanged && updated.status === "active") {
        try {
          const taskId = await schedule(updated);
          if (taskId) {
            subs.update({ id, expected_status: "active", patch: { schedule_task_id: taskId, updated_at: now() } });
            updated = subs.get(id)!;
          }
        } catch {
          // 后台对账会补建定时任务，配置变更本身已经持久化。
        }
      }
      return { ok: true, subscription: updated };
    },
    async stop(id: string): Promise<ChangeResult> {
      const current = subs.get(id);
      if (!current) return { ok: false, code: "not_found", message: "订阅不存在" };
      if (current.status === "ended")
        return { ok: false, code: "conflict", message: "订阅已结束" };
      const time = now();
      const result = await change(id, current.status, {
        status: "ended",
        end_reason: "user_stopped",
        ended_at: time,
      });
      if (result.ok) await unscheduleQuietly(result.subscription);
      return result;
    },
    // 通过 Relay 查阅会话内容：顺延该会话所有订阅的有效期；会话已关闭时结束这些订阅。
    async inspect(agent: Agent, externalSessionId: string): Promise<Snapshot> {
      const snapshot = await adapters.get(agent).snapshot(externalSessionId);
      if (snapshot.closed) await closeSession(agent, externalSessionId);
      else subs.touchSession({ agent, external_session_id: externalSessionId, now: now() });
      return snapshot;
    },
    // 通过 Relay 向会话发送消息后调用（T2.7）。
    touch(agent: Agent, externalSessionId: string) {
      return subs.touchSession({ agent, external_session_id: externalSessionId, now: now() });
    },
    closeSession,
    // 启动时对账：为缺少定时任务的未结束订阅补建，删除没有对应订阅的本插件定时任务。
    async reconcile(): Promise<ReconcileReport> {
      const report: ReconcileReport = { created: 0, deleted: 0, errors: [] };
      const tasks = await scheduler.catalog();
      const live = new Map(tasks.filter((t) => t.status === "active").map((t) => [t.id, t]));
      const wanted = new Set<string>();
      for (const sub of [...unfinished()]) {
        if (!sub.dsh_session_id) continue;
        const existing = sub.schedule_task_id ? live.get(sub.schedule_task_id) : undefined;
        if (existing && existing.sessionId === sub.dsh_session_id && MARKER.exec(existing.prompt)?.[1] === sub.id) {
          wanted.add(existing.id);
          continue;
        }
        try {
          const taskId = await schedule(sub);
          if (!taskId) continue;
          if (subs.update({ id: sub.id, expected_status: sub.status, patch: { schedule_task_id: taskId, updated_at: now() } })) {
            wanted.add(taskId);
            report.created++;
          } else {
            await scheduler.delete({ sessionId: sub.dsh_session_id, id: taskId });
          }
        } catch (error) {
          report.errors.push(`订阅 ${sub.id} 补建定时任务失败：${message(error)}`);
        }
      }
      for (const task of tasks) {
        if (!MARKER.test(task.prompt) || wanted.has(task.id)) continue;
        try {
          if (await scheduler.delete({ sessionId: task.sessionId, id: task.id })) report.deleted++;
        } catch (error) {
          report.errors.push(`删除定时任务 ${task.id} 失败：${message(error)}`);
        }
      }
      return report;
    },
  };
}
export type SubscriptionService = ReturnType<typeof createSubscriptionService>;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
