import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface RunOptions {
  cwd?: string;
  // 写入 stdin 的内容；不传时 stdin 为空，避免 CLI 等待输入。
  input?: string;
  // 超时后终止进程。不传则一直等待进程退出。
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type ClaudeRunner = (
  args: string[],
  options?: RunOptions,
) => Promise<RunResult>;

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const KILL_GRACE_MS = 1000;
const SETTLE_GRACE_MS = 1000;

function defaultExistsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// 跨平台解析 claude 可执行文件：Windows 下优先匹配原生 .exe，其次将 npm .cmd/.ps1 shim 解析为 Node 启动的 JS 入口，避免直接 spawn .cmd 触发 EINVAL/ENOENT。
export function resolveClaudeCommand({
  bin = "claude",
  cliArgs = [],
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
  existsFile = defaultExistsFile,
}: {
  bin?: string;
  cliArgs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodePath?: string;
  existsFile?: (path: string) => boolean;
} = {}): { command: string; args: string[] } {
  const paths = platform === "win32" ? win32 : posix;
  const specified = bin === "claude" && env.DSH_CLAUDE_BIN?.trim() ? env.DSH_CLAUDE_BIN.trim() : bin;
  const wrap = (command: string): { command: string; args: string[] } => {
    if (/\.[cm]?js$/i.test(command)) return { command: nodePath, args: [command, ...cliArgs] };
    if (platform === "win32" && /\.(cmd|ps1|bat)$/i.test(command)) {
      const dir = paths.dirname(command);
      const candidates = [
        paths.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        paths.join(dir, "node_modules", "@anthropic-ai", "claude-code", "dist", "cli.js"),
      ];
      for (const entry of candidates) {
        if (existsFile(entry)) return { command: nodePath, args: [entry, ...cliArgs] };
      }
      throw new Error(
        "无法在 Windows 上直接执行 claude .cmd/.bat 脚本，请安装原生 claude.exe 或将 DSH_CLAUDE_BIN 指向 claude.exe / cli.js",
      );
    }
    return { command, args: cliArgs };
  };
  if (platform !== "win32") return wrap(specified);
  if (paths.isAbsolute(specified) || specified.includes("/") || specified.includes("\\")) {
    return wrap(specified);
  }
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const dirs = pathValue.split(";").filter(Boolean).map((d) => d.replace(/^"(.*)"$/, "$1"));
  const hasExt = /\.[a-z0-9]+$/i.test(specified);
  // 优先全 PATH 搜索 .exe，再搜索 .cmd/.ps1，避免旧 npm shim 抢占原生可执行文件。
  const groups = hasExt ? [[specified]] : [[`${specified}.exe`], [`${specified}.cmd`, `${specified}.ps1`]];
  for (const names of groups) {
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = paths.join(dir, name);
        if (existsFile(candidate)) return wrap(candidate);
      }
    }
  }
  return wrap(specified);
}

// 不经过 shell，参数原样作为 argv 传入。
export function createRunner(bin = "claude"): ClaudeRunner {
  return createResolvedRunner((args) => resolveClaudeCommand({ bin, cliArgs: args }));
}

// 由命令解析器决定实际可执行与参数，供 codex 等需要解析启动脚本（Windows .cmd/.exe）的场景复用。
export function createResolvedRunner(
  resolveCommand: (args: string[]) => { command: string; args: string[] },
): ClaudeRunner {
  return (args, { cwd, input, timeoutMs, signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const launch = resolveCommand(args);
      const child = spawn(launch.command, launch.args, {
        cwd,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        timedOut = false;
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers.length = 0;
        signal?.removeEventListener("abort", terminate);
      };
      // 只结算一次：close 与强制收尾竞争时以先到为准。
      const settle = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };
      const terminate = () => {
        if (settled || timedOut) return;
        timedOut = true;
        child.kill("SIGTERM");
        timers.push(setTimeout(() => {
          child.kill("SIGKILL");
          timers.push(setTimeout(() => {
            child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
            settle({ code: null, stdout, stderr, timedOut: true });
          }, SETTLE_GRACE_MS));
        }, KILL_GRACE_MS));
      };
      if (timeoutMs !== undefined) timers.push(setTimeout(terminate, timeoutMs));
      signal?.addEventListener("abort", terminate, {once:true});
      if (signal?.aborted) terminate();
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
      });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
      });
      child.once("close", (code) => {
        settle({ code, stdout, stderr, timedOut });
      });
      child.stdin?.on("error", () => { /* 进程关闭管道由 close/error 统一结算。 */ });
      if (input !== undefined) child.stdin!.end(input);
    });
}
