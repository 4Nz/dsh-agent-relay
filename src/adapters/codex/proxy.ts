import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { resolveCodexCommand } from './cli.js';
import { connectCodex, codexEndpoint, type CodexConnectionOptions } from './rpc.js';
import type { CodexStdioOptions } from './stdio.js';

// 官方 proxy 是原始字节桥，仍需由现有客户端执行 HTTP Upgrade、WebSocket 帧与 JSON-RPC。
export async function connectCodexProxy(options: CodexConnectionOptions & CodexStdioOptions = {}) {
  const path = codexEndpoint(options);
  const launch = resolveCodexCommand({...options,cliArgs:['app-server','proxy','--sock',path]});
  const child = spawn(launch.command,launch.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const stream = Duplex.from({readable:child.stdout,writable:child.stdin});
  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    stream.destroy();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    if(child.exitCode === null) child.kill();
  }
  child.stderr.resume();
  child.on('error',()=>stream.destroy(new Error('Codex daemon 代理启动失败')));
  child.on('close',()=>stream.destroy());
  // 握手前进程也可能退出，避免未订阅的 stream error 成为全局异常。
  stream.on('error',()=>{});
  try {
    return await connectCodex({...options,createConnection:()=>stream,onClose:()=>{cleanup();options.onClose?.();}});
  } catch(error) { cleanup();throw error; }
}
