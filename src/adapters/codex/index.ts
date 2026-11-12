import { createHash } from 'node:crypto';
import { AdapterError } from '../types.js';
import type { AgentAdapter, SessionCursor, SessionInfo, Snapshot } from '../types.js';
import { connectCodex, CodexRpcError, type CodexClient, type CodexConnectionOptions } from './rpc.js';

export interface CodexAdapterOptions extends CodexConnectionOptions {
  connect?: () => Promise<CodexClient>;
}

// 协议边界只接受已验证的必要字段，未知字段忽略，必要字段变化则明确失败。
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  return value as RecordValue;
}
function bad(): never { throw new AdapterError('parse_error', 'Codex 协议响应格式无法解析'); }
function string(value: unknown): string { if (typeof value !== 'string') bad(); return value; }
function millis(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad();
  return value * 1000;
}
function optionalString(value: unknown): string | null {
  return value == null ? null : string(value);
}
function info(value: unknown): SessionInfo {
  const t = object(value);
  const status = string(object(t.status).type);
  return {
    id: string(t.id), title: optionalString(t.name), cwd: optionalString(t.cwd),
    last_activity_at: millis(t.updatedAt),
    // daemon 不是桌面执行实例，idle/notLoaded 都不能证明原会话空闲。
    runtime: status === 'active' ? 'busy' : 'unknown', held: true,
  };
}
function page(value: unknown): { data: unknown[]; nextCursor: string | null } {
  const p = object(value);
  if (!Array.isArray(p.data)) bad();
  return { data: p.data, nextCursor: optionalString(p.nextCursor) };
}
function checkId(id: string) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new AdapterError('invalid_input', 'Codex 会话 ID 格式无效');
}
const closedSnapshot = (): Snapshot => ({
  closed: true, title: null, cwd: null, cursor: null, last_activity_at: null,
  runtime: 'unknown', held: false, runtime_error: null, check_error: null, finished_turn: null, last_reply: null,
});

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const connect = options.connect ?? (() => connectCodex(options));
  async function using<T>(operation: (client: CodexClient) => Promise<T>): Promise<T> {
    let client: CodexClient | undefined;
    try { client = await connect(); return await operation(client); }
    catch (error) {
      if (error instanceof AdapterError) throw error;
      // 不把协议错误的正文写进错误信息，避免意外携带会话内容。
      throw new AdapterError('unavailable', error instanceof CodexRpcError
        ? `Codex 查询失败（协议错误 ${error.code}）` : 'Codex 连接或查询失败');
    } finally { client?.close(); }
  }
  async function* sessions(client: CodexClient, archived: boolean) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const p = page(await client.request('thread/list', {
        archived, cursor, limit: 100, sortKey: 'updated_at', sortDirection: 'desc',
        modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
      }));
      for (const item of p.data) yield info(item);
      if (!p.nextCursor) return;
      if (seen.has(p.nextCursor)) bad();
      seen.add(p.nextCursor); cursor = p.nextCursor;
    }
    throw new AdapterError('unavailable', 'Codex 会话分页超过查询上限');
  }
  return {
    agent: 'codex',
    capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: false, runPrompt: false }),
    async sendMessage() { return { status: 'rejected', reason: 'Codex 第一版不支持发送消息' }; },
    async runPrompt() { return { status: 'rejected', reason: 'Codex 开新会话执行安装为后续版本预留' }; },
    async listSessions({ limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new AdapterError('invalid_input', '会话数量必须为 1～1000 的整数');
      return using(async client => {
        const result = new Map<string, SessionInfo>();
        for await (const session of sessions(client, false)) {
          result.set(session.id, session);
          if (result.size >= limit) break;
        }
        return [...result.values()];
      });
    },
    async snapshot(sessionId, baseline = null) {
      checkId(sessionId);
      if (baseline !== null && (typeof baseline !== 'object' ||
          typeof baseline.uuid !== 'string' || !baseline.uuid.startsWith('codex:') ||
          !Number.isFinite(baseline.timestamp) || baseline.timestamp < 0))
        throw new AdapterError('invalid_input', 'Codex 快照基线格式无效');
      return using(async client => {
        // read 本身不暴露归档标志，因此通过完整归档分页确认，不依赖不稳定的文件路径。
        for await (const session of sessions(client, true))
          if (session.id === sessionId) return closedSnapshot();
        let metadata: SessionInfo;
        try { metadata = info(object(await client.request('thread/read', { threadId: sessionId, includeTurns: false })).thread); }
        catch (error) {
          // 只有明确的不存在错误且活动列表也找不到时，才认定删除。
          if (!(error instanceof CodexRpcError) || error.code !== -32600 ||
              !/^(thread not found|thread not loaded|no rollout found for thread id)/i.test(error.message)) throw error;
          for await (const session of sessions(client, false)) if (session.id === sessionId) throw error;
          return closedSnapshot();
        }
        if (metadata.id !== sessionId) bad();
        const turns = page(await client.request('thread/turns/list', {
          threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'full',
        })).data;
        const latest = turns[0] == null ? null : object(turns[0]);
        let cursor: SessionCursor | null = null;
        let finished: Snapshot['finished_turn'] = null;
        let reply: string | null = null;
        let activity = metadata.last_activity_at!;
        if (latest) {
          const id = string(latest.id), status = string(latest.status);
          if (!Array.isArray(latest.items)) bad();
          const started = latest.startedAt == null ? null : millis(latest.startedAt);
          const completed = latest.completedAt == null ? null : millis(latest.completedAt);
          activity = Math.max(activity, completed ?? started ?? 0);
          const messages = latest.items.map(object).filter(item => item.type === 'agentMessage');
          for (const item of messages) reply = string(item.text).slice(0, 1000);
          // 轮次 ID 与内容摘要都进入游标，刷新同一轮的状态/回复也能观察到变化。
          const digest = createHash('sha256').update(JSON.stringify([status, latest.items])).digest('hex').slice(0, 24);
          cursor = { uuid: `codex:${id}:${digest}`, timestamp: activity };
          const sameTurn = baseline?.uuid.startsWith(`codex:${id}:`) ?? false;
          const after = !baseline || (!sameTurn && started !== null && started > baseline.timestamp);
          if (after && metadata.runtime !== 'busy' && (status === 'completed' || status === 'failed'))
            finished = { result: status, external_ref: id };
        }
        return {
          ...metadata, closed: false, cursor, last_activity_at: activity,
          runtime_error: metadata.runtime === 'unknown' ? 'daemon 无法确认桌面会话的实时运行状态' : null,
          check_error: null,
          finished_turn: finished, last_reply: reply,
        };
      });
    },
  };
}
