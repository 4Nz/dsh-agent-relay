import { randomUUID } from 'node:crypto';
import { parseV2Marker, hasLegacyMarker } from './schedule-marker.js';

// 订阅调度边界；宿主适配保留用于清理升级前的模型提醒。
export interface ScheduledTask {
  id: string;
  sessionId: string;
  prompt: string;
  status: "active" | "inactive";
}
export interface Scheduler {
  create(input: {
    sessionId: string;
    title: string;
    prompt: string;
    everySeconds: number;
    deadline?: number;
  }): Promise<string>;
  delete(input: { sessionId: string; id: string }): Promise<boolean>;
  catalog(): Promise<ScheduledTask[]>;
}

// 直接查阅外部历史，不通过定时提醒唤醒模型。持久化订阅由原对账流程恢复计时器。
export function createPollingScheduler(
  legacy: Pick<Scheduler, 'catalog' | 'delete'>,
  check: (subscriptionId: string) => Promise<unknown>,
  onError: (error: unknown) => void,
  now: () => number = Date.now,
) {
  const tasks = new Map<string, ScheduledTask & { timer?: ReturnType<typeof setTimeout> }>();
  const pending = new Set<Promise<unknown>>();
  let stopping = false;
  const scheduler: Scheduler & { stop(): Promise<void> } = {
    async create({ sessionId, prompt, everySeconds, deadline }) {
      if (stopping) throw new Error('插件调度器正在停止');
      const subId = parseV2Marker(prompt);
      if (!subId || !Number.isSafeInteger(everySeconds) || everySeconds < 60 || everySeconds > 3600 || (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline < 0)))
        throw new TypeError('订阅检查参数无效');
      const id = `relay-poll-${randomUUID()}`;
      const task: ScheduledTask & { timer?: ReturnType<typeof setTimeout> } = { id, sessionId, prompt, status: 'active' };
      tasks.set(id, task);
      function arm() {
        task.timer = setTimeout(() => {
          if (stopping || tasks.get(id) !== task) return;
          const operation = Promise.resolve().then(() => check(subId!)).catch(onError).finally(() => {
            pending.delete(operation);
            if (!stopping && tasks.get(id) === task && (deadline === undefined || now() < deadline)) arm();
            else if (tasks.get(id) === task) task.status = 'inactive';
          });
          pending.add(operation);
        }, Math.min(everySeconds * 1000, deadline === undefined ? Infinity : Math.max(0, deadline - now())));
        task.timer.unref();
      }
      arm();
      return id;
    },
    async delete({ sessionId, id }) {
      const task = tasks.get(id);
      if (!task) return legacy.delete({ sessionId, id });
      if (task.sessionId !== sessionId) return false;
      clearTimeout(task.timer);
      return tasks.delete(id);
    },
    async catalog() {
      // 旧 Relay 提醒标记为非活跃，触发先创建插件计时器，再清理旧提醒；其余宿主任务不变。
      const old = (await legacy.catalog()).map(task => parseV2Marker(task.prompt) !== null || hasLegacyMarker(task.prompt)
        ? { ...task, status: 'inactive' as const } : task);
      return [...old, ...[...tasks.values()].map(({ timer: _timer, ...task }) => task)];
    },
    async stop() {
      stopping = true;
      for (const task of tasks.values()) clearTimeout(task.timer);
      tasks.clear();
      await Promise.allSettled([...pending]);
    },
  };
  return scheduler;
}

// 与 @deepseek-ai/dsh-schedule 的 ScheduleService 对应的最小结构，避免直接依赖其类型包。
interface ScheduleServiceLike {
  create(
    sessionId: never,
    request: { title: string; prompt: string; every_seconds: number },
  ): Promise<{ id: string }>;
  delete(request: { sessionId: never; id: never }): Promise<{ deleted: boolean }>;
  catalog(): Promise<
    { id: string; sessionId: string; prompt: string; status: "active" | "inactive" }[]
  >;
}

interface ModernScheduleRecord {
  id: string; prompt: string; status: 'active' | 'paused' | 'ended'; updatedAt?: string;
  target: { kind: string; sessionId?: string };
}
interface ModernScheduleService {
  remoteCreate: unknown;
  create(request: { title: string; prompt: string; timing: { kind: 'every'; every_seconds: number }; target: { kind: 'session'; sessionId: string } }, actorSessionId?: string): Promise<{ id: string }>;
  catalog(): Promise<ModernScheduleRecord[]>;
  edit(request: { id: string; action: 'delete'; expectedUpdatedAt: string | null }, actorSessionId?: string): Promise<{ deleted?: boolean }>;
}

export function createDshScheduler(schedule: unknown): Scheduler {
  const service = schedule as ScheduleServiceLike;
  const modern = schedule as ModernScheduleService;
  const hostWide = typeof modern.remoteCreate === 'function';
  return {
    async create({ sessionId, title, prompt, everySeconds }) {
      if (hostWide) {
        const record = await modern.create({ title, prompt, timing: { kind: 'every', every_seconds: everySeconds }, target: { kind: 'session', sessionId } }, sessionId);
        return record.id;
      }
      const record = await service.create(sessionId as never, {
        title,
        prompt,
        every_seconds: everySeconds,
      });
      return record.id;
    },
    async delete({ sessionId, id }) {
      if (hostWide) {
        const record = (await modern.catalog()).find((task) => task.id === id);
        if (!record || record.target.kind !== 'session' || record.target.sessionId !== sessionId) return false;
        const result = await modern.edit({ id, action: 'delete', expectedUpdatedAt: record.updatedAt ?? null }, sessionId);
        return result.deleted === true;
      }
      const result = await service.delete({
        sessionId: sessionId as never,
        id: id as never,
      });
      return result.deleted;
    },
    async catalog() {
      if (hostWide) return (await modern.catalog()).filter((task) => task.target.kind === 'session' && typeof task.target.sessionId === 'string').map((task) => ({
        id: task.id, sessionId: task.target.sessionId!, prompt: task.prompt,
        status: task.status === 'active' ? 'active' as const : 'inactive' as const,
      }));
      return (await service.catalog()).map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        prompt: t.prompt,
        status: t.status,
      }));
    },
  };
}
