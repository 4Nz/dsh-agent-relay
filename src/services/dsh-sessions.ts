// 集中宿主会话查询适配：listSessions 存在性核对 + 批量标题读取。
// 批量标题按本机 DSH 0.2.1-rc.2 的 SessionTitleObservationResult 合同适配，
// 不使用 any 假定结果为简单 Map。

export interface DshSessionHost {
  listSessions(): Promise<{ header: { id: string } }[]>;
  readTitleSnapshots(ids: string[]): Promise<SessionTitleObservationResult[]>;
}

// 与 @deepseek-ai/dsh-session-query 的 SessionTitleObservationResult 结构对齐。
export interface SessionTitleObservationResult {
  sessionId: string;
  status: "fulfilled";
  value: {
    session: { id: string };
    title?: { title: string };
  };
}

export interface DshSessionOption {
  id: string;
  title: string;
}

export function createDshSessions(host: DshSessionHost) {
  return {
    // 一次批量读取标题；单个标题缺失/失败回退到该 ID，其余结果仍可展示；
    // 批量整体失败向上抛出明确错误。
    async list(): Promise<DshSessionOption[]> {
      const sessions = await host.listSessions();
      const ids = sessions.map((s) => s.header.id);
      const titles = new Map<string, string>();
      if (ids.length) {
        const observations = await host.readTitleSnapshots(ids);
        for (const result of observations) {
          if (result.status === "fulfilled" && result.value.title)
            titles.set(result.sessionId, result.value.title.title);
        }
      }
      return sessions.map((s) => ({
        id: s.header.id,
        title: titles.get(s.header.id) ?? s.header.id,
      }));
    },
    // 仅存在性验证：一次轻量 listSessions 后核对 header.id，不读取标题/正文。
    // listSessions 失败时向上抛出，不当作"不存在"。
    async has(id: string): Promise<boolean> {
      const sessions = await host.listSessions();
      return sessions.some((s) => s.header.id === id);
    },
  };
}
