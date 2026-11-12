import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { CodexBindings } from '../../storage/codex-sessions.js';
import { createHash } from 'node:crypto';
import { AdapterError } from '../types.js';
import type { AgentAdapter, SendResult, SessionCursor, SessionInfo, Snapshot } from '../types.js';
import { connectCodex, codexEndpoint, CodexRpcError, CodexTransportError, type CodexClient, type CodexConnectionOptions } from './rpc.js';

export interface CodexAdapterOptions extends CodexConnectionOptions {
  connect?: () => Promise<CodexClient>;
  bindings?: CodexBindings;
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
function info(value: unknown, writable = false): SessionInfo {
  const t = object(value);
  const status = string(object(t.status).type);
  return {
    id: string(t.id), title: optionalString(t.name), cwd: optionalString(t.cwd),
    last_activity_at: millis(t.updatedAt),
    // daemon 不是桌面执行实例，idle/notLoaded 都不能证明原会话空闲。
    runtime: status === 'active' ? 'busy' : writable && status === 'idle' ? 'idle' : 'unknown', held: true,
    send_allowed: writable && status !== 'active',
    send_reason: !writable ? '仅 Relay 创建的专用后台会话支持发送；桌面及其他会话只读' : status === 'active' ? '会话处理中' : '',
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
  const endpoint = codexEndpoint(options);
  const bound = (id: string) => options.bindings?.has(id, endpoint) ?? false;
  const metadata = (value: unknown) => info(value, bound(string(object(value).id)));
  const connect = options.connect ?? (() => connectCodex(options));
  let writeConnection: Promise<CodexClient> | undefined;
  let disposed = false;
  const sending = new Set<string>();
  async function writer(): Promise<CodexClient> {
    if (disposed) throw new AdapterError('unavailable', 'Codex Adapter 已停止');
    if (!writeConnection) {
      const attempt = options.connect ? options.connect() : connectCodex({ ...options, writable: true,
        onClose: () => { if (writeConnection === attempt) writeConnection = undefined; },
      });
      writeConnection = attempt;
      void attempt.catch(() => { if (writeConnection === attempt) writeConnection = undefined; });
    }
    return writeConnection;
  }
  async function writableState(client: CodexClient, id: string): Promise<string | null> {
    for await (const session of sessions(client, true)) if (session.id === id) return '外部会话已归档';
    const current = object(object(await client.request('thread/read', { threadId: id })).thread);
    if (string(current.id) !== id) bad();
    const status = string(object(current.status).type);
    if (status === 'active') return '会话处理中';
    if (status !== 'idle' && status !== 'notLoaded') return '无法确认后台会话状态';
    // 只恢复由 Relay 创建且登记到此端点的专用会话，不恢复任意历史会话。
    const resumed = object(object(await client.request('thread/resume', { threadId: id, excludeTurns: true })).thread);
    if (string(resumed.id) !== id) bad();
    const live = string(object(resumed.status).type);
    return live === 'idle' ? null : live === 'active' ? '会话处理中' : '无法确认后台会话空闲';
  }
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
      for (const item of p.data) yield metadata(item);
      if (!p.nextCursor) return;
      if (seen.has(p.nextCursor)) bad();
      seen.add(p.nextCursor); cursor = p.nextCursor;
    }
    throw new AdapterError('unavailable', 'Codex 会话分页超过查询上限');
  }
  return {
    agent: 'codex',
    capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: !!options.bindings, runPrompt: false,
      ...(options.bindings ? { createSession: true } : {}),
    }),
    async dispose() {
      disposed = true;
      const pending = writeConnection; writeConnection = undefined;
      if (pending) { try { (await pending).close(); } catch { /* 已断开的连接无需重试。 */ } }
    },
    async createSession({ cwd }) {
      if (!options.bindings) throw new AdapterError('invalid_input', 'Codex 未启用专用会话创建');
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new AdapterError('invalid_input', '工作目录必须为绝对路径');
      let directory: string;
      try { directory = await realpath(cwd); if (!(await stat(directory)).isDirectory()) throw new Error(); }
      catch { throw new AdapterError('invalid_input', '工作目录不存在或不可访问'); }
      const client = await writer();
      let created: unknown;
      try { created = object(await client.request('thread/start', { cwd: directory })).thread; }
      catch { throw new AdapterError('unavailable', 'Codex 专用会话创建未确认，请先检查会话列表，不自动重试'); }
      const id = string(object(created).id); checkId(id);
      options.bindings.register({ session_id: id, endpoint, created_at: Date.now() });
      return metadata(created);
    },
    async sendMessage(sessionId, text): Promise<SendResult> {
      if (!options.bindings) return { status: 'rejected', reason: 'Codex 第一版不支持发送消息' };
      checkId(sessionId);
      if (typeof text !== 'string' || !text.trim()) return { status: 'rejected', reason: '消息不能为空' };
      if (!bound(sessionId)) return { status: 'rejected', reason: '此会话未登记到当前后台实例，只允许查阅' };
      if (sending.has(sessionId)) return { status: 'rejected', reason: '此会话正在发送消息' };
      sending.add(sessionId);
      let starting = false;
      try {
        const client = await writer();
        const reason = await writableState(client, sessionId);
        if (reason) return { status: 'rejected', reason };
        starting = true;
        const result = object(await client.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text }] }));
        const turnId = string(object(result.turn).id);
        if (!turnId.trim()) bad();
        return { status: 'sent', external_ref: turnId };
      } catch (error) {
        if (error instanceof CodexTransportError) writeConnection = undefined;
        // 请求已经发出却缺少可靠回执（包括畸形响应），不能当作未发送。
        const unknown = starting && !(error instanceof CodexRpcError) &&
          (!(error instanceof CodexTransportError) || error.dispatched);
        return unknown ? { status: 'unknown', error: 'Codex 接收结果未知，请核对目标轮次；不要重复发送' }
          : { status: 'failed', error: 'Codex 连接、会话恢复或发送被拒绝，请检查后台实例和原权限配置' };
      } finally { sending.delete(sessionId); }
    },
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
          (baseline.target_turn_id !== undefined && (typeof baseline.target_turn_id !== 'string' || !baseline.target_turn_id.trim())) ||
          typeof baseline.uuid !== 'string' || !baseline.uuid.startsWith('codex:') ||
          !Number.isFinite(baseline.timestamp) || baseline.timestamp < 0))
        throw new AdapterError('invalid_input', 'Codex 快照基线格式无效');
      return using(async client => {
        // read 本身不暴露归档标志，因此通过完整归档分页确认，不依赖不稳定的文件路径。
        for await (const session of sessions(client, true))
          if (session.id === sessionId) return closedSnapshot();
        let metadata: SessionInfo;
        try { metadata = info(object(await client.request('thread/read', { threadId: sessionId, includeTurns: false })).thread, bound(sessionId)); }
        catch (error) {
          // 只有明确的不存在错误且活动列表也找不到时，才认定删除。
          if (!(error instanceof CodexRpcError) || error.code !== -32600 ||
              !/^(thread not found|thread not loaded|no rollout found for thread id)/i.test(error.message)) throw error;
          for await (const session of sessions(client, false)) if (session.id === sessionId) throw error;
          return closedSnapshot();
        }
        if (metadata.id !== sessionId) bad();
        const target = baseline?.target_turn_id;
        let latest: RecordValue | null = null;
        let next: string | null = null;
        const seen = new Set<string>();
        for (let n = 0; n < 1000; n++) {
          const turns = page(await client.request('thread/turns/list', {
            threadId: sessionId, limit: target ? 50 : 1, cursor: next, sortDirection: 'desc', itemsView: 'full',
          }));
          const found = target ? turns.data.find(t => object(t).id === target) : turns.data[0];
          if (found != null) { latest = object(found); break; }
          if (!target || !turns.nextCursor) break;
          if (seen.has(turns.nextCursor)) bad();
          seen.add(turns.nextCursor); next = turns.nextCursor;
          if (n === 999) throw new AdapterError('unavailable', '目标轮次分页超过查询上限');
        }
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
          const after = !baseline || (!sameTurn && started !== null && started >= baseline.timestamp);
          if ((target || (after && metadata.runtime !== 'busy')) && (status === 'completed' || status === 'failed' || (target && status === 'interrupted')))
            finished = { result: status === 'completed' ? 'completed' : 'failed', external_ref: id };
        }
        return {
          ...metadata, closed: false, cursor, last_activity_at: activity,
          runtime_error: metadata.runtime === 'unknown' ? (bound(sessionId) ? '专用后台会话尚未加载，发送前将重新核对状态' : 'daemon 无法确认桌面会话的实时运行状态') : null,
          check_error: null,
          finished_turn: finished, last_reply: reply,
        };
      });
    },
  };
}
