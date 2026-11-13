import { request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { PLUGIN_VERSION } from '../../version.js';
import type { Duplex } from 'node:stream';
import { homedir } from 'node:os';
import { isAbsolute, resolve, join } from 'node:path';
import { AdapterError } from '../types.js';

export interface CodexClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export interface CodexConnectionOptions {
  socketPath?: string;
  timeoutMs?: number;
  writable?: boolean;
  onNotification?: (method: string, params: unknown) => void;
  onClose?: () => void;
}
export function codexEndpoint(options: CodexConnectionOptions = {}): string {
  const path = options.socketPath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
  if (!isAbsolute(path)) throw new AdapterError('invalid_input', 'Codex socket 必须为绝对路径');
  return resolve(path);
}
export class CodexTransportError extends AdapterError {
  constructor(message: string, readonly dispatched: boolean) { super('unavailable', message); }
}
export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'CodexRpcError'; }
}
const METHODS = new Set(['thread/list', 'thread/read', 'thread/turns/list']);
const WRITE_METHODS = new Set(['thread/start', 'thread/resume', 'turn/start', 'thread/queue/add']);
const MAX_MESSAGE = 16 * 1024 * 1024;
const failure = (message: string) => new AdapterError('unavailable', message);

// 本机 daemon 的传输为 Unix socket 上的 RFC 6455 WebSocket，无第三方运行依赖。
export async function connectCodex(options: CodexConnectionOptions = {}): Promise<CodexClient> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new AdapterError('invalid_input', 'Codex 查询超时必须为正整数');
  const socketPath = codexEndpoint(options);
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  let socket: Duplex | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentSize = 0;
  let ended = false;
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; dispatched: boolean }>();
  function stop(error: Error = failure('Codex 连接已断开')) {
    if (ended) return;
    ended = true;
    socket?.destroy();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new CodexTransportError(error.message, request.dispatched)); }
    pending.clear();
    options.onClose?.();
  }
  function send(value: unknown, opcode = 1) {
    if (ended || !socket) throw failure('Codex 连接已断开');
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const length = payload.length;
    if (length > MAX_MESSAGE) throw failure('Codex 请求超过大小上限');
    const head = Buffer.alloc(length < 126 ? 2 : length <= 65535 ? 4 : 10);
    head[0] = 0x80 | opcode;
    if (length < 126) head[1] = 0x80 | length;
    else if (length <= 65535) { head[1] = 0xfe; head.writeUInt16BE(length, 2); }
    else { head[1] = 0xff; head.writeBigUInt64BE(BigInt(length), 2); }
    const mask = randomBytes(4), body = Buffer.from(payload);
    for (let n = 0; n < length; n++) body[n] ^= mask[n % 4];
    socket.write(Buffer.concat([head, mask, body]));
  }
  function receive(payload: Buffer) {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('Codex JSON-RPC 格式无效');
    if (typeof data.method === 'string') {
      if (data.id != null) {
        // 不授予权限；按协议返回拒绝，不接受命令或文件规则修订。
        if (options.writable && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(data.method))
          send({ id: data.id, result: { decision: 'decline' } });
        else if (options.writable && ['execCommandApproval', 'applyPatchApproval'].includes(data.method))
          send({ id: data.id, result: { decision: 'denied' } });
        else if (options.writable && data.method === 'item/permissions/requestApproval')
          send({ id: data.id, result: { permissions: {} } });
        else send({ id: data.id, error: { code: -32601, message: 'Relay 尚不支持此交互，请回到 Codex 处理' } });
      } else options.onNotification?.(data.method, data.params);
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id); clearTimeout(request.timer);
    if (data.error && typeof data.error.code === 'number' && typeof data.error.message === 'string')
      request.reject(new CodexRpcError(data.error.code, data.error.message));
    else if ('result' in data) request.resolve(data.result);
    else request.reject(failure('Codex JSON-RPC 响应缺少结果'));
  }
  function consume(chunk: Buffer) {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, final = (buffer[0] & 128) !== 0;
        if ((buffer[0] & 0x70) || (buffer[1] & 128)) throw failure('Codex WebSocket 帧格式无效');
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        else if (size === 127) {
          if (buffer.length < 10) return;
          const length = buffer.readBigUInt64BE(2);
          if (length > BigInt(MAX_MESSAGE)) throw failure('Codex 响应超过大小上限');
          size = Number(length); offset = 10;
        }
        if (size + fragmentSize > MAX_MESSAGE) throw failure('Codex 响应超过大小上限');
        if (opcode >= 8 && (!final || size > 125)) throw failure('Codex 控制帧格式无效');
        if (buffer.length < offset + size) return;
        const body = buffer.subarray(offset, offset + size);
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) { stop(); return; }
        if (opcode === 9) { send(body, 10); continue; }
        if (opcode === 10) continue;
        if (opcode !== 0 && opcode !== 1) throw failure('Codex WebSocket 消息类型不支持');
        if ((opcode === 0 && !fragments.length) || (opcode === 1 && fragments.length))
          throw failure('Codex WebSocket 分片顺序无效');
        fragments.push(body); fragmentSize += size;
        if (final) { receive(Buffer.concat(fragments)); fragments = []; fragmentSize = 0; }
      }
    } catch { stop(failure('Codex 响应无法解析或超过大小上限')); }
  }
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/', headers: {
      Host: 'localhost', Upgrade: 'websocket', Connection: 'Upgrade',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
    }});
    const timer = setTimeout(() => { req.destroy(); reject(failure('Codex 连接超时')); }, timeoutMs);
    req.on('error', () => { clearTimeout(timer); reject(failure('无法连接 Codex daemon')); });
    req.on('response', response => { clearTimeout(timer); response.destroy(); reject(failure('Codex 拒绝 WebSocket 握手')); });
    req.on('upgrade', (response, stream, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== accept ||
          response.headers.upgrade?.toLowerCase() !== 'websocket') {
        stream.destroy(); reject(failure('Codex WebSocket 握手校验失败')); return;
      }
      socket = stream;
      socket.on('error', () => stop()); socket.on('close', () => stop());
      socket.on('data', consume);
      if (head.length) consume(head);
      resolve();
    });
    req.end();
  });
  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (ended) return Promise.reject(failure('Codex 连接已断开'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => stop(failure('Codex 请求超时')), timeoutMs);
      const entry = { resolve, reject, timer, dispatched: false };
      pending.set(id, entry);
      try { send({ id, method, params }); entry.dispatched = true; } catch { stop(); }
    });
  }
  try {
    await request('initialize', {
      clientInfo: { name: 'dsh-agent-relay', version: PLUGIN_VERSION },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized' });
  } catch (error) { stop(); throw error; }
  return {
    request(method, params) {
      if (!METHODS.has(method) && !(options.writable && WRITE_METHODS.has(method))) return Promise.reject(new AdapterError('invalid_input', 'Codex 客户端仅允许只读历史查询'));
      return request(method, params);
    },
    close: () => stop(),
  };
}
