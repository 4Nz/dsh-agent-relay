import { spawn } from 'node:child_process';
import { AdapterError } from '../types.js';
import { PLUGIN_VERSION } from '../../version.js';
import { CodexRpcError, CodexTransportError, type CodexClient } from './rpc.js';
import { resolveCodexCommand } from './cli.js';

export interface CodexStdioOptions {
  cliPath?: string;
  cliArgs?: string[];
  timeoutMs?: number;
}
export interface CodexVisibleStarterOptions extends CodexStdioOptions {
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;
}
export interface CodexVisibleStarterClient extends CodexClient {
  readonly closed: Promise<void>;
}
const METHODS = new Set(['thread/list', 'thread/read', 'thread/turns/list']);
const VISIBLE_START_METHODS = new Set(['thread/start', 'turn/start', 'thread/name/set']);
const MAX_MESSAGE = 16 * 1024 * 1024;
const unavailable = (message: string) => new AdapterError('unavailable', message);

// 独立官方实例只查持久化历史，不 resume、启动轮次或代理桌面写入。
export async function connectCodexStdio(options: CodexStdioOptions = {}): Promise<CodexClient> {
  const timeout = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeout) || timeout <= 0) throw new AdapterError('invalid_input', 'Codex 查询超时必须为正整数');
  const launch = resolveCodexCommand(options);
  const child = spawn(launch.command, launch.args, {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let ended = false, sequence = 0, buffer = '';
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  function stop(error = unavailable('Codex 历史查询连接已断开')) {
    if (ended) return;
    ended = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); buffer = '';
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (child.exitCode === null) {
      child.kill();
      const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
      kill.unref(); child.once('exit', () => clearTimeout(kill));
    }
  }
  function send(message: unknown) {
    if (ended) throw unavailable('Codex 历史查询连接已断开');
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_MESSAGE) throw unavailable('Codex 历史查询请求超过大小上限');
    child.stdin.write(text + '\n');
  }
  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (ended) return Promise.reject(unavailable('Codex 历史查询连接已断开'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => stop(unavailable('Codex 历史查询超时')), timeout);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); }
      catch { stop(unavailable('Codex 历史查询发送失败')); }
    });
  }
  child.on('error', () => stop(unavailable('无法启动 Codex 历史查询，请确认 codex 可执行文件可用，或设置 DSH_CODEX_BIN')));
  child.on('close', () => stop());
  child.stdin.on('error', () => stop());
  child.stdout.on('error', () => stop());
  child.stderr.on('error', () => stop());
  // stderr 只排空，不把可能含用户信息的诊断内容写入 Relay 日志。
  child.stderr.resume();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (ended) return;
    try {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_MESSAGE) throw new Error();
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
        if (typeof message.method === 'string') {
          // 本连接不接受外部交互或权限提升。
          if (message.id != null) send({ id: message.id, error: { code: -32601, message: 'Relay 历史查询连接不支持交互' } });
          continue;
        }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (typeof message.error?.code === 'number' && typeof message.error?.message === 'string') entry.reject(new CodexRpcError(message.error.code, message.error.message));
        else if ('result' in message) entry.resolve(message.result);
        else { entry.reject(unavailable('Codex 历史查询响应缺少结果')); stop(); }
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE) throw new Error();
    } catch { stop(unavailable('Codex 历史查询响应无法解析或超过大小上限')); }
  });
  try {
    await request('initialize', { clientInfo: { name: 'dsh-agent-relay-history', version: PLUGIN_VERSION }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
  } catch (error) { stop(); throw error; }
  return {
    transport: 'stdio',
    request(method, params) {
      if (!METHODS.has(method)) return Promise.reject(new AdapterError('invalid_input', 'Codex 历史查询连接仅允许只读操作'));
      return request(method, params);
    },
    close: () => stop(),
  };
}

// 短生命周期桌面可见会话启动器：仅允许 thread/start、turn/start、thread/name/set，不允许 resume 已有会话；
// 首轮结束后优雅退出进程以立即释放 Codex active writer 锁，避免在 Codex Desktop 中持续显示「已在另一个应用中打开」。
export async function connectCodexVisibleStarter(
  options: CodexVisibleStarterOptions = {},
): Promise<CodexVisibleStarterClient> {
  const timeout = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeout) || timeout <= 0) throw new AdapterError('invalid_input', 'Codex 启动超时必须为正整数');
  const launch = resolveCodexCommand(options);
  const child = spawn(launch.command, launch.args, {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let ended = false, initialized = false, sequence = 0, buffer = '';
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    dispatched: boolean;
  }>();
  function finishExit() {
    resolveClosed();
  }
  function stop(error = unavailable('Codex 可见会话启动进程已断开'), graceful = false) {
    if (ended) return;
    ended = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CodexTransportError(error.message, entry.dispatched));
    }
    pending.clear();
    buffer = '';
    if (graceful && child.exitCode === null) {
      try { child.stdin.end(); } catch { /* 忽略已关闭管道 */ }
      const term = setTimeout(() => {
        if (child.exitCode === null) child.kill();
        const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000);
        kill.unref();
        child.once('exit', () => clearTimeout(kill));
      }, 1500);
      term.unref();
      child.once('exit', () => clearTimeout(term));
    } else {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null) {
        child.kill();
        const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000);
        kill.unref();
        child.once('exit', () => clearTimeout(kill));
      }
    }
    options.onClose?.();
    if (child.exitCode !== null) finishExit();
  }
  function send(message: unknown) {
    if (ended) throw unavailable('Codex 可见会话启动进程已断开');
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_MESSAGE) throw unavailable('Codex 请求超过大小上限');
    child.stdin.write(text + '\n');
  }
  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (ended) return Promise.reject(new CodexTransportError('Codex 可见会话启动进程已断开', false));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const entry = {
        resolve,
        reject,
        timer: null as unknown as ReturnType<typeof setTimeout>,
        dispatched: false,
      };
      entry.timer = setTimeout(() => {
        if (!initialized) {
          stop(unavailable('Codex 可见会话启动超时'));
          return;
        }
        if (!pending.delete(id)) return;
        entry.reject(new CodexTransportError('Codex 请求超时', entry.dispatched));
      }, timeout);
      pending.set(id, entry);
      try { send({ id, method, params }); entry.dispatched = true; }
      catch { stop(unavailable('Codex 请求发送失败')); }
    });
  }
  child.on('error', () => {
    stop(unavailable('无法启动本机 Codex CLI，请确认 codex 可执行文件可用，或设置 DSH_CODEX_BIN'));
    finishExit();
  });
  child.on('close', () => {
    stop();
    finishExit();
  });
  child.stdin.on('error', () => { if (!ended) stop(); });
  child.stdout.on('error', () => { if (!ended) stop(); });
  child.stderr.on('error', () => { if (!ended) stop(); });
  child.stderr.resume();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (ended) return;
    try {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_MESSAGE) throw new Error();
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
        if (typeof message.method === 'string') {
          if (message.id != null) {
            // 不授予额外权限；按协议保守拒绝，需交互审批时待解锁后回到 Codex Desktop 处理。
            if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method))
              send({ id: message.id, result: { decision: 'decline' } });
            else if (['execCommandApproval', 'applyPatchApproval'].includes(message.method))
              send({ id: message.id, result: { decision: 'denied' } });
            else if (message.method === 'item/permissions/requestApproval')
              send({ id: message.id, result: { permissions: {} } });
            else send({ id: message.id, error: { code: -32601, message: 'Relay 尚不支持此交互，请回到 Codex 处理' } });
          } else {
            options.onNotification?.(message.method, message.params);
          }
          continue;
        }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (typeof message.error?.code === 'number' && typeof message.error?.message === 'string')
          entry.reject(new CodexRpcError(message.error.code, message.error.message));
        else if ('result' in message) entry.resolve(message.result);
        else { entry.reject(unavailable('Codex 响应缺少结果')); stop(); }
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE) throw new Error();
    } catch { stop(unavailable('Codex 响应无法解析或超过大小上限')); }
  });
  try {
    await request('initialize', { clientInfo: { name: 'dsh-agent-relay', version: PLUGIN_VERSION }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    initialized = true;
  } catch (error) { stop(); throw error; }
  return {
    transport: 'stdio',
    closed,
    request(method, params) {
      if (!VISIBLE_START_METHODS.has(method))
        return Promise.reject(new AdapterError('invalid_input', 'Codex 桌面可见新建连接仅允许创建会话、设置标题与提交首轮'));
      return request(method, params);
    },
    close: () => stop(unavailable('Codex 可见会话启动进程已关闭'), true),
  };
}
