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

export class DshTargetError extends TypeError {
  constructor(public code: string, message: string, public candidates: DshSessionOption[] = []) {
    super(message);
  }
}
export interface DshTarget { dsh_session_id?: string; dsh_session_name?: string }

export function createDshSessions(host: DshSessionHost, registry?: DshSessionArchiveRegistry) {
  const archived = (id: string) => registry?.archivedSessionIds.includes(id) ?? false;
  return {
    // 发送解析不采用展示列表的标题降级：读取不全时不能证明名称唯一。
    async resolve(target: DshTarget): Promise<string> {
      const { dsh_session_id: id, dsh_session_name: name } = target;
      for (const value of [id, name])
        if (value !== undefined && (typeof value !== "string" || !value.trim()))
          throw new DshTargetError("invalid_target", "目标会话 ID 或名称不能为空");
      if (id === undefined && name === undefined)
        throw new DshTargetError("invalid_target", "需要指定 DSH 会话 ID 或名称");
      const all = await host.listSessions();
      if (id !== undefined && !all.some(s => s.header.id === id))
        throw new DshTargetError("target_missing", "指定的 DSH 会话不存在");
      let chosen = id;
      if (name !== undefined) {
        const ids = id !== undefined ? [id] : all.map(s => s.header.id);
        const observations = await host.readTitleSnapshots(ids);
        if (ids.some(id => !observations.some(o => o.sessionId === id && o.status === "fulfilled")))
          throw new DshTargetError("target_query_failed", "会话标题读取不完整，无法确定目标；请重试或明确指定会话 ID");
        const matches = observations.filter(o => ids.includes(o.sessionId) && o.value.title?.title === name)
          .map(o => ({id: o.sessionId, title: o.value.title!.title}));
        if (matches.length === 0)
          throw new DshTargetError(id ? "target_mismatch" : "target_missing", id ? "会话名称与 ID 不一致，请确认目标" : "没有找到完整名称匹配的 DSH 会话");
        if (matches.length !== 1)
          throw new DshTargetError("target_ambiguous", "存在重名 DSH 会话，请确认后使用会话 ID 发送", matches);
        chosen = matches[0].id;
      }
      if (archived(chosen!)) throw new DshTargetError("target_archived", ARCHIVED_RECEIVER);
      return chosen!;
    },
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
