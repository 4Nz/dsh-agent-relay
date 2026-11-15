import { AdapterError } from '../types.js';
import { connectCodex, type CodexConnectionOptions } from './rpc.js';
import { connectCodexStdio, type CodexStdioOptions } from './stdio.js';
import { connectCodexProxy } from './proxy.js';

export interface CodexReaderOptions extends CodexConnectionOptions, CodexStdioOptions {}
export async function connectCodexDaemon(options: CodexReaderOptions = {}) {
  if (process.platform !== 'win32') return connectCodex(options);
  // Windows 通过官方 Rust 代理访问 AF_UNIX 控制端点，不用 Node named-pipe 解释 socket 路径。
  return connectCodexProxy(options);
}
export async function connectCodexReader(options: CodexReaderOptions = {}) {
  try { return await connectCodexDaemon(options); }
  catch (error) {
    // 显式指定的端点错误不隐藏；写入连接也绝不回退到独立实例。
    if (options.socketPath !== undefined || options.writable || !(error instanceof AdapterError) || error.code !== 'unavailable') throw error;
    return connectCodexStdio(options);
  }
}
