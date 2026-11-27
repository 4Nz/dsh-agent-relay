// 订阅调度边界；宿主适配用于创建和清理定时提醒。
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
