// 订阅服务只用到 DSH 定时任务的创建、删除和全量列表，这里包一层，便于测试替换。
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

export function createDshScheduler(schedule: unknown): Scheduler {
  const service = schedule as ScheduleServiceLike;
  return {
    async create({ sessionId, title, prompt, everySeconds }) {
      const record = await service.create(sessionId as never, {
        title,
        prompt,
        every_seconds: everySeconds,
      });
      return record.id;
    },
    async delete({ sessionId, id }) {
      const result = await service.delete({
        sessionId: sessionId as never,
        id: id as never,
      });
      return result.deleted;
    },
    async catalog() {
      return (await service.catalog()).map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        prompt: t.prompt,
        status: t.status,
      }));
    },
  };
}
