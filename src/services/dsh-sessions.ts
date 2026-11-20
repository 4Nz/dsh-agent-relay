// 集中宿主会话查询适配：接收资格核对（存在且未归档）+ 批量标题读取。
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

export type DshSessionStatus = "available" | "archived" | "missing";

export interface DshSessionArchiveRegistry {
  readonly archivedSessionIds: readonly string[];
}

export const ARCHIVED_RECEIVER = "接收通知的 DSH 会话已归档，无法执行频率规划或处理通知；请先在 DSH 恢复该会话，或选择其他未归档的接收会话";

export function createDshSessions(host: DshSessionHost, registry?: DshSessionArchiveRegistry) {
  const archived = (id: string) => registry?.archivedSessionIds.includes(id) ?? false;
  return {
    // 导航前核对当前状态；历史目标不存在时不回退到其他路由或创建新会话。
    async status(id: string): Promise<DshSessionStatus> {
      const sessions = await host.listSessions();
      if (!sessions.some((s) => s.header.id === id)) return "missing";
      return archived(id) ? "archived" : "available";
    },
    // 一次批量读取标题；单个标题缺失/失败回退到该 ID，其余结果仍可展示；
    // 批量整体失败向上抛出明确错误。
    async list(): Promise<DshSessionOption[]> {
      const sessions = (await host.listSessions()).filter((s) => !archived(s.header.id));
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
    // 接收资格验证：一次轻量 listSessions 后核对存在性及当前归档状态，不读取标题/正文。
    // 归档仍有历史记录，但宿主会阻止其执行；必须明确说明，不能作为可用接收会话。
    // listSessions 失败时向上抛出，不当作"不存在"。
    async has(id: string): Promise<boolean> {
      const sessions = await host.listSessions();
      if (archived(id)) throw new TypeError(ARCHIVED_RECEIVER);
      return sessions.some((s) => s.header.id === id);
    },
  };
}
