import { statSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { AdapterError } from '../types.js';

interface CliOptions {
  cliPath?: string; cliArgs?: string[];
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; nodePath?: string;
  existsFile?: (path: string) => boolean;
}
export function resolveCodexCommand({ cliPath, cliArgs, env = process.env, platform = process.platform, nodePath = process.execPath,
  existsFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } },
}: CliOptions = {}): { command: string; args: string[] } {
  const args = cliArgs ?? ['app-server', '--listen', 'stdio://'];
  const paths = platform === 'win32' ? win32 : posix;
  const specified = cliPath ?? env.DSH_CODEX_BIN;
  const wrap = (command: string) => {
    if (/\.[cm]?js$/i.test(command)) return { command: nodePath, args: [command, ...args] };
    if (/\.(cmd|ps1|bat)$/i.test(command)) {
      const entry = paths.join(paths.dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (!/^codex\.(cmd|ps1)$/i.test(paths.basename(command)) || !existsFile(entry))
        throw new AdapterError('unavailable', '无法解析 Codex 启动脚本，请将 DSH_CODEX_BIN 指向官方 codex.exe 或 codex.js');
      return { command: nodePath, args: [entry, ...args] };
    }
    return { command, args };
  };
  if (platform !== 'win32') return wrap(specified ?? 'codex');
  const command = specified ?? 'codex';
  if (paths.isAbsolute(command) || command.includes('/') || command.includes('\\')) return wrap(command);
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const names = /\.[a-z0-9]+$/i.test(command) ? [command] : [`${command}.exe`, `${command}.cmd`, `${command}.ps1`];
  for (const directory of pathValue.split(';').filter(Boolean)) {
    for (const name of names) {
      const file = paths.join(directory.replace(/^"(.*)"$/, '$1'), name);
      if (existsFile(file)) return wrap(file);
    }
  }
  return wrap(command);
}
